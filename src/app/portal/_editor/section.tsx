import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { VerifiedClaims } from "@/services/account/account";
import { portalCoursePath, ROUTES } from "@/services/account/navigation";
import { draftChoices, draftCourse } from "@/services/drafts/editor";

import { PortalFrame } from "../_lib/frame";
import { editorView } from "./rows";
import { EditorScreen } from "./screen";

// PA-43 · El editor de un curso (`/portal/cursos/<id>`; RF-603, FL-32). No es una página: la sirve el
// comodín del portal, que corre la guarda antes y solo llega aquí con un maestro activo o suspendido.
//
// El borrador se lee como la persona: un curso que no es suyo, o que no tiene borrador, contesta lo
// mismo que una ruta que no existe. Lo que el editor ofrece para elegir se lee como sistema, con lo
// elegido en ese borrador. Al suspendido, todo en solo lectura (RF-702); la base lo vuelve a exigir en
// cada cambio.

export async function EditorSection({
  claims,
  course,
  readOnly,
  search,
}: {
  claims: VerifiedClaims;
  course: string;
  readOnly: boolean;
  search: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const path = portalCoursePath(course);
  if (path === null) notFound();
  const read = await draftCourse(claims, course);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;
  if (read.value === null) notFound();
  const choices = await draftChoices({ practiceId: read.value.practiceId, levelId: read.value.levelId });
  if (choices.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;

  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={readOnly}>
      <EditorScreen view={editorView(read.value, choices.value, { readOnly, search, now: new Date() })} />
    </PortalFrame>
  );
}
