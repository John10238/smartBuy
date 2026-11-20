import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, transactionsTable, ordersTable, isDatabaseConnected } from "@workspace/db";
import { ListTransactionsResponse } from "@workspace/api-zod";
import { getTenantId } from "../lib/auth";
import { memoryStore } from "../lib/memoryStore";

const router: IRouter = Router();

router.get("/transactions", async (req, res): Promise<void> => {
  const tenantId = getTenantId(req);

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const orderMap = new Map(
      memoryStore.orders
        .filter((o) => o.ownerId === tenantId)
        .map((o) => [o.id, o.reference]),
    );
    const serialized = memoryStore.transactions
      .filter((tx) => tx.ownerId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((tx) => ({
        id: tx.id,
        orderId: tx.orderId,
        orderReference: tx.orderId ? (orderMap.get(tx.orderId) ?? null) : null,
        amountCents: tx.amountCents,
        provider: tx.provider as "mpesa" | "cash",
        status: tx.status as "pending" | "success" | "failed",
        mpesaCheckoutRequestId: tx.mpesaCheckoutRequestId,
        mpesaReceiptNumber: tx.mpesaReceiptNumber,
        phoneNumber: tx.phoneNumber,
        rawCallback: tx.rawCallback,
        createdAt: tx.createdAt.toISOString(),
      }));
    res.json(ListTransactionsResponse.parse(serialized));
    return;
  }

  const rows = await db
    .select({
      tx: transactionsTable,
      orderRef: ordersTable.reference,
    })
    .from(transactionsTable)
    .leftJoin(ordersTable, eq(transactionsTable.orderId, ordersTable.id))
    .where(eq(transactionsTable.ownerId, tenantId))
    .orderBy(desc(transactionsTable.createdAt));

  const serialized = rows.map(({ tx, orderRef }) => ({
    id: tx.id,
    orderId: tx.orderId,
    orderReference: orderRef,
    amountCents: tx.amountCents,
    provider: tx.provider as "mpesa" | "cash",
    status: tx.status as "pending" | "success" | "failed",
    mpesaCheckoutRequestId: tx.mpesaCheckoutRequestId,
    mpesaReceiptNumber: tx.mpesaReceiptNumber,
    phoneNumber: tx.phoneNumber,
    rawCallback: tx.rawCallback,
    createdAt: tx.createdAt.toISOString(),
  }));

  res.json(ListTransactionsResponse.parse(serialized));
});

export default router;
