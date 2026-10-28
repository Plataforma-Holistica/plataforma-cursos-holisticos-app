import type { Metadata } from "next";

import { homeListAction } from "@/app/_catalog/my-list/actions";
import { MyListBlock } from "@/app/_catalog/my-list/my-list-block";
import { StudentNav } from "@/app/_catalog/nav";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import { requireSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { accountProfile, sessionEmail } from "@/services/account/account";
import { coursePath, explorePath, lessonPath, ROUTES, teacherPath } from "@/services/account/navigation";
import { homeShelf, myList, type ShelfCourse } from "@/services/browse/browse";
import { continueWatching } from "@/services/progress/progress";
import { Button } from "@/ui/button";
import { Carousel } from "@/ui/carousel";
import { CourseCard } from "@/ui/course-card";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TeacherCard } from "@/ui/teacher-card";
import { TextLink } from "@/ui/text-link";

// El inicio del alumno (PA-20; RF-301; FL-10; T-210). Reemplaza al provisional. De arriba abajo:
// el saludo, «Continuar viendo» (o «Para empezar» para quien no ha empezado nada), «Nuevos», un
// carrusel por práctica en el orden de PA-67, y «Por maestro». Una práctica sin cursos no pinta
// su fila; con el catálogo vacío, el estado vacío en lugar de las filas.
//
// Bajo el saludo sigue diciendo con qué correo se entró: le avisa a alguien que completó una
// cuenta desde un enlace que le mandó otra persona, y cuyo buzón no controla. Y al pie, «Salir»,
// mientras no haya menú de la cuenta. «Ver todo» lleva a explorar con el filtro de la fila:
// «Para empezar», su nivel; cada práctica, la suya. «Nuevos» no lo lleva: explorar no ordena por
// otra cosa que lo más nuevo, y sin filtro pinta un carrusel por práctica (decisión mía sin
// confirmar, 2026-10-28).
//
// «Mi lista» (RF-311, tercera solicitud de T-210) va después de «Continuar viendo» o «Para
// empezar» y antes de «Nuevos», solo si tiene algo. Si no se pudo leer, no se pinta (el servicio
// lo reporta). El bloque está siempre, vacío o no: su región dice «Quitado de tu lista» aunque
// se haya quitado el último.

const text = messages.browse.home;

/** El bloque de «Mi lista»: el ancla a la que vuelve su formulario sin JavaScript. */
const MY_LIST_ID = "bloque-mi-lista";

export const metadata: Metadata = { title: text.pageTitle };

/** «Ver todo» de una fila: visible así, y con el nombre de la fila para quien no la ve. */
function SeeAll({ href, row }: { href: string; row: string }) {
  return (
    <TextLink href={href}>
      <span aria-hidden="true">{text.seeAll}</span>
      <span className="sr-only">{t(text.seeAllOf, { row })}</span>
    </TextLink>
  );
}

function courseCard(course: ShelfCourse) {
  const href = coursePath(course.slug);
  if (href === null) return null;
  return (
    <CourseCard
      key={course.slug}
      href={href}
      title={course.title}
      teacherName={course.teacherName}
      practice={course.practice}
      levelName={course.level?.name ?? null}
      lessonCount={course.lessonCount}
      isOpen={course.isOpen}
    />
  );
}

