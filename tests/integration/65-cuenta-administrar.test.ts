import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, signIn as authSignIn, readSession } from "@/adapters/supabase/auth";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { PendingAccount, SessionCheck } from "@/services/account/account";
import { createManagement } from "@/services/account/management";
import type { FailureCode } from "@/services/error-reporting/server";

import { claimedUser, clearThrottle, freshOrigin, holdProfile, notedSessions, profileOf, testServices } from "./helpers/account";
import { knownUser, memoryJar, type KnownUser, type MemoryJar } from "./helpers/auth";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Administrar la cuenta (RF-109; FL-27; TRD §9.2): lo que la pantalla de la cuenta lee de
// la persona y el cambio de nombre, contra la base y el Auth locales. Lo que importa aquí
// es de quién es lo que se lee y sobre quién se escribe: siempre la cuenta de la sesión
// que pasó la guarda, y sin una sesión así no se escribe nada.

const MINUTE = 60_000;
const emails: string[] = [];

/** Una persona con la cuenta completa que ya entró por el servicio, con su cookie en un tarro. */
async function entered(name = "Persona de prueba"): Promise<{ account: KnownUser; jar: MemoryJar }> {
  const account = await claimedUser();
  emails.push(account.email);
  await completeAccountAsOwner(account.id, name);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, account, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return { account, jar };
}

