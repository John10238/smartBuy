import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { eq, ne, and, sql, desc, isNull, gt } from "drizzle-orm";
import {
  db,
  usersTable,
  settingsTable,
  passwordResetCodesTable,
  isDatabaseConnected,
} from "@workspace/db";
import {
  LoginBody,
  UpdateCredentialsBody,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  requireAuth,
  getAuthUserId,
  createAuthToken,
  isHttpsRequest,
} from "../lib/auth";
import { memoryStore } from "../lib/memoryStore";
import { isSmtpConfigured, sendPasswordResetEmail } from "../lib/mailer";

const router: IRouter = Router();

function hashResetCode(email: string, code: string): string {
  const secret =
    process.env["SESSION_SECRET"] || "smartbuy-dev-session-secret-change-me";
  return crypto
    .createHmac("sha256", secret)
    .update(`${email.toLowerCase()}:${code}`)
    .digest("hex");
}

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const user = memoryStore.users.find((u) => u.id === userId);
    if (!user) {
      req.session.destroy(() => undefined);
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    res.json(
      GetCurrentUserResponse.parse({
        id: user.id,
        username: user.username,
        email: user.email,
      }),
    );
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) {
    req.session.destroy(() => undefined);
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json(
    GetCurrentUserResponse.parse({
      id: user.id,
      username: user.username,
      email: user.email,
    }),
  );
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? parsed.error.message });
    return;
  }

  const identifier = (parsed.data.email || parsed.data.username || "").trim();
  const identifierLower = identifier.toLowerCase();

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const user = memoryStore.users.find(
      (u) =>
        (u.email && u.email.toLowerCase() === identifierLower) ||
        u.username === identifier,
    );
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    req.session.userId = user.id;
    req.session.save((saveErr) => {
      if (saveErr) {
        req.log.error({ err: saveErr }, "Failed to save session");
        res.status(500).json({ error: "Failed to log in" });
        return;
      }
      res.setHeader("X-Auth-Token", createAuthToken(user.id));
      res.json(
        GetCurrentUserResponse.parse({
          id: user.id,
          username: user.username,
          email: user.email,
        }),
      );
    });
    return;
  }

  const [userByEmail] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${identifierLower}`);

  const user =
    userByEmail ??
    (
      await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.username, identifier))
    )[0];

  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  req.session.userId = user.id;
  req.session.save((saveErr) => {
    if (saveErr) {
      req.log.error({ err: saveErr }, "Failed to save session");
      res.status(500).json({ error: "Failed to log in" });
      return;
    }
    res.setHeader("X-Auth-Token", createAuthToken(user.id));
    res.json(
      GetCurrentUserResponse.parse({
        id: user.id,
        username: user.username,
        email: user.email,
      }),
    );
  });
});

const RegisterBody = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").optional(),
    username: z.string().trim().min(2, "Name must be at least 2 characters").optional(),
    email: z.string().trim().email("Enter a valid email address"),
    businessName: z.string().trim().optional(),
    password: z.string().min(6, "Password must be at least 6 characters"),
  })
  .refine((d) => Boolean(d.name || d.username), {
    message: "Name is required",
  });

router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const displayName = (parsed.data.name || parsed.data.username || "").trim();
  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const businessName = parsed.data.businessName?.trim() || "SmartBuy";

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    if (
      memoryStore.users.some(
        (u) => u.email && u.email.toLowerCase() === normalizedEmail,
      )
    ) {
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const now = new Date();
    const created = {
      id: memoryStore.allocUserId(),
      username: displayName,
      email: normalizedEmail,
      ownerId: null,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.users.push(created);
    const settings = memoryStore.getOrCreateSettings(created.id);
    settings.businessName = businessName;
    settings.updatedAt = now;

    req.session.userId = created.id;
    req.session.save((saveErr) => {
      if (saveErr) {
        req.log.error({ err: saveErr }, "Failed to save session after register");
        res.status(500).json({ error: "Failed to complete registration" });
        return;
      }
      res.setHeader("X-Auth-Token", createAuthToken(created.id));
      res.status(201).json(
        GetCurrentUserResponse.parse({
          id: created.id,
          username: created.username,
          email: created.email,
        }),
      );
    });
    return;
  }

  const [existingEmail] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${normalizedEmail}`);

  if (existingEmail) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [created] = await db
    .insert(usersTable)
    .values({
      username: displayName,
      email: normalizedEmail,
      ownerId: null,
      passwordHash,
    })
    .returning();

  if (!created) {
    res.status(500).json({ error: "Failed to create account" });
    return;
  }

  await db
    .insert(settingsTable)
    .values({ id: created.id, businessName, logoUrl: null })
    .onConflictDoNothing();

  req.session.userId = created.id;
  req.session.save((saveErr) => {
    if (saveErr) {
      req.log.error({ err: saveErr }, "Failed to save session after register");
      res.status(500).json({ error: "Failed to complete registration" });
      return;
    }
    res.setHeader("X-Auth-Token", createAuthToken(created.id));
    res.status(201).json(
      GetCurrentUserResponse.parse({
        id: created.id,
        username: created.username,
        email: created.email,
      }),
    );
  });
});

