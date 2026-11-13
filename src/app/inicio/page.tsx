import type { Metadata } from "next";
import Link from "next/link";

import { homeListAction } from "@/app/_catalog/my-list/actions";
import { MyListBlock } from "@/app/_catalog/my-list/my-list-block";
import { StudentNav } from "@/app/_catalog/nav";
import { studentNavFor } from "@/app/_catalog/nav-facts";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireSession } from "@/app/_lib/guard";
import { PRODUCT_TIME_ZONE } from "@/app/_lib/dates";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, plural, t } from "@/messages";
import { accountProfile } from "@/services/account/account";
import { coursePath, explorePath, lessonPath, MY_LIST_ANCHOR, ROUTES, teacherPath } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { homeShelf, myList, type PracticeRow, type ShelfCourse } from "@/services/browse/browse";
import { ROW_LIMIT } from "@/services/browse/shelf";
import type { ContinueCourse } from "@/services/progress/continue";
import { continueWatching } from "@/services/progress/progress";
import { Button } from "@/ui/button";
import { Carousel } from "@/ui/carousel";
import { CourseCard } from "@/ui/course-card";
import { CourseArt } from "@/ui/course-cover";
import { FlowerState } from "@/ui/flower-state";
import { InlineAlert } from "@/ui/inline-alert";
import { PageHeader } from "@/ui/page-header";
import { HOME_HEADER_PHOTO } from "@/ui/photos/choice";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TeacherCard } from "@/ui/teacher-card";
import { TextLink } from "@/ui/text-link";

import { Feature, type FeaturePractice, type FeatureRow } from "./feature";

// El inicio del alumno (PA-20; RF-301; FL-10; T-210). De arriba abajo: el saludo, el protagonista («Continuar viendo», o
// «Para empezar» para quien no ha empezado nada), «Mi lista», «Nuevos», las prácticas y «Por maestro». Con el catálogo
// vacío, el estado vacío en lugar de todo eso.
//
// Bajo el saludo sigue diciendo con qué correo se entró: le avisa a alguien que completó una cuenta desde un enlace que le
// mandó otra persona, y cuyo buzón no controla (TRD §9.2). El menú de la persona en la barra lo repite, y lleva «Cerrar
// sesión» (T-616). «Ver todo» de «Para empezar» lleva a explorar con su nivel. «Nuevos» no lo lleva: explorar no ordena
// por otra cosa que lo más nuevo (decisión mía sin confirmar, 2026-10-28).
//
// «Mi lista» (RF-311, tercera solicitud de T-210) va después del protagonista y antes de «Nuevos», solo si tiene algo. Si
// no se pudo leer, no se pinta (el servicio lo reporta). El bloque está siempre, vacío o no: su región dice «Quitado de tu
// lista» aunque se haya quitado el último.
//
// T-616, solicitud 3 (lo decidido en el prototipo de la dirección, del carril A; decisiones sin confirmar):
// - la cabecera alta de la casa (`PageHeader`), con las estrellas siempre (ya no alterna con el faro) y la fecha de
//   antetítulo, que se pinta en el servidor, a la hora de la Ciudad de México: un componente de servidor no se vuelve a
//   pintar en el navegador, y la página es dinámica por la sesión;
// - el protagonista (`feature.tsx`), con los demás en filas compactas;
// - las prácticas como fichas que llevan a explorar con su filtro, en vez de un carrusel por práctica;
// - «Por maestro» sin caja, en la rejilla, con retratos redondos de 120 px;
// - 96 px fijos entre bloques (64 en el teléfono). El aire va arriba de cada bloque y no en un `gap`: el bloque de «Mi
//   lista» está siempre, también vacío, y con un `gap` sumaba otro hueco entero aunque no se viera.

const text = messages.browse.home;

/** El bloque de «Mi lista»: el ancla a la que vuelve su formulario sin JavaScript, y a la que lleva la barra. */
const MY_LIST_ID = MY_LIST_ANCHOR;

/** El aire arriba de cada bloque. */
const BLOCK = "mt-16 sm:mt-24";

export const metadata: Metadata = { title: text.pageTitle };

const DATE = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: PRODUCT_TIME_ZONE });

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
      courseKey={course.slug}
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

const card = messages.ui.courseCard;

/** Un curso empezado, como fila del protagonista. Nulo si su dirección no sirve. */
function watchingRow(course: ContinueCourse, practice: FeaturePractice | null): FeatureRow | null {
  const href = lessonPath(course.courseSlug, course.lesson.id);
  if (href === null) return null;
  const completed = Math.min(course.completed, course.total);
  return {
    courseKey: course.courseSlug,
    href,
    name: t(card.nameWithProgress, {
      title: course.courseTitle,
      teacher: course.teacherName,
      number: course.lesson.number,
      total: course.total,
      completed: t(plural(course.total, card.completedOf), { completed, total: course.total }),
    }),
    title: course.courseTitle,
    line: t(card.lessonOf, { number: course.lesson.number, total: course.total }),
    practice,
    progress: { completed: course.completed, total: course.total },
  };
}

