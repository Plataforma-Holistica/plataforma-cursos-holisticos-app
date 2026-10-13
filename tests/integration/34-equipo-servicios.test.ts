import { randomBytes, randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import type { Client } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import * as adapter from "@/adapters/supabase/auth";
import { readSessionCookie, type CookieJar } from "@/adapters/supabase/auth-cookies";
import { proxy } from "@/proxy";
import { forgetBrowserProofs, type TeamStanding } from "@/services/account/account";
import { databaseTeamStore } from "@/services/account/team-store";

import { claimedUser, freshOrigin, parameter, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor, sessionCount, type KnownUser, type MemoryJar } from "./helpers/auth";
import { answer, answeringStore, asOwner, asServer, asSystem, print, reverted, teamStoreOn } from "./helpers/team";
import { totpCode, wrongCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Los servicios del equipo (RF-105, RF-106; TRD §9.2, filas «Segundo factor» e
// «Invitaciones»), contra el Auth y la base locales: en qué estado está alguien, configurar
// el segundo factor (que es aceptar la invitación) y dar el código al entrar.
//
// La guarda de sesión y Auth corren de verdad y confirman lo suyo. Lo que cambia el equipo
// queda en la auditoría, que no admite borrado: por eso la invitación y su aceptación viven
// en una transacción del dueño que se revierte, y los servicios le preguntan a la base por
// ella (`teamStoreOn`), con las mismas dos consultas que usa la aplicación. El almacén de
// verdad se prueba en lo que no deja residuo: leer, y un «no hay invitación».

const SESSION = "plataforma-sesion";
const TICKET = "plataforma-resguardo";
const FACTOR = "plataforma-factor";
const COOKIE = { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 3600 } as const;
const emails: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  // El freno de los códigos guarda sus cuentas por factor; las de estas pruebas se van.
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

interface Entered {
  person: KnownUser;
  jar: MemoryJar;
  sessionId: string;
}

/** Una persona con la cuenta completa que ya entró por el servicio, con su cookie en un tarro. */
async function entered(person?: KnownUser): Promise<Entered> {
  const account = person ?? (await completed());
  const jar = memoryJar();
  const result = await testServices().signIn(jar, account, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La sesión de prueba no pasó la guarda: ${check.kind}`);
  return { person: account, jar, sessionId: check.claims.sessionId ?? "" };
}

/** Una cuenta completa, a la que la guarda de sesión deja pasar. */
async function completed(): Promise<KnownUser> {
  const account = await claimedUser();
  emails.push(account.email);
  await completeAccountAsOwner(account.id);
  return account;
}

/** Un secreto con la forma del resguardo del buzón, puesto en ese navegador. */
function withTicket(jar: MemoryJar): string {
  const secret = randomBytes(32).toString("base64url");
  jar.set(TICKET, secret, COOKIE);
  return secret;
}

/**
 * La persona prueba su buzón dentro de la transacción: el servidor reclama su cuenta con la
 * huella del resguardo que trae su navegador. Reclamar borra lo anotado, y la sesión con la
 * que sigue se anota de nuevo, que es lo que haría entrar otra vez.
 */
async function proveMailbox(owner: Client, who: Entered, secret: string): Promise<void> {
  await asServer(owner, who.person.id, who.sessionId);
  expect(await answer(owner, "private.claim_account($1)", [print(secret)])).toBe("already_claimed");
  await asOwner(owner);
  await owner.query("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [who.sessionId, who.person.id]);
}

/**
 * Alguien con una copia de esa sesión le habla directo a Auth, sin pasar por la aplicación.
 * Lo que Auth le devuelva no llega al navegador de la persona: su cookie sigue como estaba.
 */
async function outside(jar: MemoryJar, path: string, body: unknown): Promise<Record<string, unknown>> {
  const cookie = readSessionCookie(jar, false);
  if (cookie.kind !== "tokens") throw new Error("El tarro de prueba no trae una sesión.");
  const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1${path}`, {
    method: "POST",
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
      authorization: `Bearer ${cookie.tokens.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const answered = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Auth rechazó ${path}: ${String(answered.code ?? response.status)}`);
  return answered;
}

/** Da de alta y verifica un factor propio por fuera: la sesión queda en segundo nivel con él. */
async function outsideFactor(jar: MemoryJar | CookieJar): Promise<{ factorId: string; secret: string }> {
  const memory = jar as MemoryJar;
  const factor = await outside(memory, "/factors", { factor_type: "totp", friendly_name: `fuera-${randomUUID()}` });
  const factorId = String(factor.id);
  const secret = String((factor.totp as { secret?: unknown } | undefined)?.secret);
  const challenge = await outside(memory, `/factors/${factorId}/challenge`, {});
  await outside(memory, `/factors/${factorId}/verify`, { challenge_id: challenge.id, code: totpCode(secret) });
  return { factorId, secret };
}

/**
 * El adaptador de Auth de verdad, salvo el cierre de sesión. Aceptar borra en la base la
 * sesión con la que se acepta, y aquí eso ocurre dentro de una transacción que se revierte:
 * el borrado queda sin confirmar y con su fila tomada, y el cierre de verdad se quedaría
 * esperándola. Se le contesta lo que Auth contesta ya confirmado el borrado, que la sesión
 * no existe, y se anota que el servicio lo pidió.
 */
function authAfterAccepting(): { auth: ReturnType<typeof adapter.createAuth>; logouts: string[] } {
  const logouts: string[] = [];
  const auth = adapter.createAuth({
    fetch: (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (!path.endsWith("/logout")) return fetch(input, init);
      logouts.push(path);
      return Promise.resolve(Response.json({ code: "session_not_found", message: "x" }, { status: 403 }));
    },
  });
  return { auth, logouts };
}

/** Las sesiones de esa cuenta, como las ve la transacción: en Auth y en lo anotado. */
async function sessionsIn(owner: Client, userId: string): Promise<number> {
  const rows = await owner.query(
    "select 1 from auth.sessions where user_id = $1 union all select 1 from private.app_sessions where profile_id = $1",
    [userId],
  );
  return rows.rows.length;
}

const factorsOf = (userId: string) =>
  ownerQuery<{ id: string; status: string }>(
    "select id::text as id, status::text as status from auth.mfa_factors where user_id = $1 order by created_at",
    [userId],
  );

const sessionsOf = (userId: string) =>
  ownerQuery<{ id: string; aal: string; factor: string | null }>(
    "select id::text as id, aal::text as aal, factor_id::text as factor from auth.sessions where user_id = $1",
    [userId],
  );

async function auditRows(): Promise<number> {
  const rows = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
  return rows[0]?.n ?? -1;
}

/** Lo que la transacción ve del equipo de esa persona. */
async function teamOf(owner: Client, userId: string) {
  const bound = await owner.query<{ factor: string }>("select factor_id::text as factor from private.admin_factors where profile_id = $1", [userId]);
  const capabilities = await owner.query<{ capability: string; by: string | null }>(
    "select capability::text as capability, granted_by::text as by from public.admin_capabilities where profile_id = $1 and revoked_at is null order by 1",
    [userId],
  );
  const invitations = await owner.query<{ kind: string; accepted: boolean; revoked: boolean; failures: number }>(
    `select kind, accepted_at is not null as accepted, revoked_at is not null as revoked, handoff_failures as failures
     from private.admin_invitations where profile_id = $1 order by created_at`,
    [userId],
  );
  const ticket = await owner.query<{ ticket: string | null }>("select mailbox_ticket as ticket from private.account_security where profile_id = $1", [userId]);
  return {
    factor: bound.rows[0]?.factor ?? null,
    capabilities: capabilities.rows,
    invitations: invitations.rows,
    ticket: ticket.rows[0]?.ticket ?? null,
  };
}

describe("quien no es del equipo, con el almacén de verdad", () => {
  it("su estado es «ninguno», y nada de lo que sigue hace algo: ni en Auth, ni en la auditoría", async () => {
    const { person, jar } = await entered();
    withTicket(jar);
    const audited = await auditRows();
    const services = testServices();

    const team = await services.teamStanding(jar);
    expect(team).toMatchObject({ kind: "team", standing: { state: "none" }, claims: { userId: person.id } });
    expect(await services.startSecondFactor(jar)).toEqual({ kind: "not_invited" });
    expect(await services.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "not_invited" });
    expect(await services.giveSecondFactorCode(jar, "123456")).toEqual({ kind: "not_member" });

    expect(await factorsOf(person.id)).toEqual([]);
    expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal1", factor: null }]);
    expect(jar.get(FACTOR)).toBeUndefined();
    expect(await auditRows()).toBe(audited);
    expect(services.reported).toEqual([]);
  });

  it("sin sesión, la guarda contesta primero y a la base no se le pregunta por el equipo", async () => {
    const asked: string[] = [];
    const services = testServices({
      teamStore: {
        standing: () => {
          asked.push("standing");
          return Promise.reject(new Error("no debía preguntarse"));
        },
        accept: () => {
          asked.push("accept");
          return Promise.reject(new Error("no debía preguntarse"));
        },
      },
    });
    const jar = memoryJar();
    expect(await services.teamStanding(jar)).toEqual({ kind: "anonymous" });
    expect(await services.startSecondFactor(jar)).toEqual({ kind: "anonymous" });
    expect(await services.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "anonymous" });
    expect(await services.giveSecondFactorCode(jar, "123456")).toEqual({ kind: "anonymous" });
    expect(asked).toEqual([]);
  });

  it("aceptar de verdad, sin invitación: «no hay invitación», y el factor recién verificado se quita", async () => {
    const { person, jar } = await entered();
    const secret = withTicket(jar);
    const audited = await auditRows();
    // El estado lo contesta la prueba; aceptar va a la base, como servidor y confirmando.
    const invited: TeamStanding = { state: "invited", kind: "grant", capabilities: ["support"] };
    const services = testServices({ teamStore: { standing: () => Promise.resolve(invited), accept: databaseTeamStore.accept } });

    const started = await services.startSecondFactor(jar);
    if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);
    expect(await factorsOf(person.id)).toEqual([{ id: started.factorId, status: "unverified" }]);

    expect(await services.confirmSecondFactor(jar, { code: totpCode(started.secret) })).toEqual({ kind: "not_invited" });

    // Nada quedó: ni el factor, ni su cookie, ni un renglón de auditoría. La sesión sigue.
    expect(await factorsOf(person.id)).toEqual([]);
    expect(jar.get(FACTOR)).toBeUndefined();
    expect(jar.get(TICKET)).toBe(secret);
    expect(await sessionCount(person.id)).toBe(1);
    expect(await auditRows()).toBe(audited);
    expect(services.reported).toEqual([]);
  });
});

describe("aceptar una invitación configurando el segundo factor", () => {
  it("de punta a punta: invitada, con el buzón probado, da de alta su factor, lo verifica y queda atada", async () => {
    const who = await entered();
    const { person, jar } = who;
    const secret = withTicket(jar);

    await reverted(async (owner) => {
      const { auth, logouts } = authAfterAccepting();
      const services = testServices({ teamStore: teamStoreOn(owner), auth });
      await asSystem(owner);
      expect(await answer(owner, "private.system_invite_admin($1, '{support}')", [person.email])).toBe("invited_existing");
      await asOwner(owner);

      // Invitada, pero su navegador no trae el resguardo que la base conoce.
      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", standing: { state: "invited_unproven", kind: "grant" } });
      expect(await services.startSecondFactor(jar)).toEqual({ kind: "needs_mailbox_proof" });
      expect(await services.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "needs_mailbox_proof" });
      expect(await factorsOf(person.id)).toEqual([]);

      await proveMailbox(owner, who, secret);
      expect(await services.teamStanding(jar)).toMatchObject({
        kind: "team",
        standing: { state: "invited", kind: "grant", capabilities: ["support"] },
      });
      // Sin haber empezado no hay qué confirmar.
      expect(await services.confirmSecondFactor(jar, { code: "123456" })).toEqual({ kind: "start_again" });

      const started = await services.startSecondFactor(jar);
      if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);
      expect(jar.get(FACTOR)).toBe(`${who.sessionId}.${started.factorId}`);
      expect(await factorsOf(person.id)).toEqual([{ id: started.factorId, status: "unverified" }]);

      // Un código equivocado no ata nada ni gasta nada.
      expect(await services.confirmSecondFactor(jar, { code: wrongCode(started.secret) })).toEqual({ kind: "wrong_code" });
      expect(await teamOf(owner, person.id)).toMatchObject({ factor: null, capabilities: [] });
      expect(jar.get(FACTOR)).toBe(`${who.sessionId}.${started.factorId}`);

      expect(await services.confirmSecondFactor(jar, { code: totpCode(started.secret) })).toEqual({ kind: "accepted" });

      // Atada al factor que el servidor dio de alta, con lo que la invitación daba.
      expect(await teamOf(owner, person.id)).toEqual({
        factor: started.factorId,
        capabilities: [{ capability: "support", by: null }],
        invitations: [{ kind: "grant", accepted: true, revoked: false, failures: 0 }],
        ticket: null,
      });
      // La sesión con la que aceptó la cerró la base, en la misma transacción que ató.
      expect(await sessionsIn(owner, person.id)).toBe(0);
      // Y sin nada en el navegador: su cookie se borró, y el resguardo y el factor se gastaron.
      expect(jar.get(SESSION)).toBeUndefined();
      expect(jar.get(TICKET)).toBeUndefined();
      expect(jar.get(FACTOR)).toBeUndefined();
      // El servidor le pidió a Auth cerrarla igual; que ya no exista cuenta como cerrada.
      expect(logouts).toHaveLength(1);
      // Con su atadura y sin sesión que pase la puerta: está a un código de entrar.
      await asServer(owner, person.id, who.sessionId);
      const standing = await owner.query<{ state: string }>("select state from private.team_standing(null)");
      await asOwner(owner);
      expect(standing.rows).toEqual([{ state: "needs_code" }]);
      expect(await factorsOf(person.id)).toEqual([{ id: started.factorId, status: "verified" }]);
      expect(services.reported).toEqual([]);
    });

    // Nada de eso quedó: la transacción se revirtió.
    expect(await ownerQuery("select 1 from private.admin_invitations where email = $1", [person.email.toLowerCase()])).toEqual([]);
    expect(await ownerQuery("select 1 from private.admin_factors where profile_id = $1", [person.id])).toEqual([]);
  });

  it("un restablecimiento pide además el código dictado: sin forma no se intenta, equivocado cuenta, y bien dicho ata", async () => {
    const who = await entered();
    const { person, jar } = who;
    const secret = withTicket(jar);
    const dictated = "K7QM2X9P";

    await reverted(async (owner) => {
      const { auth, logouts } = authAfterAccepting();
      const services = testServices({ teamStore: teamStoreOn(owner), auth });
      // Conserva su capacidad y perdió su atadura: tiene una invitación de restablecimiento.
      await asSystem(owner);
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'support')", [person.id]);
      await owner.query(
        `insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
         values ('rebind', $1, $2, '{}', $3, clock_timestamp(), clock_timestamp() + interval '1 day')`,
        [person.email.toLowerCase(), person.id, print(dictated)],
      );
      await asOwner(owner);
      await proveMailbox(owner, who, secret);
      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", standing: { state: "invited", kind: "rebind", capabilities: [] } });

      const started = await services.startSecondFactor(jar);
      if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);
      const code = () => totpCode(started.secret);

      // Sin código dictado, o con uno sin forma: ni se verifica ni se le pregunta a la base.
      expect(await services.confirmSecondFactor(jar, { code: code() })).toEqual({ kind: "needs_handoff" });
      expect(await services.confirmSecondFactor(jar, { code: code(), handoff: "k7q" })).toEqual({ kind: "needs_handoff" });
      expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal1", factor: null }]);
      expect((await teamOf(owner, person.id)).invitations).toEqual([{ kind: "rebind", accepted: false, revoked: false, failures: 0 }]);

      // Con forma pero equivocado: el factor ya se verificó, la base cuenta el fallo y no ata.
      expect(await services.confirmSecondFactor(jar, { code: code(), handoff: "ZZZZ9999" })).toEqual({ kind: "needs_handoff" });
      expect(await teamOf(owner, person.id)).toMatchObject({
        factor: null,
        invitations: [{ kind: "rebind", accepted: false, revoked: false, failures: 1 }],
      });
      expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal2", factor: started.factorId }]);
      // El factor se queda, para el siguiente intento.
      expect(jar.get(FACTOR)).toBe(`${who.sessionId}.${started.factorId}`);

      // Como se dicta por voz: en minúsculas y con guion.
      expect(await services.confirmSecondFactor(jar, { code: code(), handoff: "k7qm-2x9p" })).toEqual({ kind: "accepted" });
      expect(await teamOf(owner, person.id)).toEqual({
        factor: started.factorId,
        // Las que conservaba: aceptar un restablecimiento no da ninguna.
        capabilities: [{ capability: "support", by: null }],
        invitations: [{ kind: "rebind", accepted: true, revoked: false, failures: 1 }],
        ticket: null,
      });
      expect(jar.get(SESSION)).toBeUndefined();
      expect(await sessionsIn(owner, person.id)).toBe(0);
      expect(logouts).toHaveLength(1);
      expect(services.reported).toEqual([]);
    });
  });

  it("un factor verificado por fuera no es el que se ata, y el camino del servidor no lo toma", async () => {
    const who = await entered();
    const { person, jar } = who;
    const secret = withTicket(jar);

    await reverted(async (owner) => {
      const { auth } = authAfterAccepting();
      const services = testServices({ teamStore: teamStoreOn(owner), auth });
      await asSystem(owner);
      expect(await answer(owner, "private.system_invite_admin($1, '{support}')", [person.email])).toBe("invited_existing");
      await asOwner(owner);
      await proveMailbox(owner, who, secret);

      const started = await services.startSecondFactor(jar);
      if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);

      // Alguien con una copia de esa sesión habla directo con Auth, sin pasar por la
      // aplicación: da de alta su propio factor y lo verifica. La sesión queda en segundo
      // nivel con ese factor, y Auth borra el que estaba a medias (medido aquí).
      const theirs = await outsideFactor(jar);
      expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal2", factor: theirs.factorId }]);
      expect(await factorsOf(person.id)).toEqual([{ id: theirs.factorId, status: "verified" }]);

      // El servidor verifica el factor que él anotó, no el de la sesión: ya no existe, y a
      // la base no se le pregunta nada. Tampoco con el código del factor de fuera.
      expect(await services.confirmSecondFactor(jar, { code: totpCode(theirs.secret) })).toEqual({ kind: "start_again" });
      expect(jar.get(FACTOR)).toBeUndefined();

      expect(await teamOf(owner, person.id)).toMatchObject({
        factor: null,
        capabilities: [],
        invitations: [{ kind: "grant", accepted: false, revoked: false, failures: 0 }],
      });

      // La persona empieza de nuevo en su navegador. Auth la deja dar de alta otro porque el
      // nivel es de la sesión, que ya subió, y no del token de su cookie (medido aquí). El
      // que queda atado es ese, el del servidor, y el de fuera se va al aceptar.
      const again = await services.startSecondFactor(jar);
      if (again.kind !== "started") throw new Error(`No empezó de nuevo: ${again.kind}`);
      expect(await services.confirmSecondFactor(jar, { code: totpCode(again.secret) })).toEqual({ kind: "accepted" });
      expect((await teamOf(owner, person.id)).factor).toBe(again.factorId);
      const left = await owner.query<{ id: string }>("select id::text as id from auth.mfa_factors where user_id = $1", [person.id]);
      expect(left.rows).toEqual([{ id: again.factorId }]);
      // Y la sesión que el de fuera había subido de nivel se cerró con la aceptación.
      expect(await sessionsIn(owner, person.id)).toBe(0);
      expect(services.reported).toEqual([]);
    });
  });

  it("dos pestañas y un doble envío: la clave de la primera ya no vale y no gasta intentos, y el segundo envío no rompe nada", async () => {
    const who = await entered();
    const { person, jar } = who;
    const secret = withTicket(jar);

    await reverted(async (owner) => {
      const { auth, logouts } = authAfterAccepting();
      const services = testServices({ teamStore: teamStoreOn(owner), auth });
      await asSystem(owner);
      expect(await answer(owner, "private.system_invite_admin($1, '{support}')", [person.email])).toBe("invited_existing");
      await asOwner(owner);
      await proveMailbox(owner, who, secret);

      // La primera pestaña empieza y pinta su clave. La segunda empieza después: el
      // navegador es el mismo, así que la anotación pasa a ser la del segundo factor.
      const first = await services.startSecondFactor(jar);
      const second = await services.startSecondFactor(jar);
      if (first.kind !== "started" || second.kind !== "started") throw new Error("No empezó en las dos pestañas.");
      expect(second.factorId).not.toBe(first.factorId);
      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", inProgress: second.factorId });

      // En la primera, la persona teclea el código de la clave que tiene delante.
      expect(await services.confirmSecondFactor(jar, { code: totpCode(first.secret), painted: first.factorId })).toEqual({
        kind: "start_again",
      });
      // No se le preguntó nada a Auth: el freno de ese factor no contó ningún fallo.
      expect(await ownerQuery("select 1 from private.second_factor_attempts where factor_id = $1", [second.factorId])).toEqual([]);
      expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal1", factor: null }]);
      // Y la segunda pestaña sigue valiendo.
      expect(jar.get(FACTOR)).toBe(`${who.sessionId}.${second.factorId}`);

      // En la segunda, con su clave, acepta. El navegador manda el formulario dos veces: la
      // copia es lo que el segundo envío traía antes de que el primero contestara.
      const twin = jar.copy();
      expect(await services.confirmSecondFactor(jar, { code: totpCode(second.secret), painted: second.factorId })).toEqual({ kind: "accepted" });
      expect((await teamOf(owner, person.id)).factor).toBe(second.factorId);

      // El segundo envío encuentra a la persona ya atada al factor de ese navegador: se le
      // contesta lo mismo, sin verificar otra vez ni quitarle nada.
      expect(await services.confirmSecondFactor(twin, { code: totpCode(second.secret), painted: second.factorId })).toEqual({ kind: "accepted" });
      expect(twin.get(SESSION)).toBeUndefined();
      expect(twin.get(TICKET)).toBeUndefined();
      expect(twin.get(FACTOR)).toBeUndefined();
      expect(logouts).toHaveLength(2);
      expect(await teamOf(owner, person.id)).toMatchObject({
        factor: second.factorId,
        capabilities: [{ capability: "support", by: null }],
        invitations: [{ kind: "grant", accepted: true, revoked: false, failures: 0 }],
      });
      const left = await owner.query<{ id: string; status: string }>("select id::text as id, status::text as status from auth.mfa_factors where user_id = $1", [
        person.id,
      ]);
      expect(left.rows).toEqual([{ id: second.factorId, status: "verified" }]);
      expect(services.reported).toEqual([]);
    });
  });

  it("si la sesión queda verificada con otro factor justo antes de aceptar, la base no ata ninguno", async () => {
    const who = await entered();
    const { person, jar } = who;
    const secret = withTicket(jar);

    await reverted(async (owner) => {
      // Lo que haría alguien con una copia de la sesión, en el peor instante: entre que el
      // servidor verifica su factor y le pide a la base que lo ate.
      let theirs: { factorId: string; secret: string } | null = null;
      const services = testServices({
        teamStore: teamStoreOn(owner),
        auth: {
          ...adapter,
          verifyFactor: async (cookies, factorId, code) => {
            const verified = await adapter.verifyFactor(cookies, factorId, code);
            if (verified.kind === "verified") theirs = await outsideFactor(cookies);
            return verified;
          },
        },
      });
      await asSystem(owner);
      expect(await answer(owner, "private.system_invite_admin($1, '{support}')", [person.email])).toBe("invited_existing");
      await asOwner(owner);
      await proveMailbox(owner, who, secret);
      const started = await services.startSecondFactor(jar);
      if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);

      // La base exige que la sesión esté verificada con el mismo factor que se le pide atar.
      expect(await services.confirmSecondFactor(jar, { code: totpCode(started.secret) })).toEqual({ kind: "unavailable" });

      expect(theirs).not.toBeNull();
      expect(await sessionsOf(person.id)).toMatchObject([{ aal: "aal2", factor: (theirs as { factorId: string } | null)?.factorId }]);
      expect(await teamOf(owner, person.id)).toMatchObject({
        factor: null,
        capabilities: [],
        invitations: [{ kind: "grant", accepted: false, revoked: false, failures: 0 }],
      });
      // No se le quitó nada, la sesión sigue, y queda dicho.
      expect(jar.get(SESSION)).toBeDefined();
      expect(jar.get(FACTOR)).toBe(`${who.sessionId}.${started.factorId}`);
      expect(services.reported).toEqual(["invitation_not_accepted"]);
    });
  });

  it("al agotar los intentos del código dictado la invitación se revoca, y el factor verificado no se queda en la cuenta", async () => {
    const limit = await parameter("INTENTOS_ANTES_DE_FRENO");
    const who = await entered();
    const { person, jar } = who;
    const secret = withTicket(jar);

    await reverted(async (owner) => {
      const services = testServices({ teamStore: teamStoreOn(owner) });
      await asSystem(owner);
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'support')", [person.id]);
      await owner.query(
        `insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
         values ('rebind', $1, $2, '{}', $3, clock_timestamp(), clock_timestamp() + interval '1 day')`,
        [person.email.toLowerCase(), person.id, print("K7QM2X9P")],
      );
      await asOwner(owner);
      await proveMailbox(owner, who, secret);
      const started = await services.startSecondFactor(jar);
      if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);
      const wrong = () => services.confirmSecondFactor(jar, { code: totpCode(started.secret), handoff: "ZZZZ9999" });

      for (let failure = 1; failure < limit; failure += 1) {
        expect(await wrong(), `fallo ${failure}`).toEqual({ kind: "needs_handoff" });
      }
      expect(await factorsOf(person.id)).toEqual([{ id: started.factorId, status: "verified" }]);

      // El que llega al límite: la base revoca, y ya no hay siguiente intento para ese factor.
      expect(await wrong()).toEqual({ kind: "not_invited" });

      expect(await teamOf(owner, person.id)).toMatchObject({
        factor: null,
        invitations: [{ kind: "rebind", accepted: false, revoked: true, failures: limit }],
      });
      expect(await factorsOf(person.id)).toEqual([]);
      expect(jar.get(FACTOR)).toBeUndefined();
      // Conserva sus capacidades y no tiene con qué volver: alguien la restablece de nuevo.
      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", standing: { state: "unbound" } });
      // Ni con el código dictado bueno: ya no hay invitación.
      expect(await services.confirmSecondFactor(jar, { code: totpCode(started.secret), handoff: "K7QM2X9P" })).toEqual({ kind: "not_invited" });
      expect(services.reported).toEqual([]);
    });
  });
});

