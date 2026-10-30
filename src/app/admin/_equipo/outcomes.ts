import type {
  CapabilityGranted,
  CapabilityRevoked,
  FactorReset,
  FreshCode,
  InvitationRevoked,
  InviteResult,
  ReinviteResult,
} from "@/services/account/account";
import { parseEmail } from "@/services/account/field-rules";
import { ROUTES } from "@/services/account/navigation";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace la pantalla del equipo (diseño, PA-86; FL-56). Todo aquí es puro: el
// servicio corre la guarda y le pregunta a la base, y esto traduce su respuesta a un destino
// o a lo que se pinta. Cada bloque tiene su estado, su lector del formulario y su tabla, y
// cada respuesta de la base tiene su caso: uno nuevo se agrega aquí, con su prueba.
//
// Tres reglas que valen para todos los bloques:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene
//     configuración (`forbidden`), no se le dice nada aquí: se le manda a esta misma página,
//     donde decide la guarda de la página. Puede ser una alumna, una invitada, o alguien a
//     quien se le venció el código con la pantalla abierta.
//   · Lo que llega es qué botón se pulsó. Un envío sin intención, o con más de una, cuenta
//     como vacío. A quién se le hace algo sale del valor del botón, nunca del estado anterior.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState, Leave } from "../_lib/fresh-code";

/** A esta misma página: decide su guarda. */
const TO_PAGE: Leave = { kind: "leave", to: ROUTES.team, notice: null };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Una palabra corta: si es o no una capacidad lo revisa el servicio.
const WORD = /^[a-z]{1,20}$/;
// Los efectos confirmados, como los arma `effectsKey`: palabras unidas con «+», o nada.
const EFFECTS = /^(?:[a-z]{1,20}(?:\+[a-z]{1,20}){0,5})?$/;
const MAX_INTENT = 200;

/**
 * El botón que se pulsó: el único valor de `do`, partido por sus dos puntos. Nulo si lo que
 * llegó no es un formulario, no trae `do`, lo trae más de una vez o viene desmedido.
 */
function intentOf(form: unknown): string[] | null {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return null;
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return null;
  return only.split(":");
}

// ---------------------------------------------------------------------------------------
// «Tu código»: dar el código otra vez, para que un cambio pase.

/** Lo que contestó dar el código: la tabla compartida, con esta página. */
export function freshCodeOutcome(result: FreshCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.team);
}

// ---------------------------------------------------------------------------------------
// «Invitar».

export type InviteEmailProblem = "required" | "invalid";

export interface InviteProblems {
  email?: InviteEmailProblem;
  capabilities?: true;
}

export type InviteFailure =
  | "already_invited"
  | "already_member"
  | "ineligible"
  | "not_configured"
  | "invalid"
  | "needs_code"
  | "unavailable"
  | "unknown";

/** Lo que el bloque de invitar pinta después de un envío. Lo escrito vuelve: no se pierde. */
export type InviteState =
  | { kind: "idle" }
  | { kind: "invalid"; email: string; capabilities: string[]; problems: InviteProblems; attempt: number }
  /** `email`: como quedó guardado, para decirle a quién avisarle. */
  | { kind: "done"; answer: "invited_new" | "invited_existing"; email: string; attempt: number }
  | { kind: "failed"; reason: InviteFailure; email: string; capabilities: string[]; attempt: number };

const MAX_EMAIL = 500;
const MAX_CAPABILITIES = 10;

export interface InviteForm {
  email: string;
  capabilities: string[];
}

/**
 * Lo que llega del formulario de invitar: el correo y las casillas marcadas. Lo que no sea
 * un texto de tamaño razonable cuenta como vacío. Quién invita no se lee de aquí.
 */
export function readInviteForm(form: unknown): InviteForm {
  if (!(form instanceof FormData)) return { email: "", capabilities: [] };
  const email = form.get("email");
  const marked = form.getAll("capability");
  return {
    email: typeof email === "string" && email.length <= MAX_EMAIL ? email : "",
    capabilities:
      marked.length <= MAX_CAPABILITIES ? marked.filter((each): each is string => typeof each === "string" && WORD.test(each)) : [],
  };
}

const emailProblemOf = (reason: "empty" | "too_long" | "malformed"): InviteEmailProblem => (reason === "empty" ? "required" : "invalid");

/**
 * Lo que se puede revisar sin preguntarle a nadie. La revisión que manda es la del
 * servicio, con la misma regla. Nulo si no hay nada que corregir.
 */
export function checkInviteForm(input: InviteForm): InviteProblems | null {
  const problems: InviteProblems = {};
  const email = parseEmail(input.email);
  if (!email.ok) problems.email = emailProblemOf(email.reason);
  if (input.capabilities.length === 0) problems.capabilities = true;
  return problems.email === undefined && problems.capabilities === undefined ? null : problems;
}

