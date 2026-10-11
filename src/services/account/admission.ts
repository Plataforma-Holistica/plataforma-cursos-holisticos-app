import "server-only";

import type { SignInResult as AuthSignIn } from "@/adapters/supabase/auth";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SignInDecision, SignInOutcome } from "@/domain/access/login-throttle";
import type { GateResult, MissingDocument } from "@/domain/access/session-gate";

import type { FailureCode } from "@/services/error-reporting/server";

// Qué hace la aplicación con lo que decidieron la guarda y la base (TRD §9.2, filas «Freno
// progresivo» y «Lo que entra sin pasar por el formulario»; flujo de la app §6.2).
//
// Todo aquí es puro: son las tablas que traducen una decisión a lo que ve la persona, a
// cómo se cierra el intento en el freno, a si la sesión se queda, y a si hay que avisarle a
// alguien. Los servicios cargan los hechos y obedecen; no deciden por su cuenta.

/** Lo que a una cuenta le falta para estar completa. Es lo que pide PA-15. */
export interface PendingAccount {
  /** «Completa tu cuenta», o «Actualizamos nuestros textos» si solo cambiaron versiones. */
  variant: "complete_account" | "updated_texts";
  missing: { name: boolean; adultDeclaration: boolean; documents: MissingDocument[] };
}

/** Lo que decidió la guarda del dominio, como lo usa el servicio. */
export type GateView =
  | { kind: "pass" }
  | ({ kind: "incomplete" } & PendingAccount)
  | { kind: "suspended" }
  /** La marca de contraseña sigue prendida. */
  | { kind: "must_recover" }
  /** Sin perfil, o cuenta eliminada. */
  | { kind: "gone" }
  | { kind: "unavailable"; reason: "no_current_text" | "facts_incomplete" };

export function gateViewOf(result: GateResult): GateView {
  switch (result.outcome) {
    case "pass":
      return { kind: "pass" };
    case "incomplete":
      return { kind: "incomplete", variant: result.variant, missing: result.missing };
    case "password_reset_required":
      return { kind: "must_recover" };
    case "unavailable":
      return { kind: "unavailable", reason: result.reason };
    case "blocked":
      return result.reason === "suspended" ? { kind: "suspended" } : { kind: "gone" };
  }
}

/** Lo que contesta `private.note_session()`. Lo que no esté en la lista no es `noted`. */
export type NoteState = "noted" | "stale" | "skewed" | "unclaimed" | "gone" | "ineligible";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un identificador de sesión con forma de serlo. Uno que no la tiene no llega a la base. */
export const isSessionId = (value: string | null): value is string => value !== null && UUID.test(value);

export type SignInResult =
  /** Entró. `pending` dice si antes de seguir hay que completar la cuenta (PA-15). */
  | { kind: "entered"; pending: PendingAccount | null }
  /** Un solo mensaje, exista o no la cuenta y sea cual sea el dato que falló. */
  | { kind: "invalid_credentials" }
  /** Frenado: la pantalla dice a qué hora se puede volver a intentar. */
  | { kind: "throttled"; retryAt: Date }
  /** Tope por hora, de la dirección o de la cuenta: «vuelve más tarde», sin hora. */
  | { kind: "capped" }
  /** La contraseña era correcta, pero esta cuenta solo se abre recuperándola (PA-13). */
  | { kind: "must_recover" }
  /** Cuenta suspendida: ve su aviso (PA-35), sin sesión. */
  | { kind: "suspended" }
  /** No se supo. No es un «no»: se puede volver a intentar. */
  | { kind: "unavailable" };

export interface Admission {
  result: SignInResult;
  /** Cómo se cierra el intento en el freno (`settleSignIn`). */
  outcome: SignInOutcome;
  /** La sesión se queda y su cookie llega al navegador. Si no, se cierra. */
  admit: boolean;
  report: FailureCode | null;
}

const refused = (
  result: SignInResult,
  outcome: SignInOutcome,
  report: FailureCode | null = null,
): Admission => ({ result, outcome, admit: false, report });

/**
 * Un intento que el freno no deja seguir. No se le pregunta a Auth y no se cuenta: no hay
 * nada que cerrar después.
 */
export function refusalOf(decision: Extract<SignInDecision, { proceed: false }>): {
  result: SignInResult;
  report: FailureCode | null;
} {
  switch (decision.reason) {
    case "throttled":
      return { result: { kind: "throttled", retryAt: decision.retryAt }, report: null };
    // Cuál de los dos topes fue no se dice: el de la cuenta delata que alguien más la intenta.
    case "ip_hourly_cap":
    case "account_hourly_cap":
      return { result: { kind: "capped" }, report: null };
    case "invalid_input":
      return { result: { kind: "unavailable" }, report: "throttle_unavailable" };
  }
}

