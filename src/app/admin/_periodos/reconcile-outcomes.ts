import { periodPath } from "@/services/account/navigation";
import type { CompareNow, Explained } from "@/services/billing/billing";

import type { Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace la conciliación con Stripe de PA-79 (T-303, cuarta solicitud): «Comparar ahora» y «Explicar». Todo aquí es puro: el servicio corre la
// guarda y le pregunta a Stripe y a la base, y esto traduce su respuesta a un destino o a lo que se pinta. Las reglas de las demás secciones valen aquí igual:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene finanzas (`forbidden`), se le manda al panel, donde decide su guarda.
//   · El periodo llega atado desde la pantalla; del formulario llega qué botón se pulsó (y, al explicar, qué diferencia, tal como se vio) y la nota. Un envío sin
//     intención, con más de una o con un valor sin forma cuenta como vacío.
//   · Comparar y explicar contestan en el bloque y vuelven a pedir la página, que ya trae la comparación de ahora: lo que contestó se dice en palabras, y se dice
//     también lo que salió bien (coincide, no coincide, explicada). No redirigen: el aviso de una cookie no diría si coincidió.
//   · «No se supo» nunca se pinta como hecho.
//
// Viaja al navegador: no importa nada del servidor.

const toPanel = (period: number): Leave => ({ kind: "leave", to: periodPath(period), notice: null });

/** Lo que se explica con nota: lo que Stripe cobró y el libro no tiene, o un cargo en otra moneda (decisión de Sergio del 2026-11-08). La de la base, copiada. */
export const EXPLAINABLE = ["only_provider", "other_currency"] as const;
export type ExplainableSide = (typeof EXPLAINABLE)[number];

/** El tope de la nota, el de la base (`EXPLAIN_NOTE_MAX`). */
export const NOTE_MAX = 500;
/** Un poco más que el tope de la base, para que el servicio lo rechace y no se corte en silencio. */
const MAX_NOTE_READ = 600;
/** El botón lleva el id del cargo, de hasta 255. */
const MAX_INTENT = 320;
const CHARGE = /^[!-~]{1,255}$/;
const CURRENCY = /^[a-z]{3}$/;
const CENTS = /^(0|[1-9][0-9]{0,11})$/;

// ---------------------------------------------------------------------------------------
// Lo que llega.

/** Una diferencia, como la vio quien la explica: lo que el servicio le pasa a la base para que la encuentre en la comparación. */
export interface AskedDifference {
  side: ExplainableSide;
  currency: string;
  /** Los centavos de Stripe, como texto. */
  cents: string;
  charge: string;
}

export type ReconcileRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "compare" }
  | ({ step: "ask_explain" | "explain"; note: string | undefined } & AskedDifference);

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readReconcileForm(form: unknown): ReconcileRequest {
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  if (only === "cancel") return { step: "cancel" };
  if (only === "compare") return { step: "compare" };
  // El cargo va al final y puede traer «:»: lo que sigue a los centavos es el cargo entero.
  const [verb, side, currency, cents, ...rest] = only.split(":");
  const charge = rest.join(":");
  if (verb !== "ask_explain" && verb !== "explain") return { step: "none" };
  if (!EXPLAINABLE.some((each) => each === side) || currency === undefined || !CURRENCY.test(currency) || cents === undefined || !CENTS.test(cents) || !CHARGE.test(charge)) {
    return { step: "none" };
  }
  const raw = form.get("note");
  const note = typeof raw === "string" ? raw.slice(0, MAX_NOTE_READ) : undefined;
  return { step: verb, side: side as ExplainableSide, currency, cents, charge, note };
}

/** Los valores de los botones. Los arma esta tabla y los lee `readReconcileForm`. */
export const reconcileButton = {
  compare: () => "compare",
  askExplain: (difference: AskedDifference) => `ask_explain:${difference.side}:${difference.currency}:${difference.cents}:${difference.charge}`,
  explain: (difference: AskedDifference) => `explain:${difference.side}:${difference.currency}:${difference.cents}:${difference.charge}`,
  cancel: () => "cancel",
} as const;

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

export type ReconcileFailure =
  | "needs_code"
  | "missing_note"
  | "not_explainable"
  | "not_in_comparison"
  | "closed"
  | "too_early"
  | "rate_limited"
  | "no_stripe"
  | "not_found"
  | "unavailable"
  | "unknown";

/** Lo que salió: la comparación (coincide, no coincide, incompleta) o la explicación (hecha, o ya estaba). */
export type ReconcileAnswer = "matches" | "mismatch" | "incomplete" | "explained" | "already_explained";

export type ReconcileState =
  | { kind: "idle" }
  /** «Explicar» de una diferencia, abierto en su fila: el primer paso, o confirmar sin nota. */
  | { kind: "asking"; asked: AskedDifference; note: string | undefined; problem: "missing_note" | null; attempt: number }
  | { kind: "done"; answer: ReconcileAnswer; attempt: number }
  /** Con la nota que se había escrito al explicar: así no se pierde. */
  | { kind: "failed"; reason: ReconcileFailure; note: string | undefined; attempt: number };

export type ReconcileOutcome = Leave | { kind: "done"; answer: ReconcileAnswer } | { kind: "failed"; reason: ReconcileFailure };

/** Qué pregunta el paso, o nulo si no pregunta nada. Confirmar sin nota vuelve a preguntar, sin llamar al servicio. */
export function askedBy(request: ReconcileRequest): Omit<Extract<ReconcileState, { kind: "asking" }>, "kind" | "attempt"> | null {
  if (request.step !== "ask_explain" && request.step !== "explain") return null;
  const asked: AskedDifference = { side: request.side, currency: request.currency, cents: request.cents, charge: request.charge };
  if (request.step === "ask_explain") return { asked, note: request.note, problem: null };
  if (request.note === undefined || request.note.trim() === "") return { asked, note: request.note, problem: "missing_note" };
  return null;
}

/** Lo que contestó «Comparar ahora». */
export function compareOutcome(result: CompareNow, period: number): ReconcileOutcome {
  switch (result.kind) {
    case "refused":
      return toPanel(period);
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "compared": {
      const compared = result.result;
      switch (compared.kind) {
        // Un listado incompleto nunca coincide: se dice por qué.
        case "recorded":
          return { kind: "done", answer: compared.matches ? "matches" : compared.complete ? "mismatch" : "incomplete" };
        case "no_stripe":
          return { kind: "failed", reason: "no_stripe" };
        case "unknown":
          return { kind: "failed", reason: "unknown" };
        case "refused":
          switch (compared.answer) {
            case "forbidden":
              return toPanel(period);
            case "not_found":
            case "closed":
            case "too_early":
            case "rate_limited":
              return { kind: "failed", reason: compared.answer };
            // Una forma que la base rechaza ya la reportó el servicio.
            case "malformed":
              return { kind: "failed", reason: "unknown" };
          }
      }
    }
  }
}

/** Lo que contestó «Explicar». */
export function explainOutcome(result: Explained, period: number): ReconcileOutcome {
  switch (result.kind) {
    case "refused":
      return toPanel(period);
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    // La pantalla arma el botón: lo que no tiene forma es la nota (vacía, o de más).
    case "malformed":
      return { kind: "failed", reason: "missing_note" };
    case "answered":
      switch (result.answer) {
        case "explained":
          return { kind: "done", answer: "explained" };
        case "exists":
          return { kind: "done", answer: "already_explained" };
        case "forbidden":
          return toPanel(period);
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "missing_note" };
        case "not_explainable":
        case "not_in_comparison":
        case "closed":
        case "not_found":
          return { kind: "failed", reason: result.answer };
      }
  }
}
