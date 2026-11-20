import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  ordersTable,
  orderItemsTable,
  productsTable,
  transactionsTable,
  isDatabaseConnected,
} from "@workspace/db";
import { MpesaStkPushBody, MpesaStkPushResponse } from "@workspace/api-zod";
import {
  initiateStkPush,
  isMpesaConfigured,
  normalizeKenyanPhone,
  getEffectiveCallbackUrl,
} from "../lib/mpesa";
import { requireAuth } from "../lib/auth";
import { memoryStore } from "../lib/memoryStore";

const router: IRouter = Router();

router.post("/mpesa/stkpush", requireAuth, async (req, res): Promise<void> => {
  const parsed = MpesaStkPushBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (!isMpesaConfigured()) {
    res.status(400).json({
      error:
        "M-Pesa is not configured. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY and MPESA_CALLBACK_URL.",
    });
    return;
  }

  const phone = normalizeKenyanPhone(parsed.data.phoneNumber);
  if (!phone) {
    res.status(400).json({ error: "Invalid phone number" });
    return;
  }

  const order = !isDatabaseConnected
    ? (memoryStore.ensureSeeded(),
      memoryStore.orders.find((o) => o.id === parsed.data.orderId))
    : (
        await db
          .select()
          .from(ordersTable)
          .where(eq(ordersTable.id, parsed.data.orderId))
      )[0];

  if (!order) {
    res.status(400).json({ error: "Order not found" });
    return;
  }

  if (order.status === "paid") {
    res.status(400).json({ error: "Order is already paid" });
    return;
  }

  const amountKes = Math.max(1, Math.round(order.totalCents / 100));

  let stk;
  try {
    stk = await initiateStkPush({
      phoneNumber: phone,
      amount: amountKes,
      accountReference: order.reference.slice(0, 12),
      transactionDesc: `Order ${order.id}`.slice(0, 13),
    });
  } catch (err) {
    req.log.error({ err }, "STK push failed");
    res.status(502).json({ error: "Failed to reach M-Pesa Daraja" });
    return;
  }

  if (!stk.CheckoutRequestID) {
    req.log.warn({ stk }, "STK push returned no CheckoutRequestID");
    let txId: number | undefined;
    if (!isDatabaseConnected) {
      const memTx = {
        id: memoryStore.allocTransactionId(),
        orderId: order.id,
        amountCents: order.totalCents,
        provider: "mpesa",
        status: "failed",
        mpesaCheckoutRequestId: null,
        mpesaMerchantRequestId: null,
        mpesaReceiptNumber: null,
        phoneNumber: phone,
        rawCallback: JSON.stringify(stk),
        createdAt: new Date(),
      };
      memoryStore.transactions.push(memTx);
      txId = memTx.id;
    } else {
      const [tx] = await db
        .insert(transactionsTable)
        .values({
          orderId: order.id,
          amountCents: order.totalCents,
          provider: "mpesa",
          status: "failed",
          phoneNumber: phone,
          rawCallback: JSON.stringify(stk),
        })
        .returning();
      txId = tx?.id;
    }

    const rawError = stk.errorMessage ?? stk.ResponseDescription ?? "M-Pesa request rejected";
    const callbackUrl = getEffectiveCallbackUrl();
    const isCallbackUrlError =
      rawError.toLowerCase().includes("callback") ||
      rawError.toLowerCase().includes("callbackurl");
    const isDevUrl = callbackUrl.includes("localhost");

    let friendlyError = rawError;
    if (isCallbackUrlError && isDevUrl) {
      friendlyError = `Invalid callback URL: the app is using a dev-only URL (${callbackUrl}) that Safaricom cannot reach. Set MPESA_CALLBACK_URL to your production domain.`;
    } else if (isCallbackUrlError) {
      friendlyError = `Safaricom rejected the callback URL (${callbackUrl}). Make sure this URL is publicly accessible via HTTPS and not blocked by a firewall or proxy.`;
    }

    res.status(502).json({
      error: friendlyError,
      transactionId: txId,
    });
    return;
  }

  let txId: number;
  if (!isDatabaseConnected) {
    const memTx = {
      id: memoryStore.allocTransactionId(),
      orderId: order.id,
      amountCents: order.totalCents,
      provider: "mpesa",
      status: "pending",
      mpesaCheckoutRequestId: stk.CheckoutRequestID ?? null,
      mpesaMerchantRequestId: stk.MerchantRequestID ?? null,
      mpesaReceiptNumber: null,
      phoneNumber: phone,
      rawCallback: null,
      createdAt: new Date(),
    };
    memoryStore.transactions.push(memTx);
    txId = memTx.id;
  } else {
    const [tx] = await db
      .insert(transactionsTable)
      .values({
        orderId: order.id,
        amountCents: order.totalCents,
        provider: "mpesa",
        status: "pending",
        mpesaCheckoutRequestId: stk.CheckoutRequestID ?? null,
        mpesaMerchantRequestId: stk.MerchantRequestID ?? null,
        phoneNumber: phone,
      })
      .returning();

    if (!tx) {
      res.status(500).json({ error: "Failed to record transaction" });
      return;
    }
    txId = tx.id;
  }

  res.status(200).json(
    MpesaStkPushResponse.parse({
      merchantRequestId: stk.MerchantRequestID ?? null,
      checkoutRequestId: stk.CheckoutRequestID ?? null,
      responseCode: stk.ResponseCode ?? null,
      responseDescription: stk.ResponseDescription ?? null,
      customerMessage: stk.CustomerMessage ?? null,
      transactionId: txId,
    }),
  );
});

