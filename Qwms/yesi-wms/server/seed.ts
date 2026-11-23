/**
 * Demonstration dataset.
 *
 * Everything is created through the real services: native marketplace payloads
 * are stored, normalised and ingested; stock is ledger-backed; orders move
 * through the state machine; revenue posts through the ERP outbox. The seed is
 * the executable proof that the backbone works end to end.
 */
import { base32, passwordHash } from './auth.js';
import { config, SYSTEM_ACTOR } from './config.js';
import { audit, db, encrypt, maybeOne, one, pool, tx, uid, hash } from './db/index.js';
import { adapters } from './integrations/adapters.js';
import { processRawEvent, storeRawEvent, loadConnection, nativeEventIdentity } from './integrations/ingestion.js';
import { approveMapping } from './domain/mapping.js';
import { cancelOrder, markReadyToShip, reserveOrder } from './domain/orders.js';
import {
  applyTrackingUpdate,
  bookShipment,
  completeWave,
  createWave,
  dispatchShipment,
  pickTask,
} from './domain/fulfillment.js';
import { createAsn, receiveAsn, reconcileStock } from './domain/inventory.js';
import { processOnce } from './worker.js';

const ROLE_NAMES: Array<[string, string, string]> = [
  ['admin', 'admin@yesi.local', 'Ava Morgan'],
  ['supervisor', 'supervisor@yesi.local', 'Sam Rivera'],
  ['warehouse', 'warehouse@yesi.local', 'Wen Li'],
  ['finance', 'finance@yesi.local', 'Farah Haddad'],
  ['integration', 'integration@yesi.local', 'Ivan Petrov'],
  ['viewer', 'viewer@yesi.local', 'Vera Novak'],
];

const PRODUCTS: Array<[string, string, string, number, number]> = [
  ['ELC-4821', 'Aurora Wireless Earbuds Pro', 'Electronics', 129000, 128],
  ['ELC-2210', 'Nimbus 65W GaN Charger', 'Electronics', 89000, 240],
  ['ELC-3390', 'Pulse Fitness Band X2', 'Electronics', 149000, 126],
  ['ELC-1188', 'Lumen 4K Action Cam', 'Electronics', 499000, 42],
  ['ELC-5567', 'Orbit Bluetooth Speaker', 'Electronics', 199000, 96],
  ['APR-1177', 'Trailhead Merino Tee', 'Apparel', 75000, 320],
  ['APR-2245', 'Summit Fleece Hoodie', 'Apparel', 159000, 210],
  ['APR-3309', 'Drift Chino Pants', 'Apparel', 129000, 164],
  ['APR-4412', 'Cloudstep Crew Socks 3pk', 'Apparel', 29000, 480],
  ['APR-5523', 'Ridgeline Rain Shell', 'Apparel', 249000, 74],
  ['HML-2201', 'Terra Ceramic Mug Set', 'Home', 69000, 138],
  ['HML-3345', 'Glow Smart LED Strip 5m', 'Home', 59000, 190],
  ['HML-4478', 'Nook Linen Throw Blanket', 'Home', 119000, 88],
  ['HML-5590', 'Pure Mist Humidifier', 'Home', 139000, 64],
  ['HML-6612', 'Oakline Cutting Board', 'Home', 49000, 210],
  ['BTY-1120', 'Verdane Vitamin-C Serum', 'Beauty', 59000, 260],
  ['BTY-2233', 'Silkpath Hair Oil', 'Beauty', 49000, 180],
  ['BTY-3344', 'Mineral SPF 50 Fluid', 'Beauty', 69000, 320],
  ['BTY-4455', 'Rosewater Mist Toner', 'Beauty', 39000, 90],
  ['GRC-2211', 'Cold Brew Concentrate 6pk', 'Grocery', 79000, 140],
  ['GRC-3322', 'Wild Honey Reserve Jar', 'Grocery', 49000, 72],
  ['GRC-4433', 'Matcha Ceremonial Tin', 'Grocery', 89000, 40],
];

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Yesi!Demo2026';
const DEMO_SECRET = base32(Buffer.from('YESI-FULFILLMENT-DEMO-2026'));

async function drain(limit = 600): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (!(await processOnce())) return;
  }
}

function bin(index: number): string {
  // 24 unique bins: 4 zones x 3 aisles x 2 levels.
  const zone = ['A', 'B', 'C', 'D'][Math.floor(index / 6) % 4];
  const within = index % 6;
  const aisle = String(Math.floor(within / 2) + 1).padStart(2, '0');
  const level = String((within % 2) + 1).padStart(2, '0');
  return `${zone}-${aisle}-${level}`;
}

