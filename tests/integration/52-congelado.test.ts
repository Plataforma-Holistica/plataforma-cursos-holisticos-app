import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";
import { createTestUser, deleteTestUsers, ownerQuery, type TestUser } from "./helpers/users";

// Lo que congela un periodo cerrado (T-602; RN-09) contra la base local, en lo que una transacción
// revertida no puede mostrar: el congelado toma candado compartido sobre la fila del periodo, así que
// el cierre (que la toma para sí) espera a una escritura en vuelo, y una escritura que llega mientras
// se cierra espera al cierre y lo ve cerrado. El cierre todavía no existe (llega con la segunda
// solicitud): aquí se simula con `for update` y el estado puesto con el guardián apagado. Se prueba
// con alertas del bote sin consumo, que no nombran a nadie, y con la parte de un cobro y marcar pares,
// que no tienen clave foránea al periodo (la clave también toma candado: solo ahí se ve el del
// guardián). Las demás tablas usan el mismo guardián (lo prueba `supabase/tests/42_congelado.test.sql`).
//
// Usa meses de 2034, que ninguna otra prueba usa. Al terminar quita lo suyo con los guardianes
// apagados; la auditoría se queda.

const IN_FLIGHT = 203401;
const WHILE_CLOSING = 203402;
const CHARGE_START = 203403;
const PART = 203404;
const MARKED = 203405;
const STEPPED = 203406;
const OURS = [IN_FLIGHT, WHILE_CLOSING, CHARGE_START, PART, MARKED, STEPPED];

let owner: Client;
let user: TestUser;
let subscription: string;

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  return client;
}