/** El correo como se guarda, para decirlo. Si no tiene forma, como se escribió. */
export function shownEmail(typed: string): string {
  const parsed = parseEmail(typed);
  return parsed.ok ? parsed.email : typed.trim();
}

export type InviteOutcome =
  | Leave
  | { kind: "done"; answer: "invited_new" | "invited_existing" }
  | { kind: "invalid"; problems: InviteProblems }
  | { kind: "failed"; reason: InviteFailure };

/** Lo que hace cualquier bloque con una respuesta de `private.invite_admin()`. */
function invitedOutcome(answer: Extract<InviteResult, { kind: "answered" }>["answer"]): Exclude<InviteOutcome, { kind: "invalid" }> {
  switch (answer) {
    case "invited_new":
    case "invited_existing":
      return { kind: "done", answer };
    case "forbidden":
      return TO_PAGE;
    case "needs_fresh_code":
      return { kind: "failed", reason: "needs_code" };
    case "already_invited":
    case "already_member":
    case "ineligible":
    case "invalid":
      return { kind: "failed", reason: answer };
    case "unavailable":
      // Falta el plazo de las invitaciones: no lo arregla reintentar.
      return { kind: "failed", reason: "not_configured" };
  }
}

export function inviteOutcome(result: InviteResult): InviteOutcome {
  switch (result.kind) {
    case "answered":
      return invitedOutcome(result.answer);
    case "malformed": {
      const problems: InviteProblems = {};
      if (result.email !== null) problems.email = emailProblemOf(result.email);
      if (result.capabilities) problems.capabilities = true;
      return { kind: "invalid", problems };
    }
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
  }
}

// ---------------------------------------------------------------------------------------
// «El equipo»: dar y quitar capacidades.

export interface TeamIntent {
  type: "grant" | "revoke";
  profile: string;
  capability: string;
}

export type TeamFailure =
  | "already_has"
  /** Nadie se da una capacidad a sí mismo (T-401). */
  | "self"
  | "not_held"
  | "min_config"
  | "not_member"
  | "ineligible"
  | "invalid"
  | "needs_code"
  | "unavailable"
  | "unknown";

/** Lo que el bloque del equipo pinta después de un envío. */
export type TeamState =
  | { kind: "idle" }
  /** `changed`: lo que se había confirmado ya no es lo que pasaría, y se dice otra vez. */
  | { kind: "confirm"; intent: TeamIntent; changed: boolean; attempt: number }
  | { kind: "done"; what: "granted" | "revoked"; attempt: number }
  | { kind: "failed"; reason: TeamFailure; attempt: number };

export type TeamRequest =
  /** Todavía no se hace nada: se pregunta, con lo que va a pasar a la vista. */
  | { step: "ask"; intent: TeamIntent }
  /** `confirmed`: lo que la persona vio que pasaría, como lo arma `effectsKey`. */
  | { step: "confirm"; intent: TeamIntent; confirmed: string }
  | { step: "none" };

/** Los valores que llevan los botones del bloque del equipo. */
export const teamButton = {
  ask: (intent: TeamIntent) => `ask:${intent.type}:${intent.profile}:${intent.capability}`,
  confirm: (intent: TeamIntent, confirmed = "") => `confirm:${intent.type}:${intent.profile}:${intent.capability}:${confirmed}`,
  cancel: "cancel",
} as const;

/** Lo que llega del formulario del equipo: qué botón se pulsó. «Cancelar» es no pedir nada. */
export function readTeamForm(form: unknown): TeamRequest {
  const parts = intentOf(form);
  if (parts === null) return { step: "none" };
  const [step, type, profile = "", capability = "", confirmed = "", ...rest] = parts;
  if ((step !== "ask" && step !== "confirm") || (type !== "grant" && type !== "revoke")) return { step: "none" };
  if (!ID.test(profile) || !WORD.test(capability) || rest.length > 0) return { step: "none" };
  const intent: TeamIntent = { type, profile, capability };
  if (step === "ask") return parts.length === 4 ? { step: "ask", intent } : { step: "none" };
  return parts.length === 5 && EFFECTS.test(confirmed) ? { step: "confirm", intent, confirmed } : { step: "none" };
}

export type TeamOutcome =
  | Leave
  | { kind: "done"; what: "granted" | "revoked" }
  | { kind: "confirm_again" }
  | { kind: "failed"; reason: TeamFailure }
  /** Lo que llegó no tenía forma: no se dice nada. */
  | { kind: "idle" };

