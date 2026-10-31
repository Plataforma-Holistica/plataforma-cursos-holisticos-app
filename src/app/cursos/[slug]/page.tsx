import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { courseListAction } from "@/app/_catalog/my-list/actions";
import { SaveCourseButton } from "@/app/_catalog/my-list/save-button";
import { downloadResourceAction } from "@/app/_catalog/resources/actions";
import { ResourceList } from "@/app/_catalog/resources/resource-list";
import { resourceItems } from "@/app/_catalog/resources/words";
import { StudentNav } from "@/app/_catalog/nav";
import { courseDuration, lessonMinutes } from "@/app/_catalog/format";
import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { publicViewer } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, plural, t } from "@/messages";
import { coursePath, lessonPath, ROUTES, signInPath, teacherPath } from "@/services/account/navigation";
import { coursePage, courseStanding } from "@/services/browse/browse";
import { lessonAccess } from "@/services/media/media";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { CourseCover } from "@/ui/course-cover";
import { Disclaimer } from "@/ui/disclaimer";
import { InlineAlert } from "@/ui/inline-alert";
import { LessonRow } from "@/ui/lesson-row";
import { ProgressBar } from "@/ui/progress-bar";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

import { primaryAction, type PrimaryAction, type Viewer } from "./outcomes";

// La ficha de un curso (PA-02; RF-302, RF-307, RF-309; T-210). Es pública: la ve completa
// cualquiera, con sesión o sin ella. Solo cambian el botón principal, el avance y el estado de
// cada lección, según quién mira (`publicViewer`, que nunca redirige; si no se sabe quién mira,
// va sin botón). Al alumno se le pregunta a la función única de medios si puede ver la primera
// lección, sin firmar nada.
//
// Se pinta en el servidor en cada visita (decisión mía sin confirmar, 2026-10-27): lo estático
// con regeneración, la descripción y la imagen para compartir quedan para T-606. La pestaña sí
// lleva el título del curso. La constancia no se pinta hasta que exista (T-504). El deslinde
// (RF-809; T-507) va al pie, sea quien sea el que mira.
//
// Los recursos del curso (RF-308; T-404): cualquiera los ve listados, y solo el alumno lleva el
// botón; a uno sin acceso se lo dice la puerta de medios al pedir (FL-14, E1). No se le pregunta
// antes por cada uno. Si no se sabe quién mira, la lista va sin botón ni invitación.
//
// «Guardar en mi lista» (RF-311) va junto al botón principal, solo para el alumno, y solo si se
// supo si ya lo tiene guardado (se lee con su avance). Al visitante no se le ofrece (decisión de
// Sergio del 2026-10-28).

const text = messages.browse.course;

/** El botón de Mi lista: el ancla a la que vuelve su formulario sin JavaScript. */
const MY_LIST_ID = "bloque-ficha-lista";
/** Los recursos: el ancla a la que vuelve su formulario sin JavaScript. */
const RESOURCES_ID = "bloque-ficha-recursos";

/** El título del curso en la pestaña. La lectura es la misma de la página, y se recuerda. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const found = await coursePage((await params).slug);
  return { title: found.kind === "found" ? found.detail.course.title : text.pageTitle };
}

/** El estado de una lección para quien no tiene avance que leer. */
const NOT_STARTED = "not_started" as const;
const LOCKED = "locked" as const;

const BUTTON_LABEL: Record<Exclude<PrimaryAction["kind"], "none" | "continue">, string> = {
  start: text.start,
  again: text.again,
  subscribe: text.subscribe,
  open_free: text.openFree,
};

