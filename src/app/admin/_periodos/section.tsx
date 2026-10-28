import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import type { VerifiedClaims } from "@/services/account/account";
import { periodClosePath, periodPath, periodPayoutsPath, ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { anomalyAlerts } from "@/services/anomalies/anomalies";
import { financeClose, financePayouts, financePeriod, financePeriods } from "@/services/periods/periods";

import { CloseScreen, type CloseNotice } from "./close-screen";
import { PeriodsScreen } from "./list-screen";
import { PeriodScreen } from "./panel-screen";
import { acceptedReleaseNotice, acceptedUpdateNotice, payoutsView } from "./payouts-rows";
import { PayoutsScreen, type PayoutsNotice } from "./payouts-screen";
import { acceptedCloseNotice, acceptedRollupNotice, closeView, periodsView, periodView } from "./rows";

// PA-78, PA-79, PA-80 y PA-81 · Los periodos, el panel de uno, su ensayo y cierre y sus liquidaciones
// (`/admin/periodos`, `/admin/periodos/2027-10`, `/admin/periodos/2027-10/cierre` y
// `/admin/periodos/2027-10/liquidaciones`; RF-501 a RF-503, RF-505, RF-506, RF-509, RF-705, RF-408; FL-50,
// FL-51; T-605). No son páginas: las sirve el comodín de administración, que corre la guarda antes y
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
  const now = new Date().toISOString();
  // El aviso no dice de qué periodo es: se pinta solo si este tiene un pedido de hace un momento.
  const done = readNotice(reader) === "rollup_requested" && acceptedRollupNotice(read.period, now);
  return <PeriodScreen view={periodView(read.period, alerts.kind === "alerts" ? alerts.alerts : null, now)} done={done} />;
}

export async function CloseSection({ claims, period }: { claims: VerifiedClaims; period: number }) {
  const reader = await cookieReader();
  const read = await financeClose(reader, claims, period);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={periodClosePath(period)} withSession />;
  if (read.kind === "not_found" || read.close.period === null) notFound();
  // Ensayar y cerrar redirigen aquí con su aviso: lo de ahora ya trae lo hecho.
  // El aviso no dice de qué periodo es: se pinta solo si lo de este periodo es lo que el aviso dice.
  const notice = readNotice(reader);
  const found = CLOSE_NOTICES.find((each) => each === notice) ?? null;
  const done = acceptedCloseNotice(found, read.close, new Date().toISOString()) ? found : null;
  return <CloseScreen view={closeView(read.close)} done={done} />;
}

export async function PayoutsSection({ claims, period }: { claims: VerifiedClaims; period: number }) {
  const reader = await cookieReader();
  const read = await financePayouts(reader, claims, period);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={periodPayoutsPath(period)} withSession />;
  if (read.kind === "not_found" || read.payouts.period === null) notFound();
  // Las decisiones redirigen aquí con su aviso, que no dice de qué periodo es: se pinta solo si este se liberó (o
  // cambió) hace un momento.
  const notice = readNotice(reader);
  const now = new Date().toISOString();
  const done: PayoutsNotice | null =
    notice === "payouts_released" ? (acceptedReleaseNotice(read.payouts, now) ? notice : null) : notice === "payouts_updated" && acceptedUpdateNotice(read.payouts, now) ? notice : null;
  return <PayoutsScreen view={payoutsView(read.payouts)} done={done} />;
}
