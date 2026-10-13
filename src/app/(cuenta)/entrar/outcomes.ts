import type { SignInResult } from "@/services/account/account";
import { parseEmail } from "@/services/account/field-rules";
import { consentsPath, entryDestination, ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

// Qué hace la pantalla de entrar con lo que contesta el servicio (diseño, PA-11; FL-05).
// Es una tabla pura: el servicio decide quién entra, y esto solo lo traduce a un destino o
// a lo que la pantalla pinta. Un caso nuevo se agrega aquí, con su prueba.

export interface SignInFields {
  email?: "required" | "invalid";
  password?: "required";
}

/** Lo que la pantalla pinta después de un envío. Nunca trae la contraseña. */
export type SignInState =
  | { kind: "idle" }
  | { kind: "invalid"; email: string; fields: SignInFields; attempt: number }
  | { kind: "failed"; email: string; reason: "invalid_credentials" | "capped" | "unavailable"; attempt: number }
  /** `retryAt`: cuándo se puede volver a intentar, en formato ISO. */
  | { kind: "throttled"; email: string; retryAt: string; attempt: number }
  | { kind: "suspended" };

export type SignInOutcome =
  | { kind: "redirect"; to: string; notice: Notice | null }
  | { kind: "failed"; reason: "invalid_credentials" | "capped" | "unavailable" }
  | { kind: "throttled"; retryAt: string }
  | { kind: "suspended" };

const MAX_EMAIL = 320;
const MAX_PASSWORD = 1_024;
const MAX_RETURN = 2_048;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

export interface SignInForm {
  email: string;
  password: string;
  /** El destino guardado (`volver`), tal como llegó. */
  returnTo: string;
}

/**
 * Lo que llega del formulario. Una acción de servidor es una puerta pública: el formulario
 * lo arma quien pide, y hasta puede no ser un formulario. Lo que no sea un texto, falte o
 * venga desmedido cuenta como vacío.
 */
export function readSignInForm(form: unknown): SignInForm {
  if (!(form instanceof FormData)) return { email: "", password: "", returnTo: "" };
  return {
    email: textOf(form.get("email"), MAX_EMAIL),
    password: textOf(form.get("password"), MAX_PASSWORD),
    returnTo: textOf(form.get("volver"), MAX_RETURN),
  };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie: que venga un correo con forma y una
 * contraseña. No delata nada de ninguna cuenta. Nulo si no hay nada que corregir.
 */
export function checkSignInForm(input: { email: string; password: string }): SignInFields | null {
  const fields: SignInFields = {};
  if (input.email.trim() === "") fields.email = "required";
  else if (!parseEmail(input.email).ok) fields.email = "invalid";
  if (input.password === "") fields.password = "required";
  return Object.keys(fields).length > 0 ? fields : null;
}

/** @param returnTo El destino guardado (`volver`), tal como llegó: aquí se valida. */
export function signInOutcome(result: SignInResult, returnTo: string): SignInOutcome {
  switch (result.kind) {
    case "entered":
      // A quien le falta algo de su cuenta se le pide antes que cualquier otra pantalla. A
      // quien no, su estado en el equipo dice a dónde va: quien no es del equipo, a su destino.
      return {
        kind: "redirect",
        to: result.pending ? consentsPath(returnTo) : entryDestination(result.team, returnTo),
        notice: null,
      };
    case "must_recover":
      return { kind: "redirect", to: ROUTES.recover, notice: "choose_password" };
    case "suspended":
      return { kind: "suspended" };
    case "throttled":
      return { kind: "throttled", retryAt: result.retryAt.toISOString() };
    case "invalid_credentials":
    case "capped":
    case "unavailable":
      return { kind: "failed", reason: result.kind };
  }
}