export default async function CourseRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [viewer, found] = await Promise.all([publicViewer(), coursePage(slug)]);
  if (found.kind === "not_found") notFound();
  if (found.kind === "unavailable") return <UnavailableScreen retryHref={coursePath(slug) ?? ROUTES.landing} withSession={viewer.kind === "student"} />;
  const { detail } = found;
  const resources = resourceItems(found.resources);
  const { course } = detail;

  let who: Viewer = viewer.kind === "unknown" ? { kind: "unknown" } : { kind: "visitor" };
  // Si está en su lista; nulo si no mira un alumno o no se supo.
  let saved: boolean | null = null;
  if (viewer.kind === "student") {
    const [access, standing] = await Promise.all([lessonAccess(await cookieReader(), detail.firstLesson.id), courseStanding(viewer.claims, detail)]);
    who = { kind: "student", access, standing: standing.kind === "ready" ? standing.standing : null };
    saved = standing.kind === "ready" ? standing.saved : null;
  }
  const action = primaryAction(detail, who);
  const standing = who.kind === "student" ? who.standing : null;
  // Al visitante, las lecciones de un curso que pide suscripción llevan candado (PA-02, «Estados»).
  const locked = who.kind === "visitor" && !course.isOpen;
  const teacherHref = detail.teacher === null ? null : teacherPath(detail.teacher.slug);
  const tags = [course.practice?.name, course.level?.name].filter((tag): tag is string => typeof tag === "string");

  return (
    <>
      {who.kind === "student" && <StudentNav />}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-10 px-4 pt-6 pb-24 outline-none sm:px-8 sm:pb-16">
        {who.kind === "student" && <BackLink href={ROUTES.home}>{text.back}</BackLink>}

        <header className="grid gap-6 md:grid-cols-12 md:items-center md:gap-10">
          <CourseCover
            title={course.title}
            teacherName={course.teacherName}
            practiceName={course.practice?.name ?? null}
            tone={course.practice?.tone ?? null}
            className="rounded-md shadow-raised md:order-2 md:col-span-6"
          />
          <div className="flex flex-col gap-4 md:order-1 md:col-span-6">
            {tags.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <li key={tag} className="rounded-sm bg-surface-2 px-2 py-1 text-label text-text-2 uppercase">
                    {tag}
                  </li>
                ))}
              </ul>
            )}
            <h1 className="text-display-l text-balance">{course.title}</h1>
            <p className="text-body-l text-text-2">
              {teacherHref === null ? course.teacherName : <TextLink href={teacherHref}>{course.teacherName}</TextLink>}
            </p>
            <p className="text-body-s text-text-3">
              {t(plural(course.lessonCount, text.lessonsLine), { count: course.lessonCount, duration: courseDuration(course.totalSeconds) })}
            </p>
            {standing !== null && standing.started && (
              <ProgressBar
                value={standing.completed}
                max={standing.total}
                label={text.progressLabel}
                text={t(plural(standing.total, text.progress), { completed: standing.completed, total: standing.total })}
              />
            )}
            {(action.kind !== "none" || saved !== null) && (
              <div className="flex flex-wrap items-start gap-3">
                {action.kind !== "none" && (
                  <Button href={action.href}>{action.kind === "continue" ? t(text.continue, { number: action.number }) : BUTTON_LABEL[action.kind]}</Button>
                )}
                {saved !== null && (
                  <div id={MY_LIST_ID}>
                    <SaveCourseButton
                      action={courseListAction}
                      slug={course.slug}
                      title={course.title}
                      saved={saved}
                      permalink={`${coursePath(course.slug) ?? ROUTES.home}#${MY_LIST_ID}`}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {course.isOpen && <InlineAlert tone="neutral">{text.openNotice}</InlineAlert>}

        <div className="grid gap-10 md:grid-cols-12">
          <div className="flex flex-col gap-8 md:col-span-7">
            {course.summary !== null && <p className="max-w-reading text-body-l text-text-2">{course.summary}</p>}
            <section aria-labelledby="temario" className="flex flex-col gap-4">
              <h2 id="temario" className="text-h2">
                {text.syllabus}
              </h2>
              {detail.modules.map((group, index) => (
                <section key={group.id} aria-labelledby={`modulo-${group.id}`} className="flex flex-col gap-1">
                  <h3 id={`modulo-${group.id}`} className="text-h3 text-text-2">
                    {t(text.moduleTitle, { number: index + 1, title: group.title })}
                  </h3>
                  <ul className="flex flex-col">
                    {group.lessons.map((lesson) => {
                      const href = lessonPath(course.slug, lesson.id);
                      if (href === null) return null;
                      return (
                        <li key={lesson.id}>
                          <LessonRow
                            href={href}
                            number={lesson.number}
                            title={lesson.title}
                            duration={lessonMinutes(lesson.durationSeconds)}
                            state={locked ? LOCKED : (standing?.states.get(lesson.id) ?? NOT_STARTED)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </section>
          </div>

          <div className="flex flex-col gap-8 md:col-span-5">
            {detail.teacher !== null && (
              <aside aria-labelledby="sobre-maestro" className="flex flex-col gap-3">
                <h2 id="sobre-maestro" className="text-h3">
                  {t(text.about, { name: detail.teacher.name })}
                </h2>
                {detail.teacher.bio !== null && <p className="line-clamp-4 text-body text-text-2">{detail.teacher.bio}</p>}
                {teacherHref !== null && <TextLink href={teacherHref}>{t(text.seeTeacher, { name: detail.teacher.name })}</TextLink>}
              </aside>
            )}
            {resources.length > 0 && (
              <section id={RESOURCES_ID} aria-labelledby="recursos-titulo" className="flex flex-col gap-3">
                <h2 id="recursos-titulo" className="text-h3">
                  {messages.resources.courseTitle}
                </h2>
                <ResourceList
                  items={resources}
                  canDownload={who.kind === "student"}
                  action={downloadResourceAction}
                  permalink={`${coursePath(course.slug) ?? ROUTES.home}#${RESOURCES_ID}`}
                />
                {who.kind === "visitor" && <TextLink href={signInPath(coursePath(course.slug) ?? ROUTES.home)}>{messages.resources.signIn}</TextLink>}
              </section>
            )}
          </div>
        </div>
        <Disclaimer />
      </main>
    </>
  );
}
