import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { VerifiedClaims } from "@/services/account/account";
import { portalStudentsPath } from "@/services/account/navigation";
import { courseStudents } from "@/services/teachers/course-students-data";

import { studentsQuery, studentsView } from "./rows";
import { StudentsScreen } from "./screen";

// PA-51 (`/portal/cursos/<id>/alumnos`), de solo lectura (T-408). La sirve el comodín del portal, después de la guarda; el maestro suspendido también la
// ve. Quien no es maestro, o un curso que no es suyo, que no existe o que nunca se publicó, recibe lo mismo que una ruta que no existe. «No se supo» se
// dice como en las otras pantallas de lectura del portal, con «Reintentar» a la misma lista.

export async function StudentsSection({
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
  const query = studentsQuery(course, search);
  const page = portalStudentsPath(course, query);
  if (page === null) notFound();
  const read = await courseStudents(claims, query);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={page} withSession />;
  if (read.value.outcome !== "ok") notFound();
  return <StudentsScreen view={studentsView(course, read.value.value, query.order)} readOnly={readOnly} />;
}
