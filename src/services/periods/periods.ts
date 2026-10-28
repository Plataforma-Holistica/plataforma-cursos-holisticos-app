import "server-only";

import { giveSecondFactorCode, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createPeriodsPanel } from "./panel";
import { databasePeriodStore } from "./store";

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
