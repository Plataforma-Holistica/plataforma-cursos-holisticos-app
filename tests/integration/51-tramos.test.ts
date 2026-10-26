import { randomUUID } from "node:crypto";

import fc from "fast-check";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAccountAccess } from "@/domain/access/account-access";

import { localOwnerUrl } from "./helpers/local";

// Los tramos del bote (T-601; RN-13, RF-707) contra la base local, en lo que una transacción revertida
// de pgTAP no puede mostrar o no compara con nada escrito aparte:
//   · el porcentaje marginal contra un oráculo en TypeScript, con juegos y alumnos al azar;
//   · los alumnos activos de un instante contra la regla de acceso (`resolveAccountAccess`), con
//     cuentas y suscripciones al azar: el oráculo evalúa cada suscripción por separado y cuenta la
//     cuenta si alguna le daba acceso por pago o por gracia;
//   · dos que escriben un juego a la vez: la segunda espera el candado de la primera;
//   · RF-707 al confirmar, con la conexión de verdad del servidor.
// Qué hace cada regla lo prueba `supabase/tests/41_tramos.test.sql`. Nada se confirma: todo se
// revierte, o lo rechaza la base al confirmar.

let owner: Client;

async function connect(url = localOwnerUrl()): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  owner = await connect();
});

afterAll(async () => {
  await owner.end();
});

