import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireTeacher } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { teacherDashboard } from "@/services/teachers/dashboard-data";
import { taxProfileState } from "@/services/teachers/tax-data";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { clabeWaitingText } from "./_fiscal/clabe-wait";
import { dashboardView } from "./_inicio/outcomes";
import { DashboardPanel, DashboardUnavailable } from "./_inicio/screen";
import { PortalFrame } from "./_lib/frame";
import { PortalMain } from "./_lib/shell";

// El inicio del portal del maestro (`/portal`): el panel, PA-41 (T-401 y T-408). Primero la guarda; después los avisos (lo aceptado, la cuenta en solo
// lectura con el texto que se escribió para el maestro y nunca el motivo interno, los datos fiscales y la CLABE) y el panel. A quien no es maestro le
// contesta lo mismo que una ruta que no existe, y por eso no exporta `metadata`. Si el panel no se pudo leer, los avisos siguen y el panel lo dice.

const text = messages.portal.home;

export default async function PortalHomePage() {
  const step = await requireTeacher(ROUTES.portal);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portal} withSession />;
  // Esta ruta es de trabajo: la guarda no contesta otra pantalla, y si un día lo hiciera, no se pinta nada de más.
  if (step.screen !== "work") return null;

  const notice = readNotice(await cookieReader());
  const suspended = step.teacher.status === "suspended";
  // FL-31, E2: sin ellos no se le puede pagar. «No se supo» no se dice como que faltan. Se le dice también a un suspendido, salvo por fraude.
  const [taxData, dashboard] = await Promise.all([taxProfileState(step.claims), teacherDashboard(step.claims)]);
  // Quien ya no es maestro para la base (se fue entre la guarda y la lectura) no tiene panel: se le dice como «no se supo», y la guarda decide al reintentar.
  const panel = dashboard.kind === "ready" && dashboard.value.outcome === "ok" ? dashboardView(dashboard.value.value, taxData, suspended) : null;
  return (
    <PortalFrame current={ROUTES.portal} readOnly={suspended}>
      <PortalMain title={text.title} section>
        {/* Los avisos, juntos y arriba: es lo que falta hacer. Sin ninguno, el bloque no ocupa lugar. */}
        <div className="flex flex-col gap-3 empty:hidden">
          {notice === "teacher_accepted" && <InlineAlert tone="success">{t(text.accepted)}</InlineAlert>}
          {notice === "teacher_notice_accepted" && <InlineAlert tone="success">{text.noticeAccepted}</InlineAlert>}
          {suspended && step.teacher.notice !== null && (
            <section className="flex flex-col gap-2">
              <h2 className="text-h3">{t(text.suspendedTitle)}</h2>
              <p className="max-w-reading text-text-2">{step.teacher.notice}</p>
            </section>
          )}
          {taxData?.version === 0 && taxData.canSave && (
            <InlineAlert tone="warning">
              {text.taxDataMissing} <TextLink href={ROUTES.portalTaxData}>{text.taxDataLink}</TextLink>
            </InlineAlert>
          )}
          {taxData?.clabeWaitsUntil != null && <InlineAlert tone="warning">{clabeWaitingText(taxData.clabeWaitsUntil)}</InlineAlert>}
          {taxData?.clabeNoticePending === true && <InlineAlert tone="warning">{messages.portal.taxData.clabeNoticePending}</InlineAlert>}
          {taxData?.clabeRecapture === true && taxData.canSave && (
            <InlineAlert tone="warning">
              {messages.portal.taxData.clabeRecapture} <TextLink href={`${ROUTES.portalTaxData}?cambiar=1`}>{messages.portal.taxData.clabeRecaptureLink}</TextLink>
            </InlineAlert>
          )}
        </div>
        {panel === null ? <DashboardUnavailable /> : <DashboardPanel view={panel} />}
      </PortalMain>
    </PortalFrame>
  );
}
