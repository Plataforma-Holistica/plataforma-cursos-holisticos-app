import "server-only";

import { createHash } from "node:crypto";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";

import type { SessionCheck } from "./admission";
import type { AccountDependencies } from "./deps";
import * as enrolledFactors from "./enrolled-factor";
import * as mailboxTickets from "./mailbox-ticket";

// Los servicios del equipo (RF-105, RF-106, RF-712; TRD §9.2, filas «Segundo factor» e
// «Invitaciones»): en qué estado está alguien respecto al equipo, configurar el segundo
// factor (que es aceptar la invitación) y dar el código al entrar.
//
// Quién es del equipo lo decide la base. Aquí solo se decide a quién se le pregunta qué, y
// en qué orden:
//
//   · La guarda de sesión va primero, siempre. Lo que no sea «pasa» se contesta tal cual.
//   · El estado sale de `private.team_standing()`, con la huella del resguardo del buzón
//     que traiga ese navegador.
//   · El factor que se ata es el que el servidor dio de alta en ese navegador y en esa
//     sesión (`enrolled-factor.ts`), no el que diga la sesión ni el formulario.
//   · «No se supo» nunca es un sí, y nunca borra nada.

/** En qué estado está quien actúa respecto al equipo, como lo dice la base. */
export type TeamStanding =
  | { state: "none" }
  | { state: "member"; factor: string; capabilities: string[] }
  | { state: "needs_code"; factor: string }
  | { state: "unbound" }
  | { state: "invited"; kind: "grant" | "rebind"; capabilities: string[] }
  | { state: "invited_unproven"; kind: "grant" | "rebind" };

/** Lo que contesta `private.accept_admin_invitation()`. */
export const ACCEPT_ANSWERS = [
  "accepted",
  "ineligible",
  "no_invitation",
  "already_bound",
  "needs_mailbox_proof",
  "inviter_lost_config",
  "unavailable",
  "needs_handoff",
  "needs_code",
] as const;
export type AcceptAnswer = (typeof ACCEPT_ANSWERS)[number];

/**
 * Las dos preguntas que estos servicios le hacen a la base, a nombre de las claims que se
 * les pasan. Entran como dependencia para poder probar los servicios contra la base de
 * verdad dentro de una transacción que se revierte: lo que cambia el equipo queda en la
 * auditoría, que no admite borrado.
 */
export interface TeamStore {
  standing(claims: VerifiedClaims, ticketPrint: string | null): Promise<TeamStanding>;
  /** Tres de sus rechazos escriben antes de contestar: quien la implemente confirma siempre. */
  accept(claims: VerifiedClaims, ticketPrint: string, factorId: string, handoffPrint: string | null): Promise<AcceptAnswer>;
}

/** Lo que la guarda de sesión contesta cuando no deja pasar. */
type Refused = Exclude<SessionCheck, { kind: "pass" }>;

export type TeamCheck = Refused | { kind: "team"; claims: VerifiedClaims; standing: TeamStanding };

export type FactorStart =
  | Refused
  /** `secret` y `uri` se pintan una vez, a quien lo está configurando. */
  | { kind: "started"; factorId: string; secret: string; uri: string }
  | { kind: "not_invited" }
  /** Tiene invitación, pero no ha abierto un enlace de su correo en este navegador. */
  | { kind: "needs_mailbox_proof" }
  /**
   * La cuenta ya tiene un factor verificado que nadie ató, y esta sesión está en primer
   * nivel: Auth no deja dar de alta otro. La salida es probar el buzón otra vez, que con
   * una invitación viva borra los factores sin atar.
   */
  | { kind: "needs_second_level" };

export type FactorConfirmation =
  | Refused
  /**
   * Atada. La sesión con la que aceptó se manda cerrar: entra de nuevo y da su código. Si
   * Auth no la pudo cerrar, queda dicho (`session_not_closed`).
   */
  | { kind: "accepted" }
  | { kind: "wrong_code" }
  /** El freno rechazó: Auth cerró todas sus sesiones. */
  | { kind: "throttled" }
  /** No hay factor dado de alta aquí, o el que había ya no existe. */
  | { kind: "start_again" }
  | { kind: "needs_handoff" }
  | { kind: "needs_mailbox_proof" }
  | { kind: "not_invited" }
  /** La sesión se perdió a media verificación. */
  | { kind: "signed_out" };

export type CodeGiven =
  | Refused
  | { kind: "verified" }
  | { kind: "wrong_code" }
  | { kind: "throttled" }
  | { kind: "not_member" }
  | { kind: "signed_out" };

const HANDOFF = /^[A-Z0-9]{8,32}$/;

/**
 * La huella del código que quien restablece le dictó a la persona, o nulo si lo tecleado no
 * tiene forma de código. Se dicta por voz: mayúsculas o minúsculas, con espacios o guiones,
 * es el mismo.
 */