export async function seedDatabase(): Promise<{ seeded: boolean; summary?: unknown }> {
  if (!config.development) throw new Error('Seeding demo identities is forbidden in production');
  const existing = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users');
  if (Number(existing.n) > 0) return { seeded: false };

  // Machine identities referenced by the platform: ingestion/system automation,
  // the carrier gateway and the sandbox autopilot. They cannot sign in (random
  // password, MFA disabled) but they own the rows they create, so foreign keys
  // and the audit trail stay honest.
  const serviceUsers: Array<[string, string, string, string]> = [
    ['00000000-0000-0000-0000-000000000001', 'system@yesi.local', 'YESI Ingestion System', 'supervisor'],
    ['00000000-0000-0000-0000-000000000003', 'carrier-gateway@yesi.local', 'Carrier Gateway', 'integration'],
    ['00000000-0000-0000-0000-000000000004', 'autopilot@yesi.local', 'Sandbox Autopilot', 'supervisor'],
  ];
  for (const [id, email, name, role] of serviceUsers) {
    await tx(async (c) => {
      await c.query(
        `INSERT INTO users(id, email, name, role, password_hash, mfa_enabled, is_demo)
         VALUES($1,$2,$3,$4,$5,false,true)`,
        [id, email, name, role, passwordHash(`service-${uid()}-not-a-login`)],
      );
      await audit(
        c,
        { id, role: role as any, email, requestId: 'seed', type: 'system' },
        'identity.provisioned',
        'user',
        id,
        null,
        { role, service: true, demo: true },
      );
    });
  }

  const userIds: Record<string, string> = {};
  for (const [role, email, name] of ROLE_NAMES) {
    const id = uid();
    userIds[role] = id;
    await tx(async (c) => {
      await c.query(
        `INSERT INTO users(id, email, name, role, password_hash, totp_ciphertext, mfa_enabled, is_demo)
         VALUES($1,$2,$3,$4,$5,$6,true,true)`,
        [id, email, name, role, passwordHash(DEMO_PASSWORD), encrypt(DEMO_SECRET)],
      );
      await audit(
        c,
        { id, role: role as any, email, requestId: 'seed', type: 'system' },
        'identity.provisioned',
        'user',
        id,
        null,
        { role, demo: true },
      );
    });
  }
  const admin = { ...SYSTEM_ACTOR, id: userIds.admin, role: 'admin' as const, email: 'admin@yesi.local', requestId: 'seed' };

  for (let index = 0; index < 24; index++) {
    const code = bin(index);
    await tx((c) =>
      c.query('INSERT INTO locations(code, zone, kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        code,
        code[0],
        'RACK',
      ]),
    );
  }

  for (let index = 0; index < PRODUCTS.length; index++) {
    const [sku, name, category, cost] = PRODUCTS[index];
    await tx((c) =>
      c.query('INSERT INTO products(sku, name, category, cost_minor, barcode) VALUES($1,$2,$3,$4,$5)', [
        sku,
        name,
        category,
        cost,
        '46' + String(index).padStart(11, '0'),
      ]),
    );
  }

  const connectionIds: Record<string, string> = {};
  const connectionSecrets: Record<string, string> = {};
  for (const provider of ['ozon', 'yandex', 'wildberries'] as const) {
    const id = uid();
    const secret = `demo-${provider}-webhook-secret-${hashString(provider)}-not-production`;
    connectionIds[provider] = id;
    connectionSecrets[provider] = secret;
    await tx((c) =>
      c.query(
        `INSERT INTO connections(id, provider, name, account_ref, mode, credentials_ciphertext,
           webhook_secret_ciphertext, webhook_scheme, config)
         VALUES($1,$2,$3,$4,'sandbox',$5,$6,'yesi-hmac-v1',$7)`,
        [
          id,
          provider,
          provider === 'ozon' ? 'Ozon · YESI Demo Store' : provider === 'yandex' ? 'Yandex Market · YESI Demo' : 'Wildberries · YESI Demo',
          `demo-${provider}`,
          encrypt(JSON.stringify({ apiKey: 'sandbox-key-not-a-credential', clientId: 'sandbox-client', businessId: 'sandbox-business', warehouseId: '507' })),
          encrypt(secret),
          JSON.stringify({ warehouse: 'DC-EAST-02', timezone: 'Europe/Moscow' }),
        ],
      ),
    );
  }

  for (let index = 0; index < PRODUCTS.length; index++) {
    const [sku] = PRODUCTS[index];
    for (const provider of ['ozon', 'yandex', 'wildberries'] as const) {
      const prefix = provider === 'ozon' ? 'OZ' : provider === 'yandex' ? 'YM' : 'WB';
      const externalSku = provider === 'wildberries' ? String(5_500_000 + index) : `${prefix}-${sku}`;
      await tx((c) =>
        c.query(
          `INSERT INTO sku_mappings(id, connection_id, external_sku, external_name, sku, status, approved_by)
           VALUES($1,$2,$3,$4,$5,'APPROVED',$6)`,
          [uid(), connectionIds[provider], externalSku, PRODUCTS[index][1], sku, userIds.supervisor],
        ),
      );
    }
  }
  // The Wildberries sample fixture uses this barcode for the speaker.
  await tx((c) =>
    c.query(
      `INSERT INTO sku_mappings(id, connection_id, external_sku, external_name, sku, status, approved_by)
       VALUES($1,$2,'5500001','Orbit Bluetooth Speaker','ELC-5567','APPROVED',$3) ON CONFLICT DO NOTHING`,
      [uid(), connectionIds.wildberries, userIds.supervisor],
    ),
  );

  for (let index = 0; index < PRODUCTS.length; index++) {
    const [sku, , , , opening] = PRODUCTS[index];
    const location = bin(index);
    await tx(async (c) => {
      const { stockMove } = await import('./db/index.js');
      await stockMove(c, admin, {
        sku,
        location,
        onHand: opening,
        reason: 'OPENING_BALANCE',
        reference: 'seed',
        requestKey: `OPENING:${sku}:${location}`,
      });
    });
  }

  // Two inbound ASNs: one fully received, one partially received at the dock.
  const asnOne = await createAsn(admin, {
    supplier: 'Aurora Electronics Ltd',
    reference: 'PO-88421',
    lines: [
      { sku: 'ELC-1188', location: 'A-01-01', expected: 60 },
      { sku: 'ELC-2210', location: 'A-02-02', expected: 120 },
    ],
  });
  await receiveAsn(admin, asnOne.id, {
    lines: [
      { sku: 'ELC-1188', location: 'A-01-01', quantity: 60 },
      { sku: 'ELC-2210', location: 'A-02-02', quantity: 120 },
    ],
  });
  const asnTwo = await createAsn(admin, {
    supplier: 'Trailhead Apparel Co',
    reference: 'PO-88422',
    expectedAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    lines: [{ sku: 'APR-2245', location: 'B-02-01', expected: 240 }],
  });
  await receiveAsn(admin, asnTwo.id, { lines: [{ sku: 'APR-2245', location: 'B-02-01', quantity: 90 }] });

  // Ingest native marketplace payloads through the real pipeline.
  const providers = ['ozon', 'yandex', 'wildberries'] as const;
  const created: Array<{ id: string; provider: string }> = [];
  for (let index = 0; index < 18; index++) {
    const provider = providers[index % 3];
    const connection = await tx((c) => loadConnection(c, connectionIds[provider]));
    const scenario = index < 3 ? 'unmapped' : index % 5 === 0 ? 'multi_line' : 'normal';
    const seed = 200 + index;
    const externalId =
      provider === 'wildberries'
        ? String(7_700_000 + seed)
        : `${provider === 'ozon' ? 'OZ' : 'YM'}-SIM-${String(seed).padStart(6, '0')}`;
    const payload = adapters[provider].sample(scenario as any, seed, externalId);
    const stored = await storeRawEvent({
      connection,
      payload,
      eventType: 'order',
      externalEventId: nativeEventIdentity(provider, payload),
      headers: { 'x-yesi-source': 'seed' },
      signatureVerified: true,
    });
    created.push({ id: stored.raw_event_id, provider });
  }
  for (const raw of created) await processRawEvent(raw.id);
  await drain();

  const statuses = async () =>
    (await db.query(`SELECT id, external_id, status, version FROM orders ORDER BY created_at`)).rows as any[];

  const all = await statuses();
  const mapped = all.filter((order) => order.status === 'MAPPED');
  for (const order of mapped.slice(0, 8)) {
    try {
      await reserveOrder(admin, order.id, Number(order.version));
    } catch (error) {
      console.log(JSON.stringify({ level: 'warn', component: 'seed', step: 'reserve', message: (error as Error).message }));
    }
  }
  const reserved = (await statuses()).filter((order) => order.status === 'RESERVED').slice(0, 4);
  if (reserved.length >= 2) {
    const versions = Object.fromEntries(reserved.map((order) => [order.id, Number(order.version)]));
    const wave = await createWave(admin, reserved.map((order) => order.id), versions);
    const tasks = (await db.query('SELECT * FROM pick_tasks WHERE wave_id=$1', [wave.id])).rows as any[];
    for (const task of tasks) await pickTask(admin, task.id, Number(task.quantity));
    await completeWave(admin, wave.id);
  }
  const packed = (await statuses()).filter((order) => order.status === 'PACKED').slice(0, 3);
  for (const order of packed) await markReadyToShip(admin, order.id, Number(order.version));
  await drain();
  const ready = (await statuses()).filter((order) => order.status === 'READY_TO_SHIP').slice(0, 2);
  for (const order of ready) await bookShipment(admin, order.id, Number(order.version), 'YESI Ground', 'STANDARD');
  await drain();
  for (const order of ready) {
    const shipment = await maybeOne<any>(db, 'SELECT * FROM shipments WHERE order_id=$1', [order.id]);
    if (shipment?.status === 'BOOKED') await dispatchShipment(admin, shipment.id, Number(shipment.version));
  }
  await drain();
  for (const order of ready.slice(0, 2)) {
    const shipment = await maybeOne<any>(db, 'SELECT * FROM shipments WHERE order_id=$1', [order.id]);
    if (!shipment) continue;
    await applyTrackingUpdate({
      shipmentId: shipment.id,
      status: 'IN_TRANSIT',
      externalEventId: `seed:${shipment.id}:IN_TRANSIT`,
      message: 'Departed Moscow sorting hub',
      payload: { carrier: shipment.carrier, seed: true },
      source: 'TMS',
    });
  }
  const firstShipment = await maybeOne<any>(db, `SELECT * FROM shipments WHERE status='IN_TRANSIT' ORDER BY created_at LIMIT 1`);
  if (firstShipment) {
    await applyTrackingUpdate({
      shipmentId: firstShipment.id,
      status: 'DELIVERED',
      externalEventId: `seed:${firstShipment.id}:DELIVERED`,
      message: 'Delivered to customer',
      payload: { carrier: firstShipment.carrier, seed: true },
      source: 'TMS',
    });
  }
  const cancellable = (await statuses()).find((order) => order.status === 'MAPPED' && !mapped.slice(0, 8).some((o) => o.id === order.id));
  if (cancellable) await cancelOrder(admin, cancellable.id, Number(cancellable.version), 'Customer cancelled before picking');

  // A cycle count with a variance, waiting for supervisor approval.
  const countTarget = await maybeOne<any>(db, `SELECT * FROM inventory WHERE sku='HML-6612'`);
  if (countTarget) {
    await reconcileStock(admin, {
      sku: countTarget.sku,
      location: countTarget.location,
      counted: Number(countTarget.on_hand) - 3,
      expectedVersion: Number(countTarget.version),
    });
  }

  await drain();

  // Spread order timestamps so throughput charts have a realistic shape.
  const ids = all.map((order) => order.id);
  await tx(async (c) => {
    for (const [index, id] of ids.entries()) {
      await c.query(`UPDATE orders SET created_at = now() - ($2 || ' minutes')::interval WHERE id=$1`, [
        id,
        String((ids.length - index) * 11),
      ]);
    }
  });

  await tx((c) =>
    audit(c, admin, 'platform.seeded', 'platform', 'demo', null, {
      users: ROLE_NAMES.length,
      products: PRODUCTS.length,
      connections: 3,
      orders: all.length,
    }),
  );

  const summary = {
    users: ROLE_NAMES.map(([role, email]) => ({ role, email })),
    password: DEMO_PASSWORD,
    totp_secret: DEMO_SECRET,
    connections: Object.entries(connectionIds).map(([provider, id]) => ({ provider, id, secret: connectionSecrets[provider] })),
    orders: all.length,
  };
  console.log(JSON.stringify({ level: 'info', component: 'seed', message: 'Demo data seeded', ...summary }, null, 2));
  return { seeded: true, summary };
}

function hashString(value: string): string {
  return hash(value).slice(0, 12);
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  const result = await seedDatabase();
  if (!result.seeded) console.log('Seed skipped: database already contains users.');
  await db.end();
}
