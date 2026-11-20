import { db, usersTable, settingsTable, isDatabaseConnected } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth";
import { logger } from "./logger";
import { memoryStore } from "./memoryStore";

export async function ensureDefaultUser(): Promise<void> {
  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    return;
  }

  const existing = await db.select().from(usersTable).limit(1);
  if (existing.length === 0) {
    const passwordHash = await hashPassword("admin");
    await db
      .insert(usersTable)
      .values({
        username: "admin",
        email: "admin@smartbuy.co.ke",
        passwordHash,
      })
      .onConflictDoNothing();
    logger.info(
      "Seeded default user 'admin' (admin@smartbuy.co.ke) with password 'admin'. Change it from Settings.",
    );
  }

  const settings = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, 1));
  if (settings.length === 0) {
    await db
      .insert(settingsTable)
      .values({ id: 1, businessName: "SmartBuy", logoUrl: null })
      .onConflictDoNothing();
  } else {
    const current = settings[0];
    if (current?.businessName === "Duka POS") {
      await db
        .update(settingsTable)
        .set({ businessName: "SmartBuy" })
        .where(eq(settingsTable.id, 1));
      logger.info("Updated business name from 'Duka POS' to 'SmartBuy'.");
    }
  }
}