export function handoffPrint(typed: unknown): string | null {
  if (typeof typed !== "string") return null;
  const code = typed.replace(/[\s-]/g, "").toUpperCase();
  return HANDOFF.test(code) ? createHash("sha256").update(code).digest("hex") : null;
}

/**
 * Corre un trabajo contra la base y, si la base cortó a uno de dos que se cruzaron, lo
 * intenta una vez más. Las funciones del equipo escriben en tablas de Supabase Auth, y Auth
 * puede estar tocando las mismas filas: ese corte es «reintenta», no una caída.
 */
export async function withLockRetry<T>(work: () => Promise<T>, retryable: (error: unknown) => boolean): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!retryable(error)) throw error;
    return work();
  }
}

export interface TeamCore {
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  store: TeamStore;
  /** Solo para las pruebas: las cookies con otro sitio. */
  tickets?: Pick<typeof mailboxTickets, "readTicketPrint" | "dropTicket">;
  factors?: Pick<typeof enrolledFactors, "keepEnrolledFactor" | "readEnrolledFactor" | "dropEnrolledFactor">;
}

export function createTeam(deps: Pick<AccountDependencies, "auth" | "report">, core: TeamCore) {
  const { auth } = deps;
  const { store } = core;
  const { readTicketPrint, dropTicket } = core.tickets ?? mailboxTickets;
  const { keepEnrolledFactor, readEnrolledFactor, dropEnrolledFactor } = core.factors ?? enrolledFactors;

  /**
   * En qué estado está respecto al equipo quien trae esa sesión. La guarda de sesión corre
   * antes: lo que no sea «pasa» se contesta tal cual, sin preguntar más.
   */
  async function teamStanding(reader: CookieReader): Promise<TeamCheck> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return check;
    try {
      return { kind: "team", claims: check.claims, standing: await store.standing(check.claims, readTicketPrint(reader)) };
    } catch {
      await deps.report("team_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Empezar a configurar el segundo factor: lo da de alta en Auth y lo anota en ese
   * navegador. Solo para quien tiene una invitación que puede aceptar y ya probó su buzón.
   */
  async function startSecondFactor(jar: CookieJar): Promise<FactorStart> {
    const team = await teamStanding(jar);
    if (team.kind !== "team") return team;
    if (team.standing.state === "invited_unproven") return { kind: "needs_mailbox_proof" };
    if (team.standing.state !== "invited") return { kind: "not_invited" };

    const enrolled = await auth.enrollFactor(jar);
    if (!enrolled.ok) return { kind: enrolled.reason === "needs_second_level" ? "needs_second_level" : "unavailable" };
    // Sin dónde anotarlo no hay cómo verificarlo después: no se supo.
    if (!keepEnrolledFactor(jar, team.claims.sessionId ?? "", enrolled.factorId)) return { kind: "unavailable" };
    return { kind: "started", factorId: enrolled.factorId, secret: enrolled.secret, uri: enrolled.uri };
  }

  /**
   * Verificar el código del factor recién dado de alta y, con la sesión ya en segundo
   * nivel, aceptar la invitación. Aceptada, la sesión se manda cerrar: la del equipo nace
   * después de atar, entrando de nuevo y dando el código. Cerrarla es un paso aparte, que
   * depende de Auth: si falla, se aceptó igual y queda dicho.
   */
  async function confirmSecondFactor(jar: CookieJar, input: { code: string; handoff?: unknown }): Promise<FactorConfirmation> {
    const team = await teamStanding(jar);
    if (team.kind !== "team") return team;
    const { standing } = team;
    if (standing.state === "invited_unproven") return { kind: "needs_mailbox_proof" };
    if (standing.state !== "invited") return { kind: "not_invited" };

    const factorId = readEnrolledFactor(jar, team.claims.sessionId ?? "");
    if (factorId === null) return { kind: "start_again" };
    const ticket = readTicketPrint(jar);
    if (ticket === null) return { kind: "needs_mailbox_proof" };
    // En un restablecimiento, sin un código dictado con forma no se llama a nadie: a la
    // base, uno nulo le cuenta como un intento fallido.
    const handoff = standing.kind === "rebind" ? handoffPrint(input.handoff) : null;
    if (standing.kind === "rebind" && handoff === null) return { kind: "needs_handoff" };

    const verification = await auth.verifyFactor(jar, factorId, input.code);
    switch (verification.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
        return { kind: verification.kind };
      case "factor_gone":
        dropEnrolledFactor(jar);
        return { kind: "start_again" };
      case "no_session":
        return { kind: "signed_out" };
      case "oversized_session":
        // El adaptador ya la cerró. El factor quedó verificado y sin atar: lo borra volver a
        // probar el buzón. Que alguien lo sepa, como cuando pasa al entrar.
        await deps.report("session_oversized");
        return { kind: "signed_out" };
      case "unknown":
        return { kind: "unavailable" };
    }

    // Desde aquí la sesión está en segundo nivel y el factor, verificado. Con las claims
    // nuevas: son las de esa misma sesión, ya subida.
    const { claims } = verification;
    let answer: AcceptAnswer | "unknown";
    try {
      answer = await store.accept(claims, ticket, factorId, handoff);
    } catch {
      // La transacción pudo confirmarse y perderse su respuesta: no se sabe si aceptó.
      answer = "unknown";
    }

    // Solo «aceptada» y las dos que dicen que falta configuración se toman tal cual: con
    // ellas nada se quita. Con cualquier otra se vuelve a leer el estado antes de decidir:
    // nunca se le quita un factor a alguien sin haber visto que no quedó atada.
    if (answer !== "accepted" && answer !== "needs_code" && answer !== "unavailable") {
      const lost = answer === "unknown";
      let now: TeamStanding | null;
      try {
        now = await store.standing(claims, ticket);
      } catch {
        now = null;
      }
      if (now === null) {
        // No se supo: nada se quita. El código dictado equivocado se dice igual, que ya contó.
        if (answer !== "needs_handoff") answer = "unknown";
      } else if (now.state === "member" || now.state === "needs_code") {
        // Ya tiene su atadura: se aceptó. Fue un doble envío y el otro ya aceptó (con eso la
        // invitación dejó de estar viva), o se perdió la respuesta. Vale pase o no esta sesión
        // la puerta: el factor de este navegador puede ser justo el que quedó atado, y
        // quitarlo la dejaría sin con qué entrar.
        answer = "accepted";
        // Que la base aceptó y no se le entendió, alguien tiene que saberlo.
        if (lost) await deps.report("invitation_answer_lost");
      } else if (answer === "needs_handoff" && (now.state === "none" || now.state === "unbound")) {
        // El fallo que llega al límite revoca la invitación, y la base contesta lo mismo que
        // en los anteriores. Sin invitación ya no hay siguiente intento para ese factor.
        answer = "no_invitation";
      }
    }

    /** Lo que seguía no ocurrió: el factor verificado no puede quedarse sin que nadie lo ate. */
    const discard = async () => {
      if ((await auth.removeFactor(jar, factorId)) !== "removed") await deps.report("second_factor_not_removed");
      dropEnrolledFactor(jar);
    };

    switch (answer) {
      case "accepted":
        dropTicket(jar);
        dropEnrolledFactor(jar);
        if ((await auth.signOut(jar)) !== "closed") await deps.report("session_not_closed");
        return { kind: "accepted" };
      case "needs_handoff":
        // La invitación sigue viva y sin aceptar, o no se supo: el factor se queda, y el
        // siguiente intento, con el código dictado bien, lo ata.
        return { kind: "needs_handoff" };
      case "needs_mailbox_proof":
        await discard();
        return { kind: "needs_mailbox_proof" };
      case "no_invitation":
      case "already_bound":
      case "inviter_lost_config":
      case "ineligible":
        await discard();
        return { kind: "not_invited" };
      case "needs_code":
      case "unavailable":
      case "unknown":
        // Recién verificado y la base dice que falta el código o que le falta un parámetro,
        // o no contestó: no es la persona. El factor se queda, para reintentar.
        await deps.report("invitation_not_accepted");
        return { kind: "unavailable" };
    }
  }

  /**
   * Dar el código del segundo factor: quien es del equipo y está entrando, o quien ya entró
   * y necesita un código reciente para cambiar el equipo. El factor es el que dice la base.
   */
  async function giveSecondFactorCode(jar: CookieJar, code: string): Promise<CodeGiven> {
    const team = await teamStanding(jar);
    if (team.kind !== "team") return team;
    const { standing } = team;
    if (standing.state !== "needs_code" && standing.state !== "member") return { kind: "not_member" };

    const verification = await auth.verifyFactor(jar, standing.factor, code);
    switch (verification.kind) {
      case "verified":
        break;
      case "wrong_code":
      case "throttled":
        return { kind: verification.kind };
      case "factor_gone":
        return { kind: "not_member" };
      case "no_session":
        return { kind: "signed_out" };
      case "oversized_session":
        // El adaptador ya la cerró. Que alguien lo sepa, como cuando pasa al entrar.
        await deps.report("session_oversized");
        return { kind: "signed_out" };
      case "unknown":
        return { kind: "unavailable" };
    }

    // Verificar salió bien: si la base sigue sin verla del equipo, es su configuración (le
    // falta la vigencia del segundo factor), y pedirle el código otra vez no arregla nada.
    try {
      const now = await store.standing(verification.claims, readTicketPrint(jar));
      if (now.state === "member") return { kind: "verified" };
    } catch {
      // Se reporta abajo.
    }
    await deps.report("team_unavailable");
    return { kind: "unavailable" };
  }

  return { teamStanding, startSecondFactor, confirmSecondFactor, giveSecondFactorCode };
}