interface DarajaCallbackBody {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: {
        Item?: Array<{ Name?: string; Value?: string | number }>;
      };
    };
  };
}

router.get("/mpesa/callback", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.options("/mpesa/callback", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

router.post("/mpesa/callback", async (req, res): Promise<void> => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const payload = req.body as DarajaCallbackBody;
  const cb = payload?.Body?.stkCallback;

  req.log.info({ body: JSON.stringify(payload), checkoutRequestId: cb?.CheckoutRequestID, resultCode: cb?.ResultCode }, "Received M-Pesa callback from Safaricom");

  if (!cb || !cb.CheckoutRequestID) {
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    return;
  }

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const tx = memoryStore.transactions.find(
      (t) => t.mpesaCheckoutRequestId === cb.CheckoutRequestID,
    );
    if (!tx) {
      res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      return;
    }
    const success = cb.ResultCode === 0;
    const items = cb.CallbackMetadata?.Item ?? [];
    const findItem = (name: string) => items.find((i) => i.Name === name)?.Value;
    const receipt = findItem("MpesaReceiptNumber");
    const phone = findItem("PhoneNumber");

    tx.status = success ? "success" : "failed";
    if (receipt) tx.mpesaReceiptNumber = String(receipt);
    if (phone) tx.phoneNumber = String(phone);
    tx.rawCallback = JSON.stringify(payload);

    if (tx.orderId) {
      const order = memoryStore.orders.find((o) => o.id === tx.orderId);
      if (order) {
        if (success && order.status !== "paid") {
          order.status = "paid";
          order.updatedAt = new Date();
          const orderItems = memoryStore.orderItems.filter(
            (it) => it.orderId === order.id,
          );
          for (const item of orderItems) {
            const p = memoryStore.products.find((pr) => pr.id === item.productId);
            if (p) p.stock = Math.max(0, p.stock - item.quantity);
          }
        } else if (!success) {
          order.status = "failed";
          order.updatedAt = new Date();
        }
      }
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    return;
  }

  const [tx] = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.mpesaCheckoutRequestId, cb.CheckoutRequestID));

  if (!tx) {
    req.log.warn(
      { checkoutRequestId: cb.CheckoutRequestID },
      "Callback for unknown transaction",
    );
    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    return;
  }

  const success = cb.ResultCode === 0;
  const items = cb.CallbackMetadata?.Item ?? [];
  const findItem = (name: string) =>
    items.find((i) => i.Name === name)?.Value;

  const receipt = findItem("MpesaReceiptNumber");
  const phone = findItem("PhoneNumber");

  await db
    .update(transactionsTable)
    .set({
      status: success ? "success" : "failed",
      mpesaReceiptNumber: receipt ? String(receipt) : tx.mpesaReceiptNumber,
      phoneNumber: phone ? String(phone) : tx.phoneNumber,
      rawCallback: JSON.stringify(payload),
    })
    .where(eq(transactionsTable.id, tx.id));

  if (tx.orderId) {
    if (success) {
      try {
        await db.transaction(async (innerTx) => {
          const [order] = await innerTx
            .select()
            .from(ordersTable)
            .where(eq(ordersTable.id, tx.orderId!));
          if (!order) return;
          if (order.status === "paid") return;

          await innerTx
            .update(ordersTable)
            .set({ status: "paid" })
            .where(eq(ordersTable.id, order.id));

          const items = await innerTx
            .select()
            .from(orderItemsTable)
            .where(eq(orderItemsTable.orderId, order.id));

          for (const item of items) {
            await innerTx
              .update(productsTable)
              .set({
                stock: sql`GREATEST(0, ${productsTable.stock} - ${item.quantity})`,
              })
              .where(eq(productsTable.id, item.productId));
          }
        });
      } catch (err) {
        req.log.error({ err }, "Failed to mark order paid");
      }
    } else {
      await db
        .update(ordersTable)
        .set({ status: "failed" })
        .where(eq(ordersTable.id, tx.orderId));
    }
  }

  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

export default router;
