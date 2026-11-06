import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { StudentNav } from "@/app/_catalog/nav";
import { resourceItems } from "@/app/_catalog/resources/words";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireLessonSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { captionsChoice } from "@/services/account/account";
import { coursePath, lessonPath, ROUTES, teacherPath } from "@/services/account/navigation";
import { coursePage } from "@/services/browse/browse";
import { courseIsOpen, lessonPage, lessonResources, type LessonEntry } from "@/services/lessons/lessons";
import { lessonAccess } from "@/services/media/media";

import { initialOf } from "./outcomes";
import { LessonScreen, type SyllabusEntry } from "./screen";

// La página de una lección (PA-22, T-203). Pide sesión, salvo a dónde va quien no la tiene:
// al registro si el curso es el abierto, a entrar si no (flujo §6.3).
//
// Antes de pintar le pregunta a la función única de medios si esta cuenta puede ver la
// lección, sin firmar nada (`lessonAccess`): sin acceso, PA-33 ocupa el lugar del reproductor
// desde el primer momento, también sin JavaScript. La dirección del video la pide el
// reproductor después, con su acción (RF-305). A la vez lee si la cuenta dejó los subtítulos
// encendidos (RF-310); si no se supo, arrancan apagados. El temario trae el estado de cada lección
// para quien mira (T-206); el segundo donde arranca el video lo trae la concesión. Los recursos de
// la lección se leen solo con acceso (T-404): sin él, PA-33 no los muestra.
//
// Desde T-614 (parte 5; decisiones de Sergio del 2026-11-05) lleva la barra del alumno, y la ficha del curso del
// catálogo (`coursePage`, pública y recordada 30 s) da a dónde regresar, los enlaces del curso y del maestro y la
// portada que va detrás de «Reproducir». Si no se pudo leer, la lección se ve igual: sin enlace al maestro ni
// portada. Esa lectura no toca lo que decide quién ve qué.

const text = messages.lesson;

// El título de la pestaña no dice qué lección es: la página la puede pedir cualquiera.
export const metadata: Metadata = { title: text.pageTitle };

const minutes = (seconds: number) => t(text.minutes, { minutes: Math.max(1, Math.round(seconds / 60)) });

export default async function LessonRoute({ params }: { params: Promise<{ slug: string; leccion: string }> }) {
  const { slug, leccion } = await params;
  const path = `/cursos/${slug}/lecciones/${leccion}`;
  const session = await requireLessonSession(path, () => courseIsOpen(slug));
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={lessonPath(slug, leccion) ?? path} withSession />;

  const found = await lessonPage(session.claims, slug, leccion);
  if (found.kind === "not_found") notFound();
  if (found.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;
  const { page } = found;

  const [access, captions, card] = await Promise.all([lessonAccess(await cookieReader(), leccion), captionsChoice(session.claims), coursePage(slug)]);
  const initial = initialOf(access);
  if (initial.kind === "suspended") return <SuspendedScreen withSession />;
  if (initial.kind === "reload") redirect(path);
  const resources = initial.kind === "ready" ? await lessonResources(session.claims, page.lesson.id) : [];

  const entry = (lesson: LessonEntry): SyllabusEntry => ({
    id: lesson.id,
    number: lesson.number,
    title: lesson.title,
    duration: minutes(lesson.durationSeconds),
    current: lesson.current,
    href: lessonPath(page.course.slug, lesson.id) ?? path,
    state: lesson.state,
  });

  const listed = card.kind === "found" ? card.detail.course : null;
  const teacherHref = listed?.teacherSlug == null ? null : teacherPath(listed.teacherSlug);

  return (
    <>
      <StudentNav />
      <LessonScreen
        slug={page.course.slug}
        lessonId={page.lesson.id}
        heading={t(text.heading, { number: page.lesson.number, title: page.lesson.title })}
        course={{ title: page.course.title, href: coursePath(page.course.slug) ?? ROUTES.home }}
        teacher={{ name: page.course.teacherName, href: teacherHref }}
        cover={listed === null ? null : { practiceName: listed.practice?.name ?? null, tone: listed.practice?.tone ?? null }}
        summary={page.course.summary}
        about={t(text.aboutDuration, { duration: minutes(page.lesson.durationSeconds), module: page.lesson.moduleTitle })}
        modules={page.modules.map((group) => ({ id: group.id, title: group.title, lessons: group.lessons.map(entry) }))}
        next={page.next === null ? null : { title: page.next.title, href: lessonPath(page.course.slug, page.next.id) ?? path }}
        progress={page.progress}
        initial={initial}
        captions={captions.kind === "ready" && captions.on}
        resources={resources === null ? null : resourceItems(resources)}
      />
    </>
  );
}