describe("dar el código al entrar", () => {
  it("quien es del equipo y entró con su contraseña está a un código: equivocado no pasa, y con el bueno su sesión es de equipo", async () => {
    const person = await completed();
    // Antes de entrar: verificar un factor cierra las demás sesiones de primer nivel.
    const factor = await secondFactorFor(person);
    const who = await entered(person);
    const { jar } = who;

    await reverted(async (owner) => {
      const services = testServices({ teamStore: teamStoreOn(owner) });
      await asSystem(owner);
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'config')", [person.id]);
      await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
        person.id,
        factor.factorId,
        person.email.toLowerCase(),
      ]);
      await asOwner(owner);

      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", standing: { state: "needs_code", factor: factor.factorId } });
      // Con capacidades y con atadura no se configura otro factor.
      expect(await services.startSecondFactor(jar)).toEqual({ kind: "not_invited" });

      expect(await services.giveSecondFactorCode(jar, wrongCode(factor.secret))).toEqual({ kind: "wrong_code" });
      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", standing: { state: "needs_code" } });

      const before = jar.get(SESSION);
      expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });

      // La misma sesión, subida de nivel, con su cookie nueva: ya pasa la puerta.
      expect(jar.get(SESSION)).not.toBe(before);
      expect(await adapter.readSession(jar)).toMatchObject({ kind: "session", claims: { sessionId: who.sessionId, aal: "aal2" } });
      expect(await services.teamStanding(jar)).toMatchObject({
        kind: "team",
        standing: { state: "member", factor: factor.factorId, capabilities: ["config"] },
      });
      // Y puede dar su código otra vez, para un cambio al equipo que lo pida reciente.
      expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
      expect(services.reported).toEqual([]);
    });
  });
});

