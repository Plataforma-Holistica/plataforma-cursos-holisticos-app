import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { VerifiedClaims } from "@/services/account/account";
import { portalPayoutPath, ROUTES } from "@/services/account/navigation";
import { myPayouts, payoutReport } from "@/services/teachers/payout-report-data";

import { emptyReportView, payoutsView, reportView } from "./rows";
import { PayoutsScreen, ReportScreen } from "./screen";

// PA-46 (`/portal/pagos`) y PA-47 (`/portal/pagos/<AAAA-MM>`), de solo lectura (T-604, cuarta solicitud). Las sirve el comodín del portal, después de
// la guarda; el maestro suspendido también las ve. Quien no es maestro, o un periodo que no es suyo o no cerró, recibe lo mismo que una ruta que no existe.
// «No se supo» se dice como en las otras pantallas de lectura del portal, con «Reintentar».

export async function PayoutsSection({ claims, readOnly }: { claims: VerifiedClaims; readOnly: boolean }) {
  const read = await myPayouts(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portalPayouts} withSession />;
  if (read.value.outcome !== "ok") notFound();
  return <PayoutsScreen view={payoutsView(read.value.value)} readOnly={readOnly} />;
}

export async function PayoutReportSection({ claims, period, readOnly }: { claims: VerifiedClaims; period: string; readOnly: boolean }) {
  const page = portalPayoutPath(period);
  if (page === null) notFound();
  const read = await payoutReport(claims, period);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={page} withSession />;
  const answer = read.value;
  if (answer.outcome === "empty") return <ReportScreen view={emptyReportView(answer)} page={page} readOnly={readOnly} />;
  if (answer.outcome !== "ok") notFound();
  return <ReportScreen view={reportView(answer.value)} page={page} readOnly={readOnly} />;
}
