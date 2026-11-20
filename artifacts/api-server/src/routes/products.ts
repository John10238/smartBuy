import { Router, type IRouter } from "express";
import { eq, ilike, or, and, asc } from "drizzle-orm";
import { db, productsTable, isDatabaseConnected } from "@workspace/db";
import {
  ListProductsQueryParams,
  ListProductsResponse,
  CreateProductBody,
  GetProductParams,
  GetProductResponse,
  UpdateProductParams,
  UpdateProductBody,
  UpdateProductResponse,
  DeleteProductParams,
} from "@workspace/api-zod";
import { getTenantId } from "../lib/auth";
import { memoryStore, type MemoryProduct } from "../lib/memoryStore";

const router: IRouter = Router();

function serialize(p: typeof productsTable.$inferSelect | MemoryProduct) {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    description: p.description,
    priceCents: p.priceCents,
    stock: p.stock,
    category: p.category,
    imageUrl: p.imageUrl,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

router.get("/products", async (req, res): Promise<void> => {
  const parsed = ListProductsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const tenantId = getTenantId(req);
  const search = parsed.data.search?.trim();

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const q = search?.toLowerCase();
    const owned = memoryStore.products.filter((p) => p.ownerId === tenantId);
    const rows = (
      q
        ? owned.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              (p.sku?.toLowerCase().includes(q) ?? false) ||
              (p.category?.toLowerCase().includes(q) ?? false),
          )
        : owned
    ).sort((a, b) => a.name.localeCompare(b.name));
    res.json(ListProductsResponse.parse(rows.map(serialize)));
    return;
  }

  const rows = search
    ? await db
        .select()
        .from(productsTable)
        .where(
          and(
            eq(productsTable.ownerId, tenantId),
            or(
              ilike(productsTable.name, `%${search}%`),
              ilike(productsTable.sku, `%${search}%`),
              ilike(productsTable.category, `%${search}%`),
            ),
          ),
        )
        .orderBy(asc(productsTable.name))
    : await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.ownerId, tenantId))
        .orderBy(asc(productsTable.name));

  res.json(ListProductsResponse.parse(rows.map(serialize)));
});

router.post("/products", async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const tenantId = getTenantId(req);

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const now = new Date();
    const row: MemoryProduct = {
      id: memoryStore.allocProductId(),
      ownerId: tenantId,
      name: parsed.data.name,
      sku: parsed.data.sku ?? null,
      description: parsed.data.description ?? null,
      priceCents: parsed.data.priceCents,
      stock: parsed.data.stock,
      category: parsed.data.category ?? null,
      imageUrl: parsed.data.imageUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
    memoryStore.products.push(row);
    res.status(201).json(GetProductResponse.parse(serialize(row)));
    return;
  }

  const [row] = await db
    .insert(productsTable)
    .values({
      ownerId: tenantId,
      name: parsed.data.name,
      sku: parsed.data.sku ?? null,
      description: parsed.data.description ?? null,
      priceCents: parsed.data.priceCents,
      stock: parsed.data.stock,
      category: parsed.data.category ?? null,
      imageUrl: parsed.data.imageUrl ?? null,
    })
    .returning();

  if (!row) {
    res.status(500).json({ error: "Failed to insert product" });
    return;
  }

  res.status(201).json(GetProductResponse.parse(serialize(row)));
});

router.get("/products/:id", async (req, res): Promise<void> => {
  const params = GetProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const tenantId = getTenantId(req);

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const row = memoryStore.products.find(
      (p) => p.id === params.data.id && p.ownerId === tenantId,
    );
    if (!row) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(GetProductResponse.parse(serialize(row)));
    return;
  }

  const [row] = await db
    .select()
    .from(productsTable)
    .where(
      and(
        eq(productsTable.id, params.data.id),
        eq(productsTable.ownerId, tenantId),
      ),
    );

  if (!row) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(GetProductResponse.parse(serialize(row)));
});

router.patch("/products/:id", async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const tenantId = getTenantId(req);

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const row = memoryStore.products.find(
      (p) => p.id === params.data.id && p.ownerId === tenantId,
    );
    if (!row) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    if (parsed.data.name !== undefined) row.name = parsed.data.name;
    if (parsed.data.sku !== undefined) row.sku = parsed.data.sku ?? null;
    if (parsed.data.description !== undefined)
      row.description = parsed.data.description ?? null;
    if (parsed.data.priceCents !== undefined)
      row.priceCents = parsed.data.priceCents;
    if (parsed.data.stock !== undefined) row.stock = parsed.data.stock;
    if (parsed.data.category !== undefined)
      row.category = parsed.data.category ?? null;
    if (parsed.data.imageUrl !== undefined)
      row.imageUrl = parsed.data.imageUrl ?? null;
    row.updatedAt = new Date();
    res.json(UpdateProductResponse.parse(serialize(row)));
    return;
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) updates[k] = v;
  }

  if (Object.keys(updates).length === 0) {
    const [row] = await db
      .select()
      .from(productsTable)
      .where(
        and(
          eq(productsTable.id, params.data.id),
          eq(productsTable.ownerId, tenantId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(UpdateProductResponse.parse(serialize(row)));
    return;
  }

  const [row] = await db
    .update(productsTable)
    .set(updates)
    .where(
      and(
        eq(productsTable.id, params.data.id),
        eq(productsTable.ownerId, tenantId),
      ),
    )
    .returning();

  if (!row) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.json(UpdateProductResponse.parse(serialize(row)));
});

router.delete("/products/:id", async (req, res): Promise<void> => {
  const params = DeleteProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const tenantId = getTenantId(req);

  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    const idx = memoryStore.products.findIndex(
      (p) => p.id === params.data.id && p.ownerId === tenantId,
    );
    if (idx === -1) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    memoryStore.products.splice(idx, 1);
    res.sendStatus(204);
    return;
  }

  const [row] = await db
    .delete(productsTable)
    .where(
      and(
        eq(productsTable.id, params.data.id),
        eq(productsTable.ownerId, tenantId),
      ),
    )
    .returning();

  if (!row) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
