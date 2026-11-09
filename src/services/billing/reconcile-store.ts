import "server-only";

import { asServer, asSystem, type Tx } from "@/adapters/supabase/db";

import type { Actor, ReconcileStore } from "./reconcile";
import {
  askReconcileDue,
  askReconcileExplain,
  askReconcileRecord,
  askReconcileWindow,
  askSettlementComplete,
  askSettlementsMissing,
} from "./records";

// Lo que la conciliación le pregunta a la base: como sistema el trabajo de cada día, y como la persona lo que pide finanzas desde PA-79. Cada pregunta abre su
// transacción.

/** `system` y `person` son `asSystem` y `asServer`. Las pruebas pasan otros: una transacción que se revierte. */
export function createReconcileStore(system: typeof asSystem = asSystem, person: typeof asServer = asServer): ReconcileStore {
  const as = <T>(actor: Actor, reason: string, work: (tx: Tx) => Promise<T>): Promise<T> =>
    actor.kind === "system" ? system({ reason }, work) : person({ claims: actor.claims, reason }, work);
  return {
    window: (actor, period) => as(actor, "billing_reconcile_window", (tx) => askReconcileWindow(tx, period)),
    record: (actor, period, livemode, startsAt, endsAt, complete, charges) =>
      as(actor, "billing_reconcile_record", (tx) => askReconcileRecord(tx, period, livemode, startsAt, endsAt, complete, charges)),
    due: () => system({ reason: "billing_reconcile_due" }, askReconcileDue),
    settlementsMissing: (actor, period) => as(actor, "billing_settlements_missing", (tx) => askSettlementsMissing(tx, period)),
    completeSettlement: (actor, settlement) => as(actor, "billing_settlement_complete", (tx) => askSettlementComplete(tx, settlement)),
    explain: (claims, explanation) => person({ claims, reason: "billing_reconcile_explain" }, (tx) => askReconcileExplain(tx, explanation)),
  };
}

export const databaseReconcileStore = createReconcileStore();
