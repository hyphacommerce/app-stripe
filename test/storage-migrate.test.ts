import assert from "node:assert/strict";
import { test } from "node:test";

import { sqliteDriver } from "../src/storage/sqlite.ts";
import { sqlStorage } from "../src/storage/sql.ts";

const V1_TABLE = `CREATE TABLE payments (
  installation_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, payment_id)
)`;

async function columns(db: ReturnType<typeof sqliteDriver>) {
  const rows = await db.all("PRAGMA table_info(payments)", []);
  return Object.fromEntries(rows.map((r) => [String(r.name), Number(r.notnull)]));
}

test("a payments table from payments.start v1 is rebuilt with its rows, once", async () => {
  const db = sqliteDriver(":memory:");
  await db.run(V1_TABLE, []);
  await db.run("INSERT INTO payments VALUES ('inst_1', 'pay_1', 'ord_1', 'pi_1', 5)", []);
  const storage = sqlStorage(db);
  await storage.migrate();
  assert.deepEqual(await columns(db), {
    installation_id: 1,
    payment_id: 1,
    cart_id: 0,
    order_id: 0,
    intent_id: 1,
    created_at: 1,
  });
  assert.deepEqual(await storage.paymentById("inst_1", "pay_1"), {
    installationId: "inst_1",
    paymentId: "pay_1",
    cartId: null,
    intentId: "pi_1",
    createdAt: 5,
  });
  await storage.putPayment({
    installationId: "inst_1",
    paymentId: "pay_2",
    cartId: "cart_2",
    intentId: "pi_2",
    createdAt: 6,
  });
  // Migrating again changes nothing.
  await storage.migrate();
  assert.equal((await storage.paymentByIntent("inst_1", "pi_2"))?.cartId, "cart_2");
  assert.equal(
    (await db.all("SELECT name FROM sqlite_master WHERE name = 'payments_v2'", [])).length,
    0,
  );
});

test("a rebuild that crashed after the copy, or after the drop, finishes on the next migrate", async () => {
  // After the copy: both tables exist, the old one still in place.
  const copied = sqliteDriver(":memory:");
  await copied.run(V1_TABLE, []);
  await copied.run("INSERT INTO payments VALUES ('inst_1', 'pay_1', 'ord_1', 'pi_1', 5)", []);
  await copied.run(
    `CREATE TABLE payments_v2 (installation_id TEXT NOT NULL, payment_id TEXT NOT NULL,
      cart_id TEXT, order_id TEXT, intent_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (installation_id, payment_id))`,
    [],
  );
  await copied.run(
    "INSERT INTO payments_v2 VALUES ('inst_1', 'pay_1', NULL, 'ord_1', 'pi_1', 5)",
    [],
  );
  const first = sqlStorage(copied);
  await first.migrate();
  assert.equal((await first.paymentById("inst_1", "pay_1"))?.intentId, "pi_1");
  assert.equal((await columns(copied)).cart_id, 0);

  // After the drop: only the copy is left, under its temporary name.
  const dropped = sqliteDriver(":memory:");
  await dropped.run(
    `CREATE TABLE payments_v2 (installation_id TEXT NOT NULL, payment_id TEXT NOT NULL,
      cart_id TEXT, order_id TEXT, intent_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (installation_id, payment_id))`,
    [],
  );
  await dropped.run(
    "INSERT INTO payments_v2 VALUES ('inst_1', 'pay_1', NULL, 'ord_1', 'pi_1', 5)",
    [],
  );
  const second = sqlStorage(dropped);
  await second.migrate();
  assert.equal((await second.paymentById("inst_1", "pay_1"))?.intentId, "pi_1");
  assert.equal(
    (await dropped.all("SELECT name FROM sqlite_master WHERE name = 'payments_v2'", [])).length,
    0,
  );
});