// A qué pantalla va quien acaba de entrar lo dice su estado en el equipo (flujo de la app
// §6.2). El servicio lo lee al dejarla dentro, con las claims que Auth acaba de dar y sin
// volver a leer la cookie. El estado lo contesta la prueba, salvo «ninguno», que sale de la
// base: una invitación sin confirmar tendría tomado el candado con el que entrar anota la
// sesión. Lo que la base contesta con una invitación viva está probado arriba.
describe("el estado del equipo de quien acaba de entrar", () => {
  it("con el almacén de verdad, quien no es del equipo entra como «ninguno», sin tocar la auditoría", async () => {
    const person = await completed();
    const audited = await auditRows();
    const services = testServices();

    expect(await services.signIn(memoryJar(), person, freshOrigin())).toEqual({ kind: "entered", pending: null, team: "none" });

    expect(await auditRows()).toBe(audited);
    expect(services.reported).toEqual([]);
  });

  it.each<[TeamStanding]>([
    [{ state: "invited_unproven", kind: "grant" }],
    [{ state: "invited", kind: "rebind", capabilities: [] }],
    [{ state: "unbound" }],
    [{ state: "needs_code", factor: randomUUID() }],
    [{ state: "member", factor: randomUUID(), capabilities: ["config"] }],
  ])("de %j sale solo el nombre del estado, preguntado con la sesión recién abierta y el resguardo de ese navegador", async (standing) => {
    const person = await completed();
    const jar = memoryJar();
    const secret = withTicket(jar);
    const { teamStore, asked } = answeringStore(standing);
    const services = testServices({ teamStore });

    expect(await services.signIn(jar, person, freshOrigin())).toEqual({ kind: "entered", pending: null, team: standing.state });

    // Se preguntó una vez, a nombre de la sesión que quedó en el navegador, en primer nivel.
    const check = await services.checkSession(jar);
    if (check.kind !== "pass") throw new Error(`La sesión no pasó la guarda: ${check.kind}`);
    expect(asked).toEqual([{ userId: person.id, sessionId: check.claims.sessionId, aal: "aal1", ticket: print(secret) }]);
    // Leer el estado no toca nada: ni el resguardo, ni un factor a medias, ni la sesión.
    expect(jar.get(TICKET)).toBe(secret);
    expect(jar.get(FACTOR)).toBeUndefined();
    expect(await sessionCount(person.id)).toBe(1);
    expect(services.reported).toEqual([]);
  });

  it("sin resguardo en el navegador pregunta sin él", async () => {
    const person = await completed();
    const { teamStore, asked } = answeringStore({ state: "invited_unproven", kind: "grant" });

    expect(await testServices({ teamStore }).signIn(memoryJar(), person, freshOrigin())).toMatchObject({ team: "invited_unproven" });

    expect(asked).toMatchObject([{ userId: person.id, ticket: null }]);
  });

  it("si la base no dice el estado, la persona entra igual: «no se supo» no da nada, y queda dicho", async () => {
    const person = await completed();
    const jar = memoryJar();
    const { teamStore } = answeringStore("throws");
    const services = testServices({ teamStore });

    expect(await services.signIn(jar, person, freshOrigin())).toEqual({ kind: "entered", pending: null, team: null });

    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: person.id } });
    expect(services.reported).toEqual(["team_unavailable"]);
  });

  it("a quien le falta algo de su cuenta no se le pregunta por el equipo: eso se le pide primero", async () => {
    const person = await claimedUser();
    emails.push(person.email);
    const { teamStore, asked } = answeringStore({ state: "needs_code", factor: randomUUID() });

    expect(await testServices({ teamStore }).signIn(memoryJar(), person, freshOrigin())).toMatchObject({
      kind: "entered",
      pending: { variant: "complete_account" },
      team: null,
    });

    expect(asked).toEqual([]);
  });

  it("quien no entra no llega a preguntar", async () => {
    const person = await completed();
    const { teamStore, asked } = answeringStore({ state: "member", factor: randomUUID(), capabilities: ["config"] });
    const services = testServices({ teamStore });

    expect(await services.signIn(memoryJar(), { email: person.email, password: "no es esta" }, freshOrigin())).toEqual({
      kind: "invalid_credentials",
    });

    expect(asked).toEqual([]);
  });
});

