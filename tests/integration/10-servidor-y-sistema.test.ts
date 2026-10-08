import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { verifyAccessToken, type VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asSystem, type Tx } from "@/adapters/supabase/db";
import {
  DatabaseError,
  NestedTransactionError,
  RowValidationError,
  TransactionAbortedError,
  TransactionClosedError,
  TransactionControlError,
  UnverifiedClaimsError,
} from "@/adapters/supabase/errors";
import { sql } from "@/adapters/supabase/sql";

import { createTestUser, deleteTestUsers, type TestUser } from "./helpers/users";

// «Como servidor» y «como sistema» (ADR-31, TRD §8.10), contra la base local. Son el espejo
// de `pruebas.como_servicio` y `pruebas.como_sistema` de supabase/tests/_ayuda.psql.
//
// Todo lo que escribe en una tabla auditada se comprueba dentro de la transacción y se
// revierte: audit_log no admite borrado y las pruebas de base cuentan sus renglones.

class Revert extends Error {}

// «Como servidor» actúa por una persona con sesión: hace falta una de verdad.
let carla: TestUser;
let carlaClaims: VerifiedClaims;

beforeAll(async () => {
  carla = await createTestUser();
  const claims = await verifyAccessToken(carla.accessToken);
  if (!claims) throw new Error("El token de la persona de prueba no se verificó.");
  carlaClaims = claims;
});

