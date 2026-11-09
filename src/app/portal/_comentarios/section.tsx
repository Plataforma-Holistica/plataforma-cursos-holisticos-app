import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { comments as text } from "@/messages/es/comments";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { commentReplies, teacherCommentCourses, teacherComments, type TeacherThread } from "@/services/comments/comments";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "../_lib/frame";

import { readTeacherFilters, teacherCommentsHref, type TeacherFilters } from "./outcomes";
import { PA45_TITLE, TeacherComments } from "./screen";

// PA-45 · Comentarios (`/portal/comentarios`; T-501; RF-609; FL-38; plan aprobado por Sergio el 2026-11-08). Lo sirve el comodín
// del portal, después de la guarda; el maestro suspendido también lo ve, y lee. Lo de sus lecciones lo lee el servicio sin la regla
// de acceso (la base acota al maestro de quien actúa); si puede responder lo dice el portón. Los filtros y las páginas van por la
// dirección, como enlaces. Ningún enlace a la lista de alumnos (PA-51): ahí van por su alias. Las respuestas que siguen de un
// comentario de esta página también van por la dirección (`?hilo=` y `?respuestas=`), como en PA-22, y reemplazan las suyas: se
// leen por la entrada de la lección, con la lección de ese comentario y la regla de acceso, que al maestro de la lección lo deja.

type Search = Readonly<Record<string, string | string[] | undefined>>;
const one = (search: Search, key: string) => {
  const value = search[key];
  return typeof value === "string" ? value : null;
};

/** Las respuestas siguientes del hilo que pida la dirección, si es de esta página; si no se supo, se quedan las primeras. */
async function withPagedThread(claims: VerifiedClaims, items: TeacherThread[], search: Search): Promise<{ items: TeacherThread[]; pagedThread: string | null; after: string | null }> {
  const parent = items.find((item) => item.id === one(search, "hilo"));
  const after = one(search, "respuestas");
  if (parent === undefined || after === null) return { items, pagedThread: null, after: null };
  const replies = await commentReplies(claims, parent.lessonId, parent.id, after);
  if (replies.kind !== "ready") return { items, pagedThread: null, after: null };
  return {
    items: items.map((item) => (item.id === parent.id ? { ...item, replies: { items: replies.items, more: replies.next !== null } } : item)),
    pagedThread: parent.id,
    after,
  };
}

/** Lo que se está viendo, para que un envío sin JavaScript vuelva ahí: los filtros, la página y, si las hay, las respuestas del hilo. */
function hereOf(filters: TeacherFilters, pagedThread: string | null, after: string | null): string {
  const page = teacherCommentsHref(filters, filters.from);
  if (pagedThread === null || after === null) return page;
  return `${page}${page.includes("?") ? "&" : "?"}hilo=${pagedThread}&respuestas=${encodeURIComponent(after)}`;
}

export async function CommentsSection({ claims, readOnly, search }: { claims: VerifiedClaims; readOnly: boolean; search: Search }) {
  const courses = await teacherCommentCourses(claims);
  if (courses.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portalComments} withSession />;
  const filters = readTeacherFilters(search, courses.courses);
  const read = await teacherComments(claims, { course: filters.course, unanswered: filters.unanswered, before: filters.from });
  // Dejó de ser maestro entre la guarda y la lectura: lo que contesta la guarda a quien no es maestro.
  if (read.kind === "not_teacher") notFound();
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={teacherCommentsHref(filters, filters.from)} withSession />;

  const paged = read.kind === "ready" ? await withPagedThread(claims, read.items, search) : null;

  // La llave es el destino: dos cursos pueden llamarse igual.
  const filterLink = (label: string, to: { course: string | null; unanswered: boolean }) => {
    const current = to.course === filters.course && to.unanswered === filters.unanswered;
    const href = teacherCommentsHref(to);
    return (
      <li key={href}>
        <a
          href={href}
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
        {/* Con `tabIndex`, para que reciba el foco cuando lo pulsado se va con la respuesta. */}
        <h1 id={PA45_TITLE} tabIndex={-1} className="text-h1 outline-none">
          {text.portal.title}
        </h1>
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
      {read.kind === "closed" || paged === null ? (
        <InlineAlert tone="warning">{text.portal.closed}</InlineAlert>
      ) : (
        <>
          {filters.from !== null && <TextLink href={teacherCommentsHref(filters)}>{text.portal.newest}</TextLink>}
          <TeacherComments
            items={paged.items}
            here={hereOf(filters, paged.pagedThread, paged.after)}
            filters={filters}
            pagedThread={paged.pagedThread}
            write={read.write}
            unanswered={filters.unanswered}
          />
          {read.next !== null && <TextLink href={teacherCommentsHref(filters, read.next)}>{text.portal.more}</TextLink>}
        </>
      )}
    </PortalFrame>
  );
}