// Lo que una acción encuentra cuando el paso previo renovó la sesión justo antes: el
// servicio trabaja sobre la cookie recién rotada. Aquí no hay Next en medio: que la acción
// reciba esa cookie y que la suya sea la última que llega al navegador se mide en el
// extremo a extremo de las pantallas.
describe("dar el código con la sesión que el paso previo acaba de renovar", () => {
  it("con la cookie renovada verificar funciona, la reescribe otra vez, y la sesión queda de equipo", async () => {
    const person = await completed();
    const factor = await secondFactorFor(person);
    const who = await entered(person);
    const before = who.jar.get(SESSION) ?? "";

    await reverted(async (owner) => {
      const services = testServices({ teamStore: teamStoreOn(owner) });
      await asSystem(owner);
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'config')", [person.id]);
      await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
        person.id,
        factor.factorId,
        person.email.toLowerCase(),
      ]);
      await asOwner(owner);

      // Catorce minutos después el token está por vencer: el paso previo lo renueva antes de
      // que corra la acción, y le pasa a la petición la cookie nueva.
      const real = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => real() + 14 * 60_000);
      const response = await proxy(
        new NextRequest("http://localhost:3000/entrar/segundo-factor", { method: "POST", headers: { cookie: `${SESSION}=${before}` } }),
      );
      vi.restoreAllMocks();
      const header = response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION}=`)) ?? "";
      const renewed = header.split("; ")[0]?.slice(SESSION.length + 1) ?? "";
      expect(renewed).not.toBe("");
      expect(renewed).not.toBe(before);
      expect(response.headers.get("x-middleware-request-cookie")).toBe(`${SESSION}=${renewed}`);

      // La acción trabaja sobre lo que el paso previo dejó en la petición.
      const jar = memoryJar(new Map([[SESSION, renewed]]));
      expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });

      // Verificar deja una tercera cookie: la de la sesión ya en segundo nivel.
      const verified = jar.get(SESSION) ?? "";
      expect(verified).not.toBe(renewed);
      expect(await adapter.readSession(jar)).toMatchObject({ kind: "session", claims: { sessionId: who.sessionId, aal: "aal2" } });
      expect(await sessionsOf(person.id)).toEqual([{ id: who.sessionId, aal: "aal2", factor: factor.factorId }]);
      expect(await services.teamStanding(jar)).toMatchObject({ kind: "team", standing: { state: "member", capabilities: ["config"] } });
      expect(services.reported).toEqual([]);
    });
  });
});

describe("el resguardo, cuando se cierra la sesión de ese navegador", () => {
  it("salir de ese navegador porque la persona lo pidió se lleva el resguardo y el factor a medias, y nada más", async () => {
    const { jar, sessionId } = await entered();
    withTicket(jar);
    jar.set(FACTOR, `${sessionId}.fa000000-0000-4000-8000-000000000001`, COOKIE);
    const session = jar.get(SESSION);

    forgetBrowserProofs(jar);

    expect(jar.get(TICKET)).toBeUndefined();
    expect(jar.get(FACTOR)).toBeUndefined();
    // Cerrar la sesión es otro paso, de quien la llama.
    expect(jar.get(SESSION)).toBe(session);
    // Sin nada que llevarse no escribe nada.
    const empty = memoryJar();
    forgetBrowserProofs(empty);
    expect(empty.writes).toEqual([]);
  });

  // Recuperar la contraseña deja el resguardo y, en la misma respuesta, cierra la sesión que
  // ese navegador tuviera. Si cerrar una sesión se lo llevara, nadie con sesión abierta
  // podría probar su buzón. Que «Salir» sí se lo lleve llega con las pantallas, como un
  // paso propio de esa acción.
  it("cerrar la sesión no se lo lleva", async () => {
    const { person, jar } = await entered();
    const secret = withTicket(jar);

    expect(await testServices().signOut(jar)).toBe("closed");

    expect(jar.get(SESSION)).toBeUndefined();
    expect(jar.get(TICKET)).toBe(secret);
    expect(await sessionCount(person.id)).toBe(0);
  });

  // Aceptar una invitación borra en la base la sesión con la que se acepta, y después el
  // servidor le pide a Auth cerrarla. En las pruebas de arriba esa respuesta de Auth se
  // escribe a mano, porque el borrado queda sin confirmar. Aquí se mide de verdad, con el
  // borrado confirmado: Auth contesta que no existe, y eso cuenta como cerrada.
  it("cerrar en Auth una sesión que la base ya borró cuenta como cerrada, sin reporte", async () => {
    const { person, jar } = await entered();
    const secret = withTicket(jar);
    await ownerQuery("delete from auth.sessions where user_id = $1", [person.id]);
    await ownerQuery("delete from private.app_sessions where profile_id = $1", [person.id]);
    // El Auth de verdad, anotando qué contesta al cierre.
    const answered: string[] = [];
    const auth = adapter.createAuth({
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/logout")) {
          const body = (await response.clone().json()) as { code?: unknown };
          answered.push(`${response.status} ${String(body.code)}`);
        }
        return response;
      },
    });
    const services = testServices({ auth });

    expect(await services.signOut(jar)).toBe("closed");

    // Lo mismo que se le contesta a mano en las pruebas de arriba.
    expect(answered).toEqual(["403 session_not_found"]);
    expect(services.reported).toEqual([]);
    expect(jar.get(SESSION)).toBeUndefined();
    expect(jar.get(TICKET)).toBe(secret);
  });

  it("cerrar una sesión que la guarda rechazó, tampoco: es la que quedó de antes de probar el buzón", async () => {
    const { person, jar } = await entered();
    const secret = withTicket(jar);
    // Recuperar cierra todas las sesiones y borra lo anotado; la cookie de la sesión de
    // antes sigue en el navegador que abrió el enlace.
    await ownerQuery("delete from private.app_sessions where profile_id = $1", [person.id]);

    expect(await testServices().closeRejectedSession(jar)).toBe("sign_in");

    expect(jar.get(SESSION)).toBeUndefined();
    expect(jar.get(TICKET)).toBe(secret);
  });
});