afterAll(async () => {
  await deleteTestUsers([carla].filter(Boolean));
});

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
  it("prepara la transacción con la persona de las claims verificadas, sin su token", async () => {
    const [row] = await asServer(
      { claims: carlaClaims, reason: "sanción", requestId: "req-3" },
      (tx) => tx.query(readContext, context),
    );
    expect(row).toEqual({
      current_user: "app_service",
      session_user: "app_service",
      claims: "",
      actor_id: carla.id,
      // El nivel sale del token, no de quien llama.
      actor_aal: "aal1",
      actor_kind: "",
      reason: "sanción",
      request_id: "req-3",
      seen_actor: carla.id,
      is_system: false,
    });
  });

  it("un cambio auditado queda a nombre de esa persona", async () => {
    const actorId = carla.id;
    const profileId = randomUUID();
    const audit = await reverted(
      (fn) => asServer({ claims: carlaClaims, reason: "moderación", requestId: "req-4" }, fn),
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
    const attempt = asServer({ claims: carlaClaims }, (tx) => tx.execute(proposeParameter));
    await expect(attempt).rejects.toBeInstanceOf(DatabaseError);
    await expect(attempt).rejects.toMatchObject({ code: "42501" });
  });

  // Es el camino que salta la seguridad por fila: quién actúa y con qué nivel no puede
  // salir de un objeto que arma quien llama.
  it("no acepta un autor armado a mano: ni un identificador suelto ni una copia de las claims", async () => {
    const forgeries = [
      { claims: { ...carlaClaims } },
      { claims: { userId: carla.id, aal: "aal2", sessionId: null } },
      { actorId: carla.id, aal: "aal2" },
      {},
    ];
    for (const forged of forgeries) {
      await expect(
        asServer(forged as never, (tx) => tx.query(readContext, context)),
      ).rejects.toBeInstanceOf(UnverifiedClaimsError);
    }
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

  // Sobre una transacción abortada Postgres contesta ROLLBACK al commit, sin error. Si la
  // función atrapó el error y siguió, sin esta comprobación reportaría éxito.
  it("un error de la base que la función atrapa no pasa por un guardado", async () => {
    const attempt = asSystem({}, async (tx) => {
      await tx.execute(proposeParameter);
      await tx.execute(sql`select 1/0`).catch(() => {});
      return "guardado";
    });
    await expect(attempt).rejects.toBeInstanceOf(TransactionAbortedError);

    const [row] = await asSystem({}, (tx) => tx.query(pendingParameters, count));
    expect(row?.n).toBe(0);
  });

  // Quien abre y cierra la transacción es el adaptador. Una sentencia que la termine por
  // su cuenta dejaría lo que sigue fuera de ella: sin rol, sin autor y sin deshacer.
  it.each([
    ["commit", sql`commit`],
    ["rollback", sql`rollback`],
    ["end", sql`end`],
    ["abort", sql`abort`],
  ])("«%s» escrito en una consulta se rechaza", async (_name, statement) => {
    await expect(asSystem({}, (tx) => tx.execute(statement))).rejects.toBeInstanceOf(
      TransactionControlError,
    );
  });

  it("y se rechaza aunque la función atrape el error y diga que terminó bien", async () => {
    let ranAfter = false;
    const attempt = asSystem({}, async (tx) => {
      await tx.execute(sql`commit`).catch(() => {});
      await tx.query(sql`select 1 as n`, count).then(
        () => (ranAfter = true),
        () => {},
      );
      return "todo bien";
    });
    await expect(attempt).rejects.toBeInstanceOf(TransactionControlError);
    expect(ranAfter).toBe(false);
  });

  // «commit and chain» termina la transacción y abre otra: el estado que reporta la base
  // es el mismo, pero la nueva ya no trae el rol, el autor ni los tiempos límite.
  it.each([
    ["commit and chain", sql`commit and chain`],
    ["rollback and chain", sql`rollback and chain`],
  ])("«%s» no cuela una transacción nueva sin preparar", async (_name, statement) => {
    const attempt = asSystem({ reason: "prueba" }, async (tx) => {
      await tx.execute(statement);
      return "todo bien";
    });
    await expect(attempt).rejects.toBeInstanceOf(TransactionControlError);
  });

  it("varias consultas a la vez sobre la misma transacción corren una tras otra", async () => {
    const rows = await asSystem({}, (tx) =>
      Promise.all([1, 2, 3].map((n) => tx.query(sql`select ${n}::int as n`, count))),
    );
    expect(rows.map((result) => result[0]?.n)).toEqual([1, 2, 3]);
  });

  it("lo que va en fila detrás de un «commit» no llega a correr", async () => {
    let ran = false;
    const attempt = asSystem({}, (tx) =>
      Promise.all([
        tx.execute(sql`commit`),
        tx.query(sql`select 1 as n`, count).then((result) => {
          ran = true;
          return result;
        }),
      ]),
    );
    await expect(attempt).rejects.toBeInstanceOf(TransactionControlError);
    expect(ran).toBe(false);
  });

  // La marca de «estoy dentro de una transacción» se hereda a todo lo que se agenda ahí.
  // Si no se apagara al terminar, un trabajo lanzado desde dentro quedaría vetado.
  it("un trabajo agendado dentro puede abrir su propia transacción cuando la de afuera terminó", async () => {
    let later: Promise<{ n: number }[]> | undefined;
    await asSystem({}, async (tx) => {
      await tx.query(sql`select 1 as n`, count);
      later = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(() =>
        asSystem({}, (inner) => inner.query(sql`select 7 as n`, count)),
      );
    });
    expect((await later)?.[0]?.n).toBe(7);
  });

  it("una consulta es una sola sentencia: dos en el mismo texto se rechazan", async () => {
    const attempt = asSystem({}, (tx) => tx.execute(sql`select 1; select 2`));
    await expect(attempt).rejects.toBeInstanceOf(DatabaseError);
    await expect(attempt).rejects.toMatchObject({ code: "42601" });
  });

  it("no se anidan: la de adentro se rechaza al instante, sin esperar una conexión", async () => {
    const started = Date.now();
    await expect(
      asSystem({}, () => asSystem({}, (tx) => tx.query(sql`select 1 as n`, count))),
    ).rejects.toBeInstanceOf(NestedTransactionError);
    expect(Date.now() - started).toBeLessThan(2_000);

    // Y una después de otra, que no es anidar, sigue funcionando.
    await asSystem({}, (tx) => tx.query(sql`select 1 as n`, count));
    const [row] = await asSystem({}, (tx) => tx.query(sql`select 2 as n`, count));
    expect(row?.n).toBe(2);
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

    const [first] = await asServer({ claims: carlaClaims }, async (tx) => {
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