/** Auth no dio sesión. `reason` es lo que contestó el adaptador. */
export function authRefusal(reason: Extract<AuthSignIn, { ok: false }>["reason"]): Admission {
  switch (reason) {
    // Auth distingue los tres. Mostrarlos delataría el estado de la cuenta.
    case "invalid_credentials":
    case "email_not_confirmed":
    case "banned":
      return refused({ kind: "invalid_credentials" }, "failure");
    // La contraseña era correcta, pero la sesión no cabe en la cookie. Recuperar borra lo
    // que la infla.
    case "oversized_session":
      return refused({ kind: "must_recover" }, "unknown", "session_oversized");
    // El límite de Auth, o no contestó: no se supo, y no es un fallo de quien intenta.
    default:
      return refused({ kind: "unavailable" }, "unknown");
  }
}

/**
 * Una entrada que Auth aceptó: la contraseña era la de la cuenta. `noted` es lo que
 * contestó la base al anotar la sesión, o `null` si no se llegó a pedir.
 *
 * El intento solo se cierra como entrada correcta si la persona entra o si la cuenta es
 * suya y está suspendida. Con la marca prendida se cierra como fallo: si no, quien dio de
 * alta un correo ajeno quedaría como dispositivo de confianza.
 */
export function decideAdmission(view: GateView, noted: NoteState | null): Admission {
  switch (view.kind) {
    case "must_recover":
      return refused({ kind: "must_recover" }, "failure");
    case "suspended":
      return refused({ kind: "suspended" }, "success");
    case "gone":
      return refused({ kind: "invalid_credentials" }, "failure");
    case "unavailable":
      return refused(
        { kind: "unavailable" },
        "unknown",
        view.reason === "no_current_text" ? "gate_no_current_text" : "gate_unavailable",
      );
    case "pass":
    case "incomplete":
      break;
  }

  switch (noted) {
    case "noted":
      return {
        result: {
          kind: "entered",
          pending: view.kind === "incomplete" ? { variant: view.variant, missing: view.missing } : null,
        },
        outcome: "success",
        admit: true,
        report: null,
      };
    // Empezó antes del último cambio de contraseña: Auth la aceptó con una que ya no vale.
    case "stale":
      return refused({ kind: "invalid_credentials" }, "failure");
    case "unclaimed":
      return refused({ kind: "must_recover" }, "failure");
    // `skewed` (el reloj de la base no es de fiar), `gone`, `ineligible`, o algo que la
    // base no debería contestar: no se supo. No es una contraseña equivocada.
    default:
      return refused({ kind: "unavailable" }, "unknown", "session_not_noted");
  }
}

export type SessionCheck =
  | { kind: "anonymous" }
  | { kind: "pass"; claims: VerifiedClaims }
  | ({ kind: "incomplete"; claims: VerifiedClaims } & PendingAccount)
  | { kind: "suspended" }
  /** La sesión no vale: hay que cerrarla, y mandar a recuperar o a entrar. */
  | { kind: "must_sign_out"; then: "recover" | "sign_in" }
  /** No se supo. No se trata como «sin sesión». */
  | { kind: "unavailable" };

/**
 * Una entrada con sesión. `recognition` es lo que contestó `private.session_recognized()`,
 * y `view` lo que decidió la guarda, o `null` si no se llegó a evaluar.
 *
 * Primero la sesión: una que la aplicación no abrió, o que Auth ya no tiene, no entra a
 * ningún lado, sea de la cuenta que sea. Se cierra solo cuando la base dijo que no vale:
 * una respuesta que no se entiende es «no se supo», y con eso no se le cierra a nadie.
 */
export function sessionCheckOf(
  recognition: string,
  view: GateView | null,
  claims: VerifiedClaims,
): { check: SessionCheck; report: FailureCode | null } {
  switch (recognition) {
    case "recognized":
      break;
    case "not_noted":
    case "gone":
      return { check: { kind: "must_sign_out", then: "sign_in" }, report: null };
    default:
      return { check: { kind: "unavailable" }, report: "gate_unavailable" };
  }
  if (view === null) return { check: { kind: "unavailable" }, report: "gate_unavailable" };
  switch (view.kind) {
    case "pass":
      return { check: { kind: "pass", claims }, report: null };
    case "incomplete":
      return { check: { kind: "incomplete", claims, variant: view.variant, missing: view.missing }, report: null };
    case "suspended":
      return { check: { kind: "suspended" }, report: null };
    case "must_recover":
      return { check: { kind: "must_sign_out", then: "recover" }, report: null };
    case "gone":
      return { check: { kind: "must_sign_out", then: "sign_in" }, report: null };
    case "unavailable":
      return {
        check: { kind: "unavailable" },
        report: view.reason === "no_current_text" ? "gate_no_current_text" : "gate_unavailable",
      };
  }
}