export default async function HomePage() {
  const session = await requireSession(ROUTES.home);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.home} withSession />;

  const [email, profile, watching, shelf, saved] = await Promise.all([
    sessionEmail(await cookieReader()),
    accountProfile(session.claims),
    continueWatching(session.claims),
    homeShelf(),
    myList(session.claims),
  ]);
  const name = profile.kind === "ready" ? profile.name : null;
  const started = watching.kind === "ready" ? watching.courses : [];


  return (
    <>
      <StudentNav current={ROUTES.home} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-10 pt-8 pb-24 outline-none sm:pb-16">
        <div className="flex flex-col gap-1 px-4 sm:px-8">
          <h1 className="text-h1">{name === null ? text.greetingAnonymous : t(text.greeting, { name })}</h1>
          {email !== null && <p className="text-body-s text-text-3">{t(messages.account.home.signedInAs, { email })}</p>}
        </div>

        {shelf.kind === "unavailable" && (
          <div className="px-4 sm:px-8">
            <InlineAlert tone="warning" action={<Button href={ROUTES.home} variant="secondary">{text.retry}</Button>}>
              {text.unavailable}
            </InlineAlert>
          </div>
        )}

        {started.length > 0 && (
          <Carousel id="continuar-viendo" title={text.continueTitle}>
            {started.map((course) => {
              const href = lessonPath(course.courseSlug, course.lesson.id);
              if (href === null) return null;
              const practice = shelf.kind === "ready" ? (shelf.shelf.practiceOf.get(course.courseSlug) ?? null) : null;
              return (
                <CourseCard
                  key={course.courseSlug}
                  href={href}
                  title={course.courseTitle}
                  teacherName={course.teacherName}
                  practice={practice}
                  levelName={null}
                  lessonCount={course.total}
                  progress={{ completed: course.completed, total: course.total, lessonNumber: course.lesson.number }}
                />
              );
            })}
          </Carousel>
        )}

        {shelf.kind === "ready" && shelf.shelf.newest.length === 0 && (
          <p className="px-4 text-body-l text-text-2 sm:px-8">{text.empty}</p>
        )}

        {shelf.kind === "ready" && (
          <>
            {/* «Para empezar» es para quien no ha empezado nada: si no se supo, no se sabe (PA-20). */}
            {watching.kind === "ready" && started.length === 0 && shelf.shelf.starters.length > 0 && (
              <Carousel
                id="para-empezar"
                title={text.startersTitle}
                action={shelf.shelf.starters[0]?.level && <SeeAll href={explorePath({ level: shelf.shelf.starters[0].level.slug })} row={text.startersTitle} />}
              >
                {shelf.shelf.starters.map(courseCard)}
              </Carousel>
            )}
            {saved.kind === "ready" && (
              <MyListBlock
                id={MY_LIST_ID}
                action={homeListAction}
                permalink={`${ROUTES.home}#${MY_LIST_ID}`}
                courses={saved.courses.flatMap((course) => {
                  const href = coursePath(course.slug);
                  return href === null
                    ? []
                    : [
                        {
                          slug: course.slug,
                          href,
                          title: course.title,
                          teacherName: course.teacherName,
                          practice: course.practice,
                          levelName: course.level?.name ?? null,
                          lessonCount: course.lessonCount,
                          isOpen: course.isOpen,
                        },
                      ];
                })}
              />
            )}
            {shelf.shelf.newest.length > 0 && (
              <Carousel id="nuevos" title={text.newestTitle}>
                {shelf.shelf.newest.map(courseCard)}
              </Carousel>
            )}
            {shelf.shelf.practices.map((row) => (
              <Carousel key={row.slug} id={`practica-${row.slug}`} title={row.name} action={<SeeAll href={explorePath({ practice: row.slug })} row={row.name} />}>
                {row.courses.map(courseCard)}
              </Carousel>
            ))}
            {shelf.shelf.teachers.length > 0 && (
              <Carousel id="por-maestro" title={t(text.teachersTitle)} shape="tall">
                {shelf.shelf.teachers.map((teacher) => {
                  const href = teacherPath(teacher.slug);
                  if (href === null) return null;
                  return <TeacherCard key={teacher.slug} href={href} name={teacher.name} practices={teacher.practices} tone={teacher.tone} />;
                })}
              </Carousel>
            )}
          </>
        )}

        <form action={signOutAction} className="px-4 sm:px-8">
          <Button type="submit" variant="text">
            {messages.account.common.signOut}
          </Button>
        </form>
      </main>
    </>
  );
}
