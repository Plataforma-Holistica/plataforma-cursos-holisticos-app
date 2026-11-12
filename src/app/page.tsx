import Image from "next/image";

import { PublicFooter } from "@/app/_public/footer";
import { PublicHeader } from "@/app/_public/header";
import { visitorOnly } from "@/app/_lib/guard";
import { messages } from "@/messages";
import { coursePath, ROUTES, teacherPath } from "@/services/account/navigation";
import { homeShelf, type ShelfCourse } from "@/services/browse/browse";
import { Button } from "@/ui/button";
import { Carousel } from "@/ui/carousel";
import { CourseCard } from "@/ui/course-card";
import { CourseCover } from "@/ui/course-cover";
import { FlowerMark } from "@/ui/flower";
import { InlineAlert } from "@/ui/inline-alert";
import portada from "@/ui/photos/portada-muelle.jpg";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TeacherCard } from "@/ui/teacher-card";
import { TextLink } from "@/ui/text-link";

// La portada pública (PA-01; T-614, parte 2, solo lo visual: lo indexable sigue en T-606). Quien tiene
// sesión se va a su inicio (`visitorOnly`). De arriba abajo: la barra, el encabezado con la foto de la
// portada y su velo, una muestra del catálogo, el curso abierto si lo hay, quienes enseñan, «Cómo
// funciona» y el pie.
//
// Decisiones de Sergio del 2026-11-05: el encabezado lleva solo la foto (las portadas de los cursos van
// en la muestra, justo abajo); el botón principal dice «Crear cuenta» y lleva al registro hasta que
// existan los planes; sin precio ni preguntas frecuentes hasta que existan sus pantallas. Decisiones mías
// sin confirmar: la muestra son los cursos listados más nuevos (no hay todavía una selección de
// Contenido), sin «Ver todo» (explorar pide sesión), y quienes enseñan son los maestros con cursos
// listados.
//
// La foto es la única de la página que carga con prioridad: es la que mide RNF-02. Va con
// `loading="eager"` y `fetchPriority="high"`, lo que la documentación de Next 16 recomienda en vez de
// `preload` (`priority` está en desuso). El velo va del fondo más ligero arriba al fondo entero abajo,
// para que la foto se funda con la página. Foto, velo y texto se apilan por su orden, sin capas.

const text = messages.landing;

const OPEN_ID = "curso-abierto";
const HOW_ID = "como-funciona";

const HOW = [text.how.catalog, text.how.lessons, text.how.pace] as const;

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

export default async function LandingPage() {
  await visitorOnly();
  const shelf = await homeShelf();
  const ready = shelf.kind === "ready" ? shelf.shelf : null;
  const open = ready?.open ?? null;
  const openHref = open === null ? null : coursePath(open.slug);

  return (
    <>
      <PublicHeader overPhoto />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="outline-none">
        {/* Sin nombre de región: lo nombraría el titular, que ya es el de la página. */}
        <div className="relative isolate overflow-hidden">
          <Image src={portada} alt="" fill loading="eager" fetchPriority="high" sizes="100vw" className="object-cover" />
          <span aria-hidden="true" className="absolute inset-0 bg-linear-to-b from-bg/70 via-bg/65 to-bg" />
          <div className="relative mx-auto flex max-w-page flex-col items-start gap-6 px-4 pt-32 pb-20 sm:px-8 sm:pt-44 sm:pb-28">
            {/* El ancho de lectura se mide con la letra del cuerpo: medido en el titular, no lo partiría. */}
            <div className="flex max-w-reading flex-col gap-6">
              {/* La flor de la casa, grande, sobre el titular (T-616, solicitud 4; pedido de Sergio del 2026-11-11:
                  el logotipo, importante en toda página). Decorativa: el nombre ya lo dice la barra. */}
              <span data-testid="portada-flor" aria-hidden="true">
                <FlowerMark className="size-16 sm:size-20" />
              </span>
              <h1 className="text-display-xl text-balance">
                {text.hero.title}
              </h1>
              <p className="text-body-l text-text">{text.hero.lead}</p>
            </div>
            <div className="flex w-full flex-col gap-4 sm:w-auto sm:flex-row sm:items-center sm:gap-6">
              <Button href={ROUTES.signUp}>{text.hero.signUp}</Button>
              {openHref !== null && (
                <TextLink href={openHref} className="inline-flex min-h-touch items-center">
                  {text.hero.openCourse}
                </TextLink>
              )}
            </div>
            <p className="text-body-s text-text sm:hidden">
              {text.hero.haveAccount} <TextLink href={ROUTES.signIn}>{text.hero.signIn}</TextLink>
            </p>
          </div>
        </div>

        <div className="mx-auto flex max-w-page flex-col gap-14 pb-16">
          {shelf.kind === "unavailable" && (
            <div className="px-4 sm:px-8">
              <InlineAlert tone="warning">{text.unavailable}</InlineAlert>
            </div>
          )}

          {ready !== null && ready.newest.length === 0 && <p className="px-4 text-body-l text-text-2 sm:px-8">{text.empty}</p>}

          {ready !== null && ready.newest.length > 0 && (
            <Carousel id="muestra-del-catalogo" title={text.sample.title}>
              {ready.newest.map(courseCard)}
            </Carousel>
          )}

          {open !== null && openHref !== null && (
            <section aria-labelledby={OPEN_ID} className="px-4 sm:px-8">
              <div className="grid gap-6 rounded-md border border-border bg-surface-1 p-6 sm:grid-cols-12 sm:items-center sm:gap-8">
                <CourseCover
                  title={open.title}
                  teacherName={open.teacherName}
                  practiceName={open.practice?.name ?? null}
                  tone={open.practice?.tone ?? null}
                  className="rounded-sm sm:col-span-5"
                />
                <div className="flex flex-col items-start gap-3 sm:col-span-7">
                  <h2 id={OPEN_ID} className="text-label text-accent uppercase">
                    {text.openCourse.label}
                  </h2>
                  <p className="text-h3">{open.title}</p>
                  <p className="text-body text-text-2">{text.openCourse.lead}</p>
                  <Button href={openHref} variant="secondary">
                    {text.openCourse.action}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {ready !== null && ready.teachers.length > 0 && (
            <Carousel id="quienes-ensenan" title={text.teachers.title} shape="tall">
              {ready.teachers.map((teacher) => {
                const href = teacherPath(teacher.slug);
                if (href === null) return null;
                return <TeacherCard key={teacher.slug} href={href} name={teacher.name} practices={teacher.practices} tone={teacher.tone} practicePosition={teacher.practicePosition} />;
              })}
            </Carousel>
          )}

          <section aria-labelledby={HOW_ID} className="flex flex-col gap-6 px-4 sm:px-8">
            <h2 id={HOW_ID} className="text-h2">
              {text.how.title}
            </h2>
            <ol className="grid gap-6 sm:grid-cols-3">
              {HOW.map((point) => (
                <li key={point.title} className="flex flex-col gap-2 border-t border-border pt-4">
                  <p className="text-h3">{point.title}</p>
                  <p className="text-body text-text-2">{point.body}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
