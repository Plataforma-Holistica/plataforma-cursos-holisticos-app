import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { portal } from "@/messages/es/portal";
import type { VerifiedClaims } from "@/services/account/account";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import { draftChoices, draftCourse, submitPreview } from "@/services/drafts/editor";
import { legalBlocks } from "@/services/legal/texts";
import { BackLink } from "@/ui/back-link";

import { PortalFrame } from "../_lib/frame";
import { PortalMain } from "../_lib/shell";
import { submitView } from "./rows";
import { SubmitScreen } from "./screen";

// PA-44 · Enviar a revisión (`/portal/cursos/<id>/enviar`; RF-606, FL-34; T-405). No es una página: la sirve el comodín del portal, que corre la guarda antes y solo llega aquí con
// un maestro activo o suspendido. Un curso que no es suyo, o sin borrador, contesta lo mismo que una ruta que no existe. Al suspendido no se le ofrece enviar (FL-34, E3).
//
// La vista previa se lee como el servidor, a nombre del maestro: lo que falta, el anexo vigente, el plazo y la huella de lo que se enviaría. Las duraciones salen del borrador.

const text = portal.submit;

export async function SubmitSection({ claims, course, readOnly }: { claims: VerifiedClaims; course: string; readOnly: boolean }) {
  const back = portalCoursePath(course);
  if (back === null) notFound();
  const self = `${back}/enviar`;
  const draft = await draftCourse(claims, course);
  if (draft.kind === "unavailable") return <UnavailableScreen retryHref={self} withSession />;
  if (draft.value === null) notFound();

  if (readOnly) {
    return (
      <PortalFrame current={ROUTES.portalCourses} readOnly>
        <PortalMain title={draft.value.title} above={<BackLink href={back}>{text.back}</BackLink>} measure="reading">
          <p className="text-text-2">{text.readOnly}</p>
        </PortalMain>
      </PortalFrame>
    );
  }

  const [preview, choices] = await Promise.all([submitPreview(claims, course), draftChoices({ practiceId: draft.value.practiceId, levelId: draft.value.levelId })]);
  if (preview.kind === "unavailable" || choices.kind === "unavailable" || preview.value.kind === "unavailable") return <UnavailableScreen retryHref={self} withSession />;
  if (preview.value.kind === "not_found") notFound();
  const view = submitView(preview.value, draft.value, choices.value.lessonTolerance);
  const blocks = view.annex === null ? [] : legalBlocks(view.annex.body);

  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={false}>
      <SubmitScreen view={view} blocks={blocks} />
    </PortalFrame>
  );
}
