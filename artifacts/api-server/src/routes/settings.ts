import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable, isDatabaseConnected } from "@workspace/db";
import {
  UpdateSettingsBody,
  GetSettingsResponse,
} from "@workspace/api-zod";
import { requireAuth, getTenantId, resolveTenantId } from "../lib/auth";
import { memoryStore } from "../lib/memoryStore";

const router: IRouter = Router();

async function ensureSettingsForTenant(tenantId: number) {
  if (!isDatabaseConnected) {
    return memoryStore.getOrCreateSettings(tenantId);
  }

  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, tenantId));
  if (row) return row;

  const [created] = await db
    .insert(settingsTable)
    .values({ id: tenantId, businessName: "SmartBuy", logoUrl: null })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [again] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, tenantId));
  return again!;
}

router.get("/settings", async (req, res): Promise<void> => {
  const tenantId = await resolveTenantId(req);
  if (!tenantId) {
    res.json(
      GetSettingsResponse.parse({
        businessName: "SmartBuy",
        logoUrl: null,
      }),
    );
    return;
  }

  const row = await ensureSettingsForTenant(tenantId);
  res.json(
    GetSettingsResponse.parse({
      businessName: row.businessName,
      logoUrl: row.logoUrl,
    }),
  );
});

router.patch(
  "/settings",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const tenantId = getTenantId(req);

    if (!isDatabaseConnected) {
      const settings = memoryStore.getOrCreateSettings(tenantId);
      if (parsed.data.businessName !== undefined) {
        settings.businessName = parsed.data.businessName.trim();
      }
      if (parsed.data.logoUrl !== undefined) {
        settings.logoUrl = parsed.data.logoUrl;
      }
      settings.updatedAt = new Date();
      res.json(
        GetSettingsResponse.parse({
          businessName: settings.businessName,
          logoUrl: settings.logoUrl,
        }),
      );
      return;
    }

    await ensureSettingsForTenant(tenantId);

    const updates: Record<string, unknown> = {};
    if (parsed.data.businessName !== undefined) {
      updates["businessName"] = parsed.data.businessName.trim();
    }
    if (parsed.data.logoUrl !== undefined) {
      updates["logoUrl"] = parsed.data.logoUrl;
    }

    const [updated] =
      Object.keys(updates).length > 0
        ? await db
            .update(settingsTable)
            .set(updates)
            .where(eq(settingsTable.id, tenantId))
            .returning()
        : await db
            .select()
            .from(settingsTable)
            .where(eq(settingsTable.id, tenantId));

    res.json(
      GetSettingsResponse.parse({
        businessName: updated!.businessName,
        logoUrl: updated!.logoUrl,
      }),
    );
  },
);

export default router;
