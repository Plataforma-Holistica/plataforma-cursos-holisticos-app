import "server-only";

import {
  isAuthError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  isAuthWeakPasswordError,
} from "@supabase/supabase-js";

import type { PasswordSetResult } from "@/domain/access/password-outcome";

// Qué significa cada error de Supabase Auth, operación por operación (TRD §8.10).
//
// Todo es puro y va por listas cerradas. Lo que no está en una lista es «no se supo»:
// nunca un éxito, y nunca un motivo para borrar una sesión. El mensaje del proveedor no
// se lee ni se conserva: solo su código, que es un identificador y no un texto.

/** Un fallo de Auth, ya sin nada del proveedor más que su código. */
export type AuthFailure =
  /** No hubo respuesta que valga: red, tiempo límite o un error del lado de Auth (5xx). */
  | { kind: "unreachable" }
  /** Auth contestó que no. `code` es `null` si la respuesta no trae un código de texto. */
  | { kind: "rejected"; status: number; code: string | null };

/** Lee un error del SDK. Lo que no es un error suyo cuenta como «no hubo respuesta». */
export function failureFromSdk(error: unknown): AuthFailure {
  if (!isAuthError(error) || isAuthRetryableFetchError(error)) return { kind: "unreachable" };
  const status = typeof error.status === "number" ? error.status : 0;
  if (status >= 500 || status === 0) return { kind: "unreachable" };
  // Estas dos clases no siempre traen código: el SDK las reconoce por su forma.
  if (isAuthSessionMissingError(error)) return { kind: "rejected", status, code: "session_not_found" };
  if (isAuthWeakPasswordError(error)) return { kind: "rejected", status, code: "weak_password" };
  return { kind: "rejected", status, code: typeof error.code === "string" ? error.code : null };
}

/**
 * Lee la respuesta de una llamada directa a Auth que no fue un éxito. Con la cabecera de
 * versión que manda `auth-client.ts`, el código llega como texto en `code`; sin ella sería
 * un número, y aquí no se acepta.
 */
export function failureFromResponse(status: number, body: unknown): AuthFailure {
  if (status >= 500) return { kind: "unreachable" };
  const code =
    typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : null;
  return { kind: "rejected", status, code };
}

const codeOf = (failure: AuthFailure): string | null =>
  failure.kind === "rejected" ? failure.code : null;

const SIGN_UP = new Map<string, "mail_rate_limited" | "signup_disabled" | "rejected" | "misconfigured">([
  ["over_email_send_rate_limit", "mail_rate_limited"],
  ["signup_disabled", "signup_disabled"],
  ["email_provider_disabled", "signup_disabled"],
  ["validation_failed", "rejected"],
  ["email_address_invalid", "rejected"],
  // Con las dos confirmaciones prendidas Auth no dice «ya existe». Si lo dice, alguien
  // apagó una: la respuesta delataría qué correos tienen cuenta.
  ["user_already_exists", "misconfigured"],
  ["email_exists", "misconfigured"],
]);

export type SignUpFailure = "mail_rate_limited" | "signup_disabled" | "rejected" | "misconfigured" | "unknown";

export function signUpFailure(failure: AuthFailure): SignUpFailure {
  return SIGN_UP.get(codeOf(failure) ?? "") ?? "unknown";
}

export type RecoveryRequestFailure = "mail_rate_limited" | "unknown";

export function recoveryRequestFailure(failure: AuthFailure): RecoveryRequestFailure {
  return codeOf(failure) === "over_email_send_rate_limit" ? "mail_rate_limited" : "unknown";
}

// El enlace no sirve: caducó, ya se usó, es de otro tipo, no tiene forma, o la cuenta ya
// no puede entrar. En todos los casos la persona pide otro.
const LINK_DEAD = new Set(["otp_expired", "validation_failed", "user_banned", "user_not_found"]);

export type RedeemFailure = "invalid_or_expired" | "unknown";

export function redeemFailure(failure: AuthFailure): RedeemFailure {
  return LINK_DEAD.has(codeOf(failure) ?? "") ? "invalid_or_expired" : "unknown";
}

// Auth dijo que no, y se sabe que la contraseña no quedó fijada.
const PASSWORD_REJECTED = new Set([
  "validation_failed",
  "bad_jwt",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  "reauthentication_needed",
  "insufficient_aal",
]);

/** El resultado de pedirle a Auth que fije una contraseña, cuando no fue un éxito. */
export function passwordSetFailure(failure: AuthFailure): Exclude<PasswordSetResult, "ok"> {
  const code = codeOf(failure) ?? "";
  if (code === "same_password") return "same_password";
  if (code === "weak_password") return "weak_password";
  return PASSWORD_REJECTED.has(code) ? "rejected" : "unknown";
}

const SIGN_IN = new Map<string, "invalid_credentials" | "email_not_confirmed" | "banned" | "rate_limited">([
  ["invalid_credentials", "invalid_credentials"],
  // Un correo o una contraseña sin forma: el servicio los valida antes, y si aun así
  // llegan, para quien pide es lo mismo que no acertar.
  ["validation_failed", "invalid_credentials"],
  ["email_not_confirmed", "email_not_confirmed"],
  ["user_banned", "banned"],
  ["over_request_rate_limit", "rate_limited"],
]);

export type SignInFailure =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "banned"
  | "rate_limited"
  | "unknown";

export function signInFailure(failure: AuthFailure): SignInFailure {
  return SIGN_IN.get(codeOf(failure) ?? "") ?? "unknown";
}

// Los únicos motivos por los que una renovación fallida borra la cookie: la sesión ya no
// existe en Auth, y ninguna renovación posterior la va a recuperar. Un 429, un 5xx, un
// corte de red o una respuesta que no se entiende no están aquí a propósito: con ellos la
// sesión sigue viva, y borrar la cookie le cerraría la sesión a quien no hizo nada.
const SESSION_GONE_ON_REFRESH = new Set([
  "refresh_token_not_found",
  "refresh_token_already_used",
  "session_not_found",
  "session_expired",
  "user_not_found",
  "user_banned",
  // El token de renovación no tiene forma o no lo emitió este servidor: nunca va a servir.
  "validation_failed",
]);

export function sessionLostOnRefresh(failure: AuthFailure): boolean {
  return SESSION_GONE_ON_REFRESH.has(codeOf(failure) ?? "");
}

// Cerrar algo que ya no existe es haberlo cerrado.
const ALREADY_CLOSED = new Set(["session_not_found", "user_not_found"]);

export function alreadyClosed(failure: AuthFailure): boolean {
  return ALREADY_CLOSED.has(codeOf(failure) ?? "");
}

// Lo que Auth contesta cuando se le pregunta por una sesión que ya no vale. `bad_jwt` no
// está: es lo que contesta a un token vencido, y eso no dice nada de la sesión.
const SESSION_REVOKED = new Set(["session_not_found", "user_not_found", "user_banned"]);

export function sessionRevoked(failure: AuthFailure): boolean {
  return SESSION_REVOKED.has(codeOf(failure) ?? "");
}
