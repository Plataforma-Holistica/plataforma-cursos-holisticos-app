import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import type { VerifiedClaims } from "@/services/account/account";
import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { anomalyAlerts } from "@/services/anomalies/anomalies";
import { financeClose, financePeriod, financePeriods } from "@/services/periods/periods";

import { CloseScreen, type CloseNotice } from "./close-screen";
import { PeriodsScreen } from "./list-screen";
import { PeriodScreen } from "./panel-screen";
import { closeView, periodsView, periodView } from "./rows";

// PA-78, PA-79 y PA-80 · Los periodos, el panel de uno y su ensayo y cierre (`/admin/periodos`,
// `/admin/periodos/2027-10` y `/admin/periodos/2027-10/cierre`; RF-501 a RF-503, RF-509, RF-705, RF-408;
// FL-50; T-605). No son páginas: las sirve el comodín de administración, que corre la guarda antes y
// solo llega aquí con alguien del equipo que tiene finanzas (`src/app/admin/_lib/sections.tsx`). Si el
// periodo existe lo dice la base, ya pasada la guarda.
//
// Se lee con las claims con que la guarda dejó pasar, y la base solo se lo contesta a quien pasa su
// puerta con finanzas. Nada de aquí trae un identificador de alumno.

const CLOSE_NOTICES: readonly CloseNotice[] = ["period_rehearsed", "period_closed"];

export async function PeriodsSection({ claims }: { claims: VerifiedClaims }) {
  const reader = await cookieReader();
  const read = await financePeriods(reader, claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.periods} withSession />;
  return <PeriodsScreen view={periodsView(read.periods, new Date().toISOString())} />;
}

export async function PeriodSection({ claims, period }: { claims: VerifiedClaims; period: number }) {
  const reader = await cookieReader();
  const read = await financePeriod(reader, claims, period);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={periodPath(period)} withSession />;
  if (read.kind === "not_found" || read.period.period === null) notFound();
  // Las alertas del periodo salen de su propia lectura: si no se pudo, el panel lo dice y sigue.
  const alerts = await anomalyAlerts(reader, claims);
  const done = readNotice(reader) === "rollup_requested";
  return (
    <PeriodScreen view={periodView(read.period, alerts.kind === "alerts" ? alerts.alerts : null, new Date().toISOString())} done={done} />
  );
}

export async function CloseSection({ claims, period }: { claims: VerifiedClaims; period: number }) {
  const reader = await cookieReader();
  const read = await financeClose(reader, claims, period);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={periodClosePath(period)} withSession />;
  if (read.kind === "not_found" || read.close.period === null) notFound();
  // Ensayar y cerrar redirigen aquí con su aviso: lo de ahora ya trae lo hecho.
  const notice = readNotice(reader);
  const done = CLOSE_NOTICES.find((each) => each === notice) ?? null;
  return <CloseScreen view={closeView(read.close)} done={done} />;
}
