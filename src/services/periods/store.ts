import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { DatabaseError, isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import { CloseFailure, type PeriodStore } from "./panel";
import { PayoutFailure, type PayoutStore } from "./payouts";
import {
  askClose,
  askConfirmFounder,
  askDownload,
  askHold,
  askRehearsal,
  askRelease,
  askRollup,
  askUnhold,
  askVoidFounder,
  closeAnswerOf,
  confirmedOf,
  downloadOf,
  heldOf,
  readClose,
  readPayouts,
  readPeriod,
  readPeriods,
  rehearseAnswerOf,
  releasedOf,
  rollupAnswerOf,
  unheldOf,
  voidedOf,
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

/** El tope de tiempo (57014) y lo liberado que no cuadra al confirmar (23514), al liberar o al soltar. */
function namedRelease(error: unknown): unknown {
  if (error instanceof DatabaseError && error.code === "57014") return new PayoutFailure("timed_out");
  if (error instanceof DatabaseError && error.code === "23514") return new PayoutFailure("unbalanced");
  return error;
}

/**
 * Las liquidaciones de PA-81 (T-605, cuarta solicitud). Ninguna decisión escribe antes de rechazar: un choque de
 * candados revierte la transacción entera, y se intenta una vez más. Repetir es seguro: liberar otra vez contesta
 * `already_released`, retener `already_held`, soltar `not_held`, confirmar `already_decided` y anular
 * `already_void`; y si lo que se vio cambió entre tanto, `preview_changed` o `changed`.
 */
export function createPayoutStore(run: typeof asServer = asServer): PayoutStore {
  const retried = <T>(work: () => Promise<T>) => withLockRetry(work, isLockConflict);
  return {
    payouts: (claims, period) => run({ claims, reason: "finance_payouts" }, (tx) => readPayouts(tx, period)),
    release: async (claims, period, seen) => {
      try {
        return releasedOf(await retried(() => run({ claims, reason: "payouts_release" }, (tx) => askRelease(tx, period, seen))));
      } catch (error) {
        throw namedRelease(error);
      }
    },
    hold: async (claims, payout, reason, seen) =>
      heldOf(await retried(() => run({ claims, reason: "payout_hold" }, (tx) => askHold(tx, payout, reason, seen)))),
    unhold: async (claims, payout, note, seen) => {
      try {
        return unheldOf(await retried(() => run({ claims, reason: "payout_unhold" }, (tx) => askUnhold(tx, payout, note, seen))));
      } catch (error) {
        throw namedRelease(error);
      }
    },
    confirmFounder: async (claims, bonus) =>
      confirmedOf(await retried(() => run({ claims, reason: "founder_bonus_confirm" }, (tx) => askConfirmFounder(tx, bonus)))),
    voidFounder: async (claims, period, bonus, reason) =>
      voidedOf(await retried(() => run({ claims, reason: "founder_bonus_void" }, (tx) => askVoidFounder(tx, period, bonus, reason)))),
  };
}

export const databasePayoutStore = createPayoutStore();
