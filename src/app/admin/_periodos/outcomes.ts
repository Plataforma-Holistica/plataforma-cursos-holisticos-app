import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";
import type { Closed, ExportDownloaded, PeriodsCode, Rehearsed, RollupRequested } from "@/services/periods/periods";

import { givenCodeOutcome, type CodeOutcome, type Leave } from "../_lib/fresh-code";

// Qué pinta y qué hace PA-79 y PA-80 (el panel de un periodo, y su ensayo y cierre; FL-50; T-605). Todo
// aquí es puro: el servicio corre la guarda y le pregunta a la base, y esto traduce su respuesta a un
// destino o a lo que se pinta. Cada respuesta tiene su caso: una nueva no compila sin el suyo.
//
// Las reglas de las demás secciones valen aquí igual:
//
//   · A quien la guarda no dejó (`refused`), o a quien la base le dijo que no tiene finanzas
//     (`forbidden`), se le manda a la misma página, donde decide su guarda.
//   · Lo que llega es qué botón se pulsó: el paso y de qué periodo (o de qué corrida, al descargar). Un
//     envío sin intención, con más de una o con un valor sin forma cuenta como vacío.
//   · Lo que sale bien redirige a la página con su aviso: sin JavaScript, recargar no reenvía. Ensayar y
//     cerrar redirigen al cierre; pedir el recálculo, al panel.
//   · «No se supo» nunca se pinta como hecho: la pantalla vuelve a leer el periodo y dice cómo quedó.
//
// Viaja al navegador: no importa nada del servidor.

export type { CodeState } from "../_lib/fresh-code";

const MAX_INTENT = 120;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `AAAAMM` escrito como lo escribe `periodsButton`: seis cifras, mes de 01 a 12. */
const PERIOD = /^2\d{3}(0[1-9]|1[0-2])$/;

const toPanel = (period: number): Leave => ({ kind: "leave", to: periodPath(period), notice: null });
const toClose = (period: number): Leave => ({ kind: "leave", to: periodClosePath(period), notice: null });

// ---------------------------------------------------------------------------------------
// Lo que llega.

export type PeriodsRequest =
  | { step: "none" }
  | { step: "cancel" }
  | { step: "rollup"; period: number }
  | { step: "rehearse"; period: number }
  /** Cerrar lleva el ensayo que se tenía a la vista (T-605, tercera solicitud). */
  | { step: "ask_close"; period: number; run: string }
  | { step: "close"; period: number; run: string; understood: boolean }
  | { step: "download"; run: string };

/** Qué se pidió. `none` si no es un formulario, no trae `do`, lo trae más de una vez o no se entiende. */
export function readPeriodsForm(form: unknown): PeriodsRequest {
  // Una acción de servidor es una puerta pública: lo que llega puede no ser un formulario.
  if (!(form instanceof FormData)) return { step: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || only === "" || only.length > MAX_INTENT) return { step: "none" };
  const [verb, target, shown, ...rest] = only.split(":");
  if (rest.length > 0) return { step: "none" };
  if (verb === "cancel") return target === undefined ? { step: "cancel" } : { step: "none" };
  if (target === undefined) return { step: "none" };
  if (verb === "download") return ID.test(target) && shown === undefined ? { step: "download", run: target } : { step: "none" };
  if (!PERIOD.test(target)) return { step: "none" };
  const period = Number(target);
  switch (verb) {
    case "rollup":
    case "rehearse":
      return shown === undefined ? { step: verb, period } : { step: "none" };
    case "ask_close":
      return shown !== undefined && ID.test(shown) ? { step: "ask_close", period, run: shown } : { step: "none" };
    case "close":
      // La casilla «Entiendo que no se puede deshacer»: solo su valor cuenta.
      return shown !== undefined && ID.test(shown) ? { step: "close", period, run: shown, understood: form.get("understood") === "yes" } : { step: "none" };
    default:
      return { step: "none" };
  }
}

