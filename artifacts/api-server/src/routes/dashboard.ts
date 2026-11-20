import { Router, type IRouter } from "express";
import { sql, desc, eq, inArray, lt } from "drizzle-orm";
import {
  db,
  ordersTable,
  orderItemsTable,
  productsTable,
  isDatabaseConnected,
} from "@workspace/db";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import { memoryStore } from "../lib/memoryStore";

const router: IRouter = Router();

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

    let totalRevenueCents = 0;
    let todayRevenueCents = 0;
    let paidOrders = 0;
    let pendingOrders = 0;

    const paidOrderIds = new Set<number>();
    const salesByDayMap = new Map<string, { revenueCents: number; orderCount: number }>();

    for (const o of memoryStore.orders) {
      if (o.status === "paid") {
        paidOrders++;
        paidOrderIds.add(o.id);
        totalRevenueCents += o.totalCents;
        if (o.createdAt.getTime() >= dayAgo) {
          todayRevenueCents += o.totalCents;
        }
        if (o.createdAt.getTime() >= fourteenDaysAgo) {
          const day = o.createdAt.toISOString().slice(0, 10);
          const cur = salesByDayMap.get(day) ?? { revenueCents: 0, orderCount: 0 };
          cur.revenueCents += o.totalCents;
          cur.orderCount += 1;
          salesByDayMap.set(day, cur);
        }
      } else if (o.status === "pending") {
        pendingOrders++;
      }
    }

    const lowStockCount = memoryStore.products.filter((p) => p.stock < 5).length;
    const recent = [...memoryStore.orders]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5);

    const topMap = new Map<
      number,
      { productId: number; productName: string; unitsSold: number; revenueCents: number }
    >();
    for (const it of memoryStore.orderItems) {
      if (!paidOrderIds.has(it.orderId)) continue;
      const cur = topMap.get(it.productId) ?? {
        productId: it.productId,
        productName: it.productName,
        unitsSold: 0,
        revenueCents: 0,
      };
      cur.unitsSold += it.quantity;
      cur.revenueCents += it.lineTotalCents;
      topMap.set(it.productId, cur);
    }

    const topProducts = Array.from(topMap.values())
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, 5);

    const salesByDay = Array.from(salesByDayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, stats]) => ({
        day,
        revenueCents: stats.revenueCents,
        orderCount: stats.orderCount,
      }));

    const summary = {
      totalRevenueCents,
      todayRevenueCents,
      totalOrders: memoryStore.orders.length,
      paidOrders,
      pendingOrders,
      totalProducts: memoryStore.products.length,
      lowStockCount,
      recentOrders: recent.map((o) => ({
        id: o.id,
        reference: o.reference,
        status: o.status as "pending" | "paid" | "cancelled" | "failed",
        totalCents: o.totalCents,
        customerPhone: o.customerPhone,
        customerName: o.customerName,
        cashierName: o.cashierName,
        paymentMethod: o.paymentMethod as "mpesa" | "cash",
        items: memoryStore.orderItems
          .filter((it) => it.orderId === o.id)
          .map((it) => ({
            id: it.id,
            orderId: it.orderId,
            productId: it.productId,
            productName: it.productName,
            quantity: it.quantity,
            unitPriceCents: it.unitPriceCents,
            lineTotalCents: it.lineTotalCents,
          })),
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      })),
      topProducts,
      salesByDay,
    };

    res.json(GetDashboardSummaryResponse.parse(summary));
    return;
  }

  const [revenueRow] = await db
    .select({
      total: sql<number>`COALESCE(SUM(CASE WHEN ${ordersTable.status} = 'paid' THEN ${ordersTable.totalCents} ELSE 0 END), 0)::int`,
      today: sql<number>`COALESCE(SUM(CASE WHEN ${ordersTable.status} = 'paid' AND ${ordersTable.createdAt} >= NOW() - INTERVAL '24 hours' THEN ${ordersTable.totalCents} ELSE 0 END), 0)::int`,
      total_orders: sql<number>`COUNT(*)::int`,
      paid_orders: sql<number>`COUNT(*) FILTER (WHERE ${ordersTable.status} = 'paid')::int`,
      pending_orders: sql<number>`COUNT(*) FILTER (WHERE ${ordersTable.status} = 'pending')::int`,
    })
    .from(ordersTable);

  const [productCountRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(productsTable);

  const [lowStockRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(productsTable)
    .where(lt(productsTable.stock, 5));

  const recent = await db
    .select()
    .from(ordersTable)
    .orderBy(desc(ordersTable.createdAt))
    .limit(5);

  const recentItems = recent.length
    ? await db
        .select()
        .from(orderItemsTable)
        .where(
          inArray(
            orderItemsTable.orderId,
            recent.map((r) => r.id),
          ),
        )
    : [];

  const recentItemsByOrder = new Map<number, typeof recentItems>();
  for (const it of recentItems) {
    const arr = recentItemsByOrder.get(it.orderId) ?? [];
    arr.push(it);
    recentItemsByOrder.set(it.orderId, arr);
  }

  const top = await db
    .select({
      productId: orderItemsTable.productId,
      productName: orderItemsTable.productName,
      unitsSold: sql<number>`COALESCE(SUM(${orderItemsTable.quantity}), 0)::int`,
      revenueCents: sql<number>`COALESCE(SUM(${orderItemsTable.lineTotalCents}), 0)::int`,
    })
    .from(orderItemsTable)
    .innerJoin(ordersTable, eq(orderItemsTable.orderId, ordersTable.id))
    .where(eq(ordersTable.status, "paid"))
    .groupBy(orderItemsTable.productId, orderItemsTable.productName)
    .orderBy(sql`SUM(${orderItemsTable.quantity}) DESC`)
    .limit(5);

  const salesByDay = await db
    .select({
      day: sql<string>`TO_CHAR(${ordersTable.createdAt}, 'YYYY-MM-DD')`,
      revenueCents: sql<number>`COALESCE(SUM(${ordersTable.totalCents}), 0)::int`,
      orderCount: sql<number>`COUNT(*)::int`,
    })
    .from(ordersTable)
    .where(
      sql`${ordersTable.status} = 'paid' AND ${ordersTable.createdAt} >= NOW() - INTERVAL '14 days'`,
    )
    .groupBy(sql`TO_CHAR(${ordersTable.createdAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`TO_CHAR(${ordersTable.createdAt}, 'YYYY-MM-DD') ASC`);

  const summary = {
    totalRevenueCents: Number(revenueRow?.total ?? 0),
    todayRevenueCents: Number(revenueRow?.today ?? 0),
    totalOrders: Number(revenueRow?.total_orders ?? 0),
    paidOrders: Number(revenueRow?.paid_orders ?? 0),
    pendingOrders: Number(revenueRow?.pending_orders ?? 0),
    totalProducts: Number(productCountRow?.count ?? 0),
    lowStockCount: Number(lowStockRow?.count ?? 0),
    recentOrders: recent.map((o) => ({
      id: o.id,
      reference: o.reference,
      status: o.status as "pending" | "paid" | "cancelled" | "failed",
      totalCents: o.totalCents,
      customerPhone: o.customerPhone,
      customerName: o.customerName,
      cashierName: o.cashierName,
      paymentMethod: o.paymentMethod as "mpesa" | "cash",
      items: (recentItemsByOrder.get(o.id) ?? []).map((it) => ({
        id: it.id,
        orderId: it.orderId,
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        unitPriceCents: it.unitPriceCents,
        lineTotalCents: it.lineTotalCents,
      })),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    })),
    topProducts: top.map((t) => ({
      productId: t.productId,
      productName: t.productName,
      unitsSold: Number(t.unitsSold),
      revenueCents: Number(t.revenueCents),
    })),
    salesByDay: salesByDay.map((s) => ({
      day: s.day,
      revenueCents: Number(s.revenueCents),
      orderCount: Number(s.orderCount),
    })),
  };

  const parsed = GetDashboardSummaryResponse.safeParse(summary);
  if (!parsed.success) {
    req.log.error({ error: parsed.error.format() }, "Dashboard summary validation failed");
    res.status(500).json({ error: "Failed to build dashboard summary" });
    return;
  }
  res.json(parsed.data);
});

export default router;
