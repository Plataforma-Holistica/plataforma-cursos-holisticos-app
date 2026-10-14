import type { Client } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import * as adapter from "@/adapters/supabase/auth";
import type { TeamRoster, VerifiedClaims } from "@/services/account/account";
import { handoffPrint } from "@/services/account/team";

import { claimedUser, freshOrigin, parameter, testServices, type TestServices } from "./helpers/account";
import { memoryJar, secondFactorFor, type EnrolledFactor, type KnownUser, type MemoryJar } from "./helpers/auth";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode, wrongCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery, testEmail } from "./helpers/users";

// Administrar al equipo (RF-712; TRD §9.2, fila «Invitaciones»), contra el Auth y la base
// locales: la lista, invitar, revocar, dar y quitar una capacidad, restablecer un segundo
// factor, y dar el código otra vez cuando el reciente venció.
//
// La guarda de sesión y Auth corren de verdad y confirman lo suyo. Todo lo que cambia el
// equipo queda en la auditoría, que no admite borrado: por eso quien administra es del
// equipo solo dentro de una transacción del dueño que se revierte, y los servicios le
// preguntan a la base por ella (`teamStoreOn`), con las mismas consultas que usa la
// aplicación. Cada caso comprueba al final que la auditoría quedó como estaba.

const SESSION = "plataforma-sesion";
const TOKEN = "plataforma-restablecer";
const emails: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  // El freno de los códigos guarda sus cuentas por factor; las de estas pruebas se van.
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

/** Una cuenta completa, a la que la guarda de sesión deja pasar. */
async function completed(): Promise<KnownUser> {
  const account = await claimedUser();
  emails.push(account.email);
  await completeAccountAsOwner(account.id);
  return account;
}