/** Lo que contestó `private.grant_capability()`. */
function grantedOutcome(answer: Extract<CapabilityGranted, { kind: "answered" }>["answer"]): TeamOutcome {
  switch (answer) {
    case "granted":
      return { kind: "done", what: "granted" };
    case "forbidden":
      return TO_PAGE;
    case "needs_fresh_code":
      return { kind: "failed", reason: "needs_code" };
    case "already_has":
    case "not_member":
    case "ineligible":
    case "invalid":
    case "self":
      return { kind: "failed", reason: answer };
  }
}

export function grantOutcome(result: CapabilityGranted): TeamOutcome {
  switch (result.kind) {
    case "answered":
      return grantedOutcome(result.answer);
    case "malformed":
      return { kind: "idle" };
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
  }
}

/** Lo que contestó `private.revoke_capability()`. */
function revokedOutcome(answer: Extract<CapabilityRevoked, { kind: "answered" }>["answer"]): TeamOutcome {
  switch (answer) {
    case "revoked":
      return { kind: "done", what: "revoked" };
    case "forbidden":
      return TO_PAGE;
    case "needs_fresh_code":
      return { kind: "failed", reason: "needs_code" };
    case "not_found":
      return { kind: "failed", reason: "not_held" };
    case "min_config":
      return { kind: "failed", reason: "min_config" };
  }
}

export function revokeOutcome(result: CapabilityRevoked): TeamOutcome {
  switch (result.kind) {
    case "answered":
      return revokedOutcome(result.answer);
    case "revoked_self":
      // La base cerró sus sesiones y el servicio borró su cookie: no queda nada que cerrar.
      // Entra de nuevo, y a dónde llega lo decide lo que le haya quedado.
      return { kind: "leave", to: ROUTES.signIn, notice: "capability_removed" };
    case "changed":
      return { kind: "confirm_again" };
    case "malformed":
      return { kind: "idle" };
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
  }
}

// ---------------------------------------------------------------------------------------
// «Invitaciones pendientes»: revocar, e invitar de nuevo lo que caducó.

export type InvitationsFailure =
  | "gone"
  | "already_invited"
  | "already_member"
  | "ineligible"
  | "not_configured"
  | "invalid"
  | "needs_code"
  | "unavailable"
  | "unknown";

/** Lo que el bloque de invitaciones pinta después de un envío. */
export type InvitationsState =
  | { kind: "idle" }
  | { kind: "confirm"; id: string; attempt: number }
  | { kind: "done"; what: "revoked" | "reinvited"; attempt: number }
  | { kind: "failed"; reason: InvitationsFailure; attempt: number };

export type InvitationsRequest =
  | { step: "ask"; id: string }
  | { step: "revoke"; id: string }
  | { step: "reinvite"; id: string }
  | { step: "none" };

/** Los valores que llevan los botones del bloque de invitaciones. */
export const invitationButton = {
  ask: (id: string) => `ask:revoke:${id}`,
  revoke: (id: string) => `confirm:revoke:${id}`,
  reinvite: (id: string) => `confirm:reinvite:${id}`,
  cancel: "cancel",
} as const;

/** Lo que llega del formulario de invitaciones: qué botón se pulsó. */
export function readInvitationsForm(form: unknown): InvitationsRequest {
  const parts = intentOf(form);
  if (parts?.length !== 3) return { step: "none" };
  const [step, what, id = ""] = parts;
  if (!ID.test(id)) return { step: "none" };
  if (step === "ask" && what === "revoke") return { step: "ask", id };
  if (step === "confirm" && what === "revoke") return { step: "revoke", id };
  if (step === "confirm" && what === "reinvite") return { step: "reinvite", id };
  return { step: "none" };
}

export type InvitationsOutcome = Leave | { kind: "done"; what: "revoked" | "reinvited" } | { kind: "failed"; reason: InvitationsFailure } | { kind: "idle" };

/** Lo que contestó `private.revoke_admin_invitation()`. */
function invitationRevokedOutcome(answer: Extract<InvitationRevoked, { kind: "answered" }>["answer"]): InvitationsOutcome {
  switch (answer) {
    case "revoked":
      return { kind: "done", what: "revoked" };
    case "not_found":
      // Aceptada, revocada o de otra lista: hacia fuera es lo mismo, ya no está vigente.
      return { kind: "failed", reason: "gone" };
    case "forbidden":
      return TO_PAGE;
    case "needs_fresh_code":
      return { kind: "failed", reason: "needs_code" };
  }
}

export function revokeInvitationOutcome(result: InvitationRevoked): InvitationsOutcome {
  switch (result.kind) {
    case "answered":
      return invitationRevokedOutcome(result.answer);
    case "malformed":
      return { kind: "idle" };
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
  }
}

