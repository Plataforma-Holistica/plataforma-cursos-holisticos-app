import type { NameChange, OthersClosing, PasswordChange, PasswordChangeErrors, SessionClosing } from "@/services/account/account";
import { checkPasswordChange, parseDisplayName } from "@/services/account/field-rules";
import { consentsPath, ROUTES, signInPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

// Qué pinta y qué hace la pantalla de la cuenta (diseño, PA-25; FL-27). Todo aquí es puro:
// el servicio corre la guarda y guarda, y esto traduce su respuesta a un destino o a lo que
// se pinta. Un caso nuevo se agrega aquí, con su prueba. Cada bloque de la pantalla tiene
// su estado, su lector del formulario y su tabla.
//
// Viaja al navegador, que lo usa para revisar antes de enviar: no importa nada del servidor.

export type NameProblem = Extract<NameChange, { kind: "invalid" }>["reason"];

/** Lo que el bloque del nombre pinta después de un envío. */
export type NameState =
  | { kind: "idle" }
  | { kind: "invalid"; name: string; problem: NameProblem; attempt: number }
  /** `name`: como quedó guardado, sin espacios en los extremos. */
  | { kind: "saved"; name: string; attempt: number }
  | { kind: "unavailable"; name: string; attempt: number }
  | { kind: "suspended" };

const MAX_NAME = 500;

/**
 * Lo que llega del formulario del nombre. Lo que no sea un texto, o venga desmedido, cuenta
 * como vacío. De quién es la cuenta no se lee de aquí: lo dice la sesión.
 */
export function readNameForm(form: unknown): { name: string } {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { name: "" };
  const value = form.get("name");
  return { name: typeof value === "string" && value.length <= MAX_NAME ? value : "" };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie. Lo usa el navegador antes de enviar; la
 * revisión que manda es la del servicio, con la misma regla. Nulo si no hay nada que corregir.
 */
export function checkNameForm(input: { name: string }): NameProblem | null {
  const parsed = parseDisplayName(input.name);
  return parsed.ok ? null : parsed.reason;
}

export type NameOutcome =
  /** `closeSession`: la guarda dijo que esta sesión ya no vale, y la acción la cierra antes de irse. */
  | {
      kind: "redirect";
      to: string;
      notice: Notice | null;
      closeSession: boolean;
      /** La persona pidió salir de ese navegador: se lleva también el resguardo del buzón y el factor a medias. */
      forgetProofs?: boolean;
    }
  | { kind: "saved"; name: string }
  | { kind: "invalid"; problem: NameProblem }
  | { kind: "suspended" }
  | { kind: "unavailable" };

type Refusal = Extract<NameChange, { kind: "session" }>["check"];
type RefusalOutcome = Extract<NameOutcome, { kind: "redirect" | "suspended" | "unavailable" }>;

/** Lo que hace cualquier bloque de la pantalla cuando la guarda no dejó pasar a quien lo envió. */
function refusalOutcome(check: Refusal): RefusalOutcome {
  switch (check.kind) {
    case "anonymous":
      return { kind: "redirect", to: signInPath(ROUTES.account), notice: null, closeSession: false };
    case "incomplete":
      // A la cuenta le falta algo: lo pide su pantalla, y después se vuelve aquí.
      return { kind: "redirect", to: consentsPath(ROUTES.account), notice: null, closeSession: false };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "unavailable" };
    case "must_sign_out":
      return check.then === "recover"
        ? { kind: "redirect", to: ROUTES.recover, notice: "choose_password", closeSession: true }
        : { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: true };
  }
}

export function changeNameOutcome(result: NameChange): NameOutcome {
  switch (result.kind) {
    case "saved":
      return { kind: "saved", name: result.name };
    case "invalid":
      return { kind: "invalid", problem: result.reason };
    case "unavailable":
      return { kind: "unavailable" };
    case "session":
      return refusalOutcome(result.check);
  }
}

// ---------------------------------------------------------------------------------------
// El bloque de las sesiones abiertas (FL-27, paso 4).

/** Lo que el bloque de sesiones pinta después de un envío. */
export type SessionsState =
  | { kind: "idle" }
  /** `what`: una sesión, todas las demás, o una que ya no estaba abierta. */
  | { kind: "closed"; what: "one" | "others" | "gone"; attempt: number }
  | { kind: "unavailable"; attempt: number }
  | { kind: "suspended" };

/** El valor del botón «Cerrar todas las demás». Los otros botones llevan el identificador de su sesión. */
export const CLOSE_OTHERS = "others";

/** Lo que mide un identificador de sesión. Más largo que eso no es ninguno. */
const MAX_CLOSE_TARGET = 36;

export type SessionsRequest =
  | { target: "one"; sessionId: string }
  | { target: "others" }
  /** No se entiende qué se quiere cerrar: no se cierra nada. */
  | { target: "none" };

/**
 * Lo que llega del formulario de las sesiones: qué botón se pulsó. De quién es la cuenta, y
 * cuál es la sesión que se queda, no se leen de aquí: lo dice la sesión de quien envía.
 */
export function readSessionsForm(form: unknown): SessionsRequest {
  if (!(form instanceof FormData)) return { target: "none" };
  const value = form.get("close");
  if (typeof value !== "string" || value === "" || value.length > MAX_CLOSE_TARGET) return { target: "none" };
  return value === CLOSE_OTHERS ? { target: "others" } : { target: "one", sessionId: value };
}

export type SessionsOutcome = RefusalOutcome | { kind: "closed"; what: "one" | "others" | "gone" };

export function closeSessionOutcome(result: SessionClosing): SessionsOutcome {
  switch (result.kind) {
    case "closed":
      return { kind: "closed", what: "one" };
    case "not_found":
      // De otra cuenta o ya cerrada, hacia fuera es lo mismo: esa sesión no está abierta aquí.
      return { kind: "closed", what: "gone" };
    case "current":
      // La pantalla no manda la sesión propia por aquí. A quien la manda se le hace lo que
      // pidió por el camino que sí borra la cookie: se cierra y se va a la portada.
      // Es salir de ese navegador: se lleva también las pruebas que guardaba.
      return { kind: "redirect", to: ROUTES.landing, notice: null, closeSession: true, forgetProofs: true };
    case "unavailable":
      return { kind: "unavailable" };
    case "session":
      return refusalOutcome(result.check);
  }
}

export function closeOthersOutcome(result: OthersClosing): SessionsOutcome {
  switch (result.kind) {
    case "closed":
      return { kind: "closed", what: "others" };
    case "unavailable":
      return { kind: "unavailable" };
    case "session":
      return refusalOutcome(result.check);
  }
}

// ---------------------------------------------------------------------------------------
// El bloque de la contraseña (FL-27, paso 3).

/** Lo que hay que corregir, campo por campo. */
export type PasswordFields = PasswordChangeErrors;

/** Lo que el bloque de la contraseña pinta después de un envío. Nunca trae una contraseña. */
export type PasswordState =
  | { kind: "idle" }
  | { kind: "invalid"; fields: PasswordFields; attempt: number }
  | { kind: "changed"; attempt: number }
  /** `retryAt`: cuándo se puede volver a intentar, en formato ISO. */
  | { kind: "throttled"; retryAt: string; attempt: number }
  | { kind: "failed"; reason: "capped" | "unavailable"; attempt: number }
  /** La cuenta tiene segundo factor: el bloque deja de ofrecer el formulario. */
  | { kind: "recover_only" }
  | { kind: "suspended" };

const MAX_PASSWORD = 1_024;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

/**
 * Lo que llega del formulario de la contraseña: la actual y la nueva, tal como se
 * escribieron. Lo que no sea un texto de tamaño razonable cuenta como vacío. De quién es la
 * cuenta no se lee de aquí: lo dice la sesión.
 */
export function readPasswordForm(form: unknown): { current: string; next: string } {
  if (!(form instanceof FormData)) return { current: "", next: "" };
  return { current: textOf(form.get("current"), MAX_PASSWORD), next: textOf(form.get("password"), MAX_PASSWORD) };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie. Lo usa el navegador antes de enviar: un
 * envío que se detiene aquí no cuenta como un intento. La revisión que manda es la del
 * servicio, con la misma regla. Nulo si no hay nada que corregir.
 */
export function checkPasswordForm(input: { current: string; next: string }): PasswordFields | null {
  return checkPasswordChange(input.current, input.next);
}

export type PasswordOutcome =
  | RefusalOutcome
  | { kind: "changed" }
  | { kind: "invalid"; fields: PasswordFields }
  | { kind: "throttled"; retryAt: string }
  | { kind: "capped" }
  | { kind: "recover_only" };

export function changePasswordOutcome(result: PasswordChange): PasswordOutcome {
  switch (result.kind) {
    case "changed":
      return { kind: "changed" };
    case "second_factor":
      // No es un error ni hay a dónde ir: el bloque dice cómo se cambia en esa cuenta.
      return { kind: "recover_only" };
    case "invalid":
      return { kind: "invalid", fields: result.fields };
    case "throttled":
      return { kind: "throttled", retryAt: result.retryAt.toISOString() };
    case "capped":
      return { kind: "capped" };
    case "signed_out":
      // La cuenta quedó sin sesiones y este navegador sin cookie: eso ya lo hizo el servicio.
      // Aquí solo queda ir a entrar, sabiendo con cuál contraseña, y volver a la cuenta.
      return {
        kind: "redirect",
        to: signInPath(ROUTES.account),
        notice: result.password === "changed" ? "password_changed" : "password_unconfirmed",
        closeSession: false,
      };
    case "unavailable":
      return { kind: "unavailable" };
    case "session":
      return refusalOutcome(result.check);
  }
}