/** Entra por el servicio, y devuelve su tarro y su sesión. */
async function entered(person: KnownUser): Promise<{ jar: MemoryJar; sessionId: string }> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, person, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La sesión de prueba no pasó la guarda: ${check.kind}`);
  return { jar, sessionId: check.claims.sessionId ?? "" };
}

async function auditRows(): Promise<number> {
  const rows = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
  return rows[0]?.n ?? -1;
}

/** Deja a alguien en el equipo dentro de la transacción: sus capacidades y su factor atado. */
async function makeMember(owner: Client, person: KnownUser, factorId: string, capabilities: string[]): Promise<void> {
  await asSystem(owner);
  for (const capability of capabilities) {
    await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2::public.capability)", [person.id, capability]);
  }
  await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
    person.id,
    factorId,
    person.email.toLowerCase(),
  ]);
  await asOwner(owner);
}

/**
 * El adaptador de Auth de verdad, salvo el cierre de sesión. Quitarse una capacidad borra
 * en la base las sesiones de quien actúa, y aquí eso ocurre dentro de una transacción que se
 * revierte: el borrado queda sin confirmar y con su fila tomada, y el cierre de verdad se
 * quedaría esperándola. Se le contesta lo que Auth contesta ya confirmado el borrado.
 */
function authAfterClosing(): { auth: ReturnType<typeof adapter.createAuth>; logouts: string[] } {
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

interface Stage {
  owner: Client;
  services: TestServices;
  jar: MemoryJar;
  person: KnownUser;
  factor: EnrolledFactor;
  claims: VerifiedClaims;
  sessionId: string;
  /** La lista, como la lee la página que ya pasó su guarda. */
  roster: () => Promise<TeamRoster>;
}

/**
 * Alguien del equipo con esas capacidades y con su sesión ya de equipo (dio su código),
 * dentro de una transacción que se revierte. Al terminar, la auditoría quedó como estaba.
 */
async function asTeamMember<T>(
  capabilities: string[],
  fn: (stage: Stage) => Promise<T>,
  overrides: Parameters<typeof testServices>[0] = {},
): Promise<T> {
  const person = await completed();
  // Antes de entrar: verificar un factor cierra las demás sesiones de primer nivel.
  const factor = await secondFactorFor(person);
  const { jar, sessionId } = await entered(person);
  const audited = await auditRows();
  const result = await reverted(async (owner) => {
    const services = testServices({ teamStore: teamStoreOn(owner), ...overrides });
    await makeMember(owner, person, factor.factorId, capabilities);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    const check = await services.teamStanding(jar);
    if (check.kind !== "team" || check.standing.state !== "member") throw new Error("La persona de prueba no quedó en el equipo.");
    const { claims } = check;
    const roster = async () => {
      const read = await services.teamRoster(jar, claims);
      if (read.kind !== "roster") throw new Error("La lista no se pudo leer.");
      return read.roster;
    };
    return fn({ owner, services, jar, person, factor, claims, sessionId, roster });
  });
  expect(await auditRows()).toBe(audited);
  return result;
}

/** Otra persona del equipo dentro de esa transacción, con su factor de verdad y una sesión abierta. */
async function teammate(owner: Client, capabilities: string[]): Promise<KnownUser & { factor: EnrolledFactor }> {
  const person = await completed();
  const factor = await secondFactorFor(person);
  await entered(person);
  await makeMember(owner, person, factor.factorId, capabilities);
  return { ...person, factor };
}

/** Las sesiones de esa cuenta, como las ve la transacción: en Auth y en lo anotado. */
async function sessionsIn(owner: Client, userId: string): Promise<number> {
  const rows = await owner.query(
    "select 1 from auth.sessions where user_id = $1 union all select 1 from private.app_sessions where profile_id = $1",
    [userId],
  );
  return rows.rows.length;
}

const memberOf = (roster: TeamRoster, person: KnownUser) => roster.members.find((member) => member.profileId === person.id);

describe("quien no puede administrar al equipo", () => {
  it("una cuenta común, con el almacén de verdad: nada se le contesta, y nada queda escrito", async () => {
    const person = await completed();
    const { jar } = await entered(person);
    const audited = await auditRows();
    const services = testServices();
    const check = await services.checkSession(jar);
    if (check.kind !== "pass") throw new Error("La sesión de prueba no pasó la guarda.");

    expect(await services.teamRoster(jar, check.claims)).toEqual({ kind: "unavailable" });
    expect(await services.inviteAdmin(jar, { email: testEmail(), capabilities: ["config"] })).toEqual({ kind: "refused" });
    expect(await services.reinviteAdmin(jar, { id: person.id })).toEqual({ kind: "refused" });
    expect(await services.revokeInvitation(jar, { id: person.id })).toEqual({ kind: "refused" });
    expect(await services.grantCapability(jar, { profile: person.id, capability: "config" })).toEqual({ kind: "refused" });
    expect(await services.revokeCapability(jar, { profile: person.id, capability: "config", confirmed: "" })).toEqual({ kind: "refused" });
    expect(await services.prepareReset(jar, { profile: person.id })).toEqual({ kind: "refused" });
    expect(await services.resetSecondFactor(jar, { profile: person.id, confirmed: "" })).toEqual({ kind: "refused" });
    expect(await services.giveFreshCode(jar, "123456")).toEqual({ kind: "refused" });

    // No se le pintó como caída: la sesión no pasa la puerta, y eso no se reporta.
    expect(services.reported).toEqual([]);
    expect(jar.get(TOKEN)).toBeUndefined();
    expect(await auditRows()).toBe(audited);
  });

  it("alguien del equipo sin configuración: pasa la puerta con lo suyo, y aun así no ve ni cambia al equipo", async () => {
    await asTeamMember(["support", "content", "finance", "moderation"], async ({ services, jar, person, claims }) => {
      expect(await services.teamRoster(jar, claims)).toEqual({ kind: "unavailable" });
      expect(await services.inviteAdmin(jar, { email: testEmail(), capabilities: ["support"] })).toEqual({ kind: "refused" });
      expect(await services.grantCapability(jar, { profile: person.id, capability: "config" })).toEqual({ kind: "refused" });
      expect(await services.prepareReset(jar, { profile: person.id })).toEqual({ kind: "refused" });
      expect(await services.giveFreshCode(jar, "123456")).toEqual({ kind: "refused" });
      expect(services.reported).toEqual([]);
    });
  });
});

describe("la lista y las invitaciones", () => {
  it("quien tiene configuración se ve en su lista, invita, revoca e invita de nuevo lo que caducó", async () => {
    const days = await parameter("VIGENCIA_INVITACION_DIAS");
    const existing = await completed();
    await asTeamMember(["config"], async ({ owner, services, jar, person, roster }) => {
      const first = await roster();
      expect(first.freshCode).toBe(true);
      expect(first.invitations).toEqual([]);
      expect(first.members).toEqual([
        {
          profileId: person.id,
          email: person.email.toLowerCase(),
          displayName: "Persona de prueba",
          status: "active",
          capabilities: ["config"],
          factor: "bound",
          rebind: "none",
          configRemovable: false,
          isSelf: true,
        },
      ]);

      // Un correo sin cuenta, con mayúsculas y espacios: se guarda normalizado.
      const fresh = testEmail();
      expect(await services.inviteAdmin(jar, { email: `  ${fresh.toUpperCase()} `, capabilities: ["support", "content", "support"] })).toEqual({
        kind: "answered",
        answer: "invited_new",
      });
      expect(await services.inviteAdmin(jar, { email: fresh, capabilities: ["config"] })).toEqual({ kind: "answered", answer: "already_invited" });
      expect(await services.inviteAdmin(jar, { email: existing.email, capabilities: ["finance"] })).toEqual({
        kind: "answered",
        answer: "invited_existing",
      });
      // A quien ya es del equipo se le da la capacidad, no se le invita.
      expect(await services.inviteAdmin(jar, { email: person.email, capabilities: ["finance"] })).toEqual({ kind: "answered", answer: "already_member" });

      const invited = await roster();
      expect(invited.invitations.map((each) => ({ ...each, id: "", createdAt: null, expiresAt: null }))).toEqual([
        {
          id: "",
          kind: "grant",
          email: fresh.toLowerCase(),
          profileId: null,
          capabilities: ["content", "support"],
          invitedBy: person.id,
          createdAt: null,
          expiresAt: null,
          expired: false,
          acceptable: true,
        },
        {
          id: "",
          kind: "grant",
          email: existing.email.toLowerCase(),
          profileId: existing.id,
          capabilities: ["finance"],
          invitedBy: person.id,
          createdAt: null,
          expiresAt: null,
          expired: false,
          acceptable: true,
        },
      ]);
      const [toNew, toExisting] = invited.invitations;
      if (!toNew || !toExisting) throw new Error("Faltan invitaciones.");
      // Las horas llegan como horas, y el plazo es el del parámetro.
      expect(Math.round((toNew.expiresAt.getTime() - toNew.createdAt.getTime()) / 86_400_000)).toBe(days);
      expect(Math.abs(toNew.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
      // Invitar no le tocó nada a la cuenta que ya existía, y no la metió al equipo.
      expect(memberOf(invited, existing)).toBeUndefined();

      // Una viva y sin caducar no se invita de nuevo.
      expect(await services.reinviteAdmin(jar, { id: toNew.id })).toEqual({ kind: "gone" });

      expect(await services.revokeInvitation(jar, { id: toExisting.id })).toEqual({ kind: "answered", answer: "revoked" });
      expect(await services.revokeInvitation(jar, { id: toExisting.id })).toEqual({ kind: "answered", answer: "not_found" });
      expect((await roster()).invitations.map((each) => each.id)).toEqual([toNew.id]);

      // Caducada: sigue en la lista, y se invita de nuevo con lo que la base tiene de ella.
      await asSystem(owner);
      await owner.query(
        "update private.admin_invitations set created_at = created_at - interval '30 days', expires_at = clock_timestamp() - interval '1 second' where id = $1",
        [toNew.id],
      );
      await asOwner(owner);
      expect((await roster()).invitations).toMatchObject([{ id: toNew.id, expired: true, acceptable: false }]);
      expect(await services.reinviteAdmin(jar, { id: toNew.id })).toEqual({ kind: "answered", answer: "invited_new" });
      const again = await roster();
      expect(again.invitations).toMatchObject([
        { email: fresh.toLowerCase(), capabilities: ["content", "support"], expired: false, acceptable: true, invitedBy: person.id },
      ]);
      expect(again.invitations[0]?.id).not.toBe(toNew.id);

      expect(services.reported).toEqual([]);
    });
  });
});

describe("dar y quitar capacidades", () => {
  it("dar vale en la siguiente lectura; quitar cierra las sesiones de esa persona, y quitarle la última la saca del equipo", async () => {
    await asTeamMember(["config"], async ({ owner, services, jar, roster }) => {
      const other = await teammate(owner, ["support"]);
      expect(await sessionsIn(owner, other.id)).toBe(2);
      expect(memberOf(await roster(), other)).toMatchObject({ capabilities: ["support"], factor: "bound", isSelf: false, configRemovable: false });

      expect(await services.grantCapability(jar, { profile: other.id, capability: "content" })).toEqual({ kind: "answered", answer: "granted" });
      expect(await services.grantCapability(jar, { profile: other.id, capability: "content" })).toEqual({ kind: "answered", answer: "already_has" });
      expect(memberOf(await roster(), other)?.capabilities).toEqual(["content", "support"]);
      // Dar no cierra nada.
      expect(await sessionsIn(owner, other.id)).toBe(2);

      // Lo que se confirmó tiene que ser lo que pasaría: no es su última, y se dijo que sí.
      expect(await services.revokeCapability(jar, { profile: other.id, capability: "content", confirmed: "last" })).toEqual({ kind: "changed" });
      expect(memberOf(await roster(), other)?.capabilities).toEqual(["content", "support"]);

      expect(await services.revokeCapability(jar, { profile: other.id, capability: "content", confirmed: "" })).toEqual({
        kind: "answered",
        answer: "revoked",
      });
      expect(memberOf(await roster(), other)?.capabilities).toEqual(["support"]);
      expect(await sessionsIn(owner, other.id)).toBe(0);

      // Ahora sí es su última, y hay que haberlo confirmado.
      expect(await services.revokeCapability(jar, { profile: other.id, capability: "support", confirmed: "" })).toEqual({ kind: "changed" });
      expect(await services.revokeCapability(jar, { profile: other.id, capability: "support", confirmed: "last" })).toEqual({
        kind: "answered",
        answer: "revoked",
      });
      expect(memberOf(await roster(), other)).toBeUndefined();
      const bound = await owner.query("select 1 from private.admin_factors where profile_id = $1", [other.id]);
      const factors = await owner.query("select 1 from auth.mfa_factors where user_id = $1", [other.id]);
      expect([bound.rows.length, factors.rows.length]).toEqual([0, 0]);
      // A quien ya no es del equipo no se le da nada: se le invita.
      expect(await services.grantCapability(jar, { profile: other.id, capability: "support" })).toEqual({ kind: "answered", answer: "not_member" });

      expect(services.reported).toEqual([]);
    });
  });

  it("con dos personas con configuración, a ninguna se le puede quitar: lo dice la lista y lo dice la base", async () => {
    await asTeamMember(["config"], async ({ owner, services, jar, person, roster, sessionId }) => {
      const other = await teammate(owner, ["config"]);
      const list = await roster();
      expect(memberOf(list, person)?.configRemovable).toBe(false);
      expect(memberOf(list, other)?.configRemovable).toBe(false);

      expect(await services.revokeCapability(jar, { profile: other.id, capability: "config", confirmed: "last" })).toEqual({
        kind: "answered",
        answer: "min_config",
      });
      expect(await services.revokeCapability(jar, { profile: person.id, capability: "config", confirmed: "self+last" })).toEqual({
        kind: "answered",
        answer: "min_config",
      });
      // Nadie perdió nada, ni su sesión.
      expect(memberOf(await roster(), other)?.capabilities).toEqual(["config"]);
      expect(jar.get(SESSION)).toBeDefined();
      const mine = await owner.query("select 1 from auth.sessions where id = $1", [sessionId]);
      expect(mine.rows).toHaveLength(1);
      expect(services.reported).toEqual([]);
    });
  });

  it("quien se quita una capacidad a sí misma queda sin sesión: la base la cierra, y su cookie se borra", async () => {
    const { auth, logouts } = authAfterClosing();
    await asTeamMember(
      ["config", "support"],
      async ({ owner, services, jar, person, roster }) => {
        await teammate(owner, ["config"]);
        await teammate(owner, ["config"]);
        expect(memberOf(await roster(), person)?.configRemovable).toBe(true);
        expect(await sessionsIn(owner, person.id)).toBe(2);

        expect(await services.revokeCapability(jar, { profile: person.id, capability: "support", confirmed: "self" })).toEqual({ kind: "revoked_self" });

        expect(await sessionsIn(owner, person.id)).toBe(0);
        expect(jar.get(SESSION)).toBeUndefined();
        expect(logouts).toHaveLength(1);
        // Lo siguiente que pida ya no pasa: no tiene sesión.
        expect(await services.inviteAdmin(jar, { email: testEmail(), capabilities: ["support"] })).toEqual({ kind: "refused" });
        expect(services.reported).toEqual([]);
      },
      { auth },
    );
  });
});

describe("restablecer el segundo factor de alguien", () => {
  it("con el testigo del primer paso restablece una vez, devuelve el código y a la base le deja su huella", async () => {
    await asTeamMember(["config"], async ({ owner, services, jar, person, sessionId, roster }) => {
      const other = await teammate(owner, ["config", "support"]);

      // Sin el primer paso no hay testigo: no se toca nada.
      expect(await services.resetSecondFactor(jar, { profile: other.id, confirmed: "alone" })).toEqual({ kind: "already_sent" });
      expect(memberOf(await roster(), other)?.factor).toBe("bound");
      // Nadie se restablece a sí misma.
      expect(await services.prepareReset(jar, { profile: person.id })).toEqual({ kind: "malformed" });

      expect(await services.prepareReset(jar, { profile: other.id })).toEqual({ kind: "ready" });
      expect(jar.get(TOKEN)).toBe(`${sessionId}.${other.id}`);

      // Es la única otra persona con configuración, y eso hay que haberlo confirmado.
      expect(await services.resetSecondFactor(jar, { profile: other.id, confirmed: "" })).toEqual({ kind: "changed" });
      expect(jar.get(TOKEN)).toBeDefined();
      expect(memberOf(await roster(), other)?.factor).toBe("bound");

      const result = await services.resetSecondFactor(jar, { profile: other.id, confirmed: "alone" });
      if (result.kind !== "reset") throw new Error(`No restableció: ${result.kind}`);
      expect(result.code).toMatch(/^[2-9A-HJKMNP-Z]{4}(?:-[2-9A-HJKMNP-Z]{4}){3}$/);
      expect(jar.get(TOKEN)).toBeUndefined();

      // Lo que la base dejó: sin atadura, sin factores, sin sesiones, con la marca de
      // contraseña, y una invitación para volver con la huella de ese código.
      const left = await owner.query<{ bound: number; factors: number; flagged: boolean }>(
        `select (select count(*)::int from private.admin_factors where profile_id = $1) as bound,
                (select count(*)::int from auth.mfa_factors where user_id = $1) as factors,
                (select password_reset_required from public.profiles where id = $1) as flagged`,
        [other.id],
      );
      expect(left.rows[0]).toEqual({ bound: 0, factors: 0, flagged: true });
      expect(await sessionsIn(owner, other.id)).toBe(0);
      const invitation = await owner.query<{ kind: string; handoff: string; by: string }>(
        "select kind, handoff, invited_by::text as by from private.admin_invitations where profile_id = $1 and accepted_at is null and revoked_at is null",
        [other.id],
      );
      expect(invitation.rows).toEqual([{ kind: "rebind", handoff: handoffPrint(result.code.toLowerCase().replace(/-/g, " ")), by: person.id }]);

      // Y la lista lo dice: conserva sus capacidades, sin factor, con su invitación para volver.
      const after = await roster();
      expect(memberOf(after, other)).toMatchObject({ capabilities: ["support", "config"], factor: "none", rebind: "pending" });
      expect(after.invitations).toMatchObject([{ kind: "rebind", email: other.email.toLowerCase(), capabilities: [], acceptable: true }]);
      // Ni la lista ni nada de lo que viaja a la pantalla trae la huella.
      expect(JSON.stringify(after)).not.toContain(invitation.rows[0]?.handoff);

      // Un reenvío del mismo formulario ya no trae testigo: no restablece otra vez.
      expect(await services.resetSecondFactor(jar, { profile: other.id, confirmed: "alone+again" })).toEqual({ kind: "already_sent" });
      const same = await owner.query<{ handoff: string }>(
        "select handoff from private.admin_invitations where profile_id = $1 and accepted_at is null and revoked_at is null",
        [other.id],
      );
      expect(same.rows).toEqual([{ handoff: invitation.rows[0]?.handoff }]);

      // Restablecer otra vez se puede, con otro primer paso: el código anterior deja de servir.
      expect(await services.prepareReset(jar, { profile: other.id })).toEqual({ kind: "ready" });
      const second = await services.resetSecondFactor(jar, { profile: other.id, confirmed: "alone+again" });
      if (second.kind !== "reset") throw new Error(`No restableció otra vez: ${second.kind}`);
      expect(second.code).not.toBe(result.code);

      expect(services.reported).toEqual([]);
    });
  });
});

describe("el código reciente", () => {
  // Medido el 2026-10-13 y fijado aquí: verificar otra vez el mismo factor en la misma
  // sesión mueve la hora de su verificación, que es lo que mira la puerta de los cambios.
  // Si una versión de Auth dejara de moverla, el bloque «escribe tu código» de la pantalla
  // del equipo pediría el código sin fin, y esta prueba es la que avisa.
  it("pasados los minutos del parámetro la lista se sigue viendo y los cambios piden el código; darlo otra vez los abre", async () => {
    const minutes = await parameter("VIGENCIA_CODIGO_RECIENTE_MINUTOS");
    await asTeamMember(["config"], async ({ services, jar, factor, sessionId, roster }) => {
      expect((await roster()).freshCode).toBe(true);
      expect(await services.inviteAdmin(jar, { email: testEmail(), capabilities: ["support"] })).toEqual({ kind: "answered", answer: "invited_new" });

      // La verificación envejece en Auth, ya confirmada: es la fila que Auth va a mover.
      const aged = await ownerQuery<{ id: string }>(
        `update auth.mfa_amr_claims set updated_at = now() - make_interval(mins => $2::int)
         where session_id = $1 and authentication_method = 'totp' returning id::text as id`,
        [sessionId, minutes + 1],
      );
      expect(aged).toHaveLength(1);

      const stale = await roster();
      expect(stale.freshCode).toBe(false);
      expect(stale.members).toHaveLength(1);
      expect(await services.inviteAdmin(jar, { email: testEmail(), capabilities: ["support"] })).toEqual({
        kind: "answered",
        answer: "needs_fresh_code",
      });

      // Un código equivocado no abre nada.
      expect(await services.giveFreshCode(jar, wrongCode(factor.secret))).toEqual({ kind: "wrong_code" });
      expect((await roster()).freshCode).toBe(false);

      const before = jar.get(SESSION);
      expect(await services.giveFreshCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
      // La misma sesión, con su cookie reescrita, y la hora de su verificación movida.
      expect(jar.get(SESSION)).not.toBe(before);
      const moved = await ownerQuery<{ fresh: boolean; rows: number }>(
        `select bool_and(updated_at > now() - interval '1 minute') as fresh, count(*)::int as rows
         from auth.mfa_amr_claims where session_id = $1 and authentication_method = 'totp'`,
        [sessionId],
      );
      expect(moved).toEqual([{ fresh: true, rows: 1 }]);

      expect((await roster()).freshCode).toBe(true);
      expect(await services.inviteAdmin(jar, { email: testEmail(), capabilities: ["support"] })).toEqual({ kind: "answered", answer: "invited_new" });
      expect(services.reported).toEqual([]);
    });
  });
});
