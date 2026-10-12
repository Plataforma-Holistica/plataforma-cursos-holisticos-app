import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signIn as authSignIn, readSession } from "@/adapters/supabase/auth";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { PendingAccount, SessionCheck } from "@/services/account/account";
import { createManagement } from "@/services/account/management";
import type { FailureCode } from "@/services/error-reporting/server";

import { claimedUser, clearThrottle, freshOrigin, notedSessions, testServices } from "./helpers/account";
import { memoryJar, sessionCount, type KnownUser, type MemoryJar } from "./helpers/auth";
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

/** El servicio con una guarda que contesta lo que se le diga, y lo que reportó. */
function managementWith(check: SessionCheck) {
  const reported: FailureCode[] = [];
  const management = createManagement(
    {
      isLocal: () => true,
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { checkSession: () => Promise.resolve(check) },
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
  await deleteTestUsersByEmail(emails);
});

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

  it("si la sesión con la que se pide no está entre las abiertas, no pinta una lista sin ella", async () => {
    const who = await account();
    const mine = await open(who);
    // No debería pasar: la guarda no deja llegar a una sesión que la aplicación no anotó.
    await ownerQuery("delete from private.app_sessions where session_id = $1", [idOf(mine.claims)]);
    const services = testServices();
    expect(await services.accountSessions(mine.claims)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
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
