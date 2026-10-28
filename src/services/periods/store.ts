import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { DatabaseError, isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import { CloseFailure, type PeriodStore } from "./panel";
import {
  askClose,
  askDownload,
  askRehearsal,
  askRollup,
  closeAnswerOf,
  downloadOf,
  readClose,
  readPeriod,
  readPeriods,
  rehearseAnswerOf,
  rollupAnswerOf,
} from "./records";

// Lo que el servicio de los periodos le pregunta a la base, a nombre de las claims que verificó: cada
// pregunta abre su transacción como servidor, con quién actúa y con qué sesión tomados de esas claims.

/** El tope de tiempo de la base (57014) y, al confirmar el cierre, la suma que no cuadra (23514). */
function named(error: unknown, closing: boolean): unknown {
  if (error instanceof DatabaseError && error.code === "57014") return new CloseFailure("timed_out");
  if (closing && error instanceof DatabaseError && error.code === "23514") return new CloseFailure("unbalanced");
  return error;
}

/** `run` es `asServer`. Las pruebas pasan otro: para ver qué se reintenta, o una transacción que se revierte. */
export function createPeriodStore(run: typeof asServer = asServer): PeriodStore {
  return {
    // Las lecturas no toman candados: no hay choque que reintentar.
    periods: (claims) => run({ claims, reason: "finance_periods" }, (tx) => readPeriods(tx)),
    period: (claims, period) => run({ claims, reason: "finance_period" }, (tx) => readPeriod(tx, period)),
    close: (claims, period) => run({ claims, reason: "finance_close" }, (tx) => readClose(tx, period)),
    // Pedir choca solo con el índice de un pedido abierto, que la base resuelve sin error.
    requestRollup: async (claims, period) => rollupAnswerOf(await run({ claims, reason: "rollup_request" }, (tx) => askRollup(tx, period))),
    // Ensayar y cerrar no escriben antes de rechazar: un choque de candados revierte la transacción
    // entera, y se intenta una vez más. Cerrar otra vez es seguro: contesta `already_closed`.
    rehearse: async (claims, period) => {
      try {
        return rehearseAnswerOf(await withLockRetry(() => run({ claims, reason: "period_rehearsal" }, (tx) => askRehearsal(tx, period)), isLockConflict));
      } catch (error) {
        throw named(error, false);
      }
    },
    closePeriod: async (claims, period, runId) => {
      try {
        return closeAnswerOf(await withLockRetry(() => run({ claims, reason: "period_close" }, (tx) => askClose(tx, period, runId)), isLockConflict));
      } catch (error) {
        throw named(error, true);
      }
    },
    download: async (claims, runId) => downloadOf(await run({ claims, reason: "close_export_download" }, (tx) => askDownload(tx, runId))),
  };
}

export const databasePeriodStore = createPeriodStore();
