import { ROUTES } from "@/services/account/navigation";
import type { BillingCode, EventResolved, EventRetried } from "@/services/billing/billing";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace PA-84 (la cola de los avisos de cobro; FL-55; T-303, tercera solicitud). Todo aquí es puro: el servicio corre la guarda y le pregunta a la
// base, y esto traduce su respuesta a un destino o a lo que se pinta. Las reglas de las demás secciones valen aquí igual:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene finanzas (`forbidden`), se le manda a esta misma página, donde decide su guarda.
//   · Lo que llega es qué botón se pulsó (qué, de qué aviso y con qué revisión) y la nota de resolver. Un envío sin intención, con más de una o con un aviso sin forma
//     cuenta como vacío.
//   · Lo que sale bien redirige a esta página con su aviso: sin JavaScript, recargar no reenvía.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState } from "../_lib/fresh-code";

const TO_PAGE: Leave = { kind: "leave", to: ROUTES.billingEvents, notice: null };
type DoneNotice = "billing_event_processed" | "billing_event_already_applied" | "billing_event_on_its_way" | "billing_event_resolved";
const done = (notice: DoneNotice): Leave => ({ kind: "leave", to: ROUTES.billingEvents, notice });

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9]{1,10}$/;
const MAX_INTENT = 120;
/** Un poco más que el tope de la base, para que la base lo rechace y no se corte en silencio. */
const MAX_NOTE_READ = 600;

export function billingCodeOutcome(result: BillingCode): CodeOutcome {
  return givenCodeOutcome(result, ROUTES.billingEvents);
}

// ---------------------------------------------------------------------------------------
// Lo que llega.

export type BillingRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "retry" | "ask_resolve" | "resolve"; event: string; revision: string; note: string | undefined };

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readBillingForm(form: unknown): BillingRequest {
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  if (only === "cancel") return { step: "cancel" };
  const [verb, event, revision, ...rest] = only.split(":");
  if (rest.length > 0 || event === undefined || !ID.test(event) || revision === undefined || !REVISION.test(revision)) return { step: "none" };
  const raw = form.get("note");
  const note = typeof raw === "string" ? raw.slice(0, MAX_NOTE_READ) : undefined;
  if (verb === "retry" || verb === "ask_resolve" || verb === "resolve") return { step: verb, event, revision, note };
  return { step: "none" };
}

/** Los valores de los botones. Los arma esta tabla y los lee `readBillingForm`. */
export const billingButton = {
  retry: (event: string, revision: number) => `retry:${event}:${revision}`,
  askResolve: (event: string, revision: number) => `ask_resolve:${event}:${revision}`,
  resolve: (event: string, revision: number | string) => `resolve:${event}:${revision}`,
  cancel: () => "cancel",
} as const;

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

export type BillingFailure =
  | "needs_code"
  | "missing_note"
  /** Volvió a fallar: se dice el código en palabras y tal cual, para pasárselo al desarrollador. */
  | "failed_again"
  /** Volvió a la fila con su espera (Stripe no contestó, o una segunda suscripción viva). */
  | "requeued"
  | "changed"
  | "not_failed"
  | "self"
  | "not_found"
  | "unavailable"
  | "unknown";

/** Qué se está preguntando: resolver ese aviso, con la revisión que se vio. */
export interface Asked {
  event: string;
  revision: string;
  problem: "missing_note" | null;
}

export type BillingState =
  | { kind: "idle" }
  | { kind: "confirming"; asked: Asked; note: string | undefined; attempt: number }
  | { kind: "failed"; reason: BillingFailure; code: string | null; event: string; note: string | undefined; attempt: number };

export type BillingOutcome = Leave | { kind: "failed"; reason: BillingFailure; code?: string };

/** Qué pregunta el paso, o nulo si no pregunta nada. Confirmar sin nota vuelve a preguntar, sin llamar al servicio. */
export function askedBy(request: BillingRequest): Asked | null {
  if (request.step === "ask_resolve") return { event: request.event, revision: request.revision, problem: null };
  if (request.step === "resolve" && (request.note === undefined || request.note.trim() === "")) {
    return { event: request.event, revision: request.revision, problem: "missing_note" };
  }
  return null;
}

/** Lo que contestó «Reintentar». */
export function retryOutcome(result: EventRetried): BillingOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    // La pantalla arma el botón: un aviso sin forma es uno que ya no está.
    case "malformed":
      return { kind: "failed", reason: "not_found" };
    case "answered":
      switch (result.answer) {
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "changed":
        case "not_failed":
        case "self":
        case "not_found":
          return { kind: "failed", reason: result.answer };
      }
      break;
    case "ran":
      switch (result.run.kind) {
        case "processed":
          return done("billing_event_processed");
        case "already_applied":
          return done("billing_event_already_applied");
        case "busy":
        case "still_pending":
          return done("billing_event_on_its_way");
        case "changed":
          return { kind: "failed", reason: "changed" };
        case "failed":
          return { kind: "failed", reason: "failed_again", code: result.run.code };
        case "retry":
          return { kind: "failed", reason: "requeued", code: result.run.code };
      }
  }
}

/** Lo que contestó «Resolver a mano». */
export function resolveOutcome(result: EventResolved): BillingOutcome {
  switch (result.kind) {
    case "refused":
      return TO_PAGE;
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "malformed":
      return { kind: "failed", reason: "missing_note" };
    case "answered":
      switch (result.answer) {
        case "resolved":
          return done("billing_event_resolved");
        case "forbidden":
          return TO_PAGE;
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "missing_note" };
        case "changed":
        case "not_failed":
        case "self":
        case "not_found":
          return { kind: "failed", reason: result.answer };
      }
  }
}
