import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { checkSession } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createPayoutReports, type PayoutReportStore } from "./payout-report";
import { askPayoutReport, askPayoutReportCsv, askPayoutsMine } from "./payout-report-records";

// El reporte del maestro, ya armado: lo que importan las pantallas de pagos (PA-46 y PA-47). Corre como el servidor, a nombre de la persona: las tablas del
// cierre no tienen permisos para la aplicación, y la lectura escribe los alias que falten.

export type { MyPayouts, PayoutCsv, PayoutMoney, PayoutReportAnswer, PayoutReportValue, PayoutRow, ReportRead, TeacherPayoutStatus } from "./payout-report";
export { periodSegment } from "./payout-report";

const store: PayoutReportStore = {
  mine: (claims) => asServer({ claims, reason: "payouts_mine" }, askPayoutsMine),
  report: (claims, period) => asServer({ claims, reason: "payout_report" }, (tx) => askPayoutReport(tx, period)),
  csv: (claims, period) => asServer({ claims, reason: "payout_report_csv" }, (tx) => askPayoutReportCsv(tx, period)),
};

export const { myPayouts, payoutReport, payoutReportCsv } = createPayoutReports({ store, checkSession, report: reportFailure });
