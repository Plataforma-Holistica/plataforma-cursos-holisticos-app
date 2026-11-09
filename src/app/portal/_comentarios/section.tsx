import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { comments as text } from "@/messages/es/comments";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { teacherCommentCourses, teacherComments } from "@/services/comments/comments";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "../_lib/frame";

import { readTeacherFilters, teacherCommentsHref } from "./outcomes";
import { TeacherComments } from "./screen";

// PA-45 · Comentarios (`/portal/comentarios`; T-501; RF-609; FL-38; plan aprobado por Sergio el 2026-11-08). Lo sirve el comodín
// del portal, después de la guarda; el maestro suspendido también lo ve, y lee. Lo de sus lecciones lo lee el servicio sin la regla
// de acceso (la base acota al maestro de quien actúa); si puede responder lo dice el portón. Los filtros y las páginas van por la
// dirección, como enlaces. Ningún enlace a la lista de alumnos (PA-51): ahí van por su alias.

export async function CommentsSection({ claims, readOnly, search }: { claims: VerifiedClaims; readOnly: boolean; search: Readonly<Record<string, string | string[] | undefined>> }) {
  const courses = await teacherCommentCourses(claims);
  if (courses.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portalComments} withSession />;
  const filters = readTeacherFilters(search, courses.courses);
  const read = await teacherComments(claims, { course: filters.course, unanswered: filters.unanswered, before: filters.from });
  // Dejó de ser maestro entre la guarda y la lectura: lo que contesta la guarda a quien no es maestro.
  if (read.kind === "not_teacher") notFound();
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={teacherCommentsHref(filters, filters.from)} withSession />;

  const filterLink = (label: string, to: { course: string | null; unanswered: boolean }) => {
    const current = to.course === filters.course && to.unanswered === filters.unanswered;
    return (
      <li key={label}>
        <a
          href={teacherCommentsHref(to)}
          aria-current={current ? "true" : undefined}
          className={current ? "font-semibold text-text underline underline-offset-4" : "text-accent underline-offset-4 hover:underline"}
        >
          {label}
        </a>
      </li>
    );
  };

  return (
    <PortalFrame current={ROUTES.portalComments} readOnly={readOnly}>
      <div className="flex max-w-reading flex-col gap-3">
        <h1 className="text-h1">{text.portal.title}</h1>
        <p className="text-text-2">{text.portal.intro}</p>
      </div>
      <nav aria-label={text.portal.filters} className="flex flex-col gap-2">
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-body-s">
          {filterLink(text.portal.allCourses, { course: null, unanswered: filters.unanswered })}
          {courses.courses.map((course) => filterLink(course.title, { course: course.id, unanswered: filters.unanswered }))}
        </ul>
        <ul className="flex flex-wrap gap-x-4 text-body-s">
          {filterLink(text.portal.everything, { course: filters.course, unanswered: false })}
          {filterLink(text.portal.unanswered, { course: filters.course, unanswered: true })}
        </ul>
      </nav>
      {read.kind === "closed" ? (
        <InlineAlert tone="warning">{text.portal.closed}</InlineAlert>
      ) : (
        <>
          {filters.from !== null && <TextLink href={teacherCommentsHref(filters)}>{text.portal.newest}</TextLink>}
          <TeacherComments items={read.items} here={teacherCommentsHref(filters, filters.from)} write={read.write} unanswered={filters.unanswered} />
          {read.next !== null && <TextLink href={teacherCommentsHref(filters, read.next)}>{text.portal.more}</TextLink>}
        </>
      )}
    </PortalFrame>
  );
}
