import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { anomalyAlerts } from "@/services/anomalies/anomalies";

import { alertsView } from "./rows";
import { AlertsScreen, type DoneNotice } from "./screen";

// PA-68 mínima · Las alertas de anomalía (`/admin/alertas`; RF-406, RN-17, FL-64; T-208). No es
// una página: la sirve el comodín de administración, que corre la guarda antes y solo llega aquí
// con alguien del equipo que tiene Finanzas (`src/app/admin/_lib/sections.tsx`).
//
// Las alertas se leen con las claims con que la guarda dejó pasar, y la base solo se las contesta
// a quien pasa su puerta con Finanzas. Ninguna cuenta llega con su identificador: cada una es su
// huella en esa alerta.

const DONE: readonly DoneNotice[] = ["alert_reviewed", "fraud_decided", "account_excluded", "exclusion_revoked"];

export async function AlertsSection({ claims }: { claims: VerifiedClaims }) {
  const reader = await cookieReader();
  const read = await anomalyAlerts(reader, claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.alerts} withSession />;

  // Cada decisión redirige aquí con su aviso: la lista de ahora ya trae lo decidido.
  const notice = readNotice(reader);
  const done = DONE.find((each) => each === notice) ?? null;
  return <AlertsScreen view={alertsView(read.alerts)} done={done} />;
}
