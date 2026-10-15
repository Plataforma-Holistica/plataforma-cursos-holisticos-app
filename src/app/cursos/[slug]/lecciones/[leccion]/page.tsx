import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireLessonSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { captionsChoice } from "@/services/account/account";
import { lessonPath } from "@/services/account/navigation";
import { courseIsOpen, lessonPage, type LessonEntry } from "@/services/lessons/lessons";
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
// encendidos (RF-310); si no se supo, arrancan apagados.

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

  const [access, captions] = await Promise.all([lessonAccess(await cookieReader(), leccion), captionsChoice(session.claims)]);
  const initial = initialOf(access);
  if (initial.kind === "suspended") return <SuspendedScreen withSession />;
  if (initial.kind === "reload") redirect(path);

  const entry = (lesson: LessonEntry): SyllabusEntry => ({
    id: lesson.id,
    number: lesson.number,
    title: lesson.title,
    duration: minutes(lesson.durationSeconds),
    current: lesson.current,
    href: lessonPath(page.course.slug, lesson.id) ?? path,
  });

  return (
    <LessonScreen
      slug={page.course.slug}
      lessonId={page.lesson.id}
      heading={t(text.heading, { number: page.lesson.number, title: page.lesson.title })}
      byline={t(text.byline, { course: page.course.title, teacher: page.course.teacherName })}
      summary={page.course.summary}
      about={t(text.aboutDuration, { duration: minutes(page.lesson.durationSeconds), module: page.lesson.moduleTitle })}
      modules={page.modules.map((group) => ({ id: group.id, title: group.title, lessons: group.lessons.map(entry) }))}
      next={page.next === null ? null : { title: page.next.title, href: lessonPath(page.course.slug, page.next.id) ?? path }}
      initial={initial}
      captions={captions.kind === "ready" && captions.on}
    />
  );
}
