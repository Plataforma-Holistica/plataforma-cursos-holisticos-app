"use server";

import { leaveFor } from "@/app/(cuenta)/_lib/exit";
import { nextAttempt } from "@/app/(cuenta)/_lib/form-state";
import { cookieJar } from "@/app/_lib/request-context";
import { portalPayoutPath, ROUTES } from "@/services/account/navigation";
import { payoutReportCsv } from "@/services/teachers/payout-report-data";

import { csvOutcome, readCsvForm, type CsvState } from "./outcomes";

// La acción de PA-47 (T-604, cuarta solicitud): el reporte del periodo en CSV. No decide quién puede: el servicio corre la guarda de sesión, y la base
// contesta solo lo del maestro que pide. Del formulario llega el periodo; del estado anterior solo se lee el número de intento.

/**
 * Descargar el CSV. El archivo vuelve en el estado de esta acción como dirección de datos, igual que la exportación del cierre (PA-80): bajo el portal
 * no hay rutas, y así el archivo no viaja con otros formularios. No cambia nada: no vuelve a pedir la página.
 */
export async function payoutCsvAction(previous: CsvState, form: FormData): Promise<CsvState> {
  const request = readCsvForm(form);
  if (request === null) return { kind: "idle" };
  const attempt = nextAttempt(previous);
  const jar = await cookieJar();
  const back = portalPayoutPath(request.period) ?? ROUTES.portalPayouts;
  const outcome = csvOutcome(await payoutReportCsv(jar, request.period), back);
  if (outcome.kind === "leave") return leaveFor(jar, outcome);
  if (outcome.kind === "file") return { kind: "file", fileName: outcome.fileName, href: outcome.href, attempt };
  return { kind: "failed", reason: outcome.reason, attempt };
}
