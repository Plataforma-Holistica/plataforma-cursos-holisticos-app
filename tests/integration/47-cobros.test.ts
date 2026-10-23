import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";
import { createTestUser, deleteTestUsers, ownerQuery, type TestUser } from "./helpers/users";

// El mismo cobro registrado a la vez desde varias conexiones (T-301; RF-211, RN-02), contra la
// base local. Qué escribe `private.record_charge()` lo prueba `supabase/tests/31_libro_de_ingresos`,
// que se revierte; aquí se mira lo que una transacción revertida no puede: que la segunda llamada
// espere a la primera y vea su cobro ya confirmado. Nadie de la aplicación llama la función
// todavía (la abre T-303), así que se llama como el dueño de la base. Los cobros son un libro: la
// limpieza de `deleteTestUsers` los borra con sus guardias apagadas, solo para las cuentas de prueba.

const CALLERS = 9;
let user: TestUser;
let subscription: string;

beforeAll(async () => {
  user = await createTestUser();
  subscription = randomUUID();
  await ownerQuery(
    `insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
     values ($1, $2, 'manual', $3, 'annual', 'pending', 'MXN')`,
    [subscription, user.id, `it-${subscription}`],
  );
});

afterAll(async () => {
  if (user) await deleteTestUsers([user]);
  const guards = await ownerQuery<{ off: number }>(
    `select count(*)::int as off from pg_trigger
     where tgrelid in ('public.charges'::regclass, 'public.revenue_allocations'::regclass)
       and tgname like 'ledger_no_%' and tgenabled = 'D'`,
  );
  expect(guards[0]?.off).toBe(0);
});

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  return client;
}

function record(client: Client, chargeId: string, gross = 299000) {
  return client
    .query<{ answer: { outcome: string; charge_id: string | null } }>(
      `select private.record_charge($1, $2, 'manual', $3, null, 'annual', '2026-10-10 12:00-06', 'MXN', $4,
                                    null, null, null, null, null) as answer`,
      [user.id, subscription, chargeId, gross],
    )
    .then((result) => result.rows[0]!.answer);
}

/**
 * Espera a que las otras conexiones estén detenidas por la primera, que tiene el cobro sin
 * confirmar. Sin esto, que choquen depende de la suerte.
 */
async function waitBehind(first: Client, count: number): Promise<void> {
  const pid = (await first.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  const deadline = Date.now() + 4_000;
  for (;;) {
    const rows = await ownerQuery<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))`,
      [pid],
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error("Las llamadas no llegaron a esperar al primer cobro.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function counts(chargeId: string) {
  const rows = await ownerQuery<{ charges: number; parts: number; total: string | null; net: string | null }>(
    `select count(distinct c.id)::int as charges, count(a.id)::int as parts, sum(a.base_cents)::text as total,
            max(c.revenue_net_mxn_cents)::text as net
     from public.charges c left join public.revenue_allocations a on a.charge_id = c.id
     where c.provider = 'manual' and c.provider_charge_id = $1`,
    [chargeId],
  );
  return rows[0]!;
}

describe("el mismo cobro a la vez", () => {
  it("diez llamadas a la vez dejan un cobro con sus doce partes, y las otras nueve lo reconocen", async () => {
    const chargeId = `it-${randomUUID()}`;
    const first = await connect();
    const others = await Promise.all(Array.from({ length: CALLERS }, connect));
    try {
      await first.query("begin");
      const recorded = await record(first, chargeId);
      expect(recorded.outcome).toBe("recorded");
      const waiting = Promise.all(others.map((client) => record(client, chargeId)));
      await waitBehind(first, CALLERS);
      await first.query("commit");
      const answers = await waiting;
      expect(answers.map((answer) => answer.outcome)).toEqual(Array(CALLERS).fill("already_recorded"));
      expect(new Set(answers.map((answer) => answer.charge_id))).toEqual(new Set([recorded.charge_id]));
      expect(await counts(chargeId)).toEqual({ charges: 1, parts: 12, total: "244871", net: "244871" });
    } finally {
      await first.query("rollback").catch(() => undefined);
      await Promise.all([first, ...others].map((client) => client.end()));
    }
  });

  it("si la primera se deshace, una de las que esperaban lo registra y las demás ven ese", async () => {
    const chargeId = `it-${randomUUID()}`;
    const first = await connect();
    const others = await Promise.all(Array.from({ length: CALLERS }, connect));
    try {
      await first.query("begin");
      expect((await record(first, chargeId)).outcome).toBe("recorded");
      const waiting = Promise.all(others.map((client) => record(client, chargeId)));
      await waitBehind(first, CALLERS);
      await first.query("rollback");
      const answers = await waiting;
      const recorded = answers.filter((answer) => answer.outcome === "recorded");
      expect(recorded).toHaveLength(1);
      expect(answers.filter((answer) => answer.outcome === "already_recorded")).toHaveLength(CALLERS - 1);
      expect(new Set(answers.map((answer) => answer.charge_id))).toEqual(new Set([recorded[0]!.charge_id]));
      expect(await counts(chargeId)).toEqual({ charges: 1, parts: 12, total: "244871", net: "244871" });
    } finally {
      await Promise.all([first, ...others].map((client) => client.end()));
    }
  });

  it("con otro monto mientras espera, es un conflicto y no escribe", async () => {
    const chargeId = `it-${randomUUID()}`;
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      expect((await record(first, chargeId)).outcome).toBe("recorded");
      const waiting = record(second, chargeId, 299001);
      await waitBehind(first, 1);
      await first.query("commit");
      expect(await waiting).toEqual({ outcome: "conflict", charge_id: null });
      expect(await counts(chargeId)).toEqual({ charges: 1, parts: 12, total: "244871", net: "244871" });
    } finally {
      await first.query("rollback").catch(() => undefined);
      await Promise.all([first, second].map((client) => client.end()));
    }
  });

  it("fuera de read committed se niega: no vería el cobro de la otra", async () => {
    const client = await connect();
    try {
      await client.query("begin isolation level repeatable read");
      await expect(record(client, `it-${randomUUID()}`)).rejects.toMatchObject({ code: "25000" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });
});
