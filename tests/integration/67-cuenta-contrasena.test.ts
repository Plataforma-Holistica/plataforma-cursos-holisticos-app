import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth, signIn as authSignIn } from "@/adapters/supabase/auth";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asSystem } from "@/adapters/supabase/db";
import { PASSWORD_MAX_BYTES } from "@/domain/access/password-policy";
import type { AuthPort, PendingAccount, SessionCheck } from "@/services/account/account";
import type { RequestOrigin } from "@/services/account/origin";
import { loadThrottleParams } from "@/services/account/store";

import {
  claimedUser,
  clearThrottle,
  freshOrigin,
  hitsOf,
  holdLock,
  holdProfile,
  keysOf,
  managementWith,
  notedSessions,
  pairOf,
  profileOf,
  seedHits,
  signInBuckets,
  testServices,
  throttleRows,
} from "./helpers/account";
import {
  authVisitor,
  failingFetch,
  memoryJar,
  networkDown,
  recordingFetch,
  sessionCount,
  tooManyRequests,
  type KnownUser,
  type MemoryJar,
} from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { lastMailTo } from "./helpers/mailbox";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Cambiar la contraseña desde la cuenta (RF-109; FL-27, paso 3; TRD §9.2), contra la base, el
// Auth y el buzón locales. Lo que importa: sin la contraseña actual no cambia nada, comprobarla
// pasa por el mismo freno que entrar, y después del cambio no queda abierta ninguna sesión
// que haya entrado con la contraseña de antes.

const COOKIE = "plataforma-sesion";
const WRONG = "una-contraseña-que-no-es";
const CHANGED_MAIL = "Tu contraseña cambió";
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CLOSED = { kind: "must_sign_out", then: "sign_in" };
const NOTE = "private.note_password_change()";

const emails: string[] = [];
let params: Awaited<ReturnType<typeof loadThrottleParams>>;

const fresh = () => `N-${randomUUID()}`;
const fromChrome = (): RequestOrigin => ({ ...freshOrigin(), userAgent: CHROME_WINDOWS });

async function account(options: { complete?: boolean } = {}): Promise<KnownUser> {
  const created = await claimedUser();
  emails.push(created.email);
  if (options.complete ?? true) await completeAccountAsOwner(created.id);
  return created;
}

