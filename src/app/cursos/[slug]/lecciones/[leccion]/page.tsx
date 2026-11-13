import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { StudentNav } from "@/app/_catalog/nav";
import { studentNavFor } from "@/app/_catalog/nav-facts";
import { resourceItems } from "@/app/_catalog/resources/words";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireLessonSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { captionsChoice } from "@/services/account/account";
import { coursePath, lessonPath, ROUTES, teacherPath } from "@/services/account/navigation";
import { coursePage } from "@/services/browse/browse";
import { commentReplies, lessonComments, type LessonCommentsAnswer } from "@/services/comments/comments";
import { courseIsOpen, lessonPage, lessonResources, type LessonEntry } from "@/services/lessons/lessons";
import { lessonAccess } from "@/services/media/media";

import { initialOf } from "./outcomes";
import { commentCursor } from "@/app/_comments/view";

import { LessonScreen, type LessonCommentsSlot, type SyllabusEntry } from "./screen";

// La página de una lección (PA-22, T-203). Pide sesión, salvo a dónde va quien no la tiene:
// al registro si el curso es el abierto, a los planes si es uno normal y a entrar si no se supo (flujo §6.3).
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
//
// Los comentarios (T-501) los lee el servicio, que decide el acceso con la regla única: sin la lección, sin acceso o
// cerrados, no hay pestaña. La página de comentarios va en la dirección (`?comentarios=`), y las respuestas que siguen de un
// hilo de esa página también (`?hilo=` y `?respuestas=`): reemplazan las suyas, sin acumularse.

const text = messages.lesson;

// El título de la pestaña no dice qué lección es: la página la puede pedir cualquiera.
export const metadata: Metadata = { title: text.pageTitle };

const minutes = (seconds: number) => t(text.minutes, { minutes: Math.max(1, Math.round(seconds / 60)) });

type Search = Record<string, string | string[] | undefined>;

/** Un solo valor de la dirección, o nulo. */
const one = (search: Search, key: string): string | null => {
  const value = search[key];
  return typeof value === "string" ? value : null;
};

/** Lo que la pantalla pinta de los comentarios, con las respuestas siguientes del hilo que pida la dirección. */
async function commentsSlot(claims: Parameters<typeof lessonComments>[0], lessonId: string, path: string, search: Search, read: LessonCommentsAnswer): Promise<LessonCommentsSlot | null> {
  if (read.kind === "unavailable") return { kind: "unavailable" };
  if (read.kind !== "ready") return null;
  // Un cursor sin forma lo descarta el servicio, que empieza por lo más reciente: entonces esta es la primera página.
  const cursor = commentCursor(one(search, "comentarios"));
  let items = read.items;
  let pagedThread: string | null = null;
  const thread = one(search, "hilo");
  const after = one(search, "respuestas");
  if (thread !== null && after !== null && items.some((item) => item.id === thread)) {
    const replies = await commentReplies(claims, lessonId, thread, after);
    if (replies.kind === "ready") {
      items = items.map((item) => (item.id === thread ? { ...item, replies: { items: replies.items, more: replies.next !== null } } : item));
      pagedThread = thread;
    }
  }
  // Lo que se está viendo, para que un envío sin JavaScript vuelva ahí: la página y, si las hay, las respuestas del hilo.
  const query = [cursor === null ? null : `comentarios=${encodeURIComponent(cursor)}`, pagedThread === null || after === null ? null : `hilo=${pagedThread}&respuestas=${encodeURIComponent(after)}`].filter(Boolean);
  const here = query.length === 0 ? path : `${path}?${query.join("&")}`;
  return { kind: "ready", view: { count: read.count, items, next: read.next, paged: cursor !== null, cursor, here, pagedThread, me: read.me, write: read.write } };
}

export default async function LessonRoute({ params, searchParams }: { params: Promise<{ slug: string; leccion: string }>; searchParams: Promise<Search> }) {
  const { slug, leccion } = await params;
  const search = await searchParams;
  const path = `/cursos/${slug}/lecciones/${leccion}`;
  const session = await requireLessonSession(path, () => courseIsOpen(slug));
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={lessonPath(slug, leccion) ?? path} withSession />;

  const found = await lessonPage(session.claims, slug, leccion);
  if (found.kind === "not_found") notFound();
  if (found.kind === "unavailable") return <UnavailableScreen retryHref={path} withSession />;
  const { page } = found;

  const [access, captions, card, commentsRead, nav] = await Promise.all([
    lessonAccess(await cookieReader(), leccion),
    captionsChoice(session.claims),
    coursePage(slug),
    lessonComments(session.claims, page.lesson.id, commentCursor(one(search, "comentarios"))),
    studentNavFor(session.claims),
  ]);
  const initial = initialOf(access);
  if (initial.kind === "suspended") return <SuspendedScreen withSession />;
  if (initial.kind === "reload") redirect(path);
  const resources = initial.kind === "ready" ? await lessonResources(session.claims, page.lesson.id) : [];
  const comments = initial.kind === "denied" ? null : await commentsSlot(session.claims, page.lesson.id, lessonPath(page.course.slug, page.lesson.id) ?? path, search, commentsRead);

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
      <StudentNav {...nav} />
      <LessonScreen
        slug={page.course.slug}
        lessonId={page.lesson.id}
        heading={t(text.heading, { number: page.lesson.number, title: page.lesson.title })}
        course={{ title: page.course.title, href: coursePath(page.course.slug) ?? ROUTES.home }}
        teacher={{ name: page.course.teacherName, href: teacherHref }}
        cover={listed === null ? null : { practiceName: listed.practice?.name ?? null, tone: listed.practice?.tone ?? null }}
        summary={page.course.summary}
        moduleTitle={page.lesson.moduleTitle}
        // El módulo va en el antetítulo de la cabecera (T-616, 3b-2): esta frase ya no lo repite.
        about={t(text.aboutDuration, { duration: minutes(page.lesson.durationSeconds) })}
        modules={page.modules.map((group) => ({ id: group.id, title: group.title, lessons: group.lessons.map(entry) }))}
        next={page.next === null ? null : { title: page.next.title, href: lessonPath(page.course.slug, page.next.id) ?? path }}
        progress={page.progress}
        initial={initial}
        captions={captions.kind === "ready" && captions.on}
        resources={resources === null ? null : resourceItems(resources)}
        comments={comments}
      />
    </>
  );
}
