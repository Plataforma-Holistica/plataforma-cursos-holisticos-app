import "server-only";

import { giveSecondFactorCode, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";


import { createPeriodsPanel } from "./panel";
import { createPayoutsPanel } from "./payouts";
import { databasePayoutStore, databasePeriodStore } from "./store";

// Los periodos, el ensayo y el cierre, ya armados con la guarda del equipo, la base y el registro de
// errores. Lo que importan las pantallas (PA-78 a PA-80, T-605).

export type {
  CloseAnswer,
  Closed,
  CloseExportFile,
  CloseRead,
  DownloadAnswer,
  ExportDownloaded,
  FinanceClose,
  FinancePeriod,
  FinancePeriods,
  PeriodRead,
  PeriodRow,
  PeriodsCode,
  PeriodsRead,
  PeriodStatus,
  Rehearsed,
  RehearseAnswer,
  RollupAnswer,
  RollupRequested,
  RollupRequestStatus,
  RollupRun,
  RunFigures,
  RunStatus,
  RunTeacher,
} from "./panel";
export { CLOSE_ANSWERS, DOWNLOAD_ANSWERS, PERIOD_STATUSES, REHEARSE_ANSWERS, ROLLUP_ANSWERS, periodOf } from "./panel";

export const { financePeriods, financePeriod, financeClose, requestRollup, rehearse, closePeriod, downloadExport, givePeriodsCode } = createPeriodsPanel(
  { report: reportFailure },
  { teamStanding, giveSecondFactorCode, store: databasePeriodStore },
);

// Las liquidaciones del periodo (PA-81). En producción no se libera hasta T-409 (decisión de Sergio del
// 2026-10-28): sin CLABE ni retenciones, el monto liberado no sería el que se transfiere. T-409 quita el freno.
export type {
  BonusStatus,
  ConfirmAnswer,
  ConfirmResult,
  FinancePayouts,
  HoldAnswer,
  HoldResult,
  PayoutRow,
  PayoutsRead,
  PayoutStatus,
  ReleaseAnswer,
  ReleaseResult,
  UnholdAnswer,
  UnholdResult,
  VoidAnswer,
  VoidResult,
} from "./payouts";
export { BONUS_STATUSES, CONFIRM_ANSWERS, HOLD_ANSWERS, PAYOUT_STATUSES, RELEASE_ANSWERS, UNHOLD_ANSWERS, VOID_ANSWERS } from "./payouts";

export const { financePayouts, releasePayouts, holdPayout, unholdPayout, confirmFounderBonus, voidFounderBonus } = createPayoutsPanel(
  { report: reportFailure },
  { teamStanding, store: databasePayoutStore },
);