/** Un curso para empezar, como fila del protagonista. Nulo si su dirección no sirve. */
function starterRow(course: ShelfCourse): FeatureRow | null {
  const href = coursePath(course.slug);
  if (href === null) return null;
  return {
    courseKey: course.slug,
    href,
    name: t(card.name, { title: course.title, teacher: course.teacherName }),
    title: course.title,
    line: [course.teacherName, course.level?.name].filter((part): part is string => typeof part === "string").join(" · "),
    practice: course.practice,
    progress: null,
  };
}

export default async function HomePage() {
  const session = await requireSession(ROUTES.home);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.home} withSession />;

  const [nav, profile, watching, shelf, saved] = await Promise.all([
    studentNavFor(session.claims),
    accountProfile(session.claims),
    continueWatching(session.claims),
    homeShelf(),
    myList(session.claims),
  ]);
  const { email } = nav;
  const name = profile.kind === "ready" ? profile.name : null;
  const started = watching.kind === "ready" ? watching.courses : [];
  const invitationGone = readNotice(await cookieReader()) === "teacher_invitation_gone";

  // La práctica de cada curso, con su orden en el catálogo, para el motivo de su portada (nota del carril A de la 142):
  // «continuar viendo» no la trae, y `practiceOf` solo da el nombre y el tono.
  const practiceOf = new Map<string, FeaturePractice | null>();
  if (shelf.kind === "ready") {
    for (const [slug, practice] of shelf.shelf.practiceOf) practiceOf.set(slug, practice);
    for (const course of [...shelf.shelf.newest, ...shelf.shelf.starters, ...shelf.shelf.practices.flatMap((row) => row.courses)]) {
      practiceOf.set(course.slug, course.practice);
    }
  }

  // El protagonista: lo más reciente que se está viendo, o el primero de «Para empezar» si se supo que no hay nada empezado.
  const watchingRows = started.flatMap((course) => watchingRow(course, practiceOf.get(course.courseSlug) ?? null) ?? []);
  const starters = shelf.kind === "ready" && watching.kind === "ready" && started.length === 0 ? shelf.shelf.starters : [];
  const starterRows = starters.flatMap((course) => starterRow(course) ?? []);
  const [current, ...moreWatching] = watchingRows;
  const [firstStarter, ...moreStarters] = starterRows;
  const currentCourse = started.find((course) => course.courseSlug === current?.courseKey);
  const firstStarterCourse = starters.find((course) => course.slug === firstStarter?.courseKey);

  return (
    <>
      <StudentNav current={ROUTES.home} {...nav} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col pb-24 outline-none sm:pb-16">
        <PageHeader size="hero" photo={HOME_HEADER_PHOTO} eyebrow={DATE.format(new Date())} title={name === null ? text.greetingAnonymous : t(text.greeting, { name })}>
          {/* Con qué cuenta se entró (TRD §9.2): en línea chica, pero a la vista. También va en el menú de la persona. */}
          {email !== null && <p className="text-body-s text-text-2">{t(messages.account.home.signedInAs, { email })}</p>}
        </PageHeader>

        {invitationGone && (
          <div className="mt-8 px-4 sm:px-8">
            <InlineAlert tone="warning">{text.invitationGone}</InlineAlert>
          </div>
        )}

        {shelf.kind === "unavailable" && (
          <div className="mt-8 px-4 sm:px-8">
            <InlineAlert tone="warning" action={<Button href={ROUTES.home} variant="secondary">{text.retry}</Button>}>
              {text.unavailable}
            </InlineAlert>
          </div>
        )}

        {current !== undefined && currentCourse !== undefined && (
          <div className="mt-6 sm:mt-14">
            <Feature
              id="continuar-viendo"
              heading={text.continueTitle}
              lead={{
                ...current,
                teacherName: currentCourse.teacherName,
                progressLine: t(plural(currentCourse.total, messages.browse.course.progress), {
                  completed: Math.min(currentCourse.completed, currentCourse.total),
                  total: currentCourse.total,
                }),
                action: t(messages.browse.course.continue, { number: currentCourse.lesson.number }),
              }}
              rows={moreWatching}
            />
          </div>
        )}

        {shelf.kind === "ready" && shelf.shelf.newest.length === 0 && (
          <FlowerState title={text.empty} className={BLOCK}>
            {text.emptyLead}
          </FlowerState>
        )}

        {shelf.kind === "ready" && (
          <>
            {/* «Para empezar» es para quien no ha empezado nada: si no se supo, no se sabe (PA-20). */}
            {firstStarter !== undefined && firstStarterCourse !== undefined && (
              <div className="mt-6 sm:mt-14">
                <Feature
                  id="para-empezar"
                  heading={text.startersTitle}
                  seeAll={firstStarterCourse.level && <SeeAll href={explorePath({ level: firstStarterCourse.level.slug })} row={text.startersTitle} />}
                  lead={{ ...firstStarter, teacherName: firstStarterCourse.teacherName, progressLine: null, action: text.seeCourse }}
                  rows={moreStarters}
                />
              </div>
            )}
            {saved.kind === "ready" && (
              <MyListBlock
                id={MY_LIST_ID}
                action={homeListAction}
                permalink={`${ROUTES.home}#${MY_LIST_ID}`}
                offset={BLOCK}
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
              <div className={BLOCK}>
                <Carousel id="nuevos" title={text.newestTitle}>
                  {shelf.shelf.newest.map(courseCard)}
                </Carousel>
              </div>
            )}
            {shelf.shelf.practices.length > 0 && <PracticeTiles rows={shelf.shelf.practices} />}
            {shelf.shelf.teachers.length > 0 && (
              <section aria-labelledby="por-maestro" className={`${BLOCK} flex flex-col gap-6 px-4 sm:px-8`}>
                <h2 id="por-maestro" className="text-h2">
                  {t(text.teachersTitle)}
                </h2>
                {/* En el teléfono se desliza (y se desvanece en el borde); desde `sm`, la rejilla. Aire arriba (`pt-3`, devuelto
                    con `-mt-3`), como en `Carousel`: desplazar en horizontal también recorta en vertical, y cortaba el anillo de foco.
                    Y el ajuste a ficha con el margen (`scroll-px-4`): sin él, la primera quedaba pegada al borde. */}
                <ul
                  aria-labelledby="por-maestro"
                  className="-mx-4 -mt-3 flex snap-x scroll-px-4 gap-4 overflow-x-auto px-4 pt-3 pb-2 scrollbar-none max-sm:mask-r-from-85% sm:mx-0 sm:grid sm:grid-cols-4 sm:gap-x-6 sm:gap-y-8 sm:overflow-visible sm:px-0 lg:grid-cols-6"
                >
                  {shelf.shelf.teachers.map((teacher) => {
                    const href = teacherPath(teacher.slug);
                    if (href === null) return null;
                    return (
                      <li key={teacher.slug} className="relative w-36 shrink-0 snap-start sm:w-auto">
                        <TeacherCard
                          href={href}
                          name={teacher.name}
                          practices={teacher.practices}
                          tone={teacher.tone}
                          practicePosition={teacher.practicePosition}
                          shape="round"
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}

/** Las prácticas como fichas, en su orden (PA-67): cada una con su motivo, su nombre y cuántos cursos; lleva a explorar con su filtro. */
function PracticeTiles({ rows }: { rows: readonly PracticeRow[] }) {
  return (
    <section aria-labelledby="practicas" className={`${BLOCK} flex flex-col gap-6 px-4 sm:px-8`}>
      <h2 id="practicas" className="text-h2">
        {text.practicesTitle}
      </h2>
      {/* Aire arriba para el anillo de foco y el ajuste a ficha con el margen, como en «Por maestro». */}
      <ul
        aria-labelledby="practicas"
        className="-mx-4 -mt-3 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pt-3 pb-2 scrollbar-none max-sm:mask-r-from-85% sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-4 xl:grid-cols-6"
      >
        {rows.map((row) => {
          const position = row.courses[0]?.practice?.position ?? null;
          // El catálogo corta cada fila a su tope: una que llega a él puede tener más, y la ficha no dice menos de los que hay.
          const count =
            row.courses.length >= ROW_LIMIT
              ? t(text.practiceCountAtLeast, { count: ROW_LIMIT })
              : t(plural(row.courses.length, text.practiceCount), { count: row.courses.length });
          return (
            <li key={row.slug} className="relative w-44 shrink-0 snap-start sm:w-auto">
              <Link href={explorePath({ practice: row.slug })} className="group relative block overflow-hidden rounded-lg edge-light shadow-raised outline-offset-4 focus-visible:shadow-focus">
                <CourseArt
                  practiceName={null}
                  practiceKey={position ?? row.slug}
                  tone={row.tone}
                  seed={row.slug}
                  shape="wide"
                  largeMotif
                  className="transition duration-(--duration-base) ease-standard group-hover:brightness-110"
                />
                <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/3 bg-linear-to-t from-bg/85 via-bg/40 to-transparent" />
                {/* El nombre entero, en un texto que solo se lee; lo visible, fuera del árbol, como en la tarjeta de curso. */}
                <span className="sr-only">{t(text.practiceTile, { name: row.name, count })}</span>
                <span aria-hidden="true" className="absolute inset-x-0 bottom-0 flex min-w-0 flex-col p-4">
                  <span className="truncate font-display text-h3 text-text">{row.name}</span>
                  <span className="text-caption text-text-2">{count}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
