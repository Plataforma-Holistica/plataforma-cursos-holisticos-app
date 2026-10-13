import type { CodeGiven } from "@/services/account/account";
import { parseSecondFactorCode } from "@/services/account/field-rules";
import { consentsPath, ROUTES, secondFactorPath, signInPath, teamDestination } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

// Qué hace la pantalla que pide el código del segundo factor con lo que contesta el
// servicio (diseño, PA-12; flujo de la app §6.2). Es una tabla pura: el servicio decide si
// el código vale y quién es del equipo, y esto solo lo traduce a un destino o a lo que la
// pantalla pinta. Un caso nuevo se agrega aquí, con su prueba.
//
// Viaja al navegador, que revisa la forma del código al salir del campo: no importa nada
// del servidor.

export type CodeProblem = "required" | "invalid";

/** Lo que la pantalla pinta después de un envío. Nunca trae el código. */
export type GiveCodeState =
  | { kind: "idle" }
  | { kind: "invalid"; problem: CodeProblem; attempt: number }
  | { kind: "failed"; reason: "wrong_code" | "unavailable"; attempt: number }
  | { kind: "suspended" };

export type GiveCodeOutcome =
  /** `closeSession`: la sesión de esta petición ya no vale, y la acción la cierra antes de irse. */
  | { kind: "redirect"; to: string; notice: Notice | null; closeSession: boolean }
  | { kind: "failed"; reason: "wrong_code" | "unavailable" }
  | { kind: "suspended" };

// Un código pegado trae espacios, y quien lo teclea puede dejar alguno de más. Lo que pase
// de aquí no es un código.
const MAX_CODE = 64;
const MAX_RETURN = 2_048;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

export interface GiveCodeForm {
  code: string;
  /** El destino guardado (`volver`), tal como llegó. */
  returnTo: string;
}

/**
 * Lo que llega del formulario. Una acción de servidor es una puerta pública: lo que no sea
 * un texto, falte o venga desmedido cuenta como vacío.
 */
export function readGiveCodeForm(form: unknown): GiveCodeForm {
  if (!(form instanceof FormData)) return { code: "", returnTo: "" };
  return { code: textOf(form.get("code"), MAX_CODE), returnTo: textOf(form.get("volver"), MAX_RETURN) };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie: que venga un código con forma de código.
 * Es la regla del dominio, la misma que aplica el servicio. Un código sin forma no llega a
 * Auth, y por eso no cuenta en su freno. Nulo si no hay nada que corregir.
 */
export function checkCode(code: string): CodeProblem | null {
  const parsed = parseSecondFactorCode(code);
  if (parsed.ok) return null;
  return parsed.reason === "empty" ? "required" : "invalid";
}

/** @param returnTo El destino guardado (`volver`), tal como llegó: aquí se valida. */
export function giveCodeOutcome(result: CodeGiven, returnTo: string): GiveCodeOutcome {
  switch (result.kind) {
    case "verified":
      return { kind: "redirect", to: teamDestination(returnTo), notice: null, closeSession: false };
    case "wrong_code":
      return { kind: "failed", reason: "wrong_code" };
    case "throttled":
      // El freno rechazó: Auth ya cerró todas las sesiones de la cuenta y el adaptador borró
      // la cookie. No queda nada que cerrar: solo decirle qué pasó.
      return { kind: "redirect", to: ROUTES.signIn, notice: "second_factor_throttled", closeSession: false };
    case "not_member":
      // Ya no está a un código de entrar (le quitaron sus capacidades, o su factor ya no
      // existe). La guarda de esta misma pantalla vuelve a decidir qué le toca ver.
      return { kind: "redirect", to: secondFactorPath(returnTo), notice: null, closeSession: false };
    case "signed_out":
      // La sesión se cerró en otro lado a media verificación: su cookie se quedó, y se borra.
      return { kind: "redirect", to: ROUTES.signIn, notice: "session_ended", closeSession: true };
    case "anonymous":
      return { kind: "redirect", to: signInPath(returnTo), notice: null, closeSession: false };
    case "incomplete":
      // A la cuenta le falta algo: lo pide su pantalla, y después sigue a donde iba.
      return { kind: "redirect", to: consentsPath(returnTo), notice: null, closeSession: false };
    case "must_sign_out":
      return result.then === "recover"
        ? { kind: "redirect", to: ROUTES.recover, notice: "choose_password", closeSession: true }
        : { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: true };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
  }
}