/** Las claims con las que la guarda deja pasar a esa sesión: las que recibe la página. */
async function passedClaims(jar: MemoryJar): Promise<VerifiedClaims> {
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La sesión de prueba no pasó la guarda: ${check.kind}`);
  return check.claims;
}

/**
 * Las claims verificadas de una cuenta cuyo perfil ya no existe. La cuenta va sin
 * completar: un perfil con consentimientos no se puede borrar.
 */
async function claimsWithoutProfile(): Promise<VerifiedClaims> {
  const account = await claimedUser();
  emails.push(account.email);
  const jar = memoryJar();
  await testServices().signIn(jar, account, freshOrigin());
  const check = await testServices().checkSession(jar);
  if (check.kind !== "incomplete") throw new Error(`La cuenta de prueba no quedó sin completar: ${check.kind}`);
  await ownerQuery("delete from public.profiles where id = $1", [account.id]);
  return check.claims;
}

/** Todo lo que un cambio de nombre no debe tocar de una cuenta. */
async function restOf(userId: string) {
  const rows = await ownerQuery<{ adult_at: string | null; status: string; pending: boolean; consents: number }>(
    `select p.adult_declared_at::text as adult_at, p.status::text as status, p.password_reset_required as pending,
            (select count(*)::int from public.consents c where c.profile_id = p.id) as consents
     from public.profiles p where p.id = $1`,
    [userId],
  );
  return { ...rows[0], sessions: await notedSessions(userId) };
}

async function auditRows(): Promise<number> {
  const rows = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
  return rows[0]?.n ?? -1;
}

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

describe("lo que la pantalla pinta de la persona", () => {
  it("con las claims que dio la guarda, el nombre de esa cuenta", async () => {
    const { jar } = await entered("Ana de Prueba");
    const services = testServices();
    expect(await services.accountProfile(await passedClaims(jar))).toEqual({ kind: "ready", name: "Ana de Prueba" });
    expect(services.reported).toEqual([]);
  });

  it("cada quien lee solo el suyo", async () => {
    const ana = await entered("Ana");
    const beatriz = await entered("Beatriz");
    const services = testServices();
    expect(await services.accountProfile(await passedClaims(ana.jar))).toEqual({ kind: "ready", name: "Ana" });
    expect(await services.accountProfile(await passedClaims(beatriz.jar))).toEqual({ kind: "ready", name: "Beatriz" });
  });

  it("unas claims a las que se les cambió la cuenta no leen la de nadie: no se supo, y se reporta", async () => {
    const ana = await entered("Ana");
    const beatriz = await entered("Beatriz");
    const forged = { ...(await passedClaims(ana.jar)), userId: beatriz.account.id };
    const services = testServices();
    expect(await services.accountProfile(forged)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
  });

  it("con las claims ya vencidas, no se supo", async () => {
    const { jar } = await entered();
    const claims = await passedClaims(jar);
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + 60 * MINUTE);
    const services = testServices();
    expect(await services.accountProfile(claims)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
  });

  it("si el perfil ya no existe, no pinta un nombre vacío: no se supo", async () => {
    const claims = await claimsWithoutProfile();
    const services = testServices();
    expect(await services.accountProfile(claims)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["account_unavailable"]);
  });
});

describe("cambiar el nombre", () => {
  it("lo guarda sin espacios en los extremos, y la cuenta sigue pasando la guarda", async () => {
    const { account, jar } = await entered("Ana");
    const services = testServices();
    expect(await services.changeName(jar, { name: "  Beatriz de Prueba " })).toEqual({ kind: "saved", name: "Beatriz de Prueba" });
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Beatriz de Prueba" });
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: account.id } });
    expect(await services.accountProfile(await passedClaims(jar))).toEqual({ kind: "ready", name: "Beatriz de Prueba" });
    expect(services.reported).toEqual([]);
  });

  it("solo toca el nombre de esa cuenta: ni lo demás suyo, ni a nadie más, ni la auditoría", async () => {
    const ana = await entered("Ana");
    const otra = await entered("Otra persona");
    const before = { ana: await restOf(ana.account.id), otra: await restOf(otra.account.id), audit: await auditRows() };

    expect(await testServices().changeName(ana.jar, { name: "Ana María" })).toEqual({ kind: "saved", name: "Ana María" });

    expect(await profileOf(otra.account.id)).toMatchObject({ display_name: "Otra persona" });
    expect({ ana: await restOf(ana.account.id), otra: await restOf(otra.account.id), audit: await auditRows() }).toEqual(before);
    expect(before.ana).toMatchObject({ status: "active", pending: false, consents: 3, sessions: 1 });
    expect(before.ana.adult_at).not.toBeNull();
  });

  it.each([
    ["vacío", "", "empty"],
    ["solo espacios", "   ", "empty"],
    ["de 121 caracteres", "a".repeat(121), "too_long"],
    ["solo signos", "...", "invalid"],
    ["con un carácter que no se puede guardar", "Ana\u0000", "invalid"],
  ] as const)("un nombre %s no se guarda, y dice por qué", async (_case, name, reason) => {
    const { account, jar } = await entered("Ana");
    const services = testServices();
    expect(await services.changeName(jar, { name })).toEqual({ kind: "invalid", reason });
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana" });
    expect(services.reported).toEqual([]);
  });

  it("el más largo que se acepta cabe en la base: la regla y la tabla cuentan igual", async () => {
    const { account, jar } = await entered();
    // Fuera del plano básico: cada uno es un carácter para la persona y dos unidades para JavaScript.
    const longest = "𝒜".repeat(120);
    expect(await testServices().changeName(jar, { name: longest })).toEqual({ kind: "saved", name: longest });
    expect(await profileOf(account.id)).toMatchObject({ display_name: longest });
  });

  it("dos cambios a la vez: los dos se guardan, y queda uno de los dos", async () => {
    const { account, jar } = await entered("Ana");
    const services = testServices();
    expect(await Promise.all([services.changeName(jar, { name: "Uno" }), services.changeName(jar.copy(), { name: "Dos" })])).toEqual([
      { kind: "saved", name: "Uno" },
      { kind: "saved", name: "Dos" },
    ]);
    expect(["Uno", "Dos"]).toContain((await profileOf(account.id))?.display_name);
    expect(services.reported).toEqual([]);
  });

  it("si guardar falla, no se supo, se reporta y el nombre queda como estaba", async () => {
    const { account, jar } = await entered("Ana");
    const services = testServices();
    const release = await holdProfile(account.id);
    try {
      expect(await services.changeName(jar, { name: "Beatriz" })).toEqual({ kind: "unavailable" });
    } finally {
      await release();
    }
    expect(services.reported).toEqual(["account_unavailable"]);
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana" });
  });
});

describe("sin una sesión que pase la guarda no se cambia nada", () => {
  it("sin cookie: lo dice la guarda, antes de mirar el nombre", async () => {
    const services = testServices();
    expect(await services.changeName(memoryJar(), { name: "Ana" })).toEqual({ kind: "session", check: { kind: "anonymous" } });
    // Un nombre que no se puede guardar no le dice nada a quien no tiene sesión.
    expect(await services.changeName(memoryJar(), { name: "" })).toEqual({ kind: "session", check: { kind: "anonymous" } });
  });

  it("una sesión abierta directo en Auth", async () => {
    const { account } = await entered("Ana");
    const direct = memoryJar();
    expect((await authSignIn(direct, account.email, account.password)).ok).toBe(true);
    expect(await testServices().changeName(direct, { name: "Beatriz" })).toEqual({
      kind: "session",
      check: { kind: "must_sign_out", then: "sign_in" },
    });
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana" });
  });

  it("una cuenta a la que le falta algo: primero lo completa en su pantalla", async () => {
    const account = await claimedUser();
    emails.push(account.email);
    const jar = memoryJar();
    expect(await testServices().signIn(jar, account, freshOrigin())).toMatchObject({ kind: "entered" });

    expect(await testServices().changeName(jar, { name: "Ana" })).toMatchObject({
      kind: "session",
      check: { kind: "incomplete", variant: "complete_account" },
    });
    expect(await profileOf(account.id)).toMatchObject({ display_name: null, adult: false });
  });

  it("una cuenta con la marca de contraseña prendida: a recuperar", async () => {
    // No debería existir una sesión anotada así: se arma como dueño de la base.
    const account = await knownUser();
    emails.push(account.email);
    const jar = memoryJar();
    expect((await createAuth().signIn(jar, account.email, account.password)).ok).toBe(true);
    const read = await readSession(jar);
    if (read.kind !== "session" || read.claims.sessionId === null) throw new Error("La sesión de prueba no se leyó.");
    await ownerQuery("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [
      read.claims.sessionId,
      account.id,
    ]);

    expect(await testServices().changeName(jar, { name: "Ana" })).toEqual({
      kind: "session",
      check: { kind: "must_sign_out", then: "recover" },
    });
    expect(await profileOf(account.id)).toMatchObject({ display_name: null, pending: true });
  });

  it("una copia de la cookie, después de salir", async () => {
    const { account, jar } = await entered("Ana");
    const kept = jar.copy();
    expect(await testServices().signOut(jar)).toBe("closed");
    expect(await testServices().changeName(kept, { name: "Beatriz" })).toEqual({
      kind: "session",
      check: { kind: "must_sign_out", then: "sign_in" },
    });
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana" });
  });

  it("con el token vencido no se supo, y no se guarda", async () => {
    const { account, jar } = await entered("Ana");
    const later = testServices({ auth: createAuth({ now: () => Date.now() + 16 * MINUTE }) });
    expect(await later.changeName(jar, { name: "Beatriz" })).toEqual({ kind: "session", check: { kind: "unavailable" } });
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana" });
  });

  // La guarda de verdad no deja armar todos sus casos sobre una cuenta que además traiga
  // claims que la base acepte. Con una guarda que contesta lo que se le diga se ve lo que
  // importa: el servicio obedece, aunque tenga a la mano unas claims con las que podría escribir.
  it("lo que no sea «pasa» se devuelve tal cual, y con claims válidas en la mano tampoco se escribe", async () => {
    const { account, jar } = await entered("Ana");
    const claims = await passedClaims(jar);
    const pending: PendingAccount = {
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    };
    const refusals: SessionCheck[] = [
      { kind: "anonymous" },
      { kind: "incomplete", claims, ...pending },
      { kind: "suspended" },
      { kind: "must_sign_out", then: "sign_in" },
      { kind: "must_sign_out", then: "recover" },
      { kind: "unavailable" },
    ];
    for (const check of refusals) {
      const management = managementWith(check);
      expect(await management.changeName(jar, { name: "Beatriz" })).toEqual({ kind: "session", check });
      expect(management.reported).toEqual([]);
    }
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana" });
  });

  // La guarda corre en una transacción y la escritura en otra. Entre las dos la cuenta puede
  // dejar de pasar: se suspende, se le prende la marca de contraseña, retira un texto. Aquí
  // la guarda dice «pasa» sobre una cuenta que en la base no pasa, con claims que la base acepta.
  it("si la cuenta dejó de pasar la guarda entre la guarda y la escritura, no guarda", async () => {
    const account = await claimedUser();
    emails.push(account.email);
    const jar = memoryJar();
    await testServices().signIn(jar, account, freshOrigin());
    const check = await testServices().checkSession(jar);
    if (check.kind !== "incomplete") throw new Error(`La cuenta de prueba no quedó sin completar: ${check.kind}`);

    const management = managementWith({ kind: "pass", claims: check.claims });
    expect(await management.changeName(jar, { name: "Beatriz" })).toEqual({ kind: "unavailable" });
    expect(management.reported).toEqual(["account_unavailable"]);
    expect(await profileOf(account.id)).toMatchObject({ display_name: null });
  });

  it("si la cuenta desapareció entre la guarda y la escritura, no dice «guardado»", async () => {
    const claims = await claimsWithoutProfile();
    const management = managementWith({ kind: "pass", claims });
    expect(await management.changeName(memoryJar(), { name: "Beatriz" })).toEqual({ kind: "unavailable" });
    expect(management.reported).toEqual(["account_unavailable"]);
  });
});
