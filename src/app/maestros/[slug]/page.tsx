import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { messages, t } from "@/messages";
import { coursePath, ROUTES, teacherPath } from "@/services/account/navigation";
import { teacherPage } from "@/services/browse/browse";
import { CourseCard } from "@/ui/course-card";
import { toneClasses } from "@/ui/course-cover";
import { cx } from "@/ui/cx";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// La ficha de un maestro (PA-03; RF-303; T-210). Pública, y la misma para todos: no lee la
// sesión. Sin retrato (los carga contenido en PA-66), la inicial sobre el tono de su primera
// práctica. Debajo, sus cursos listados, los más nuevos primero, en una cuadrícula: con pocos
// cursos, una fila fija se lee mejor que un carrusel (PA-03). Un maestro sin cursos listados, o
// que no está listado, no existe (PA-19). «Suscribirme» del visitante espera a la pantalla de
// planes (T-30x).

const text = messages.browse.teacher;

export const metadata: Metadata = { title: t(text.pageTitle) };

export default async function TeacherRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await teacherPage(slug);
  if (found.kind === "not_found") notFound();
  if (found.kind === "unavailable") return <UnavailableScreen retryHref={teacherPath(slug) ?? ROUTES.landing} withSession={false} />;
  const { teacher, courses } = found;
  const tone = courses.find((course) => course.practice !== null)?.practice?.tone ?? null;
  const initial = [...teacher.name.trim()][0]?.toUpperCase() ?? "";

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-12 px-4 py-8 outline-none sm:px-8">
      <header className="grid gap-6 sm:grid-cols-12 sm:items-end sm:gap-10">
        <div
          aria-hidden="true"
          className={cx("@container flex aspect-2/3 max-h-96 items-center justify-center rounded-md bg-linear-to-t shadow-raised sm:col-span-4 lg:col-span-3", toneClasses(tone))}
        >
          <span className="font-display text-cover-initial text-text">{initial}</span>
        </div>
        <div className="flex flex-col gap-4 sm:col-span-8 lg:col-span-9">
          <h1 className="text-display-l">{teacher.name}</h1>
          {teacher.practices.length > 0 && <p className="text-label text-text-2 uppercase">{teacher.practices.join(" · ")}</p>}
          {teacher.bio !== null && <p className="max-w-reading text-body-l text-text-2">{teacher.bio}</p>}
        </div>
      </header>

      <section aria-labelledby="cursos-del-maestro" className="flex flex-col gap-4">
        <h2 id="cursos-del-maestro" className="text-h2">
          {t(text.courses, { name: teacher.name })}
        </h2>
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => {
            const href = coursePath(course.slug);
            if (href === null) return null;
            return (
              <li key={course.slug}>
                <CourseCard
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
  );
}