export function reinviteOutcome(result: ReinviteResult): InvitationsOutcome {
  switch (result.kind) {
    case "answered": {
      const outcome = invitedOutcome(result.answer);
      return outcome.kind === "done" ? { kind: "done", what: "reinvited" } : outcome;
    }
    case "gone":
      return { kind: "failed", reason: "gone" };
    case "malformed":
      return { kind: "idle" };
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
  }
}

// ---------------------------------------------------------------------------------------
// «Restablecer un segundo factor». Su propio bloque, su propia acción y su propio estado:
// la respuesta trae el código que se dicta, y sin JavaScript React manda el estado de una
// acción dentro de todo formulario ligado a ella.

export type ResetFailure =
  | "already_sent"
  | "self"
  | "ineligible"
  | "not_member"
  | "not_configured"
  | "invalid"
  | "needs_code"
  | "unavailable"
  | "unknown";

/** Lo que el bloque de restablecer pinta después de un envío. */
export type ResetState =
  | { kind: "idle" }
  | { kind: "confirm"; profile: string; changed: boolean; attempt: number }
  /**
   * El código que hay que dictar. Mientras el estado sea este, la pantalla no pinta ningún
   * formulario de esta acción: viajaría dentro de él.
   */
  | { kind: "code"; code: string; attempt: number }
  | { kind: "failed"; reason: ResetFailure; attempt: number };

export type ResetRequest =
  /** El primer paso: a quién. No llama a nadie, como «preguntar» en los demás bloques. */
  | { step: "choose"; profile: string }
  /** `version`: la versión de la persona con que se pintó la confirmación. */
  | { step: "confirm"; profile: string; confirmed: string; version: string }
  | { step: "cancel" }
  | { step: "none" };

/** Los valores que llevan los botones del bloque de restablecer. */
export const resetButton = {
  choose: (profile: string) => `choose:${profile}`,
  /**
   * A quién, lo que se confirmó que pasaría y la versión de la persona que la página leyó.
   * Con la versión, un formulario reenviado (un doble clic, o recargar) no restablece otra vez.
   */
  confirm: (profile: string, confirmed: string, version: string) => `confirm:${profile}:${confirmed}:${version}`,
  cancel: "cancel",
} as const;

// La forma de la versión: `n.a`, dos contadores. La misma regla que `RESET_VERSION` del
// servicio, que este archivo no puede importar porque viaja al navegador; una prueba las
// compara.
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** Lo que llega del formulario de restablecer: qué botón se pulsó. */
export function readResetForm(form: unknown): ResetRequest {
  const parts = intentOf(form);
  if (parts === null) return { step: "none" };
  const [step, profile = "", confirmed = "", version = ""] = parts;
  if (step === "cancel" && parts.length === 1) return { step: "cancel" };
  if (!ID.test(profile)) return { step: "none" };
  if (step === "choose" && parts.length === 2) return { step: "choose", profile };
  if (step === "confirm" && parts.length === 4 && EFFECTS.test(confirmed) && VERSION.test(version)) {
    return { step: "confirm", profile, confirmed, version };
  }
  return { step: "none" };
}

export type ResetOutcome =
  | Leave
  | { kind: "confirm_again" }
  | { kind: "code"; code: string }
  /** Lo que llegó no tenía forma, o era quien actúa: la pantalla no lo ofrece, y no se dice nada. */
  | { kind: "idle" }
  | { kind: "failed"; reason: ResetFailure };

/** Lo que contestó `private.reset_second_factor()` cuando no restableció. */
function notResetOutcome(answer: Extract<FactorReset, { kind: "answered" }>["answer"]): ResetOutcome {
  switch (answer) {
    case "forbidden":
      return TO_PAGE;
    case "needs_fresh_code":
      return { kind: "failed", reason: "needs_code" };
    case "self":
    case "ineligible":
    case "not_member":
    case "invalid":
      return { kind: "failed", reason: answer };
    case "unavailable":
      // Falta el plazo de las invitaciones: no lo arregla reintentar.
      return { kind: "failed", reason: "not_configured" };
    // El servicio ya las traduce; están aquí para que la tabla recorra la lista entera.
    case "already_sent":
      return { kind: "failed", reason: "already_sent" };
    case "changed":
      return { kind: "confirm_again" };
  }
}

export function resetOutcome(result: FactorReset): ResetOutcome {
  switch (result.kind) {
    case "reset":
      return { kind: "code", code: result.code };
    case "answered":
      return notResetOutcome(result.answer);
    case "already_sent":
      return { kind: "failed", reason: "already_sent" };
    case "changed":
      return { kind: "confirm_again" };
    case "malformed":
      return { kind: "idle" };
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
  }
}