/** Los valores de los botones. Los arma esta tabla y los lee `readPeriodsForm`. */
export const periodsButton = {
  rollup: (period: number) => `rollup:${period}`,
  rehearse: (period: number) => `rehearse:${period}`,
  askClose: (period: number, run: string) => `ask_close:${period}:${run}`,
  close: (period: number, run: string) => `close:${period}:${run}`,
  download: (run: string) => `download:${run}`,
  cancel: () => "cancel",
} as const;

/** Un periodo atado a una acción desde la pantalla (`202710`), si tiene forma; si no, nulo. */
export function periodFrom(value: unknown): number | null {
  return typeof value === "number" && PERIOD.test(String(value)) ? value : null;
}

/** El valor de la casilla «Entiendo que no se puede deshacer». */
export const UNDERSTOOD = "yes";

/**
 * A dónde vuelve quien dio su código: la página de donde lo dio. Llega atado a la acción desde la
 * pantalla, y una acción es una puerta pública: lo que no sea un periodo con forma y una de las dos
 * páginas va a la lista.
 */
export function periodCodeTarget(target: unknown): string {
  if (typeof target !== "object" || target === null) return ROUTES.periods;
  const { period: value, page } = target as { period?: unknown; page?: unknown };
  const period = periodFrom(value);
  if (period === null) return ROUTES.periods;
  if (page === "panel") return periodPath(period);
  if (page === "close") return periodClosePath(period);
  return ROUTES.periods;
}

/** Lo que contestó dar el código: la tabla compartida, con la página de donde se dio. */
export function periodsCodeOutcome(result: PeriodsCode, page: string): CodeOutcome {
  return givenCodeOutcome(result, page);
}

// ---------------------------------------------------------------------------------------
// Lo que se pinta.

export type PeriodFailure =
  | "needs_code"
  | "not_rollable"
  | "too_soon"
  | "rehearsal_failed"
  | "already_closed"
  | "no_period"
  | "photo_missing"
  | "no_pool_percent"
  | "before_launch"
  | "not_closing"
  | "previous_not_closed"
  | "rollup_running"
  | "last_rollup_failed"
  | "needs_full_rollup"
  | "rollup_marks"
  | "open_alerts"
  | "rehearsal_missing"
  | "rehearsal_stale"
  | "rehearsal_superseded"
  | "timed_out"
  | "unbalanced"
  | "not_found"
  | "unavailable"
  | "unknown";

export type PeriodOutcome = Leave | { kind: "failed"; reason: PeriodFailure };

/** Lo que pinta el bloque del recálculo (PA-79) después de un envío. */
export type PanelState = { kind: "idle" } | { kind: "failed"; reason: PeriodFailure; attempt: number };

/** Lo que pinta el ensayo y el cierre (PA-80) después de un envío. */
export type CloseState =
  | { kind: "idle" }
  /** El diálogo de cierre, abierto: el primer paso, o confirmar sin marcar la casilla. Con el ensayo que se veía. */
  | { kind: "confirming"; period: number; run: string; missingUnderstood: boolean; attempt: number }
  | { kind: "failed"; reason: PeriodFailure; step: "rehearse" | "close"; attempt: number };

/** Lo que pinta la descarga después de un envío. Su propio estado: el archivo no viaja con los otros formularios. */
export type DownloadState =
  | { kind: "idle" }
  | { kind: "file"; filename: string; rows: number; href: string; attempt: number }
  | { kind: "failed"; reason: PeriodFailure; attempt: number };

/** Lo que contestó pedir el recálculo. */
export function rollupOutcome(result: RollupRequested, period: number): PeriodOutcome {
  switch (result.kind) {
    case "refused":
      return toPanel(period);
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    // Un periodo sin forma solo llega con un formulario armado a mano.
    case "malformed":
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "answered":
      switch (result.answer) {
        // Ya pedido: hay uno pendiente o corriendo, que es lo que se quería.
        case "requested":
        case "already_requested":
          return { kind: "leave", to: periodPath(period), notice: "rollup_requested" };
        case "not_rollable":
          return { kind: "failed", reason: "not_rollable" };
        case "forbidden":
          return toPanel(period);
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "unknown" };
      }
  }
}

