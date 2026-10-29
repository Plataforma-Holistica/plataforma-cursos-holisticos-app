import type { Metadata } from "next";
import { X } from "lucide";
import Link from "next/link";

import { exploreListAction } from "@/app/_catalog/my-list/actions";
import { SaveCourseButton } from "@/app/_catalog/my-list/save-button";
import { StudentNav } from "@/app/_catalog/nav";
import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { requireSession } from "@/app/_lib/guard";
import { messages, plural, t } from "@/messages";
import { coursePath, explorePath, ROUTES, teacherPath } from "@/services/account/navigation";
import { explore, exploreQueryOf, myList, type ExploreQuery, type ShelfCourse } from "@/services/browse/browse";
import { Button } from "@/ui/button";
import { Carousel } from "@/ui/carousel";
import { CourseCard } from "@/ui/course-card";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TeacherCard } from "@/ui/teacher-card";
import { TextLink } from "@/ui/text-link";

import { ExploreForm } from "./explore-form";

// Explorar y buscar (PA-21; RF-304; FL-11; T-210, segunda solicitud). Pide sesión (RF-304). Sin
// filtro ni búsqueda, un carrusel por práctica; con algo pedido, cuántos cursos y la cuadrícula
// (la única de la Plataforma, D-19), y arriba los maestros cuyo nombre coincide con la búsqueda.
// Sin resultados, lo dice, ofrece limpiar los filtros y muestra «Nuevos» debajo. Los filtros y la
// búsqueda viven en la dirección: regresar de una ficha no los pierde.
//
// Bajo cada tarjeta, «Guardar en mi lista» o «Quitar de mi lista» (RF-311; decisión de Sergio del
// 2026-10-28). Si la lista no se pudo leer, no se sabe cuál toca, y las tarjetas van sin botón.
// Sin JavaScript el formulario vuelve a explorar con los mismos filtros, en la tarjeta.

const text = messages.browse.explore;

export const metadata: Metadata = { title: text.pageTitle };

/** Lo que hace falta para el botón de Mi lista: qué está guardado, y a dónde vuelve. Nulo si no se supo. */
type Saving = { saved: ReadonlySet<string>; shownPath: string } | null;

/** El ancla de la tarjeta de un curso: ahí vuelve su formulario sin JavaScript. */
const cardAnchor = (slug: string) => `bloque-explorar-${slug}`;

function courseCard(course: ShelfCourse, saving: Saving) {
  const href = coursePath(course.slug);
  if (href === null) return null;
  const card = (
    <CourseCard
      href={href}
      title={course.title}
      teacherName={course.teacherName}
      practice={course.practice}
      levelName={course.level?.name ?? null}
      lessonCount={course.lessonCount}
      isOpen={course.isOpen}
    />
  );
  if (saving === null) return <div key={course.slug}>{card}</div>;
  return (
    <div key={course.slug} id={cardAnchor(course.slug)} className="flex flex-col gap-3">
      {card}
      {/* Con otros filtros, otro botón: lo que contestó el anterior (un aviso de error) no se queda. */}
      <SaveCourseButton
        key={saving.shownPath}
        action={exploreListAction}
        slug={course.slug}
        title={course.title}
        saved={saving.saved.has(course.slug)}
        permalink={`${saving.shownPath}#${cardAnchor(course.slug)}`}
      />
    </div>
  );
}

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const asked = exploreQueryOf(await searchParams);
  const session = await requireSession(explorePath(asked));
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={explorePath(asked)} withSession />;

  const [answer, saved] = await Promise.all([explore(asked), myList(session.claims)]);

  return (
    <>
      <StudentNav current={ROUTES.explore} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-8 pt-6 pb-24 outline-none sm:pt-8 sm:pb-16">
        <h1 className="px-4 text-h1 sm:px-8">{text.heading}</h1>
        {answer.kind === "unavailable" ? (
          <div className="px-4 sm:px-8">
            <InlineAlert tone="warning" action={<Button href={explorePath(asked)} variant="secondary">{text.retry}</Button>}>
              {text.unavailable}
            </InlineAlert>
          </div>
        ) : (
          <Explore answer={answer} saved={saved.kind === "ready" ? new Set(saved.courses.map((course) => course.slug)) : null} />
        )}
      </main>
    </>
  );
}

type Ready = Extract<Awaited<ReturnType<typeof explore>>, { kind: "ready" }>;