/** Abre una sesión de esa cuenta por el servicio, con su propia cookie. */
async function open(who: KnownUser): Promise<{ jar: MemoryJar; claims: VerifiedClaims }> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La sesión de prueba no pasó la guarda: ${check.kind}`);
  return { jar, claims: check.claims };
}

/** Otra sesión de esa cuenta abierta directo en Auth, sin pasar por la Plataforma. */
async function elsewhere(who: KnownUser): Promise<void> {
  const opened = await authVisitor().auth.signInWithPassword({ email: who.email, password: who.password });
  if (opened.error) throw new Error("La sesión de prueba no se abrió.");
}

const guard = (jar: MemoryJar) => testServices().checkSession(jar);

/** Si Auth acepta esa contraseña. Abre una sesión por fuera: se cuenta antes de preguntar. */
const accepts = async (who: KnownUser, secret: string) => (await authSignIn(memoryJar(), who.email, secret)).ok;

async function changedAt(userId: string): Promise<number> {
  const rows = await ownerQuery<{ at: number }>(
    "select extract(epoch from password_changed_at)::float8 as at from private.account_security where profile_id = $1",
    [userId],
  );
  const at = rows[0]?.at;
  if (typeof at !== "number") throw new Error("La cuenta de prueba no tiene fecha de cambio de contraseña.");
  return at;
}

const labelOf = async (sessionId: string | null) =>
  (await ownerQuery<{ user_agent: string | null }>("select user_agent from private.app_sessions where session_id = $1", [sessionId]))[0]
    ?.user_agent;

/** Declara o retira la mayoría de edad de una cuenta, como dueño: con eso deja de pasar la guarda, o vuelve a pasar. */
async function declareAdult(userId: string, declared: boolean): Promise<void> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  try {
    await owner.query("begin");
    await owner.query("select set_config('app.actor_id', $1, true)", [userId]);
    await owner.query("update public.profiles set adult_declared_at = case when $2 then now() end where id = $1", [userId, declared]);
    await owner.query("commit");
  } finally {
    await owner.query("rollback").catch(() => undefined);
    await owner.end();
  }
}

/** El Auth de verdad, con las funciones que se le cambien. `calls` son las rutas que se le pidieron. */
function authWith(change: (real: AuthPort) => Partial<AuthPort>): { auth: AuthPort; calls: string[] } {
  const spy = recordingFetch();
  const real = createAuth({ fetch: spy.fetch });
  return { auth: { ...real, ...change(real) }, calls: spy.calls };
}

/** Servicios cuyo Auth anota lo que se le pide. */
function watched() {
  const spy = recordingFetch();
  return { services: testServices({ auth: createAuth({ fetch: spy.fetch }) }), calls: spy.calls };
}

const asked = (calls: readonly string[], path: string) => calls.filter((call) => call.startsWith(path)).length;
const TOKEN = "/auth/v1/token";
const USER = "/auth/v1/user";

beforeAll(async () => {
  params = await asSystem({ reason: "prueba" }, (tx) => loadThrottleParams(tx));
});

beforeEach(async () => {
  await clearThrottle();
});

afterAll(async () => {
  // Por si la prueba que le quita este permiso al servidor murió antes de devolverlo.
  await ownerQuery(`grant execute on function ${NOTE} to app_service`);
  await clearThrottle();
  await deleteTestUsersByEmail(emails);
});

describe("cambiar la contraseña con la actual correcta", () => {
  it("cambia, avisa por correo, cierra las demás sesiones y deja una nueva en este navegador", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    await elsewhere(who);
    const before = await changedAt(who.id);
    const written = here.jar.writes.length;
    const origin = fromChrome();
    const chosen = fresh();
    const services = testServices();

    expect(await services.changePassword(here.jar, { current: who.password, next: chosen }, origin)).toEqual({ kind: "changed" });
    expect(services.reported).toEqual([]);

    // Queda una sola sesión, la nueva, y es la de este navegador.
    expect(await sessionCount(who.id)).toBe(1);
    expect(await notedSessions(who.id)).toBe(1);
    const now = await guard(here.jar);
    expect(now).toMatchObject({ kind: "pass", claims: { userId: who.id } });
    const sessionId = now.kind === "pass" ? now.claims.sessionId : null;
    expect(sessionId).not.toBe(here.claims.sessionId);
    expect(await labelOf(sessionId)).toBe(CHROME_WINDOWS);
    expect(here.jar.writes.slice(written).map((write) => write.name)).toEqual([COOKIE]);
    expect(await guard(there.jar)).toEqual(CLOSED);

    // El cambio quedó fechado: una entrada que empezó antes ya no se anota.
    expect(await changedAt(who.id)).toBeGreaterThan(before);
    expect((await lastMailTo(who.email)).subject).toBe(CHANGED_MAIL);
    // El intento se cerró como una entrada correcta desde esa dirección.
    const pair = await pairOf(keysOf(who.email, origin));
    expect(pair).toMatchObject({ failed_count: 0 });
    expect(pair?.last_success_at).not.toBeNull();
    // Nada más de la cuenta se movió: la marca de contraseña sigue apagada.
    expect(await profileOf(who.id)).toMatchObject({ pending: false, status: "active", adult: true });

    expect(await accepts(who, who.password)).toBe(false);
    expect(await accepts(who, chosen)).toBe(true);
  });

  it("se puede volver a cambiar enseguida, con la que se acaba de poner", async () => {
    const who = await account();
    const { jar } = await open(who);
    const first = fresh();
    const second = fresh();
    const services = testServices();
    expect(await services.changePassword(jar, { current: who.password, next: first }, freshOrigin())).toEqual({ kind: "changed" });
    expect(await services.changePassword(jar, { current: first, next: second }, freshOrigin())).toEqual({ kind: "changed" });
    expect(services.reported).toEqual([]);
    expect(await guard(jar)).toMatchObject({ kind: "pass" });
    expect(await sessionCount(who.id)).toBe(1);
    expect(await accepts(who, second)).toBe(true);
  });

  it("desde una dirección que no se conoce cambia igual, y ese par no queda de confianza", async () => {
    const who = await account();
    const { jar } = await open(who);
    const origin = freshOrigin();
    const services = testServices({ proxyTrusted: () => false });
    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, origin)).toEqual({ kind: "changed" });
    expect(await pairOf(keysOf(who.email, origin, false))).toMatchObject({ failed_count: 0, last_success_at: null });
    // En local es lo normal: nadie pone la cabecera.
    expect(services.reported).toEqual([]);
  });
});

describe("lo que se revisa sin preguntarle a nadie", () => {
  it.each([
    ["sin la contraseña actual", () => ({ current: "", next: fresh() }), { current: "required" }],
    ["con la nueva más corta que el mínimo", (who: KnownUser) => ({ current: who.password, next: "corta-7" }), { next: "too_short" }],
    [
      "con la nueva de más de 72 bytes",
      (who: KnownUser) => ({ current: who.password, next: "a".repeat(PASSWORD_MAX_BYTES + 1) }),
      { next: "too_long" },
    ],
    ["con un carácter de control en la nueva", (who: KnownUser) => ({ current: who.password, next: "abcdefgh\u0000i" }), { next: "malformed" }],
    ["con la nueva igual a la actual", (who: KnownUser) => ({ current: who.password, next: who.password }), { next: "same" }],
    ["sin ninguna de las dos", () => ({ current: "", next: "" }), { current: "required", next: "too_short" }],
  ])("%s: dice qué campo corregir, y no cuenta un intento ni le pregunta a Auth", async (_case, input, fields) => {
    const who = await account();
    const { jar } = await open(who);
    const rows = await throttleRows();
    const { services, calls } = watched();

    expect(await services.changePassword(jar, input(who), freshOrigin())).toEqual({ kind: "invalid", fields });

    expect(asked(calls, TOKEN) + asked(calls, USER)).toBe(0);
    expect(await throttleRows()).toBe(rows);
    expect(services.reported).toEqual([]);
    expect(await guard(jar)).toMatchObject({ kind: "pass" });
  });

  // Más larga de lo que la Plataforma deja fijar: no es la contraseña de nadie.
  it("una contraseña actual de más de 72 bytes no es la suya, y no cuesta un intento", async () => {
    const who = await account();
    const { jar } = await open(who);
    const rows = await throttleRows();
    const { services, calls } = watched();

    const input = { current: "€".repeat(25), next: fresh() };
    expect(await services.changePassword(jar, input, freshOrigin())).toEqual({ kind: "invalid", fields: { current: "mismatch" } });
    // En el límite sí se le pregunta a Auth: 24 signos de euro son 72 bytes.
    const edge = { current: "€".repeat(24), next: fresh() };
    expect(asked(calls, TOKEN)).toBe(0);
    expect(await throttleRows()).toBe(rows);
    expect(await services.changePassword(jar, edge, freshOrigin())).toEqual({ kind: "invalid", fields: { current: "mismatch" } });
    expect(asked(calls, TOKEN)).toBe(1);
  });
});

describe("con la contraseña actual equivocada", () => {
  it("no cambia nada, no cierra ninguna sesión y cuenta como un intento fallido de entrada", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    const before = await changedAt(who.id);
    const origin = freshOrigin();
    const { services, calls } = watched();

    expect(await services.changePassword(here.jar, { current: WRONG, next: fresh() }, origin)).toEqual({
      kind: "invalid",
      fields: { current: "mismatch" },
    });

    const keys = keysOf(who.email, origin);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(1);
    expect(asked(calls, USER)).toBe(0);
    expect(services.reported).toEqual([]);
    expect(await sessionCount(who.id)).toBe(2);
    expect(await changedAt(who.id)).toBe(before);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass", claims: { sessionId: here.claims.sessionId } });
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
    expect(here.jar.writes).toHaveLength(1);
    expect(await accepts(who, who.password)).toBe(true);
  });
});

describe("el freno de intentos es el de entrar", () => {
  it("los fallos de aquí y los de la pantalla de entrar se suman, y frenado ni se le pregunta a Auth", async () => {
    const who = await account();
    const { jar } = await open(who);
    const origin = freshOrigin();
    const services = testServices();
    for (let attempt = 1; attempt < params.threshold; attempt += 1) {
      expect((await services.changePassword(jar, { current: WRONG, next: fresh() }, origin)).kind).toBe("invalid");
    }
    expect(await services.signIn(memoryJar(), { email: who.email, password: WRONG }, origin)).toEqual({ kind: "invalid_credentials" });

    // Con la contraseña correcta, tampoco: hay que esperar.
    const spied = watched();
    const result = await spied.services.changePassword(jar, { current: who.password, next: fresh() }, origin);
    expect(result).toMatchObject({ kind: "throttled" });
    expect(result.kind === "throttled" && result.retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(asked(spied.calls, TOKEN) + asked(spied.calls, USER)).toBe(0);
    expect(spied.services.reported).toEqual([]);
    // Y al revés: lo que se falló aquí frena también la pantalla de entrar.
    expect((await testServices().signIn(memoryJar(), who, origin)).kind).toBe("throttled");

    expect(await guard(jar)).toMatchObject({ kind: "pass" });
    expect(await accepts(who, who.password)).toBe(true);
  });

  it.each(["ip", "account"] as const)("con el tope por hora lleno (%s) contesta «vuelve más tarde», sin preguntarle a Auth", async (which) => {
    const who = await account();
    const { jar } = await open(who);
    const origin = freshOrigin();
    await clearThrottle();
    await seedHits(signInBuckets(keysOf(who.email, origin))[which], params.hourlyCap);
    const { services, calls } = watched();

    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, origin)).toEqual({ kind: "capped" });
    expect(asked(calls, TOKEN)).toBe(0);
    expect(services.reported).toEqual([]);
  });

  it("si no consigue el candado de la huella, nadie pasa, no se le pregunta a Auth, y se reporta", async () => {
    const who = await account();
    const { jar } = await open(who);
    const origin = freshOrigin();
    const { services, calls } = watched();
    const unlock = await holdLock(keysOf(who.email, origin).account);
    try {
      expect(await services.changePassword(jar, { current: who.password, next: fresh() }, origin)).toEqual({ kind: "unavailable" });
    } finally {
      await unlock();
    }
    expect(services.reported).toEqual(["throttle_unavailable"]);
    expect(asked(calls, TOKEN)).toBe(0);
    expect(await accepts(who, who.password)).toBe(true);
  });

  it("si Auth no contesta al comprobar la actual, no se supo: nada cambia, y el par conserva el intento", async () => {
    const who = await account();
    const { jar } = await open(who);
    const origin = freshOrigin();
    const down = testServices({ auth: createAuth({ fetch: failingFetch(/\/token/, networkDown).fetch }) });

    expect(await down.changePassword(jar, { current: who.password, next: fresh() }, origin)).toEqual({ kind: "unavailable" });
    // Un corte de Auth no es una falla de esta cuenta: no se reporta como tal.
    expect(down.reported).toEqual([]);

    const keys = keysOf(who.email, origin);
    // Quien pudiera hacer que Auth no conteste no puede así probar contraseñas sin acumular.
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await hitsOf(signInBuckets(keys).ip)).toBe(0);
    expect(await guard(jar)).toMatchObject({ kind: "pass" });
  });

  // El cambio ya pasó la comprobación cuando el cierre del freno falla: sigue. El intento
  // queda contado como fallo, que es el lado seguro, y se reporta.
  it("si el cierre del intento falla, el cambio sigue, y se reporta", async () => {
    const who = await account();
    const { jar } = await open(who);
    const origin = freshOrigin();
    const keys = keysOf(who.email, origin);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const gated: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input instanceof Request ? input.url : input).includes("/token")) {
        arrive();
        await held;
      }
      return response;
    };
    const services = testServices({ auth: createAuth({ fetch: gated }) });
    const chosen = fresh();

    const pending = services.changePassword(jar, { current: who.password, next: chosen }, origin);
    await arrived;
    const unlock = await holdLock(keys.account);
    release();
    let result;
    try {
      result = await pending;
    } finally {
      await unlock();
    }

    expect(result).toEqual({ kind: "changed" });
    expect(services.reported).toEqual(["sign_in_settle_failed"]);
    expect(await pairOf(keys)).toMatchObject({ failed_count: 1, last_success_at: null });
    expect(await guard(jar)).toMatchObject({ kind: "pass" });
  });
});

describe("sin una sesión que pase la guarda no se cambia nada", () => {
  it("sin cookie", async () => {
    const who = await account();
    const { services, calls } = watched();
    const input = { current: who.password, next: fresh() };
    expect(await services.changePassword(memoryJar(), input, freshOrigin())).toEqual({ kind: "session", check: { kind: "anonymous" } });
    expect(asked(calls, TOKEN) + asked(calls, USER)).toBe(0);
    expect(await throttleRows()).toBe(0);
  });

  it("con una sesión abierta directo en Auth, que la aplicación no anotó", async () => {
    const who = await account();
    const jar = memoryJar();
    expect((await authSignIn(jar, who.email, who.password)).ok).toBe(true);
    const { services, calls } = watched();
    const input = { current: who.password, next: fresh() };
    expect(await services.changePassword(jar, input, freshOrigin())).toEqual({ kind: "session", check: CLOSED });
    expect(asked(calls, TOKEN) + asked(calls, USER)).toBe(0);
    expect(await accepts(who, who.password)).toBe(true);
  });

  it("con una cuenta a la que le falta algo: primero se lo pide su pantalla", async () => {
    const who = await account({ complete: false });
    const jar = memoryJar();
    expect((await testServices().signIn(jar, who, freshOrigin())).kind).toBe("entered");
    const { services, calls } = watched();
    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, freshOrigin())).toMatchObject({
      kind: "session",
      check: { kind: "incomplete" },
    });
    expect(asked(calls, TOKEN) + asked(calls, USER)).toBe(0);
  });

  it("con la cookie copiada de una sesión que ya salió", async () => {
    const who = await account();
    const { jar } = await open(who);
    const copied = jar.copy();
    await testServices().signOut(jar);
    const { services, calls } = watched();
    expect(await services.changePassword(copied, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "session",
      check: CLOSED,
    });
    expect(asked(calls, TOKEN) + asked(calls, USER)).toBe(0);
  });

  // La guarda de verdad no deja armar todos sus casos. Con una que contesta lo que se le
  // diga se ve lo que importa: el servicio obedece, aunque traiga la contraseña correcta.
  it("lo que no sea «pasa» se devuelve tal cual, y con la contraseña correcta tampoco se cambia", async () => {
    const who = await account();
    const here = await open(who);
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
    const rows = await throttleRows();
    for (const check of refusals) {
      const management = managementWith(check);
      const input = { current: who.password, next: fresh() };
      expect(await management.changePassword(here.jar, input, freshOrigin())).toEqual({ kind: "session", check });
      expect(management.reported).toEqual([]);
    }
    expect(await throttleRows()).toBe(rows);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass", claims: { sessionId: here.claims.sessionId } });
    expect(await accepts(who, who.password)).toBe(true);
  });
});

describe("de quién es la contraseña que se comprueba", () => {
  type Read = Awaited<ReturnType<AuthPort["readSession"]>>;

  /** Un Auth cuya segunda lectura de la sesión, la que da el correo, contesta otra cosa. */
  function secondRead(answer: (real: Read) => Read) {
    let reads = 0;
    return authWith((real) => ({
      readSession: async (reader) => {
        const read = await real.readSession(reader);
        reads += 1;
        return reads === 2 ? answer(read) : read;
      },
    }));
  }

  it.each([
    ["no trae correo", (read: Read): Read => (read.kind === "session" ? { ...read, email: null } : read)],
    ["trae algo que no es un correo", (read: Read): Read => (read.kind === "session" ? { ...read, email: "no es un correo" } : read)],
    ["ya no se puede leer", (): Read => ({ kind: "none" })],
  ])("si la sesión %s, no se supo: no se cuenta un intento ni se le pregunta a Auth, y se reporta", async (_case, answer) => {
    const who = await account();
    const { jar } = await open(who);
    const rows = await throttleRows();
    const { auth, calls } = secondRead(answer);
    const services = testServices({ auth });

    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
    expect(asked(calls, TOKEN)).toBe(0);
    expect(await throttleRows()).toBe(rows);
  });

  // No puede pasar hoy: el correo sale de la misma cookie que pasó la guarda. Si algún día
  // saliera de otro lado, la contraseña de otra cuenta no debe servir para cambiar esta.
  it("la contraseña correcta de otra cuenta no cambia la de ninguna de las dos", async () => {
    const who = await account();
    const other = await account();
    const { jar } = await open(who);
    const { auth, calls } = secondRead((read) => (read.kind === "session" ? { ...read, email: other.email } : read));
    const services = testServices({ auth });

    expect(await services.changePassword(jar, { current: other.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "invalid",
      fields: { current: "mismatch" },
    });
    expect(asked(calls, TOKEN)).toBe(1);
    expect(asked(calls, USER)).toBe(0);
    // La sesión que esa comprobación abrió en la otra cuenta se cerró.
    expect(await sessionCount(other.id)).toBe(0);
    expect(await notedSessions(other.id)).toBe(0);
    expect(await guard(jar)).toMatchObject({ kind: "pass" });
    expect(await accepts(who, who.password)).toBe(true);
    expect(await accepts(other, other.password)).toBe(true);
  });
});

describe("la cuenta deja de pasar la guarda a media operación", () => {
  // La guarda dijo «pasa» y, antes de comprobar la contraseña, a la cuenta le falta algo.
  it("no cambia la contraseña, cierra la sesión de la comprobación y contesta lo que la guarda dice ahora", async () => {
    const who = await account();
    const { jar } = await open(who);
    const { auth, calls } = authWith((real) => ({
      provePassword: async (email, password) => {
        await declareAdult(who.id, false);
        return real.provePassword(email, password);
      },
    }));
    const services = testServices({ auth });

    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, freshOrigin())).toMatchObject({
      kind: "session",
      check: { kind: "incomplete", missing: { adultDeclaration: true } },
    });
    // No es una caída: no se reporta nada.
    expect(services.reported).toEqual([]);
    expect(asked(calls, USER)).toBe(0);
    expect(await sessionCount(who.id)).toBe(1);
    expect(await accepts(who, who.password)).toBe(true);
  });

  it("si la guarda después insiste en que pasa, no se supo, y se reporta", async () => {
    const who = await account();
    const { jar } = await open(who);
    const { auth, calls } = authWith((real) => ({
      provePassword: async (email, password) => {
        await declareAdult(who.id, false);
        return real.provePassword(email, password);
      },
      discardProof: async (proven) => {
        await declareAdult(who.id, true);
        return real.discardProof(proven);
      },
    }));
    const services = testServices({ auth });

    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
    expect(asked(calls, USER)).toBe(0);
    expect(await sessionCount(who.id)).toBe(1);
  });

  it("si la guarda después tampoco supo, no se supo, y se reporta", async () => {
    const who = await account();
    const { jar } = await open(who);
    let reads = 0;
    const { auth } = authWith((real) => ({
      readSession: async (reader) => {
        reads += 1;
        return reads > 2 ? { kind: "unknown" } : real.readSession(reader);
      },
      provePassword: async (email, password) => {
        await declareAdult(who.id, false);
        return real.provePassword(email, password);
      },
    }));
    const services = testServices({ auth });

    expect(await services.changePassword(jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
    expect(await sessionCount(who.id)).toBe(1);
  });
});

describe("cuando la entrada de la comprobación no se puede admitir", () => {
  // La contraseña era la suya, pero la base no dejó anotar esa entrada: no se supo.
  it("no cambia nada, cierra esa sesión, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    let release: (() => Promise<void>) | undefined;
    const { auth, calls } = authWith((real) => ({
      provePassword: async (email, password) => {
        const proof = await real.provePassword(email, password);
        release = await holdProfile(who.id);
        return proof;
      },
    }));
    const services = testServices({ auth });
    try {
      expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
        kind: "unavailable",
      });
    } finally {
      await release?.();
    }
    expect(services.reported).toEqual(["gate_unavailable"]);
    expect(asked(calls, USER)).toBe(0);
    expect(await sessionCount(who.id)).toBe(1);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass", claims: { sessionId: here.claims.sessionId } });
  });
});

describe("cuando Auth no acepta la contraseña nueva", () => {
  it.each([
    ["dice que es la que ya tenía", "same_password", { kind: "invalid", fields: { next: "same" } }, []],
    ["dice que es débil", "weak_password", { kind: "invalid", fields: { next: "weak" } }, []],
    ["la rechaza", "rejected", { kind: "unavailable" }, ["account_unavailable"]],
  ] as const)("si %s: nada cambió, la sesión de la comprobación se cierra y la de este navegador sigue", async (_case, answer, expected, reported) => {
    const who = await account();
    const here = await open(who);
    const { auth } = authWith(() => ({ changeProvenPassword: () => Promise.resolve(answer) }));
    const services = testServices({ auth });

    expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual(expected);
    expect(services.reported).toEqual(reported);
    expect(await sessionCount(who.id)).toBe(1);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass", claims: { sessionId: here.claims.sessionId } });
    expect(here.jar.writes).toHaveLength(1);
    expect(await accepts(who, who.password)).toBe(true);
  });
});

describe("cuando Auth rechaza guardar por algo que no es la contraseña", () => {
  // Un límite de peticiones no deja duda: no se guardó. No se cierra nada.
  it("con el límite de peticiones de Auth: nada cambió, la sesión sigue, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    const before = await changedAt(who.id);
    const services = testServices({ auth: createAuth({ fetch: failingFetch(/\/auth\/v1\/user$/, tooManyRequests).fetch }) });

    expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "unavailable",
    });
    expect(services.reported).toEqual(["account_unavailable"]);
    expect(await sessionCount(who.id)).toBe(2);
    expect(await changedAt(who.id)).toBe(before);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass", claims: { sessionId: here.claims.sessionId } });
    expect(await guard(there.jar)).toMatchObject({ kind: "pass" });
    expect(await accepts(who, who.password)).toBe(true);
  });

  // Entre la comprobación y el guardado, las sesiones de la cuenta se cierran desde otro
  // lado. Auth rechaza guardar porque la sesión de la comprobación ya no existe. La de este
  // navegador tampoco: no es una caída, y se contesta lo que la guarda dice ahora.
  it("si las sesiones se cerraron desde otro lado a media operación: lo dice la guarda, y no se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const { auth } = authWith((real) => ({
      changeProvenPassword: async (proven, password) => {
        await ownerQuery("delete from auth.sessions where user_id = $1", [who.id]);
        return real.changeProvenPassword(proven, password);
      },
    }));
    const services = testServices({ auth });

    expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "session",
      check: CLOSED,
    });
    expect(services.reported).toEqual([]);
    expect(await accepts(who, who.password)).toBe(true);
  });
});

describe("cuando no se sabe si la contraseña cambió", () => {
  it("si Auth no contesta al guardarla: la cuenta queda sin sesiones, este navegador sin cookie, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    await elsewhere(who);
    const before = await changedAt(who.id);
    const services = testServices({ auth: createAuth({ fetch: failingFetch(/\/auth\/v1\/user$/, networkDown).fetch }) });

    expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "signed_out",
      password: "unknown",
    });
    expect(services.reported).toEqual(["password_change_unconfirmed"]);
    expect(await sessionCount(who.id)).toBe(0);
    expect(await notedSessions(who.id)).toBe(0);
    expect(here.jar.get(COOKIE)).toBeUndefined();
    expect(await guard(there.jar)).toEqual(CLOSED);
    // El cambio se fecha de todos modos: si sí cambió, es lo que deja fuera a una entrada vieja.
    expect(await changedAt(who.id)).toBeGreaterThan(before);
    // Aquí no cambió: se entra con la de antes.
    expect((await testServices().signIn(memoryJar(), who, freshOrigin())).kind).toBe("entered");
  });

  it("si Auth la guardó y su respuesta se perdió: lo mismo, y se entra con la nueva", async () => {
    const who = await account();
    const here = await open(who);
    const lost: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === USER) throw new TypeError("fetch failed");
      return response;
    };
    const services = testServices({ auth: createAuth({ fetch: lost }) });
    const chosen = fresh();

    expect(await services.changePassword(here.jar, { current: who.password, next: chosen }, freshOrigin())).toEqual({
      kind: "signed_out",
      password: "unknown",
    });
    expect(services.reported).toEqual(["password_change_unconfirmed"]);
    expect(await sessionCount(who.id)).toBe(0);
    expect(here.jar.get(COOKIE)).toBeUndefined();
    expect((await lastMailTo(who.email)).subject).toBe(CHANGED_MAIL);
    expect((await testServices().signIn(memoryJar(), who, freshOrigin())).kind).toBe("invalid_credentials");
    expect((await testServices().signIn(memoryJar(), { email: who.email, password: chosen }, freshOrigin())).kind).toBe("entered");
  });
});

describe("cuando la contraseña cambió y lo que sigue falla", () => {
  // La sesión de la comprobación ya cumplió. Si Auth no la cierra, nadie tiene sus tokens y
  // la aplicación no la reconoce, pero alguien tiene que saberlo.
  it("si la sesión de la comprobación no se pudo cerrar: el cambio sigue, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const services = testServices({ auth: createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch }) });

    expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({ kind: "changed" });
    expect(services.reported).toEqual(["session_not_closed"]);
    // Sigue viva en Auth, pero la aplicación solo tiene anotada la de este navegador.
    expect(await sessionCount(who.id)).toBe(2);
    expect(await notedSessions(who.id)).toBe(1);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
  });

  // Como si el código hubiera llegado antes que su migración: el servidor no puede fechar.
  it("si el cambio no se pudo fechar: la cuenta queda sin sesiones, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const there = await open(who);
    const chosen = fresh();
    const services = testServices();
    await ownerQuery(`revoke execute on function ${NOTE} from app_service`);
    try {
      expect(await services.changePassword(here.jar, { current: who.password, next: chosen }, freshOrigin())).toEqual({
        kind: "signed_out",
        password: "changed",
      });
    } finally {
      await ownerQuery(`grant execute on function ${NOTE} to app_service`);
    }
    expect(services.reported).toEqual(["password_change_incomplete"]);
    expect(await sessionCount(who.id)).toBe(0);
    expect(here.jar.get(COOKIE)).toBeUndefined();
    expect(await guard(there.jar)).toEqual(CLOSED);
    expect(await accepts(who, who.password)).toBe(false);
    expect((await testServices().signIn(memoryJar(), { email: who.email, password: chosen }, freshOrigin())).kind).toBe("entered");
  });

  // La base contesta que no fechó nada (la cuenta se quedó sin fecha de reclamo a media
  // operación). Solo «fechado» cuenta como fechado: lo demás es un cambio a medias.
  it("si la base contesta que no fechó: la cuenta queda sin sesiones, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const chosen = fresh();
    const { auth } = authWith((real) => ({
      changeProvenPassword: async (proven, password) => {
        const saved = await real.changeProvenPassword(proven, password);
        await ownerQuery("delete from private.account_security where profile_id = $1", [who.id]);
        return saved;
      },
    }));
    const services = testServices({ auth });

    expect(await services.changePassword(here.jar, { current: who.password, next: chosen }, freshOrigin())).toEqual({
      kind: "signed_out",
      password: "changed",
    });
    expect(services.reported).toEqual(["password_change_incomplete"]);
    expect(await sessionCount(who.id)).toBe(0);
    expect(here.jar.get(COOKIE)).toBeUndefined();
    expect(await accepts(who, chosen)).toBe(true);
  });

  it("si la entrada con la nueva no se logra: este navegador queda sin sesión, y hay que entrar", async () => {
    const who = await account();
    const here = await open(who);
    const chosen = fresh();
    const { auth } = authWith(() => ({ signIn: () => Promise.resolve({ ok: false, reason: "unknown" }) }));
    const services = testServices({ auth });

    expect(await services.changePassword(here.jar, { current: who.password, next: chosen }, freshOrigin())).toEqual({
      kind: "signed_out",
      password: "changed",
    });
    expect(await sessionCount(who.id)).toBe(0);
    expect(await notedSessions(who.id)).toBe(0);
    expect(here.jar.get(COOKIE)).toBeUndefined();
    expect(await accepts(who, chosen)).toBe(true);
  });

  it("si esa entrada no se puede anotar: su sesión se cierra, no llega al navegador, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    let release: (() => Promise<void>) | undefined;
    const { auth } = authWith((real) => ({
      signIn: async (jar, email, password) => {
        const entered = await real.signIn(jar, email, password);
        release = await holdProfile(who.id);
        return entered;
      },
    }));
    const services = testServices({ auth });
    try {
      expect(await services.changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
        kind: "signed_out",
        password: "changed",
      });
    } finally {
      await release?.();
    }
    expect(services.reported).toEqual(["gate_unavailable"]);
    expect(await sessionCount(who.id)).toBe(0);
    expect(here.jar.get(COOKIE)).toBeUndefined();
  });

  it("si el tarro no deja escribir la cookie nueva: su sesión se cierra, y se reporta", async () => {
    const who = await account();
    const here = await open(who);
    const sealed = {
      get: (name: string) => here.jar.get(name),
      set: () => {
        throw new Error("Aquí no se pueden escribir cookies.");
      },
    };
    const services = testServices();

    expect(await services.changePassword(sealed, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "signed_out",
      password: "changed",
    });
    expect(services.reported).toEqual(["session_cookie_not_written"]);
    expect(await sessionCount(who.id)).toBe(0);
  });
});

describe("lo que estaba en vuelo mientras cambiaba la contraseña", () => {
  // Auth acepta la contraseña de antes y su respuesta se detiene. Mientras, la contraseña
  // cambia desde la cuenta. Esa entrada empezó antes del cambio: no entra.
  it("una entrada con la contraseña de antes no se anota ni deja cookie", async () => {
    const who = await account();
    const here = await open(who);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const gated: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input instanceof Request ? input.url : input).includes("/token")) {
        arrive();
        await held;
      }
      return response;
    };
    const late = testServices({ auth: createAuth({ fetch: gated }) });
    const lateJar = memoryJar();

    const pending = late.signIn(lateJar, who, freshOrigin());
    await arrived;
    expect(await testServices().changePassword(here.jar, { current: who.password, next: fresh() }, freshOrigin())).toEqual({
      kind: "changed",
    });
    release();

    expect((await pending).kind).not.toBe("entered");
    expect(lateJar.writes).toEqual([]);
    expect(await notedSessions(who.id)).toBe(1);
    expect(await sessionCount(who.id)).toBe(1);
    expect(await guard(here.jar)).toMatchObject({ kind: "pass" });
  });

  // Lo que la fecha consigue, visto desde fuera del servicio. Una sesión viva en Auth, de
  // la cuenta, cuyo intento empezó antes del cambio: la base ya no la anota. Sin fechar, la
  // anotaría, porque el intento es posterior a la fecha de antes.
  it("después del cambio, una sesión viva cuyo intento empezó antes ya no se puede anotar", async () => {
    const who = await account();
    const here = await open(who);
    const chosen = fresh();
    const started = (await ownerQuery<{ at: string }>("select clock_timestamp()::text as at"))[0]?.at ?? "";

    expect(await testServices().changePassword(here.jar, { current: who.password, next: chosen }, freshOrigin())).toEqual({
      kind: "changed",
    });

    // Una sesión que Auth tiene viva y la aplicación no anotó, como la de una entrada en vuelo.
    expect((await authSignIn(memoryJar(), who.email, chosen)).ok).toBe(true);
    const loose = await ownerQuery<{ id: string }>(
      `select s.id::text as id from auth.sessions s
       where s.user_id = $1 and not exists (select 1 from private.app_sessions x where x.session_id = s.id)`,
      [who.id],
    );
    expect(loose).toHaveLength(1);
    const note = async (at: string) =>
      (
        await ownerQuery<{ state: string }>(
          `with actor as (select set_config('app.actor_id', $1, true))
           select private.note_session($2::uuid, $3::timestamptz) as state from actor`,
          [who.id, loose[0]?.id, at],
        )
      )[0]?.state;
    expect(await note(started)).toBe("stale");
    // La misma sesión, con un intento que empieza ahora, sí: lo que la detuvo fue la fecha.
    const now = (await ownerQuery<{ at: string }>("select clock_timestamp()::text as at"))[0]?.at ?? "";
    expect(await note(now)).toBe("noted");
  });

  // Fechar el cambio toma un candado de fila del perfil, el mismo que toma anotar una sesión:
  // así una entrada se anota antes, y el cambio la borra, o después, y ve la fecha nueva.
  // Con el perfil retenido por otra sesión de la base, fechar espera en lugar de adelantarse.
  it("fechar el cambio espera a quien tiene tomado el perfil", async () => {
    const who = await account();
    const before = await changedAt(who.id);
    const holder = new Client({ connectionString: localOwnerUrl() });
    const asker = new Client({ connectionString: localOwnerUrl() });
    await holder.connect();
    await asker.connect();
    try {
      await holder.query("begin");
      // El más débil que detiene a quien fecha: si la función bajara el suyo, esto ya no la detendría.
      await holder.query("select 1 from public.profiles where id = $1 for share", [who.id]);
      await asker.query("begin");
      await asker.query("set local lock_timeout = '400ms'");
      await asker.query("select set_config('app.actor_id', $1, true)", [who.id]);
      await expect(asker.query(`select ${NOTE}`)).rejects.toMatchObject({ code: "55P03" });
      await asker.query("rollback");
      await holder.query("rollback");

      // Con el perfil libre sí fecha.
      await asker.query("begin");
      await asker.query("select set_config('app.actor_id', $1, true)", [who.id]);
      expect((await asker.query<{ state: string }>(`select ${NOTE} as state`)).rows[0]?.state).toBe("noted");
      await asker.query("commit");
    } finally {
      await asker.query("rollback").catch(() => undefined);
      await holder.query("rollback").catch(() => undefined);
      await asker.end();
      await holder.end();
    }
    expect(await changedAt(who.id)).toBeGreaterThan(before);
  });

  // Dos navegadores de la misma cuenta la cambian a la vez. Gane quien gane, la aplicación
  // no reconoce una sesión que no haya terminado en «cambió», y a lo más reconoce una.
  it("dos cambios a la vez desde dos sesiones de la cuenta no dejan una sesión reconocida de más", async () => {
    const who = await account();
    const one = await open(who);
    const two = await open(who);
    const [first, second] = await Promise.all([
      testServices().changePassword(one.jar, { current: who.password, next: fresh() }, freshOrigin()),
      testServices().changePassword(two.jar, { current: who.password, next: fresh() }, freshOrigin()),
    ]);

    const passes = [(await guard(one.jar)).kind === "pass", (await guard(two.jar)).kind === "pass"];
    expect(passes.filter(Boolean).length).toBeLessThanOrEqual(1);
    if (passes[0]) expect(first).toEqual({ kind: "changed" });
    if (passes[1]) expect(second).toEqual({ kind: "changed" });
    expect([first.kind, second.kind].some((kind) => kind === "changed" || kind === "signed_out")).toBe(true);
    expect(await notedSessions(who.id)).toBe(passes.filter(Boolean).length);
    expect(await accepts(who, who.password)).toBe(false);
  });
});
