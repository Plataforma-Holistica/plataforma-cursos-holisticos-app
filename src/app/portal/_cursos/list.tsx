import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import type { VerifiedClaims } from "@/services/account/account";
import { portalNewCoursePath, ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { teacherCourses } from "@/services/drafts/editor";
import { Button } from "@/ui/button";
import { CourseCover } from "@/ui/course-cover";
import { InlineAlert } from "@/ui/inline-alert";
import { StatusBadge } from "@/ui/status-badge";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "../_lib/frame";
import { courseRows } from "./rows";

// PA-42 · Mis cursos (`/portal/cursos`; RF-603, FL-32). No es una página: la sirve el comodín del
// portal, que corre la guarda antes y solo llega aquí con un maestro activo o suspendido.
//
// Los cursos se leen como la persona: su maestro lee lo suyo, también suspendido. Al suspendido no se le
// ofrece crear, editar ni borrar (RF-702), y lo dice la franja. Ocultar un botón no es el control: la
// base vuelve a exigir al maestro activo en cada cambio.

const text = messages.portal.courses;

export async function CoursesSection({ claims, readOnly }: { claims: VerifiedClaims; readOnly: boolean }) {
  const read = await teacherCourses(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.portalCourses} withSession />;
  const notice = readNotice(await cookieReader());
  const rows = courseRows(read.value, readOnly);

  return (
    <PortalFrame current={ROUTES.portalCourses} readOnly={readOnly}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-h1">{text.title}</h1>
        {!readOnly && rows.length > 0 && <Button href={portalNewCoursePath()}>{text.newCourse}</Button>}
      </div>
      {notice === "course_deleted" && <InlineAlert tone="success">{text.deleted}</InlineAlert>}
      {notice === "course_gone" && <InlineAlert tone="neutral">{text.gone}</InlineAlert>}
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-md border border-border p-6">
          <p className="text-body-l text-text-2">{text.empty}</p>
          {!readOnly && <Button href={portalNewCoursePath()}>{text.firstCourse}</Button>}
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-4 rounded-md border border-border p-4 sm:flex-row sm:items-center">
              <CourseCover
                title={row.cover.title}
                teacherName={row.cover.teacherName ?? ""}
                practiceName={row.cover.practiceName}
                tone={row.cover.tone}
                className="w-full rounded-sm sm:w-48 sm:shrink-0"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <h2 className="text-h3">{row.title}</h2>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-s text-text-2">
                  <StatusBadge tone={row.tone}>{row.state}</StatusBadge>
                  {row.lessons !== null && <span>{row.lessons}</span>}
                  <span>{t(text.editedOn, { date: row.edited })}</span>
                </div>
                {row.detail !== null && <p className="text-body-s text-text-2">{row.detail}</p>}
              </div>
              <div className="flex flex-wrap gap-3 sm:flex-col sm:items-end">
                {row.action !== null && (
                  <Button href={row.action.href} variant="secondary">
                    <span aria-hidden="true">{row.action.label}</span>
                    <span className="sr-only">{row.action.name}</span>
                  </Button>
                )}
                {row.remove !== null && (
                  <TextLink href={row.remove.href}>
                    <span aria-hidden="true">{row.remove.label}</span>
                    <span className="sr-only">{row.remove.name}</span>
                  </TextLink>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </PortalFrame>
  );
}
