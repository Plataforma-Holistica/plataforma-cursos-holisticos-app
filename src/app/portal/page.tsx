import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireTeacher } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "./_lib/frame";

// El inicio del portal del maestro (`/portal`, T-401), en su versión mínima: el panel con cifras llega con
// T-408. A quien no es maestro le contesta lo mismo que una ruta que no existe, y por eso no exporta `metadata`.
// Un maestro suspendido ve aquí el texto que se escribió para él, nunca el motivo interno.

const text = messages.portal.home;

export default async function PortalHomePage() {
  const step = await requireTeacher(ROUTES.portal);
  if (step.kind === "suspended") return <SuspendedScreen withSession />;
  if (step.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portal} withSession />;
  // Esta ruta es de trabajo: la guarda no contesta otra pantalla, y si un día lo hiciera, no se pinta nada de más.
  if (step.screen !== "work") return null;

  const notice = readNotice(await cookieReader());
  const suspended = step.teacher.status === "suspended";
  return (
    <PortalFrame current={ROUTES.portal} readOnly={suspended}>
      <h1 className="text-h1">{text.title}</h1>
      {notice === "teacher_accepted" && <InlineAlert tone="success">{t(text.accepted)}</InlineAlert>}
      {notice === "teacher_notice_accepted" && <InlineAlert tone="success">{text.noticeAccepted}</InlineAlert>}
      {suspended && step.teacher.notice !== null && (
        <section className="flex flex-col gap-2">
          <h2 className="text-h3">{t(text.suspendedTitle)}</h2>
          <p className="text-text-2">{step.teacher.notice}</p>
        </section>
      )}
      <p className="text-text-2">{text.intro}</p>
      <p>
        <TextLink href={ROUTES.portalCourses}>{text.courses}</TextLink>
      </p>
    </PortalFrame>
  );
}
