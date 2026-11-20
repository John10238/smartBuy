import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, isDatabaseConnected } from "@workspace/db";
import { hashPassword, getAuthUserId } from "../lib/auth";
import { z } from "zod";
import { memoryStore } from "../lib/memoryStore";

const router: IRouter = Router();

router.get("/users", async (_req, res): Promise<void> => {
  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const rows = [...memoryStore.users].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    res.json(
      rows.map((u) => ({
        id: u.id,
        username: u.username,
        createdAt: u.createdAt.toISOString(),
      })),
    );
    return;
  }

  const rows = await db
    .select({ id: usersTable.id, username: usersTable.username, createdAt: usersTable.createdAt })
    .from(usersTable)
    .orderBy(usersTable.createdAt);

  res.json(rows.map((u) => ({ id: u.id, username: u.username, createdAt: u.createdAt.toISOString() })));
});

const CreateUserBody = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

router.post("/users", async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { username, password } = parsed.data;
  const trimmed = username.trim();

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    if (memoryStore.users.some((u) => u.username === trimmed)) {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }
    const passwordHash = await hashPassword(password);
    const now = new Date();
    const created = {
      id: memoryStore.allocUserId(),
      username: trimmed,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.users.push(created);
    req.log.info({ username: created.username }, "New user created");
    res.status(201).json({
      id: created.id,
      username: created.username,
      createdAt: created.createdAt.toISOString(),
    });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, trimmed));

  if (existing) {
    res.status(409).json({ error: "Username is already taken" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(usersTable)
    .values({ username: trimmed, passwordHash })
    .returning({ id: usersTable.id, username: usersTable.username, createdAt: usersTable.createdAt });

  if (!created) {
    res.status(500).json({ error: "Failed to create user" });
    return;
  }

  req.log.info({ username: created.username }, "New user created");
  res.status(201).json({ id: created.id, username: created.username, createdAt: created.createdAt.toISOString() });
});

const ResetPasswordBody = z.object({
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});

router.patch("/users/:id/password", async (req, res): Promise<void> => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const target = memoryStore.users.find((u) => u.id === targetId);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    target.passwordHash = await hashPassword(parsed.data.newPassword);
    target.updatedAt = new Date();
    req.log.info({ targetId }, "Admin reset user password");
    res.json({ ok: true });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, targetId));

  req.log.info({ targetId }, "Admin reset user password");
  res.json({ ok: true });
});

router.delete("/users/:id", async (req, res): Promise<void> => {
  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  if (targetId === getAuthUserId(req)) {
    res.status(400).json({ error: "You cannot delete your own account" });
    return;
  }

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const idx = memoryStore.users.findIndex((u) => u.id === targetId);
    if (idx === -1) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    memoryStore.users.splice(idx, 1);
    req.log.info({ targetId }, "User deleted");
    res.sendStatus(204);
    return;
  }

  const [target] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, targetId));

  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await db.delete(usersTable).where(eq(usersTable.id, targetId));
  req.log.info({ targetId }, "User deleted");
  res.sendStatus(204);
});

export default router;