function Explore({ answer, saved }: { answer: Ready; saved: ReadonlySet<string> | null }) {
  const { query, facets, results, shelf } = answer;
  const saving: Saving = saved === null ? null : { saved, shownPath: explorePath(query) };
  const card = (course: ShelfCourse) => courseCard(course, saving);
  const chips = activeFilters(query, facets);
  const hasFilters = chips.length > 0;

  const count = results === null ? null : t(plural(results.courses.length, text.count), { count: results.courses.length });

  return (
    <>
      <ExploreForm
        action={ROUTES.explore}
        query={query}
        shownPath={explorePath(query)}
        withoutSearch={explorePath({ ...query, q: null })}
        practices={facets.practices}
        teachers={facets.teachers}
        levels={facets.levels}
      />
      {/* Existe desde antes de la primera búsqueda: una región que aparece ya con texto no siempre se anuncia. */}
      <p role="status" className="sr-only">
        {count}
      </p>
      {hasFilters && (
        <div className="px-4 sm:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="sr-only">{text.activeFilters}</h2>
            <ul className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <li key={chip.param}>
                  <Link
                    href={chip.without}
                    replace
                    scroll={false}
                    className="inline-flex min-h-touch items-center gap-2 rounded-sm bg-accent-subtle px-3 text-body-s text-text hover:bg-surface-2"
                  >
                    <span className="sr-only">{t(text.removeFilter, { name: chip.name })}</span>
                    <span aria-hidden="true">{chip.name}</span>
                    <Icon icon={X} size={16} />
                  </Link>
                </li>
              ))}
            </ul>
            <TextLink href={explorePath({ q: query.q })}>{text.clearFilters}</TextLink>
          </div>
        </div>
      )}

      {results === null ? (
        shelf.practices.length === 0 ? (
          <p className="px-4 text-body-l text-text-2 sm:px-8">{messages.browse.home.empty}</p>
        ) : (
          shelf.practices.map((row) => (
          <Carousel
            key={row.slug}
            id={`practica-${row.slug}`}
            title={row.name}
            action={<SeeAll href={explorePath({ practice: row.slug })} row={row.name} />}
          >
            {row.courses.map(card)}
          </Carousel>
          ))
        )
      ) : (
        <>
          {results.teachers.length > 0 && (
            <Carousel id="maestros" title={t(text.teachersTitle)} shape="tall">
              {results.teachers.map((teacher) => {
                const href = teacherPath(teacher.slug);
                if (href === null) return null;
                return <TeacherCard key={teacher.slug} href={href} name={teacher.name} practices={teacher.practices} tone={teacher.tone} />;
              })}
            </Carousel>
          )}
          <section aria-labelledby="resultados" className="flex flex-col gap-4 px-4 sm:px-8">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="resultados" className="text-h2">
                {text.resultsTitle}
              </h2>
              <p aria-hidden="true" className="text-body-s text-text-2">
                {count}
              </p>
            </div>
            {results.courses.length > 0 ? (
              <ul aria-labelledby="resultados" className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
                {results.courses.map((course) => (
                  <li key={course.slug} className="relative min-w-0">
                    {card(course)}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-start gap-4 rounded-md bg-surface-1 p-6">
                <p className="text-body-l text-text">{text.empty}</p>
                {hasFilters ? (
                  <Button href={explorePath({ q: query.q })} variant="secondary">
                    {text.clearFilters}
                  </Button>
                ) : (
                  <Button href={explorePath()} variant="secondary">
                    {text.clearSearch}
                  </Button>
                )}
              </div>
            )}
          </section>
          {results.courses.length === 0 && shelf.newest.length > 0 && (
            <Carousel id="seleccion" title={text.selectionTitle}>
              {shelf.newest.map(card)}
            </Carousel>
          )}
        </>
      )}
    </>
  );
}

function SeeAll({ href, row }: { href: string; row: string }) {
  return (
    <TextLink href={href}>
      <span aria-hidden="true">{messages.browse.home.seeAll}</span>
      <span className="sr-only">{t(messages.browse.home.seeAllOf, { row })}</span>
    </TextLink>
  );
}

/** Las etiquetas de los filtros activos, cada una con la dirección sin ella. */
function activeFilters(query: ExploreQuery, facets: Ready["facets"]) {
  const name = (slug: string | null, options: readonly { slug: string; name: string }[]) => options.find((option) => option.slug === slug)?.name;
  const chips: { param: string; name: string; without: string }[] = [];
  const practice = name(query.practice, facets.practices);
  if (practice !== undefined) chips.push({ param: "practica", name: practice, without: explorePath({ ...query, practice: null }) });
  const teacher = name(query.teacher, facets.teachers);
  if (teacher !== undefined) chips.push({ param: "maestro", name: teacher, without: explorePath({ ...query, teacher: null }) });
  const level = name(query.level, facets.levels);
  if (level !== undefined) chips.push({ param: "nivel", name: level, without: explorePath({ ...query, level: null }) });
  return chips;
}
