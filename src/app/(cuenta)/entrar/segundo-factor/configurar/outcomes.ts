import type { FactorConfirmation, FactorStart } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";

import { checkCode } from "../outcomes";

// Qué hace la pantalla que configura el segundo factor con lo que contestan sus dos
// servicios (diseño, PA-12; flujo de la app §6.2): empezar, que da de alta el factor y
// muestra su clave, y confirmar, que verifica el código y acepta la invitación. Son tablas
// puras: quién tiene una invitación y qué factor se ata lo deciden el servicio y la base.
//
// Viaja al navegador: no importa nada del servidor.

/** A dónde se sale de la pantalla. `closeSession`: la sesión de esta petición ya no vale. */
interface Leave {
  kind: "redirect";
  to: string;
  notice: Notice | null;
  closeSession: boolean;
}

type Refusal = Exclude<FactorStart, { kind: "started" | "not_invited" | "needs_mailbox_proof" | "needs_second_level" }>;

/** Lo que hacen las dos acciones cuando la guarda de sesión no dejó pasar a quien envió. */
function refusalOutcome(check: Refusal): Leave | { kind: "suspended" } | { kind: "unavailable" } {
  switch (check.kind) {
    case "anonymous":
      return { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: false };
    case "incomplete":
      return { kind: "redirect", to: ROUTES.consents, notice: null, closeSession: false };
    case "must_sign_out":
      return check.then === "recover"
        ? { kind: "redirect", to: ROUTES.recover, notice: "choose_password", closeSession: true }
        : { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: true };
    case "suspended":
      return { kind: "suspended" };
    case "unavailable":
      return { kind: "unavailable" };
  }
}

// ---------------------------------------------------------------------------------------
// Empezar.

/**
 * Lo que la pantalla pinta después de «Empezar». `started` trae la clave, y es el único
 * estado de la aplicación que la trae: mientras sea el vigente no se pinta ningún formulario
 * de esa acción, porque sin JavaScript el estado viaja dentro del formulario.
 */
export type StartState =
  | { kind: "idle" }
  /** `factorId` vuelve como «lo que pinté». `qr`: la imagen, ya como dirección de datos, o nulo. */
  | { kind: "started"; factorId: string; secret: string; uri: string; qr: string | null; attempt: number }
  | { kind: "needs_mailbox_proof" }
  | { kind: "needs_second_level" }
  | { kind: "unavailable"; attempt: number }
  | { kind: "suspended" };

export type StartOutcome =
  | Leave
  | { kind: "started"; factorId: string; secret: string; uri: string; qr: string | null }
  | { kind: "needs_mailbox_proof" }
  | { kind: "needs_second_level" }
  | { kind: "suspended" }
  | { kind: "unavailable" };

export function startOutcome(result: FactorStart): StartOutcome {
  switch (result.kind) {
    case "started":
      return { kind: "started", factorId: result.factorId, secret: result.secret, uri: result.uri, qr: result.qr };
    case "not_invited":
      // Ya no tiene una invitación que pueda aceptar (se revocó, o ya es del equipo): la
      // guarda de esta misma pantalla vuelve a decidir qué le toca ver.
      return { kind: "redirect", to: ROUTES.factorSetup, notice: null, closeSession: false };
    case "needs_mailbox_proof":
    case "needs_second_level":
      return { kind: result.kind };
    default:
      return refusalOutcome(result);
  }
}

// ---------------------------------------------------------------------------------------
// Confirmar.

export interface ConfirmFields {
  code?: "required" | "invalid" | "wrong";
  /** El código que dicta quien restableció el factor: faltó, o no es ese. */
  handoff?: "required" | "wrong";
}

/** Lo que la pantalla pinta después de enviar el código. Nunca trae el código ni la clave. */
export type ConfirmState =
  | { kind: "idle" }
  | { kind: "invalid"; fields: ConfirmFields; attempt: number }
  /** La clave que la persona tiene delante ya no es la vigente: toca empezar de nuevo. */
  | { kind: "start_again"; attempt: number }
  | { kind: "needs_mailbox_proof" }
  | { kind: "unavailable"; attempt: number }
  | { kind: "suspended" };

export type ConfirmOutcome =
  | Leave
  | { kind: "invalid"; fields: ConfirmFields }
  | { kind: "start_again" }
  | { kind: "needs_mailbox_proof" }
  | { kind: "suspended" }
  | { kind: "unavailable" };

const MAX_CODE = 64;
// El código dictado mide hasta 32, y se dicta con espacios o guiones.
const MAX_HANDOFF = 128;
// Un identificador de factor mide 36. Lo que pase de aquí no lo pintó esta pantalla.
const MAX_PAINTED = 64;

const textOf = (value: FormDataEntryValue | null, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";

export interface ConfirmForm {
  code: string;
  handoff: string;
  /** El factor que la pantalla dice que pintó. Solo se compara: no decide qué se ata. */
  painted: string;
}

/**
 * Lo que llega del formulario. Una acción de servidor es una puerta pública: lo que no sea
 * un texto, falte o venga desmedido cuenta como vacío.
 */
export function readConfirmForm(form: unknown): ConfirmForm {
  if (!(form instanceof FormData)) return { code: "", handoff: "", painted: "" };
  return {
    code: textOf(form.get("code"), MAX_CODE),
    handoff: textOf(form.get("handoff"), MAX_HANDOFF),
    painted: textOf(form.get("painted"), MAX_PAINTED),
  };
}

/**
 * Lo que se puede revisar sin preguntarle a nadie: la forma del código. Si hace falta el
 * código dictado no se sabe aquí: lo dice la base, por el servicio. Nulo si no hay nada que
 * corregir.
 */
export function checkConfirmForm(input: { code: string }): ConfirmFields | null {
  const problem = checkCode(input.code);
  return problem ? { code: problem } : null;
}

/** @param typedHandoff El código dictado tal como se tecleó: solo para saber si faltó. */
export function confirmOutcome(result: FactorConfirmation, typedHandoff: string): ConfirmOutcome {
  switch (result.kind) {
    case "accepted":
      // Atada, y sin sesión: la base la cerró al aceptar y el servicio ya borró su cookie.
      // Entra de nuevo y da su código.
      return { kind: "redirect", to: ROUTES.signIn, notice: "second_factor_ready", closeSession: false };
    case "wrong_code":
      return { kind: "invalid", fields: { code: "wrong" } };
    case "throttled":
      // El freno rechazó: Auth ya cerró todas las sesiones y el adaptador borró la cookie.
      return { kind: "redirect", to: ROUTES.signIn, notice: "second_factor_throttled", closeSession: false };
    case "start_again":
      return { kind: "start_again" };
    case "needs_handoff":
      return { kind: "invalid", fields: { handoff: typedHandoff.trim() === "" ? "required" : "wrong" } };
    case "needs_mailbox_proof":
      return { kind: "needs_mailbox_proof" };
    case "not_invited":
      return { kind: "redirect", to: ROUTES.factorSetup, notice: null, closeSession: false };
    case "signed_out":
      // La sesión se cerró en otro lado a media verificación: su cookie se quedó, y se borra.
      return { kind: "redirect", to: ROUTES.signIn, notice: "session_ended", closeSession: true };
    default:
      return refusalOutcome(result);
  }
}
