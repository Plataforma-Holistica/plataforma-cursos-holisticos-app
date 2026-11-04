import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { VerifiedClaims } from "@/services/account/account";
import { portalCoursePath, portalDiscardVersionPath, ROUTES } from "@/services/account/navigation";
import { draftCourse } from "@/services/drafts/editor";

import { PortalFrame } from "../_lib/frame";
import { DiscardVersionScreen } from "./discard-screen";
import { discardButton } from "./outcomes";

// Confirmar que se descartan los cambios a un curso publicado (`/portal/cursos/<id>/descartar`; T-405, H-18). Lo sirve el comodín del portal,
// después de la guarda. Solo la versión en borrador de un curso del maestro, y no a un suspendido: lo demás contesta lo mismo que una ruta que no
// existe. La base lo vuelve a exigir al descartar.

export async function DiscardVersionSection({ claims, course, readOnly }: { claims: VerifiedClaims; course: string; readOnly: boolean }) {
  const path = portalDiscardVersionPath(course);
  const back = portalCoursePath(course);
  if (readOnly || path === null || back === null) notFound();
  const read = await draftCourse(claims, course);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;
  if (read.value === null || read.value.state !== "changes_pending" || read.value.pendingVersion !== "draft") notFound();

  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={false}>
      <DiscardVersionScreen
        title={read.value.title}
        confirm={discardButton(read.value.id, read.value.contentRevision)}
        path={path}
        back={back}
        wasSent={read.value.returned !== null}
      />
    </PortalFrame>
  );
}
