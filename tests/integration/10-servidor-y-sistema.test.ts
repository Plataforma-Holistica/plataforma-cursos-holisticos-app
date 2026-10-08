import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { asServer, asSystem, type Tx } from "@/adapters/supabase/db";
import { DatabaseError, RowValidationError, TransactionClosedError } from "@/adapters/supabase/errors";
import { sql } from "@/adapters/supabase/sql";

// «Como servidor» y «como sistema» (ADR-31, TRD §8.10), contra la base local. Son el espejo
// de `pruebas.como_servicio` y `pruebas.como_sistema` de supabase/tests/_ayuda.psql.
//
// Todo lo que escribe en una tabla auditada se comprueba dentro de la transacción y se
// revierte: audit_log no admite borrado y las pruebas de base cuentan sus renglones.

class Revert extends Error {}

/** Corre `work` y revierte la transacción al final, pase lo que pase. */
async function reverted<T>(
  open: (fn: (tx: Tx) => Promise<never>) => Promise<never>,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | undefined;
  await expect(
    open(async (tx) => {
      outcome = { value: await work(tx) };
      throw new Revert();
    }),
  ).rejects.toBeInstanceOf(Revert);
  if (!outcome) throw new Error("la transacción no llegó al final");
  return outcome.value;
}

const context = z.object({
  current_user: z.string(),
  session_user: z.string(),
  claims: z.string().nullable(),
  actor_id: z.string().nullable(),
  actor_aal: z.string().nullable(),
  actor_kind: z.string().nullable(),
  reason: z.string().nullable(),
  request_id: z.string().nullable(),
  seen_actor: z.uuid().nullable(),
  is_system: z.boolean(),
});

const readContext = sql`
  select current_user::text, session_user::text,
    current_setting('request.jwt.claims', true) as claims,
    current_setting('app.actor_id', true) as actor_id,
    current_setting('app.actor_aal', true) as actor_aal,
    current_setting('app.actor_kind', true) as actor_kind,
    current_setting('app.reason', true) as reason,
    current_setting('app.request_id', true) as request_id,
    private.actor_id() as seen_actor,
    private.actor_is_system() as is_system`;

const auditRow = z.object({
  actor_id: z.uuid().nullable(),
  actor_kind: z.string(),
  action: z.string(),
  reason: z.string().nullable(),
  request_id: z.string().nullable(),
});

const lastAudit = (table: string) => sql`
  select actor_id, actor_kind, action, reason, request_id
  from public.audit_log where entity_table = ${table} order by id desc limit 1`;

const proposeParameter = sql`
  insert into public.business_parameters (key, value, status, effective_from)
  values ('GRACIA_COBRO_DIAS', '10', 'proposed', now() + interval '1 day')`;

const pendingParameters = sql`
  select count(*)::int as n from public.business_parameters
  where key = 'GRACIA_COBRO_DIAS' and effective_from > now()`;
const count = z.object({ n: z.number() });

describe("asSystem", () => {
  it("prepara la transacción como sistema, sin persona y sin token", async () => {
    const [row] = await asSystem({ reason: "cierre", requestId: "req-1" }, (tx) =>
      tx.query(readContext, context),
    );
    expect(row).toEqual({
      current_user: "app_service",
      session_user: "app_service",
      claims: "",
      actor_id: "",
      actor_aal: "",
      actor_kind: "system",
      reason: "cierre",
      request_id: "req-1",
      seen_actor: null,
      is_system: true,
    });
  });

  it("un cambio auditado queda a nombre del sistema, con motivo y petición", async () => {
    const audit = await reverted(
      (fn) => asSystem({ reason: "ajuste programado", requestId: "req-2" }, fn),
      async (tx) => {
        expect(await tx.execute(proposeParameter)).toBe(1);
        return tx.query(lastAudit("public.business_parameters"), auditRow);
      },
    );
    expect(audit).toEqual([
      {
        actor_id: null,
        actor_kind: "system",
        action: "business_parameters.insert",
        reason: "ajuste programado",
        request_id: "req-2",
      },
    ]);
  });

  it("sin motivo ni petición, la auditoría los deja vacíos", async () => {
    const audit = await reverted(
      (fn) => asSystem({}, fn),
      async (tx) => {
        await tx.execute(proposeParameter);
        return tx.query(lastAudit("public.business_parameters"), auditRow);
      },
    );
    expect(audit[0]).toMatchObject({ actor_kind: "system", reason: null, request_id: null });
  });
});

