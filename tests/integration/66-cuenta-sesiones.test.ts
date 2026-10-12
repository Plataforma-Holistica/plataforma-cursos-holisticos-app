import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signIn as authSignIn, readSession } from "@/adapters/supabase/auth";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { PendingAccount, SessionCheck } from "@/services/account/account";
import { createManagement } from "@/services/account/management";
import type { FailureCode } from "@/services/error-reporting/server";

import { claimedUser, clearThrottle, freshOrigin, notedSessions, testServices } from "./helpers/account";
import { memoryJar, sessionCount, type KnownUser, type MemoryJar } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Las sesiones a la vista (RF-109; FL-27, paso 4; TRD §9.2): lo que una persona ve de sus
// sesiones abiertas, y cerrar una o todas las demás, contra la base y el Auth locales. Lo
// que importa: solo ve y solo cierra las suyas, y sin una sesión que pase la guarda no se
// cierra nada.

const MINUTE = 60_000;
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const emails: string[] = [];

async function account(): Promise<KnownUser> {
  const created = await claimedUser();
  emails.push(created.email);
  await completeAccountAsOwner(created.id);
  return created;
}

/** Abre otra sesión de esa cuenta por el servicio, desde ese navegador, con su propia cookie. */
async function open(who: KnownUser, userAgent: string | null = CHROME_WINDOWS): Promise<{ jar: MemoryJar; claims: VerifiedClaims }> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, { ...freshOrigin(), userAgent });
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La sesión de prueba no pasó la guarda: ${check.kind}`);
  return { jar, claims: check.claims };
}

const idOf = (claims: VerifiedClaims): string => {
  if (claims.sessionId === null) throw new Error("La sesión de prueba no trae identificador.");
  return claims.sessionId;
};

const labelOf = async (sessionId: string) =>
  (await ownerQuery<{ user_agent: string | null }>("select user_agent from private.app_sessions where session_id = $1", [sessionId]))[0]
    ?.user_agent;

const guard = (jar: MemoryJar) => testServices().checkSession(jar);
const CLOSED = { kind: "must_sign_out", then: "sign_in" };

/**
 * El servicio con una guarda que contesta lo que se le diga, y lo que reportó. Con varias
 * respuestas las da en orden, y repite la última.
 */
function managementWith(...checks: [SessionCheck, ...SessionCheck[]]) {
  const answers: SessionCheck[] = [...checks];
  const next = (): SessionCheck => {
    const [first, ...later] = answers;
    if (later.length > 0) answers.shift();
    return first ?? checks[0];
  };
  const reported: FailureCode[] = [];
  const management = createManagement(
    {
      isLocal: () => true,
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { checkSession: () => Promise.resolve(next()) },
  );
  return { ...management, reported };
}

beforeEach(async () => {
  await clearThrottle();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  // Por si la prueba que le quita este permiso al servidor murió antes de devolverlo.
  await ownerQuery("grant execute on function private.tag_session(uuid, text) to app_service");
  await deleteTestUsersByEmail(emails);
});

/**
 * Corre esos cierres a la vez de verdad: otra sesión de la base tiene tomado el perfil, se
 * lanzan todos, se espera a que cada uno esté detenido por ese candado, y entonces se suelta.
 * Sin esto, que dos llamadas coincidan depende de la suerte.
 */
async function atOnce<Results extends unknown[]>(userId: string, work: { [Index in keyof Results]: () => Promise<Results[Index]> }): Promise<Results> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  let running: Promise<Results> | undefined;
  try {
    await owner.query("begin");
    const held = await owner.query<{ pid: number }>("select pg_backend_pid() as pid");
    await owner.query("select 1 from public.profiles where id = $1 for update", [userId]);
    running = Promise.all(work.map((start) => start())) as Promise<Results>;

    // El primero que llega espera a quien tiene el perfil, y los demás hacen fila detrás de
    // él: todos esperan un candado, y al menos uno, el de esta sesión de la base.
    const deadline = Date.now() + 4_000;
    for (;;) {
      const rows = await ownerQuery<{ waiting: number; behind: boolean | null }>(
        `select count(*)::int as waiting, bool_or($1::int = any(pg_blocking_pids(pid))) as behind
         from pg_stat_activity where usename = 'app_service' and wait_event_type = 'Lock'`,
        [held.rows[0]?.pid ?? -1],
      );
      if ((rows[0]?.waiting ?? 0) >= work.length && rows[0]?.behind === true) break;
      if (Date.now() > deadline) throw new Error("Los cierres no llegaron a esperar el perfil a la vez.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await owner.query("commit");
    return await running;
  } finally {
    await owner.query("rollback").catch(() => undefined);
    await running?.catch(() => undefined);
    await owner.end();
  }
}

describe("al abrir una sesión queda dicho desde qué navegador", () => {
  it("el que mandó la petición, limpio", async () => {
    const who = await account();
    const { claims } = await open(who, `  ${CHROME_WINDOWS}\u0000\n `);
    expect(await labelOf(idOf(claims))).toBe(CHROME_WINDOWS);
  });

  it("sin navegador, la sesión se abre igual y queda sin etiqueta", async () => {
    const who = await account();
    const { claims } = await open(who, null);
    expect(await labelOf(idOf(claims))).toBeNull();
  });

  it("uno desmedido se guarda recortado", async () => {
    const who = await account();
    const { claims } = await open(who, "x".repeat(2_000));
    expect(await labelOf(idOf(claims))).toBe("x".repeat(512));
  });
});

describe("la etiqueta no decide nada, y que falle no impide entrar", () => {
  it("si no se puede etiquetar, la sesión se abre igual, se lista como de un navegador desconocido y se reporta", async () => {
    const who = await account();
    // Como si el código hubiera llegado antes que su migración: el servidor no puede etiquetar.
    await ownerQuery("revoke execute on function private.tag_session(uuid, text) from app_service");
    const services = testServices();
    const jar = memoryJar();
    try {
      expect(await services.signIn(jar, who, { ...freshOrigin(), userAgent: CHROME_WINDOWS })).toEqual({ kind: "entered", pending: null });
    } finally {
      await ownerQuery("grant execute on function private.tag_session(uuid, text) to app_service");
    }
    expect(services.reported).toEqual(["session_not_tagged"]);

    const check = await guard(jar);
    if (check.kind !== "pass") throw new Error(`La sesión no pasó la guarda: ${check.kind}`);
    expect(await labelOf(idOf(check.claims))).toBeNull();
    expect(await testServices().accountSessions(check.claims)).toMatchObject({
      kind: "ready",
      sessions: [{ id: idOf(check.claims), device: { browser: null, system: null }, current: true }],
    });
  });
});

describe("ver las sesiones abiertas", () => {
  it("con una sola: esa, marcada como la de ahora, con su navegador y sus horas", async () => {
    const who = await account();
    const { claims } = await open(who, CHROME_WINDOWS);
    const services = testServices();
    const listed = await services.accountSessions(claims);
    expect(listed).toEqual({
      kind: "ready",
      sessions: [
        {
          id: idOf(claims),
          openedAt: expect.stringMatching(ISO) as string,
          lastActiveAt: expect.stringMatching(ISO) as string,
          device: { browser: "chrome", system: "windows" },
          current: true,
        },
      ],
    });
    expect(services.reported).toEqual([]);
  });

  it("con varias: todas las suyas, cada una con su navegador, y solo una es la de ahora", async () => {
    const who = await account();
    const first = await open(who, CHROME_WINDOWS);
    const second = await open(who, SAFARI_IPHONE);
    const third = await open(who, "curl/8.4.0");

    const seen = await testServices().accountSessions(second.claims);
    if (seen.kind !== "ready") throw new Error("La lista no llegó.");
    expect(seen.sessions.map(({ id, device, current }) => ({ id, device, current })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: idOf(first.claims), device: { browser: "chrome", system: "windows" }, current: false },
        { id: idOf(second.claims), device: { browser: "safari", system: "ios" }, current: true },
        { id: idOf(third.claims), device: { browser: null, system: null }, current: false },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("no trae las de otra cuenta, ni una abierta directo en Auth", async () => {
    const who = await account();
    const other = await account();
    const mine = await open(who);
    await open(other, FIREFOX_LINUX);
    expect((await authSignIn(memoryJar(), who.email, who.password)).ok).toBe(true);
    expect(await sessionCount(who.id)).toBe(2);

    const seen = await testServices().accountSessions(mine.claims);
    expect(seen).toMatchObject({ kind: "ready", sessions: [{ id: idOf(mine.claims), current: true }] });
  });

  it("unas claims a las que se les cambió la cuenta no listan las de nadie: no se supo, y se reporta", async () => {
    const who = await account();
    const other = await account();
    const mine = await open(who);
    await open(other);
    const services = testServices();
    expect(await services.accountSessions({ ...mine.claims, userId: other.id })).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
  });

  it("unas claims que no dicen de qué sesión son no listan nada: no se supo, y se reporta", async () => {
    const who = await account();
    const mine = await open(who);
    const services = testServices();
    // La guarda no deja pasar un token así. Si algún día llegara, no se pinta una lista sin saber cuál es la de ahora.
    expect(await services.accountSessions({ ...mine.claims, sessionId: null })).toEqual({ kind: "unavailable" });
    expect(await services.accountSessions({ ...mine.claims, sessionId: "no-es-un-identificador" })).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable", "account_unavailable"]);
  });

  it("si la sesión con la que se pide se cerró desde otro lado, no pinta una lista sin ella, y no es una caída", async () => {
    const who = await account();
    const mine = await open(who);
    const other = await open(who);
    // Entre la guarda de la página y esta lectura, la otra sesión cerró esta.
    expect(await testServices().closeSession(other.jar, { sessionId: idOf(mine.claims) })).toEqual({ kind: "closed" });
    const services = testServices();
    expect(await services.accountSessions(mine.claims)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual([]);
  });
});

describe("cerrar una sesión", () => {
  it("otra de la misma cuenta: deja de pasar la guarda en el acto, y la de ahora sigue", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who, SAFARI_IPHONE);
    const services = testServices();

    expect(await services.closeSession(here.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "closed" });

    expect(await guard(there.jar)).toEqual(CLOSED);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(who.id)).toBe(1);
    expect(await notedSessions(who.id)).toBe(1);
    // Con su token de renovación tampoco vuelve: se fue con la sesión.
    const refreshed = await ownerQuery<{ n: number }>("select count(*)::int as n from auth.refresh_tokens where session_id = $1", [
      idOf(there.claims),
    ]);
    expect(refreshed[0]?.n).toBe(0);
    expect(services.reported).toEqual([]);

    // Cerrarla otra vez ya no encuentra nada.
    expect(await services.closeSession(here.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "not_found" });
  });

  it("la de otra cuenta no se encuentra, y sigue abierta", async () => {
    const who = await account();
    const other = await account();
    const here = await open(who);
    const theirs = await open(other);

    expect(await testServices().closeSession(here.jar, { sessionId: idOf(theirs.claims) })).toEqual({ kind: "not_found" });

    expect(await guard(theirs.jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(other.id)).toBe(1);
    expect(await notedSessions(other.id)).toBe(1);
  });

  it.each([
    ["vacío", ""],
    ["un texto cualquiera", "otras"],
    ["algo que parece SQL", "' or true --"],
    ["un identificador con algo pegado", "5e560000-0000-0000-0000-000000000001; drop"],
    ["un texto desmedido", "a".repeat(5_000)],
  ])("lo que no tiene forma de identificador (%s) no es una sesión de nadie", async (_case, sessionId) => {
    const who = await account();
    const here = await open(who);
    const services = testServices();
    expect(await services.closeSession(here.jar, { sessionId })).toEqual({ kind: "not_found" });
    expect(await sessionCount(who.id)).toBe(1);
    expect(services.reported).toEqual([]);
  });

  it("la sesión con la que se pide no se cierra por aquí, se escriba como se escriba", async () => {
    const who = await account();
    const here = await open(who);
    const services = testServices();
    expect(await services.closeSession(here.jar, { sessionId: idOf(here.claims) })).toEqual({ kind: "current" });
    expect(await services.closeSession(here.jar, { sessionId: idOf(here.claims).toUpperCase() })).toEqual({ kind: "current" });
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(who.id)).toBe(1);
  });

  it("un identificador en mayúsculas cierra la misma sesión", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    expect(await testServices().closeSession(here.jar, { sessionId: idOf(there.claims).toUpperCase() })).toEqual({ kind: "closed" });
    expect(await guard(there.jar)).toEqual(CLOSED);
  });

  it("si cerrar falla, no se supo, se reporta y la sesión sigue abierta", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    const management = managementWith({ kind: "pass", claims: here.claims });
    // Las claims vencen entre la guarda y la transacción: la base las rechaza.
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + 60 * MINUTE);
    expect(await management.closeSession(here.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "unavailable" });
    vi.restoreAllMocks();
    expect(management.reported).toEqual(["account_unavailable"]);
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
  });
});

describe("dos cierres a la vez", () => {
  // Sin el candado de la base, cada «cerrar las demás» veía viva su sesión y borraba la de
  // la otra: la cuenta se quedaba sin ninguna, y las dos respuestas decían que salió bien.
  it("«cerrar las demás» desde dos sesiones: una gana y la otra se entera de que ya no tiene sesión", async () => {
    const who = await account();
    const first = await open(who);
    const second = await open(who, SAFARI_IPHONE);
    const services = testServices();

    const results = await atOnce(who.id, [() => services.closeOtherSessions(first.jar), () => services.closeOtherSessions(second.jar)]);

    expect(results.map((result) => result.kind).sort()).toEqual(["closed", "session"]);
    expect(results.find((result) => result.kind === "closed")).toEqual({ kind: "closed", count: 1 });
    expect(results.find((result) => result.kind === "session")).toEqual({ kind: "session", check: CLOSED });
    // Queda exactamente una, y es la de quien ganó.
    expect(await sessionCount(who.id)).toBe(1);
    expect(await notedSessions(who.id)).toBe(1);
    const winner = results[0].kind === "closed" ? first : second;
    expect(await guard(winner.jar)).toMatchObject({ kind: "pass" });
    // Que una sesión pierda contra otra no es una caída.
    expect(services.reported).toEqual([]);
  });

  it("cerrar una mientras esa cierra las demás: nunca se quedan las dos, ni ninguna", async () => {
    const who = await account();
    const first = await open(who);
    const second = await open(who, SAFARI_IPHONE);
    const services = testServices();

    const [one, others] = await atOnce(who.id, [
      () => services.closeSession(first.jar, { sessionId: idOf(second.claims) }),
      () => services.closeOtherSessions(second.jar),
    ]);

    expect(await sessionCount(who.id)).toBe(1);
    expect([one.kind, others.kind].sort()).toEqual(["closed", "session"]);
    expect(services.reported).toEqual([]);
  });

  it("dos sesiones que se cierran una a la otra: queda una", async () => {
    const who = await account();
    const first = await open(who);
    const second = await open(who, SAFARI_IPHONE);
    const services = testServices();

    const results = await atOnce(who.id, [
      () => services.closeSession(first.jar, { sessionId: idOf(second.claims) }),
      () => services.closeSession(second.jar, { sessionId: idOf(first.claims) }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["closed", "session"]);
    expect(await sessionCount(who.id)).toBe(1);
    expect(services.reported).toEqual([]);
  });
});

describe("un cierre que la base no hizo", () => {
  // La base se niega cuando la sesión con la que se pide no se reconoce. Aquí la guarda dice
  // «pasa» sobre una sesión abierta directo en Auth, que la base no reconoce.
  async function unrecognized(who: KnownUser) {
    const direct = memoryJar();
    expect((await authSignIn(direct, who.email, who.password)).ok).toBe(true);
    const read = await readSession(direct);
    if (read.kind !== "session") throw new Error("La sesión directa no se leyó.");
    return { jar: direct, claims: read.claims };
  }

  it("si la guarda, al volver a preguntarle, dice que esa sesión ya no vale, se contesta eso y no se reporta", async () => {
    const who = await account();
    const there = await open(who);
    const asking = await unrecognized(who);
    const management = managementWith({ kind: "pass", claims: asking.claims }, { kind: "must_sign_out", then: "sign_in" });
    expect(await management.closeSession(asking.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "session", check: CLOSED });
    expect(management.reported).toEqual([]);
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
  });

  it.each([
    ["insiste en que pasa", { kind: "pass" }],
    ["tampoco supo", { kind: "unavailable" }],
  ] as const)("si la guarda %s, lo que falló fue cerrar: no se supo, y se reporta", async (_case, second) => {
    const who = await account();
    const there = await open(who);
    const asking = await unrecognized(who);
    const again: SessionCheck = second.kind === "pass" ? { kind: "pass", claims: asking.claims } : second;

    const one = managementWith({ kind: "pass", claims: asking.claims }, again);
    expect(await one.closeSession(asking.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "unavailable" });
    expect(one.reported).toEqual(["account_unavailable"]);

    const others = managementWith({ kind: "pass", claims: asking.claims }, again);
    expect(await others.closeOtherSessions(asking.jar)).toEqual({ kind: "unavailable" });
    expect(others.reported).toEqual(["account_unavailable"]);

    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(who.id)).toBe(2);
  });
});

describe("cerrar todas las demás", () => {
  it("se van las otras de la cuenta, también una abierta directo en Auth, y nada de nadie más", async () => {
    const who = await account();
    const other = await account();
    const here = await open(who);
    const second = await open(who, SAFARI_IPHONE);
    const third = await open(who, FIREFOX_LINUX);
    const theirs = await open(other);
    const direct = memoryJar();
    expect((await authSignIn(direct, who.email, who.password)).ok).toBe(true);
    expect(await sessionCount(who.id)).toBe(4);
    const services = testServices();

    expect(await services.closeOtherSessions(here.jar)).toEqual({ kind: "closed", count: 3 });

    expect(await sessionCount(who.id)).toBe(1);
    expect(await notedSessions(who.id)).toBe(1);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
    expect(await guard(second.jar)).toEqual(CLOSED);
    expect(await guard(third.jar)).toEqual(CLOSED);
    expect(await guard(theirs.jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(other.id)).toBe(1);
    expect(services.reported).toEqual([]);
    // La lista ya solo trae la de ahora.
    expect(await services.accountSessions(here.claims)).toMatchObject({ kind: "ready", sessions: [{ id: idOf(here.claims), current: true }] });
  });

  it("sin otras abiertas, cierra cero", async () => {
    const who = await account();
    const here = await open(who);
    expect(await testServices().closeOtherSessions(here.jar)).toEqual({ kind: "closed", count: 0 });
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
  });

  it("si la base no reconoce la sesión que se queda, no cierra ninguna: no se supo, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    // Una sesión propia, abierta directo en Auth: su token verifica, pero nadie la anotó.
    const direct = memoryJar();
    expect((await authSignIn(direct, who.email, who.password)).ok).toBe(true);
    const read = await readSession(direct);
    if (read.kind !== "session") throw new Error("La sesión directa no se leyó.");

    // La guarda de verdad no la dejaría pasar. Aquí dice que sí: la base es la segunda barrera.
    const management = managementWith({ kind: "pass", claims: read.claims });
    expect(await management.closeOtherSessions(direct)).toEqual({ kind: "unavailable" });
    expect(management.reported).toEqual(["account_unavailable"]);
    expect(await sessionCount(who.id)).toBe(2);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
  });
});

describe("sin una sesión que pase la guarda no se cierra nada", () => {
  it("sin cookie", async () => {
    const who = await account();
    const there = await open(who);
    const services = testServices();
    expect(await services.closeSession(memoryJar(), { sessionId: idOf(there.claims) })).toEqual({ kind: "session", check: { kind: "anonymous" } });
    expect(await services.closeOtherSessions(memoryJar())).toEqual({ kind: "session", check: { kind: "anonymous" } });
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
  });

  it("con una sesión abierta directo en Auth, aunque sea de la misma cuenta", async () => {
    const who = await account();
    const there = await open(who);
    const direct = memoryJar();
    expect((await authSignIn(direct, who.email, who.password)).ok).toBe(true);
    const services = testServices();
    expect(await services.closeSession(direct, { sessionId: idOf(there.claims) })).toEqual({ kind: "session", check: CLOSED });
    expect(await services.closeOtherSessions(direct)).toEqual({ kind: "session", check: CLOSED });
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(who.id)).toBe(2);
  });

  it("con una copia de la cookie, después de que esa sesión se cerró desde otra", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    const kept = there.jar.copy();
    expect(await testServices().closeSession(here.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "closed" });

    // La sesión cerrada ya no cierra a las demás, aunque su token siga verificando.
    const services = testServices();
    expect(await services.closeOtherSessions(kept)).toEqual({ kind: "session", check: CLOSED });
    expect(await services.closeSession(kept, { sessionId: idOf(here.claims) })).toEqual({ kind: "session", check: CLOSED });
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
  });

  // Con una guarda que contesta lo que se le diga se ve que el servicio obedece, aunque
  // tenga a la mano unas claims con las que la base sí cerraría.
  it("lo que no sea «pasa» se devuelve tal cual, y con claims válidas en la mano tampoco se cierra", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    const pending: PendingAccount = {
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    };
    const refusals: SessionCheck[] = [
      { kind: "anonymous" },
      { kind: "incomplete", claims: here.claims, ...pending },
      { kind: "suspended" },
      { kind: "must_sign_out", then: "sign_in" },
      { kind: "must_sign_out", then: "recover" },
      { kind: "unavailable" },
    ];
    for (const check of refusals) {
      const management = managementWith(check);
      expect(await management.closeSession(here.jar, { sessionId: idOf(there.claims) })).toEqual({ kind: "session", check });
      expect(await management.closeOtherSessions(here.jar)).toEqual({ kind: "session", check });
      expect(management.reported).toEqual([]);
    }
    expect(await sessionCount(who.id)).toBe(2);
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
  });
});
