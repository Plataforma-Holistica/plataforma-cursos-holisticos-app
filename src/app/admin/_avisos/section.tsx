import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { billingQueue } from "@/services/billing/billing";

import { billingView } from "./rows";
import { BillingEventsScreen, type DoneNotice } from "./screen";

// PA-84 · Los avisos de cobro sin procesar (`/admin/avisos-cobro`; RF-208, RF-710, FL-55; T-303, tercera solicitud). No es una página: la sirve el comodín de
// administración, que corre la guarda antes y solo llega aquí con alguien del equipo que tiene Finanzas (`src/app/admin/_lib/sections.tsx`). La cola se lee con
// las claims con que la guarda dejó pasar, y la base solo se la contesta a quien pasa su puerta con Finanzas.

const DONE: readonly DoneNotice[] = ["billing_event_processed", "billing_event_already_applied", "billing_event_on_its_way", "billing_event_resolved"];

export async function BillingEventsSection({ claims }: { claims: VerifiedClaims }) {
  const reader = await cookieReader();
  const read = await billingQueue(reader, claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.billingEvents} withSession />;

  // Cada acción que sale bien redirige aquí con su aviso: la cola de ahora ya trae lo hecho.
  const notice = readNotice(reader);
  const done = DONE.find((each) => each === notice) ?? null;
  return <BillingEventsScreen view={billingView(read.queue)} done={done} />;
}
