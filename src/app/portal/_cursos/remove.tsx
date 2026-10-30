import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { VerifiedClaims } from "@/services/account/account";
import { portalDeleteCoursePath, ROUTES } from "@/services/account/navigation";
import { draftCourse } from "@/services/drafts/editor";

import { PortalFrame } from "../_lib/frame";
import { DeleteCourseScreen } from "./delete-screen";
import { deleteButton } from "./outcomes";

// Confirmar el borrado de un curso (`/portal/cursos/<id>/borrar`). Lo sirve el comodín del portal,
// después de la guarda. Solo un borrador del maestro, nunca enviado, y no a un suspendido: lo demás
// contesta lo mismo que una ruta que no existe. La base lo vuelve a exigir al borrar.

export async function DeleteCourseSection({ claims, course, readOnly }: { claims: VerifiedClaims; course: string; readOnly: boolean }) {
  const path = portalDeleteCoursePath(course);
  if (readOnly || path === null) notFound();
  const read = await draftCourse(claims, course);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;
  if (read.value === null || read.value.state !== "draft") notFound();

  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={false}>
      <DeleteCourseScreen title={read.value.title} confirm={deleteButton(read.value.id, read.value.contentRevision)} path={path} />
    </PortalFrame>
  );
}