/** Espera a que `count` conexiones estén detenidas por la de `first`. */
async function waitBehind(first: Client, count: number): Promise<void> {
  const pid = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const rows = await owner.query<{ waiting: number }>(
      "select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))",
      [pid],
    );
    if ((rows.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("La otra conexión no llegó a esperar.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const insertAlert = (client: Client, period: number) =>
  client.query(
    `select set_config('app.actor_kind', 'system', true);
     insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value) values (${period}, 'unconsumed_pool_ratio', 1, 1)`,
  );

beforeAll(async () => {
  owner = await connect();
  const taken = await owner.query("select 1 from public.payout_periods where period_id = any($1::int[])", [OURS]);
  if ((taken.rowCount ?? 0) > 0) throw new Error("hay periodos de 2034 en la base local: pnpm db:reset");
  await owner.query("begin");
  await owner.query("select set_config('app.actor_kind', 'system', true)");
  for (const period of OURS) await owner.query("select private.open_period($1)", [period]);
  await owner.query("commit");
  user = await createTestUser();
  subscription = randomUUID();
  await ownerQuery(
    `insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
     values ($1, $2, 'manual', $3, 'monthly', 'pending', 'MXN')`,
    [subscription, user.id, `it-${subscription}`],
  );
});

afterAll(async () => {
  if (user) await deleteTestUsers([user]);
  await owner.query("begin");
  try {
    await owner.query("select set_config('app.actor_kind', 'system', true)");
    await owner.query("alter table public.anomaly_alerts disable trigger alerts_guard");
    await owner.query("alter table public.anomaly_alerts disable trigger anomaly_alerts_frozen");
    await owner.query("delete from public.anomaly_alerts where period_id = any($1::int[])", [OURS]);
    await owner.query("alter table public.anomaly_alerts enable trigger anomaly_alerts_frozen");
    await owner.query("alter table public.anomaly_alerts enable trigger alerts_guard");
    await owner.query("alter table public.payout_periods disable trigger payout_periods_guard");
    await owner.query("delete from public.payout_periods where period_id = any($1::int[])", [OURS]);
    await owner.query("alter table public.payout_periods enable trigger payout_periods_guard");
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
  const off = await owner.query<{ n: number }>(
    `select count(*)::int as n from pg_trigger
     where tgrelid in ('public.anomaly_alerts'::regclass, 'public.payout_periods'::regclass) and tgenabled = 'D'`,
  );
  expect(off.rows[0]?.n).toBe(0);
  await owner.end();
});

describe("lo congelado contra el cierre", () => {
  it("el cierre espera a una escritura en vuelo de su periodo (aquí ya basta la clave foránea)", async () => {
    const writer = await connect();
    const closer = await connect();
    try {
      await writer.query("begin");
      await insertAlert(writer, IN_FLIGHT);
      await closer.query("begin");
      let locked = false;
      const waiting = closer.query("select 1 from public.payout_periods where period_id = $1 for update", [IN_FLIGHT]).then(() => {
        locked = true;
      });
      await waitBehind(writer, 1);
      expect(locked).toBe(false);
      await writer.query("commit");
      await waiting;
      expect(locked).toBe(true);
      await closer.query("rollback");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await closer.query("rollback").catch(() => undefined);
      await Promise.all([writer, closer].map((client) => client.end()));
    }
  });

  it("una escritura que llega mientras se cierra espera y lo ve cerrado", async () => {
    const closer = await connect();
    const writer = await connect();
    try {
      await closer.query("begin");
      await closer.query("select set_config('app.actor_kind', 'system', true)");
      await closer.query("select 1 from public.payout_periods where period_id = $1 for update", [WHILE_CLOSING]);
      await closer.query("alter table public.payout_periods disable trigger payout_periods_guard");
      await closer.query("update public.payout_periods set status = 'closed', entered_closing_at = now() where period_id = $1", [WHILE_CLOSING]);
      await closer.query("alter table public.payout_periods enable trigger payout_periods_guard");
      await writer.query("begin");
      const attempt = insertAlert(writer, WHILE_CLOSING).then(
        () => "entró",
        (error: { code?: string }) => error.code,
      );
      await waitBehind(closer, 1);
      await closer.query("commit");
      expect(await attempt).toBe("55000");
      await writer.query("rollback");
      const alerts = await owner.query("select 1 from public.anomaly_alerts where period_id = $1", [WHILE_CLOSING]);
      expect(alerts.rowCount).toBe(0);
    } finally {
      await closer.query("rollback").catch(() => undefined);
      await writer.query("rollback").catch(() => undefined);
      await Promise.all([closer, writer].map((client) => client.end()));
    }
  });

  it("la parte de un cobro en un periodo, que no tiene clave a él, también detiene su cierre", async () => {
    const writer = await connect();
    const closer = await connect();
    try {
      await writer.query("begin");
      const charge = await writer.query<{ id: string }>(
        `insert into public.charges (profile_id, subscription_id, provider, provider_charge_id, plan, charged_at, period_id,
                                     allocation_start_period_id, currency, gross_cents, tax_cents, fx_rate_to_mxn, fx_source,
                                     gross_mxn_cents, net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents)
         values ($1, $2, 'manual', $3, 'monthly', '2034-03-15 12:00-06', $4, $4, 'MXN', 34900, 4814, 1, 'same_currency',
                 34900, 30086, 1600, 500, 28581)
         returning id`,
        [user.id, subscription, `it-${randomUUID()}`, CHARGE_START],
      );
      // La parte va a otro periodo, que la tabla de partes no nombra con clave: solo el guardián lo toma.
      await writer.query(
        `insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
         values ($1, $2, $3, 'charge', 1, 1, 28581, 500, 'late_charge_v1')`,
        [charge.rows[0]!.id, user.id, PART],
      );
      await closer.query("begin");
      let locked = false;
      const waiting = closer.query("select 1 from public.payout_periods where period_id = $1 for update", [PART]).then(() => {
        locked = true;
      });
      await waitBehind(writer, 1);
      expect(locked).toBe(false);
      // Se deshace: la parte no cuadra con el cobro, y la revisión al confirmar la rechazaría.
      await writer.query("rollback");
      await waiting;
      expect(locked).toBe(true);
      await closer.query("rollback");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await closer.query("rollback").catch(() => undefined);
      await Promise.all([writer, closer].map((client) => client.end()));
    }
  });

  it("marcar los pares de una cuenta en un periodo, aunque no haya ninguno, también detiene su cierre", async () => {
    const writer = await connect();
    const closer = await connect();
    try {
      await writer.query("begin");
      expect((await writer.query("select private.mark_pairs_for($1, $2, null, null) as n", [user.id, MARKED])).rows[0].n).toBe(0);
      await closer.query("begin");
      let locked = false;
      const waiting = closer.query("select 1 from public.payout_periods where period_id = $1 for update", [MARKED]).then(() => {
        locked = true;
      });
      await waitBehind(writer, 1);
      expect(locked).toBe(false);
      await writer.query("commit");
      await waiting;
      expect(locked).toBe(true);
      await closer.query("rollback");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await closer.query("rollback").catch(() => undefined);
      await Promise.all([writer, closer].map((client) => client.end()));
    }
  });

  it("un paso de la consolidación de un periodo también detiene su cierre", async () => {
    const writer = await connect();
    const closer = await connect();
    try {
      await writer.query("begin");
      const run = (await writer.query<{ id: string }>("select private.open_job_run('nightly_rollup', $1, 'dirty') as id", [STEPPED])).rows[0]!.id;
      expect((await writer.query("select private.rollup_step($1, now()) ->> 'read' as n", [run])).rows[0].n).toBe("0");
      await closer.query("begin");
      let locked = false;
      const waiting = closer.query("select 1 from public.payout_periods where period_id = $1 for update", [STEPPED]).then(() => {
        locked = true;
      });
      await waitBehind(writer, 1);
      expect(locked).toBe(false);
      await writer.query("rollback");
      await waiting;
      expect(locked).toBe(true);
      await closer.query("rollback");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await closer.query("rollback").catch(() => undefined);
      await Promise.all([writer, closer].map((client) => client.end()));
    }
  });
});