describe("asServer", () => {
  it("prepara la transacción con el autor declarado, sin token", async () => {
    const actorId = randomUUID();
    const [row] = await asServer(
      { actorId, aal: "aal2", reason: "sanción", requestId: "req-3" },
      (tx) => tx.query(readContext, context),
    );
    expect(row).toEqual({
      current_user: "app_service",
      session_user: "app_service",
      claims: "",
      actor_id: actorId,
      actor_aal: "aal2",
      actor_kind: "",
      reason: "sanción",
      request_id: "req-3",
      seen_actor: actorId,
      is_system: false,
    });
  });

  it("un cambio auditado queda a nombre de esa persona", async () => {
    const actorId = randomUUID();
    const profileId = randomUUID();
    const audit = await reverted(
      (fn) => asServer({ actorId, aal: "aal2", reason: "moderación", requestId: "req-4" }, fn),
      async (tx) => {
        await tx.execute(sql`insert into public.profiles (id) values (${profileId})`);
        await tx.execute(sql`
          update public.profiles set comment_ban_until = now() + interval '1 day'
          where id = ${profileId}`);
        return tx.query(lastAudit("public.profiles"), auditRow);
      },
    );
    expect(audit[0]).toMatchObject({
      actor_id: actorId,
      actor_kind: "user",
      reason: "moderación",
      request_id: "req-4",
    });
  });

  it("la base decide por el autor: sin la capacidad, el cambio se rechaza", async () => {
    const attempt = asServer({ actorId: randomUUID(), aal: "aal2" }, (tx) =>
      tx.execute(proposeParameter),
    );
    await expect(attempt).rejects.toBeInstanceOf(DatabaseError);
    await expect(attempt).rejects.toMatchObject({ code: "42501" });
  });

  it("rechaza un autor que no es un identificador, antes de tocar la base", async () => {
    await expect(
      asServer({ actorId: "no-es-uuid", aal: "aal1" }, (tx) => tx.query(readContext, context)),
    ).rejects.toThrow(/actorId/);
  });
});

describe("la transacción", () => {
  it("un error revierte todo y llega tal cual a quien llamó", async () => {
    const failure = new Error("regla de negocio");
    await expect(
      asSystem({}, async (tx) => {
        await tx.execute(proposeParameter);
        throw failure;
      }),
    ).rejects.toBe(failure);

    const [row] = await asSystem({}, (tx) => tx.query(pendingParameters, count));
    expect(row?.n).toBe(0);
  });

  it("una consulta tardía lanza: no corre en la transacción de otra petición", async () => {
    let leaked: Tx | undefined;
    await asSystem({}, async (tx) => {
      leaked = tx;
    });
    if (!leaked) throw new Error("no se capturó la transacción");
    await expect(leaked.query(sql`select 1 as n`, count)).rejects.toBeInstanceOf(
      TransactionClosedError,
    );
    await expect(leaked.execute(sql`select 1`)).rejects.toBeInstanceOf(TransactionClosedError);
  });

  it("nada sobrevive a la transacción en la misma conexión", async () => {
    const probe = z.object({ pid: z.number(), role: z.string(), probe: z.string().nullable() });
    const readProbe = sql`
      select pg_backend_pid() as pid, current_user::text as role,
        current_setting('app.sonda', true) as probe`;

    const [first] = await asServer({ actorId: randomUUID(), aal: "aal2" }, async (tx) => {
      await tx.execute(sql`select set_config('app.sonda', 'dejada por otra petición', true)`);
      return tx.query(readProbe, probe);
    });
    const second = await asSystem({}, async (tx) => ({
      probe: (await tx.query(readProbe, probe))[0],
      context: (await tx.query(readContext, context))[0],
    }));

    expect(first?.probe).toBe("dejada por otra petición");
    // Misma conexión de la base: si fuera otra, la prueba no demostraría nada.
    expect(second.probe).toMatchObject({ pid: first?.pid, role: "app_service" });
    expect(second.probe?.probe ?? "").toBe("");
    expect(second.context).toMatchObject({
      actor_id: "",
      actor_aal: "",
      actor_kind: "system",
      claims: "",
    });
  });

  it("cada transacción lleva sus tiempos límite", async () => {
    const limits = z.object({ statement: z.string(), lock: z.string(), idle: z.string() });
    const [row] = await asSystem({}, (tx) =>
      tx.query(
        sql`select current_setting('statement_timeout') as statement,
              current_setting('lock_timeout') as lock,
              current_setting('idle_in_transaction_session_timeout') as idle`,
        limits,
      ),
    );
    expect(row).toEqual({ statement: "10s", lock: "5s", idle: "15s" });
  });

  it("un error de la base llega con su código y sin el SQL ni los valores", async () => {
    const secret = "valor-de-una-persona";
    const error: unknown = await asSystem({}, (tx) =>
      tx.execute(sql`select ${secret}::uuid`),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error).toMatchObject({ code: "22P02" });
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    expect(text).not.toContain(secret);
    expect(text).not.toContain("::uuid");
  });

  it("una fila que no cumple su esquema se rechaza", async () => {
    await expect(
      asSystem({}, (tx) => tx.query(sql`select 'texto' as n`, count)),
    ).rejects.toBeInstanceOf(RowValidationError);
  });

  it("no acepta SQL como texto suelto: solo lo que produce la etiqueta", async () => {
    await expect(
      asSystem({}, (tx) => tx.execute("select 1" as never)),
    ).rejects.toThrow(/etiqueta/);
    await expect(
      asSystem({}, (tx) => tx.query({ text: "select 1 as n", values: [] } as never, count)),
    ).rejects.toThrow(/etiqueta/);
  });
});