router.post("/auth/logout", (req, res): void => {
  const isHttps = isHttpsRequest(req);
  if (req.session) {
    req.session.userId = undefined;
  }
  req.session.destroy((err) => {
    if (err) {
      req.log.error({ err }, "Failed to destroy session");
      res.status(500).json({ error: "Failed to log out" });
      return;
    }
    res.clearCookie("duka.sid", {
      path: "/",
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? "none" : "lax",
      ...(isHttps ? { partitioned: true } : {}),
    } as Parameters<typeof res.clearCookie>[1]);
    res.sendStatus(204);
  });
});

const ForgotPasswordBody = z.object({
  email: z.string().trim().email("Enter a valid email address"),
});

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const parsed = ForgotPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.errors[0]?.message ?? "Invalid email" });
    return;
  }

  const normalizedEmail = parsed.data.email.toLowerCase();
  const smtpReady = isSmtpConfigured();

  let targetUser: { id: number; email: string } | null = null;
  let businessName = "SmartBuy";

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const found = memoryStore.users.find(
      (u) => u.email && u.email.toLowerCase() === normalizedEmail,
    );
    if (found && found.email) {
      targetUser = { id: found.id, email: found.email };
      businessName =
        memoryStore.getOrCreateSettings(found.ownerId ?? found.id)
          .businessName || "SmartBuy";
    }
  } else {
    const [found] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        ownerId: usersTable.ownerId,
      })
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${normalizedEmail}`);
    if (found && found.email) {
      targetUser = { id: found.id, email: found.email };
      const [settings] = await db
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.id, found.ownerId ?? found.id));
      if (settings?.businessName) {
        businessName = settings.businessName;
      }
    }
  }

  if (!targetUser) {
    if (!smtpReady) {
      res.status(404).json({
        error: "No account found with that email address.",
      });
      return;
    }
    res.json({
      ok: true,
      delivery: "smtp",
      message:
        "If an account with that email exists, a 6-digit reset code has been sent.",
    });
    return;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = hashResetCode(normalizedEmail, code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

  if (!isDatabaseConnected) {
    for (const existing of memoryStore.passwordResetCodes) {
      if (existing.userId === targetUser.id && !existing.usedAt) {
        existing.usedAt = now;
      }
    }
    memoryStore.passwordResetCodes.push({
      id: memoryStore.allocResetCodeId(),
      userId: targetUser.id,
      email: normalizedEmail,
      codeHash,
      expiresAt,
      usedAt: null,
      createdAt: now,
    });
  } else {
    await db
      .update(passwordResetCodesTable)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetCodesTable.userId, targetUser.id),
          isNull(passwordResetCodesTable.usedAt),
        ),
      );
    await db.insert(passwordResetCodesTable).values({
      userId: targetUser.id,
      email: normalizedEmail,
      codeHash,
      expiresAt,
    });
  }

  if (smtpReady) {
    try {
      await sendPasswordResetEmail({
        to: targetUser.email,
        code,
        businessName,
      });
      res.json({
        ok: true,
        delivery: "smtp",
        message: `A 6-digit reset code has been sent to ${targetUser.email}.`,
      });
    } catch (err) {
      req.log.error({ err }, "Failed to send password reset email");
      res.status(500).json({
        error: "Failed to send reset email. Check SMTP configuration.",
      });
    }
    return;
  }

  req.log.info(
    { email: targetUser.email, resetCode: code },
    "SMTP not configured — generated password reset code",
  );
  res.json({
    ok: true,
    delivery: "preview",
    message:
      "SMTP email is not configured in this environment. Use the verification code shown below to reset your password.",
    previewCode: code,
  });
});

const ResetPasswordWithCodeBody = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit reset code"),
  newPassword: z
    .string()
    .min(6, "New password must be at least 6 characters"),
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = ResetPasswordWithCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const normalizedEmail = parsed.data.email.toLowerCase();
  const expectedHash = hashResetCode(normalizedEmail, parsed.data.code);
  const now = new Date();

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const user = memoryStore.users.find(
      (u) => u.email && u.email.toLowerCase() === normalizedEmail,
    );
    if (!user) {
      res.status(400).json({ error: "Invalid or expired reset code" });
      return;
    }

    const latestCode = [...memoryStore.passwordResetCodes]
      .reverse()
      .find(
        (c) =>
          c.userId === user.id &&
          c.email === normalizedEmail &&
          !c.usedAt &&
          c.expiresAt.getTime() > now.getTime(),
      );

    if (
      !latestCode ||
      latestCode.codeHash.length !== expectedHash.length ||
      !crypto.timingSafeEqual(
        Buffer.from(latestCode.codeHash),
        Buffer.from(expectedHash),
      )
    ) {
      res.status(400).json({ error: "Invalid or expired reset code" });
      return;
    }

    user.passwordHash = await hashPassword(parsed.data.newPassword);
    user.updatedAt = now;
    latestCode.usedAt = now;

    res.json({
      ok: true,
      message: "Password updated. You can now sign in with your new password.",
    });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(sql`lower(${usersTable.email}) = ${normalizedEmail}`);

  if (!user) {
    res.status(400).json({ error: "Invalid or expired reset code" });
    return;
  }

  const [latestCode] = await db
    .select()
    .from(passwordResetCodesTable)
    .where(
      and(
        eq(passwordResetCodesTable.userId, user.id),
        eq(passwordResetCodesTable.email, normalizedEmail),
        isNull(passwordResetCodesTable.usedAt),
        gt(passwordResetCodesTable.expiresAt, now),
      ),
    )
    .orderBy(desc(passwordResetCodesTable.createdAt))
    .limit(1);

  if (
    !latestCode ||
    latestCode.codeHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(latestCode.codeHash),
      Buffer.from(expectedHash),
    )
  ) {
    res.status(400).json({ error: "Invalid or expired reset code" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, user.id));
  await db
    .update(passwordResetCodesTable)
    .set({ usedAt: now })
    .where(eq(passwordResetCodesTable.id, latestCode.id));

  res.json({
    ok: true,
    message: "Password updated. You can now sign in with your new password.",
  });
});

router.patch(
  "/auth/credentials",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = UpdateCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message ?? parsed.error.message });
      return;
    }

    if (
      !parsed.data.newEmail &&
      !parsed.data.newUsername &&
      !parsed.data.newPassword
    ) {
      res.status(400).json({
        error: "Provide a new email, username, password, or combination.",
      });
      return;
    }

    const userId = getAuthUserId(req)!;

    if (!isDatabaseConnected) {
      memoryStore.ensureSeeded();
      const user = memoryStore.users.find((u) => u.id === userId);
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const ok = await verifyPassword(
        parsed.data.currentPassword,
        user.passwordHash,
      );
      if (!ok) {
        res.status(401).json({ error: "Current password is incorrect" });
        return;
      }
      if (parsed.data.newEmail) {
        const newEmail = parsed.data.newEmail.trim().toLowerCase();
        if (newEmail !== (user.email ?? "").toLowerCase()) {
          const conflict = memoryStore.users.find(
            (u) => u.email?.toLowerCase() === newEmail && u.id !== userId,
          );
          if (conflict) {
            res.status(409).json({ error: "That email is already in use" });
            return;
          }
          user.email = newEmail;
        }
      }
      if (parsed.data.newUsername) {
        const newName = parsed.data.newUsername.trim();
        if (newName && newName !== user.username) {
          user.username = newName;
        }
      }
      if (parsed.data.newPassword) {
        user.passwordHash = await hashPassword(parsed.data.newPassword);
      }
      user.updatedAt = new Date();
      res.json(
        GetCurrentUserResponse.parse({
          id: user.id,
          username: user.username,
          email: user.email,
        }),
      );
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const ok = await verifyPassword(
      parsed.data.currentPassword,
      user.passwordHash,
    );
    if (!ok) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.newEmail) {
      const newEmail = parsed.data.newEmail.trim().toLowerCase();
      if (newEmail !== (user.email ?? "").toLowerCase()) {
        const [conflict] = await db
          .select()
          .from(usersTable)
          .where(
            and(
              sql`lower(${usersTable.email}) = ${newEmail}`,
              ne(usersTable.id, userId),
            ),
          );
        if (conflict) {
          res.status(409).json({ error: "That email is already in use" });
          return;
        }
        updates["email"] = newEmail;
      }
    }
    if (parsed.data.newUsername) {
      const newName = parsed.data.newUsername.trim();
      if (newName && newName !== user.username) {
        updates["username"] = newName;
      }
    }
    if (parsed.data.newPassword) {
      updates["passwordHash"] = await hashPassword(parsed.data.newPassword);
    }

    if (Object.keys(updates).length === 0) {
      res.json(
        GetCurrentUserResponse.parse({
          id: user.id,
          username: user.username,
          email: user.email,
        }),
      );
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, userId))
      .returning();

    if (!updated) {
      res.status(500).json({ error: "Failed to update credentials" });
      return;
    }

    res.json(
      GetCurrentUserResponse.parse({
        id: updated.id,
        username: updated.username,
        email: updated.email,
      }),
    );
  },
);

export default router;
