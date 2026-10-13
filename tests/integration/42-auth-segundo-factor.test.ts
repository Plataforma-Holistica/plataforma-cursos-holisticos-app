import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createAuth, enrollFactor, readSession, removeFactor, signIn, verifyFactor } from "@/adapters/supabase/auth";

import { knownUser, memoryJar, recordingFetch, secondFactorFor, sessionCount, type KnownUser, type MemoryJar } from "./helpers/auth";
import { parameter } from "./helpers/account";
import { totpCode, wrongCode } from "./helpers/totp";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// El segundo factor en el adaptador de Auth, contra el Auth local (TRD §9.2, fila «Segundo
// factor»): dar de alta un factor de aplicación de códigos, verificarlo y quitarlo, todo a
// nombre de la sesión de la cookie. Verificar no abre otra sesión: sube de nivel la misma y
// Auth entrega tokens nuevos, que son los que quedan en la cookie.

const COOKIE = "plataforma-sesion";
const emails: string[] = [];

afterAll(async () => {
  // El freno de los códigos guarda sus cuentas por factor; las de estas pruebas se van.
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

/** Una persona con la sesión abierta por el adaptador y su cookie en un tarro. */
async function entered(): Promise<{ person: KnownUser; jar: MemoryJar }> {
  const person = await knownUser();
  emails.push(person.email);
  const jar = memoryJar();
  const result = await signIn(jar, person.email, person.password);
  if (!result.ok) throw new Error(`La persona de prueba no entró: ${result.reason}`);
  return { person, jar };
}

const factorsOf = (userId: string) =>
  ownerQuery<{ id: string; status: string; type: string }>(
    "select id::text as id, status::text as status, factor_type::text as type from auth.mfa_factors where user_id = $1 order by created_at",
    [userId],
  );

const sessionsOf = (userId: string) =>
  ownerQuery<{ id: string; aal: string; factor: string | null }>(
    "select id::text as id, aal::text as aal, factor_id::text as factor from auth.sessions where user_id = $1",
    [userId],
  );

/** Da de alta un factor con esa sesión, y falla la prueba si no se pudo. */
async function enrolled(jar: MemoryJar): Promise<{ factorId: string; secret: string; uri: string }> {
  const result = await enrollFactor(jar);
  if (!result.ok) throw new Error(`El factor no se dio de alta: ${result.reason}`);
  return result;
}

describe("dar de alta un factor", () => {
  it("sin sesión no hay a nombre de quién", async () => {
    expect(await enrollFactor(memoryJar())).toEqual({ ok: false, reason: "no_session" });
    expect(await enrollFactor(memoryJar(new Map([[COOKIE, "esto-no-es-una-cookie"]])))).toEqual({ ok: false, reason: "no_session" });
  });

  it("con la sesión de la cookie queda uno sin verificar, y se entrega su clave para pintarla una vez", async () => {
    const { person, jar } = await entered();
    const before = jar.get(COOKIE);

    const factor = await enrolled(jar);

    expect(factor.factorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(factor.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(factor.uri.startsWith("otpauth://totp/")).toBe(true);
    expect(factor.uri).toContain(`secret=${factor.secret}`);
    expect(await factorsOf(person.id)).toEqual([{ id: factor.factorId, status: "unverified", type: "totp" }]);
    // Dar de alta no sube el nivel ni toca la cookie.
    expect(jar.get(COOKIE)).toBe(before);
    expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal1", factor: null }]);
  });

  it("empezar de nuevo quita el que quedó a medias: nunca se acumulan", async () => {
    const { person, jar } = await entered();
    const first = await enrolled(jar);
    const second = await enrolled(jar);
    expect(second.factorId).not.toBe(first.factorId);
    expect(second.secret).not.toBe(first.secret);
    expect(await factorsOf(person.id)).toEqual([{ id: second.factorId, status: "unverified", type: "totp" }]);
  });

  it("a una cuenta que ya tiene uno verificado, con la sesión en primer nivel, Auth no la deja: se dice", async () => {
    const person = await knownUser();
    emails.push(person.email);
    const existing = await secondFactorFor(person);
    const jar = memoryJar();
    expect((await signIn(jar, person.email, person.password)).ok).toBe(true);

    expect(await enrollFactor(jar)).toEqual({ ok: false, reason: "needs_second_level" });
    // Y el que tenía sigue ahí: no se le borra nada verificado.
    expect(await factorsOf(person.id)).toEqual([{ id: existing.factorId, status: "verified", type: "totp" }]);
  });

  it("si Auth no contesta, no se supo", async () => {
    const { jar } = await entered();
    const down = createAuth({ fetch: () => Promise.reject(new Error("sin red")) });
    expect(await down.enrollFactor(jar)).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("verificar un código", () => {
  it("con el código bueno la misma sesión sube de nivel, y la cookie lleva los tokens nuevos", async () => {
    const { person, jar } = await entered();
    const before = jar.get(COOKIE);
    const [session] = await sessionsOf(person.id);
    const factor = await enrolled(jar);

    const result = await verifyFactor(jar, factor.factorId, totpCode(factor.secret));

    expect(result).toMatchObject({ kind: "verified", claims: { userId: person.id, aal: "aal2", sessionId: session?.id } });
    expect(jar.get(COOKIE)).toBeDefined();
    expect(jar.get(COOKIE)).not.toBe(before);
    expect(await factorsOf(person.id)).toEqual([{ id: factor.factorId, status: "verified", type: "totp" }]);
    expect(await sessionsOf(person.id)).toEqual([{ id: session?.id, aal: "aal2", factor: factor.factorId }]);
    // La cookie nueva se lee como una sesión de segundo nivel de la misma cuenta.
    expect(await readSession(jar)).toMatchObject({ kind: "session", claims: { userId: person.id, aal: "aal2", sessionId: session?.id } });
  });

  it("con un código equivocado no cambia nada: ni el factor, ni la sesión, ni la cookie", async () => {
    const { person, jar } = await entered();
    const before = jar.get(COOKIE);
    const factor = await enrolled(jar);

    expect(await verifyFactor(jar, factor.factorId, wrongCode(factor.secret))).toEqual({ kind: "wrong_code" });

    expect(jar.get(COOKIE)).toBe(before);
    expect(await factorsOf(person.id)).toEqual([{ id: factor.factorId, status: "unverified", type: "totp" }]);
    expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal1", factor: null }]);
    // Y el bueno sigue sirviendo después: un fallo no gasta nada.
    expect(await verifyFactor(jar, factor.factorId, totpCode(factor.secret))).toMatchObject({ kind: "verified" });
  });

  it.each(["", "12345", "1234567", "12345a", " 123456", "１２３４５６"])("lo que no son seis dígitos (%j) no llega a Auth", async (code) => {
    const { jar } = await entered();
    const factor = await enrolled(jar);
    const watched = recordingFetch();
    const auth = createAuth({ fetch: watched.fetch });
    expect(await auth.verifyFactor(jar, factor.factorId, code)).toEqual({ kind: "wrong_code" });
    expect(watched.calls).toEqual([]);
  });

  it("un factor que no tiene forma de serlo tampoco llega a Auth", async () => {
    const { jar } = await entered();
    const watched = recordingFetch();
    const auth = createAuth({ fetch: watched.fetch });
    expect(await auth.verifyFactor(jar, "../user", "123456")).toEqual({ kind: "factor_gone" });
    expect(watched.calls).toEqual([]);
  });

  it("si el factor ya no existe, se dice: hay que empezar de nuevo, no reintentar", async () => {
    const { jar } = await entered();
    const first = await enrolled(jar);
    // Empezar de nuevo quitó el primero.
    await enrolled(jar);
    expect(await verifyFactor(jar, first.factorId, totpCode(first.secret))).toEqual({ kind: "factor_gone" });
    expect(await verifyFactor(jar, randomUUID(), "123456")).toEqual({ kind: "factor_gone" });
  });

  it("sin sesión no se verifica nada", async () => {
    expect(await verifyFactor(memoryJar(), randomUUID(), "123456")).toEqual({ kind: "no_session" });
  });

  it("quien ya tiene su factor da el código al entrar, y su sesión sube de nivel", async () => {
    const person = await knownUser();
    emails.push(person.email);
    const factor = await secondFactorFor(person);
    const jar = memoryJar();
    expect((await signIn(jar, person.email, person.password)).ok).toBe(true);

    expect(await verifyFactor(jar, factor.factorId, totpCode(factor.secret))).toMatchObject({ kind: "verified", claims: { aal: "aal2" } });
    expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal2", factor: factor.factorId }]);
  });

  it("el factor de otra cuenta no se puede verificar con esta sesión", async () => {
    const other = await knownUser();
    emails.push(other.email);
    const theirs = await secondFactorFor(other);
    const { person, jar } = await entered();

    expect(await verifyFactor(jar, theirs.factorId, totpCode(theirs.secret))).toEqual({ kind: "factor_gone" });
    expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal1", factor: null }]);
  });

  it("pasado el límite de fallos el freno rechaza: Auth cierra todas las sesiones y la cookie se borra", async () => {
    const person = await knownUser();
    emails.push(person.email);
    const factor = await secondFactorFor(person);
    const jar = memoryJar();
    expect((await signIn(jar, person.email, person.password)).ok).toBe(true);
    const limit = await parameter("INTENTOS_ANTES_DE_FRENO");

    // Los fallos de antes del límite solo dicen que el código no coincide.
    for (let attempt = 1; attempt < limit; attempt += 1) {
      expect(await verifyFactor(jar, factor.factorId, wrongCode(factor.secret))).toEqual({ kind: "wrong_code" });
    }
    expect(await sessionCount(person.id)).toBe(1);
    // El que llega al límite ya lo rechaza el freno.
    expect(await verifyFactor(jar, factor.factorId, wrongCode(factor.secret))).toEqual({ kind: "throttled" });
    expect(jar.get(COOKIE)).toBeUndefined();
    expect(await sessionCount(person.id)).toBe(0);

    // Y mientras dura la espera, ni el código bueno pasa: entrar de nuevo no la salta.
    const again = memoryJar();
    expect((await signIn(again, person.email, person.password)).ok).toBe(true);
    expect(await verifyFactor(again, factor.factorId, totpCode(factor.secret))).toEqual({ kind: "throttled" });
    expect(again.get(COOKIE)).toBeUndefined();
    expect(await sessionCount(person.id)).toBe(0);
  });

  it("si Auth no contesta, no se supo, y la cookie sigue como estaba", async () => {
    const { jar } = await entered();
    const factor = await enrolled(jar);
    const before = jar.get(COOKIE);
    const down = createAuth({ fetch: () => Promise.reject(new Error("sin red")) });
    expect(await down.verifyFactor(jar, factor.factorId, totpCode(factor.secret))).toEqual({ kind: "unknown" });
    expect(jar.get(COOKIE)).toBe(before);
  });
});

describe("quitar un factor", () => {
  it("el que se acaba de verificar, con esa misma sesión, se quita", async () => {
    const { person, jar } = await entered();
    const factor = await enrolled(jar);
    expect(await verifyFactor(jar, factor.factorId, totpCode(factor.secret))).toMatchObject({ kind: "verified" });

    expect(await removeFactor(jar, factor.factorId)).toBe("removed");
    expect(await factorsOf(person.id)).toEqual([]);
  });

  it("uno que ya no está cuenta como quitado; sin sesión o sin respuesta, no se supo", async () => {
    const { jar } = await entered();
    expect(await removeFactor(jar, randomUUID())).toBe("removed");
    expect(await removeFactor(memoryJar(), randomUUID())).toBe("unknown");
    const factor = await enrolled(jar);
    const down = createAuth({ fetch: () => Promise.reject(new Error("sin red")) });
    expect(await down.removeFactor(jar, factor.factorId)).toBe("unknown");
  });
});