/** Espera a que `count` conexiones estén detenidas por la de `first`. */
async function waitBehind(first: Client, count: number): Promise<void> {
  const pid = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const rows = await owner.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where wait_event_type in ('Lock', 'Advisory') and $1::int = any(pg_blocking_pids(pid))`,
      [pid],
    );
    if ((rows.rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("La otra conexión no llegó a esperar.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------------------
// Los tramos marginales.

interface Tiers {
  thresholds: number[];
  bps: number[];
}

/** RN-13: el alumno número u va al tramo de mayor umbral que no pasa de u; el promedio, hacia abajo. */
function marginal(tiers: Tiers, students: number): number {
  if (students === 0) return tiers.bps[0]!;
  let sum = 0n;
  for (let student = 1; student <= Math.min(students, 5_000); student++) {
    let tier = 0;
    while (tier + 1 < tiers.thresholds.length && tiers.thresholds[tier + 1]! <= student) tier++;
    sum += BigInt(tiers.bps[tier]!);
  }
  // Más allá de 5 000 alumnos, todos caen en el último tramo (los umbrales del generador no pasan de ahí).
  if (students > 5_000) sum += BigInt(students - 5_000) * BigInt(tiers.bps.at(-1)!);
  return Number(sum / BigInt(students));
}

const tiersArbitrary: fc.Arbitrary<Tiers> = fc
  .uniqueArray(fc.integer({ min: 1, max: 4_000 }), { maxLength: 5 })
  .chain((rest) => {
    const thresholds = [0, ...rest.sort((a, b) => a - b)];
    return fc
      .array(fc.integer({ min: 1, max: 10_000 }), { minLength: thresholds.length, maxLength: thresholds.length })
      .map((bps) => ({ thresholds, bps: bps.sort((a, b) => a - b) }));
  });

describe("los tramos marginales", () => {
  it("dan lo mismo que el oráculo, con juegos y alumnos al azar", async () => {
    await fc.assert(
      fc.asyncProperty(tiersArbitrary, fc.oneof(fc.integer({ min: 0, max: 6_000 }), fc.integer({ min: 0, max: 2_000_000 })), async (tiers, students) => {
        const result = await owner.query<{ bps: number }>("select private.marginal_pool_bps($1, $2, $3) as bps", [
          tiers.thresholds,
          tiers.bps,
          students,
        ]);
        expect(result.rows[0]!.bps).toBe(marginal(tiers, students));
      }),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------------------
// Los alumnos activos.

const BASE = Date.parse("2035-06-15T12:00:00Z");
const HOUR = 3_600_000;
type Status = "pending" | "active" | "in_grace" | "canceled" | "expired" | "refunded";

interface Subscription {
  status: Status;
  created: number;
  paidThrough: number | null;
  failed: number | null;
  ended: number | null;
}

interface Account {
  suspended: boolean;
  fraud: boolean;
  subscriptions: Subscription[];
}

const at = (hours: number) => BASE + hours * HOUR;
const hours = fc.integer({ min: -400, max: 400 });

const subscriptionArbitrary: fc.Arbitrary<Subscription> = fc
  .record({
    status: fc.constantFrom<Status>("pending", "active", "in_grace", "canceled", "expired", "refunded"),
    created: hours,
    paidThrough: hours,
    failed: fc.option(hours, { nil: null }),
    ended: fc.option(hours, { nil: null }),
  })
  .map((s) => ({
    status: s.status,
    created: at(s.created - 500),
    // La base exige el fin pagado salvo a una pendiente (que puede traerlo o no), y la falla a una en gracia.
    paidThrough: s.status === "pending" && s.created % 2 === 0 ? null : at(s.paidThrough),
    failed: s.status === "in_grace" ? at(s.failed ?? s.paidThrough) : s.failed === null ? null : at(s.failed),
    ended: s.ended === null ? null : at(s.ended),
  }));

const accountArbitrary: fc.Arbitrary<Account> = fc
  .record({
    suspended: fc.boolean(),
    fraud: fc.boolean(),
    subscriptions: fc.array(subscriptionArbitrary, { minLength: 1, maxLength: 3 }),
  })
  // Una cuenta tiene a lo más una viva (`active` o `in_grace`).
  .map((account) => ({
    ...account,
    subscriptions: account.subscriptions.map((s, i) =>
      i > 0 && (s.status === "active" || s.status === "in_grace") ? { ...s, status: "expired" as const } : s,
    ),
  }));

/** La regla de acceso, suscripción por suscripción: cuenta si alguna le daba acceso por pago o por gracia. */
function counts(account: Account, instant: number, graceDays: number): boolean {
  if (account.suspended || account.fraud) return false;
  return account.subscriptions.some((s) => {
    if (s.status === "pending" || s.created > instant) return false;
    const access = resolveAccountAccess(
      {
        suspended: false,
        paidThrough: s.paidThrough === null ? null : new Date(s.paidThrough),
        lastRenewalFailedAt: s.failed === null ? null : new Date(s.failed),
        endedAt: s.ended === null ? null : new Date(s.ended),
        refunded: s.status === "refunded",
        courtesy: [],
      },
      new Date(instant),
      { graceDays },
    );
    return access.allowed && (access.basis === "subscription" || access.basis === "grace");
  });
}

describe("los alumnos activos", () => {
  it("son las cuentas a las que la regla de acceso les daba acceso, con cuentas al azar", async () => {
    const grace = await owner.query<{ days: number }>(
      "select (private.parameter_value('GRACIA_COBRO_DIAS', $1::timestamptz) #>> '{}')::int as days",
      [new Date(BASE).toISOString()],
    );
    const graceDays = grace.rows[0]!.days;
    await fc.assert(
      fc.asyncProperty(fc.array(accountArbitrary, { minLength: 1, maxLength: 8 }), fc.array(hours, { minLength: 1, maxLength: 4 }), async (accounts, instants) => {
        const moments = instants.map(at);
        await owner.query("begin");
        try {
          const before = await owner.query<{ n: number }>(
            "select private.active_students_at(t) as n from unnest($1::timestamptz[]) with ordinality u (t, o) order by o",
            [moments.map((m) => new Date(m).toISOString())],
          );
          await owner.query("select set_config('app.actor_kind', 'system', true)");
          for (const account of accounts) {
            const id = randomUUID();
            await owner.query("insert into auth.users (id, email) values ($1, $2)", [id, `it-tramos-${id}@prueba.test`]);
            await owner.query(
              `update public.profiles set suspended_for_fraud = $3,
                 status = $2::public.profile_status,
                 suspended_at = case when $2 = 'suspended' then now() end,
                 suspension_reason = case when $2 = 'suspended' then 'prueba' end
               where id = $1`,
              [id, account.suspended ? "suspended" : "active", account.fraud],
            );
            for (const s of account.subscriptions) {
              await owner.query(
                `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency,
                   current_period_start, current_period_end, last_renewal_failed_at, ended_at, created_at)
                 values ($1, 'manual', $2, 'monthly', $3, 'MXN', $4::timestamptz - interval '30 days', $4, $5, $6, $7)`,
                [
                  id,
                  `it-tramos-${randomUUID()}`,
                  s.status,
                  s.paidThrough === null ? null : new Date(s.paidThrough).toISOString(),
                  s.failed === null ? null : new Date(s.failed).toISOString(),
                  s.ended === null ? null : new Date(s.ended).toISOString(),
                  new Date(s.created).toISOString(),
                ],
              );
            }
          }
          const after = await owner.query<{ n: number }>(
            "select private.active_students_at(t) as n from unnest($1::timestamptz[]) with ordinality u (t, o) order by o",
            [moments.map((m) => new Date(m).toISOString())],
          );
          moments.forEach((moment, i) => {
            const expected = accounts.filter((account) => counts(account, moment, graceDays)).length;
            expect(after.rows[i]!.n - before.rows[i]!.n).toBe(expected);
          });
        } finally {
          await owner.query("rollback");
        }
      }),
      { numRuns: 120 },
    );
  });
});

// ---------------------------------------------------------------------------------------
// Dos juegos a la vez, y fuera de read committed.

describe("escribir un juego", () => {
  it("dos a la vez, aunque sean de otro periodo: la segunda espera el candado de la primera, que revierte, y nada queda", async () => {
    const first = await connect();
    const second = await connect();
    const period = 204011;
    const other = 204012;
    try {
      await first.query("begin");
      await first.query("select set_config('app.actor_kind', 'system', true)");
      await first.query("select private.set_pool_tiers($1, '{0,10}', '{6000,6500}')", [period]);
      await second.query("begin");
      await second.query("select set_config('app.actor_kind', 'system', true)");
      let done = false;
      const waiting = second.query("select private.set_pool_tiers($1, '{0}', '{6100}')", [other]).then(() => {
        done = true;
      });
      await waitBehind(first, 1);
      expect(done).toBe(false);
      await first.query("rollback");
      await waiting;
      const seen = await second.query<{ tiers: string[] }>(
        `select array(select min_active_students || ':' || pool_bps from public.pool_tiers
                      where effective_period_id = $1 and canceled_at is null order by 1) as tiers`,
        [other],
      );
      expect(seen.rows[0]!.tiers).toEqual(["0:6100"]);
      await second.query("rollback");
      const left = await owner.query("select 1 from public.pool_tiers where effective_period_id in ($1, $2)", [period, other]);
      expect(left.rowCount).toBe(0);
      const audit = await owner.query(
        "select 1 from public.audit_log where entity_table = 'public.pool_tiers' and new_value ->> 'effective_period_id' in ($1, $2)",
        [String(period), String(other)],
      );
      expect(audit.rowCount).toBe(0);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      await Promise.all([first, second].map((client) => client.end()));
    }
  });

  it("fuera de read committed se niega: no vería el juego de la otra", async () => {
    const client = await connect();
    try {
      await client.query("begin isolation level repeatable read");
      await client.query("select set_config('app.actor_kind', 'system', true)");
      await expect(client.query("select private.set_pool_tiers(204101, '{0}', '{6000}')")).rejects.toMatchObject({ code: "25000" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------------------
// RF-707 al confirmar, con la conexión del servidor (como el sistema, que no da código).

describe("RF-707 por instante, con la conexión del servidor", () => {
  let server: Client;

  beforeAll(async () => {
    server = await connect(process.env.DATABASE_URL);
  });

  afterAll(async () => {
    await server.end();
  });

  async function asSystem(work: () => Promise<unknown>): Promise<void> {
    await server.query("begin");
    await server.query("select set_config('app.actor_kind', 'system', true)");
    await work();
  }

  it("un parámetro del reparto en un periodo que ya empezó se rechaza al confirmar, y no queda", async () => {
    const key = "UMBRAL_MEDIO_PCT";
    try {
      await asSystem(() =>
        server.query(
          `insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
           values ($1, '2600', 'decided', '2025-09-01 06:00Z', 202509)`,
          [key],
        ),
      );
      await expect(server.query("commit")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await server.query("rollback").catch(() => undefined);
    }
    const left = await owner.query("select 1 from public.business_parameters where key = $1 and effective_period_id = 202509", [key]);
    expect(left.rowCount).toBe(0);
  });

  it("uno que no es del reparto, hacia atrás, también", async () => {
    try {
      await asSystem(() =>
        server.query(`insert into public.business_parameters (key, value, status, effective_from)
                      values ('VENTANA_REEMBOLSO_DIAS', '8', 'proposed', now() - interval '1 minute')`),
      );
      await expect(server.query("commit")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await server.query("rollback").catch(() => undefined);
    }
  });

  it("la gracia es del reparto: el servidor no la programa a medio mes, y desde el inicio de un periodo sí", async () => {
    const next = await owner.query("select private.period_of(now() + interval '1 day') as period");
    try {
      await asSystem(() =>
        server.query(
          `insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
           values ('GRACIA_COBRO_DIAS', '8', 'proposed', now() + interval '1 day', $1)`,
          [next.rows[0].period],
        ),
      );
      await expect(server.query("commit")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await server.query("rollback").catch(() => undefined);
    }
    const left = await owner.query(
      "select 1 from public.business_parameters where key = 'GRACIA_COBRO_DIAS' and value = '8'",
    );
    expect(left.rowCount).toBe(0);
    try {
      await asSystem(async () => {
        await server.query("set constraints business_parameters_timing immediate");
        await server.query(
          `insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
           values ('GRACIA_COBRO_DIAS', '8', 'proposed', private.period_start(204001), 204001)`,
        );
      });
    } finally {
      await server.query("rollback");
    }
  });

  it("uno del reparto desde el inicio de un periodo que no ha empezado pasa la revisión, con lo que el servidor puede preguntar", async () => {
    try {
      await asSystem(async () => {
        await server.query("set constraints business_parameters_timing immediate");
        await server.query(
          `insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
           values ('UMBRAL_MEDIO_PCT', '2600', 'decided', private.period_start(204001), 204001)`,
        );
      });
    } finally {
      await server.query("rollback");
    }
  });

  it("el porcentaje base no lo escribe el servidor: es el tramo de 0", async () => {
    try {
      await asSystem(() => Promise.resolve());
      await expect(
        server.query(
          `insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
           values ('BOTE_PCT_BASE', '6100', 'decided', private.period_start(204001), 204001)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await server.query("rollback");
    }
  });
});