/** Lo que contestó ensayar. */
export function rehearseOutcome(result: Rehearsed, period: number): PeriodOutcome {
  switch (result.kind) {
    case "refused":
      return toClose(period);
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "timed_out":
      return { kind: "failed", reason: "timed_out" };
    case "malformed":
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "answered":
      switch (result.answer) {
        case "rehearsed":
          return { kind: "leave", to: periodClosePath(period), notice: "period_rehearsed" };
        case "failed":
          return { kind: "failed", reason: "rehearsal_failed" };
        case "already_closed":
          return { kind: "failed", reason: "already_closed" };
        case "no_period":
          return { kind: "failed", reason: "no_period" };
        case "photo_missing":
          return { kind: "failed", reason: "photo_missing" };
        case "no_pool_bps":
          return { kind: "failed", reason: "no_pool_percent" };
        case "before_launch":
          return { kind: "failed", reason: "before_launch" };
        case "too_soon":
          return { kind: "failed", reason: "too_soon" };
        case "forbidden":
          return toClose(period);
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "unknown" };
      }
  }
}

/** Lo que contestó cerrar. Cada precondición de `close_period` dice cuál falta (05 §8.6). */
export function closeOutcome(result: Closed, period: number): PeriodOutcome {
  switch (result.kind) {
    case "refused":
      return toClose(period);
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "timed_out":
      return { kind: "failed", reason: "timed_out" };
    case "unbalanced":
      return { kind: "failed", reason: "unbalanced" };
    case "malformed":
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    case "answered":
      switch (result.answer) {
        case "closed":
          return { kind: "leave", to: periodClosePath(period), notice: "period_closed" };
        // Cerrar otra vez es seguro: la página, que vuelve a leer, ya lo pinta cerrado.
        case "already_closed":
          return { kind: "failed", reason: "already_closed" };
        case "not_closing":
          return { kind: "failed", reason: "not_closing" };
        case "before_launch":
          return { kind: "failed", reason: "before_launch" };
        case "previous_not_closed":
          return { kind: "failed", reason: "previous_not_closed" };
        case "photo_missing":
          return { kind: "failed", reason: "photo_missing" };
        case "no_pool_bps":
          return { kind: "failed", reason: "no_pool_percent" };
        case "rollup_running":
          return { kind: "failed", reason: "rollup_running" };
        case "last_rollup_failed":
          return { kind: "failed", reason: "last_rollup_failed" };
        case "needs_full_rollup":
          return { kind: "failed", reason: "needs_full_rollup" };
        case "rollup_marks":
          return { kind: "failed", reason: "rollup_marks" };
        case "open_alerts":
          return { kind: "failed", reason: "open_alerts" };
        case "rehearsal_missing":
          return { kind: "failed", reason: "rehearsal_missing" };
        case "rehearsal_stale":
          return { kind: "failed", reason: "rehearsal_stale" };
        case "rehearsal_superseded":
          return { kind: "failed", reason: "rehearsal_superseded" };
        case "forbidden":
          return toClose(period);
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
        case "malformed":
          return { kind: "failed", reason: "unknown" };
      }
  }
}

/** La exportación como dirección de datos: el enlace la guarda con su nombre, con JavaScript y sin él. */
export function csvHref(content: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(content)}`;
}

/** Lo que contestó descargar la exportación. */
export function downloadOutcome(
  result: ExportDownloaded,
  period: number,
): Leave | { kind: "file"; filename: string; rows: number; href: string } | { kind: "failed"; reason: PeriodFailure } {
  switch (result.kind) {
    case "refused":
      return toClose(period);
    case "unavailable":
      return { kind: "failed", reason: "unavailable" };
    case "unknown":
      return { kind: "failed", reason: "unknown" };
    // Una corrida sin forma solo llega con un formulario armado a mano.
    case "malformed":
      return { kind: "failed", reason: "not_found" };
    case "file":
      return { kind: "file", filename: result.file.filename, rows: result.file.rows, href: csvHref(result.file.content) };
    case "answered":
      switch (result.answer) {
        case "not_found":
          return { kind: "failed", reason: "not_found" };
        case "forbidden":
          return toClose(period);
        case "needs_fresh_code":
          return { kind: "failed", reason: "needs_code" };
      }
  }
}
