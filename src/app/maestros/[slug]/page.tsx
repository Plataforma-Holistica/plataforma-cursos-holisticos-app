import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";

import { StudentNav } from "@/app/_catalog/nav";
import { studentNavFor } from "@/app/_catalog/nav-facts";
import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { publicViewer } from "@/app/_lib/guard";
import { PublicFooter } from "@/app/_public/footer";
import { PublicHeader } from "@/app/_public/header";
import { messages, t } from "@/messages";
import { coursePath, ROUTES, teacherPath } from "@/services/account/navigation";
import { teacherPage } from "@/services/browse/browse";
import { CourseCard } from "@/ui/course-card";
import { toneClasses } from "@/ui/course-cover";
import { cx } from "@/ui/cx";
import { Filigree } from "@/ui/flower";
import { practicePhoto } from "@/ui/photos/choice";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// La ficha de un maestro (PA-03; RF-303; T-210). Pública, y la misma para todos; solo pregunta
// quién mira, para darle al alumno su barra (y al visitante la del sitio público, T-614). Sin retrato (los
// carga contenido en PA-66), la foto de ambiente de su primera práctica (T-614, parte 4); sin práctica, la
// inicial sobre el tono neutro. Debajo, sus cursos listados, los más nuevos
// primero, en una cuadrícula: con pocos cursos, una fila fija se lee mejor que un carrusel
// (PA-03). Un maestro sin cursos listados, o que no está listado, no existe (PA-19). «Suscribirme» del visitante espera a la pantalla de
// planes (T-30x).

const text = messages.browse.teacher;

/** El nombre del maestro en la pestaña. La lectura es la misma de la página, y se recuerda. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const found = await teacherPage((await params).slug);
  return { title: found.kind === "found" ? found.teacher.name : t(text.pageTitle) };
}

export default async function TeacherRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [viewer, found] = await Promise.all([publicViewer(), teacherPage(slug)]);
  if (found.kind === "not_found") notFound();
  if (found.kind === "unavailable") return <UnavailableScreen retryHref={teacherPath(slug) ?? ROUTES.landing} withSession={viewer.kind === "student"} />;
  const { teacher, courses } = found;
  const initial = [...teacher.name.trim()][0]?.toUpperCase() ?? "";
  const photo = practicePhoto(teacher.practicePosition);
  // La barra, solo al alumno: después de saber quién mira (la ficha se recuerda 30 s).
  const nav = viewer.kind === "student" ? await studentNavFor(viewer.claims) : null;

  return (
    <>
      {nav !== null && <StudentNav {...nav} />}
      {/* Al visitante, la barra y el pie del sitio público (T-614, parte 4). */}
      {viewer.kind === "visitor" && <PublicHeader />}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={cx("mx-auto flex max-w-page flex-col gap-12 px-4 outline-none sm:px-8", viewer.kind === "student" ? "pb-24 sm:pb-16" : "pb-16")}>
        {/* T-616, solicitud 3 (el lenguaje del sistema visual; decisión mía sin confirmar): a todo lo ancho, con el resplandor y la
            filigrana detrás (la foto ya va en el retrato), y sus prácticas de antetítulo, en oro pleno sobre el resplandor. */}
        <header className="relative isolate -mx-4 overflow-hidden px-4 pt-8 pb-4 sm:-mx-8 sm:px-8 sm:pt-12">
          <span aria-hidden="true" className="absolute inset-0 -z-10 glow-header" />
          <Filigree className="absolute -top-40 -right-36 -z-10 size-112 sm:-top-56 sm:right-0 sm:size-160" />
          <div className="grid gap-6 sm:grid-cols-12 sm:items-end sm:gap-10">
            <div
              aria-hidden="true"
              className={cx(
                "@container relative flex aspect-2/3 max-h-96 items-center justify-center overflow-hidden rounded-lg bg-linear-to-t edge-light shadow-raised sm:col-span-4 lg:col-span-3",
                toneClasses(teacher.tone),
              )}
            >
              {photo === null ? (
                <span className="font-display text-cover-initial text-text">{initial}</span>
              ) : (
                <Image src={photo} alt="" fill sizes="(min-width: 1024px) 336px, (min-width: 640px) 33vw, 100vw" className="object-cover" />
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-4 sm:col-span-8 lg:col-span-9">
              {teacher.practices.length > 0 && <p className="eyebrow text-accent">{teacher.practices.join(" · ")}</p>}
              <h1 className="text-display-l wrap-break-word">{teacher.name}</h1>
              {teacher.bio !== null && <p className="max-w-reading text-body-l text-text-2">{teacher.bio}</p>}
            </div>
          </div>
        </header>

        <section aria-labelledby="cursos-del-maestro" className="flex flex-col gap-4">
          <h2 id="cursos-del-maestro" className="text-h2">
            {t(text.courses, { name: teacher.name })}
          </h2>
          {/* La rejilla de explorar: dos, tres y cinco columnas (T-616, solicitud 3); a tres en computadora, los carteles medían más
              de 500 px de alto. */}
          <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
            {courses.map((course) => {
              const href = coursePath(course.slug);
              if (href === null) return null;
              return (
                <li key={course.slug}>
                  <CourseCard
                    courseKey={course.slug}
                    href={href}
                    title={course.title}
                    teacherName={course.teacherName}
                    practice={course.practice}
                    levelName={course.level?.name ?? null}
                    lessonCount={course.lessonCount}
                    isOpen={course.isOpen}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      </main>
      {viewer.kind === "visitor" && <PublicFooter />}
    </>
  );
}
