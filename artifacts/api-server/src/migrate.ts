import { pool, isDatabaseConnected } from "@workspace/db";
import { logger } from "./lib/logger";
import { memoryStore } from "./lib/memoryStore";
import bcrypt from "bcryptjs";

const DDL = `
CREATE TABLE IF NOT EXISTS "users" (
  "id"            serial PRIMARY KEY,
  "username"      text   NOT NULL,
  "email"         text   UNIQUE,
  "owner_id"      integer,
  "password_hash" text   NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text UNIQUE;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "owner_id" integer;
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_username_key";

CREATE TABLE IF NOT EXISTS "settings" (
  "id"            integer PRIMARY KEY NOT NULL,
  "business_name" text    NOT NULL DEFAULT 'SmartBuy',
  "logo_url"      text,
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "products" (
  "id"          serial  PRIMARY KEY,
  "owner_id"    integer NOT NULL DEFAULT 1,
  "name"        text    NOT NULL,
  "sku"         text,
  "description" text,
  "price_cents" integer NOT NULL,
  "stock"       integer NOT NULL DEFAULT 0,
  "category"    text,
  "image_url"   text,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "owner_id" integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS "orders" (
  "id"             serial  PRIMARY KEY,
  "owner_id"       integer NOT NULL DEFAULT 1,
  "reference"      text    NOT NULL UNIQUE,
  "status"         text    NOT NULL DEFAULT 'pending',
  "total_cents"    integer NOT NULL,
  "customer_phone" text,
  "customer_name"  text,
  "cashier_name"   text,
  "payment_method" text    NOT NULL DEFAULT 'mpesa',
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "owner_id" integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS "order_items" (
  "id"              serial  PRIMARY KEY,
  "order_id"        integer NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "product_id"      integer NOT NULL REFERENCES "products"("id"),
  "product_name"    text    NOT NULL,
  "quantity"        integer NOT NULL,
  "unit_price_cents" integer NOT NULL,
  "line_total_cents" integer NOT NULL
);

CREATE TABLE IF NOT EXISTS "transactions" (
  "id"                        serial  PRIMARY KEY,
  "owner_id"                  integer NOT NULL DEFAULT 1,
  "order_id"                  integer REFERENCES "orders"("id") ON DELETE SET NULL,
  "amount_cents"              integer NOT NULL,
  "provider"                  text    NOT NULL DEFAULT 'mpesa',
  "status"                    text    NOT NULL DEFAULT 'pending',
  "mpesa_checkout_request_id" text,
  "mpesa_merchant_request_id" text,
  "mpesa_receipt_number"      text,
  "phone_number"              text,
  "raw_callback"              text,
  "created_at"                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "owner_id" integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS "password_reset_codes" (
  "id"         serial      PRIMARY KEY,
  "user_id"    integer     NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "email"      text        NOT NULL,
  "code_hash"  text        NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at"    timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid"    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   json    NOT NULL,
  "expire" timestamp(6) NOT NULL
) WITH (OIDS=FALSE);

CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
`;

export async function runMigrations(): Promise<void> {
  if (!isDatabaseConnected) {
    memoryStore.ensureSeeded();
    logger.info("DATABASE_URL not set — initialized in-memory store");
    return;
  }

  logger.info("Running database migrations…");
  const client = await pool.connect();
  try {
    await client.query(DDL);

    await client.query(
      `INSERT INTO settings (id, business_name) VALUES (1, 'SmartBuy') ON CONFLICT (id) DO NOTHING`,
    );

    const { rows } = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users",
    );
    const count = parseInt(rows[0]?.count ?? "0", 10);
    if (count === 0) {
      const hash = await bcrypt.hash("admin", 10);
      await client.query(
        `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING`,
        ["admin", "admin@smartbuy.co.ke", hash],
      );
      logger.info(
        "Seeded default admin user — email: admin@smartbuy.co.ke, password: admin. Change it from Settings.",
      );
    } else {
      await client.query(
        `UPDATE users SET email = $1 WHERE username = 'admin' AND email IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1))`,
        ["admin@smartbuy.co.ke"],
      );
    }

    logger.info("Migrations complete");
  } finally {
    client.release();
  }
}
