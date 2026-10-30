import { randomUUID } from "node:crypto";

import { redirect } from "next/navigation";

import { ROUTES } from "@/services/account/navigation";

import { PortalFrame } from "../_lib/frame";
import { NewCourseScreen } from "./new-screen";

// Crear un curso (`/portal/cursos/nuevo`; FL-32, paso 1). Lo sirve el comodín del portal, después de la
// guarda. El testigo nace aquí, al pintar: es lo que hace que un doble envío o «Reintentar» no creen dos
// cursos. Al maestro suspendido no se le ofrece crear: vuelve a su lista, que lo explica.

export function NewCourseSection({ readOnly }: { readOnly: boolean }) {
  if (readOnly) redirect(ROUTES.portalCourses);
  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={false}>
      <NewCourseScreen token={randomUUID()} />
    </PortalFrame>
  );
}
