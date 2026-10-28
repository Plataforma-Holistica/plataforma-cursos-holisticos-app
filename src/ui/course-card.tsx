import Link from "next/link";

import { plural, t } from "@/messages/format";
import { ui } from "@/messages/es/ui";

import { CourseCover } from "./course-cover";
import { cx } from "./cx";

// Tarjeta de curso (`CourseCard`, diseño, sección 5.3; T-210): la portada generada y, debajo, el
// título, el maestro y una línea con la práctica, el nivel y cuántas lecciones. Variantes de
// esta solicitud: estándar, con progreso (la de «continuar viendo») y con aviso de curso
// abierto. La vista ampliada, la vertical y la de fila llegan después.
//
// Toda la tarjeta es un solo enlace, y su nombre va entero en un texto que solo se lee: lo
// visible queda fuera del árbol de accesibilidad, como en la fila de lección.

export interface CourseCardProps {
  href: string;
  title: string;
  teacherName: string;
  practice: { name: string; tone: number } | null;
  levelName: string | null;
  lessonCount: number;
  isOpen?: boolean;
  /** La de «continuar viendo»: cuántas terminó y la lección sugerida. */
  progress?: { completed: number; total: number; lessonNumber: number };
  className?: string;
}

export function CourseCard({ href, title, teacherName, practice, levelName, lessonCount, isOpen = false, progress, className }: CourseCardProps) {
  const text = ui.courseCard;
  const name =
    progress === undefined
      ? t(text.name, { title, teacher: teacherName })
      : t(text.nameWithProgress, { title, teacher: teacherName, number: progress.lessonNumber, total: progress.total });
  const meta = [practice?.name, levelName, t(plural(lessonCount, text.lessons), { count: lessonCount })].filter(
    (part): part is string => typeof part === "string",
  );
  return (
    <Link
      href={href}
      className={cx(
        "group flex flex-col gap-3 rounded-md outline-offset-4 transition-transform duration-(--duration-fast) ease-standard motion-safe:hover:scale-103",
        className,
      )}
    >
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="relative block overflow-hidden rounded-md group-hover:shadow-raised">
        <CourseCover title={title} teacherName={teacherName} practiceName={practice?.name ?? null} tone={practice?.tone ?? null} />
        {isOpen && (
          <span className="absolute top-2 left-2 rounded-sm bg-bg px-2 py-1 text-label text-text uppercase">{text.open}</span>
        )}
        {progress !== undefined && (
          <progress
            value={Math.min(progress.completed, progress.total)}
            max={Math.max(progress.total, 1)}
            className="progress-bar progress-bar-thin absolute right-0 bottom-0 left-0 w-full"
          />
        )}
      </span>
      <span aria-hidden="true" className="flex flex-col gap-1">
        <span className="line-clamp-2 text-h3 text-text">{title}</span>
        <span className="text-body-s text-text-2">{teacherName}</span>
        <span className="text-caption text-text-3">
          {progress === undefined ? meta.join(" · ") : t(text.lessonOf, { number: progress.lessonNumber, total: progress.total })}
        </span>
      </span>
    </Link>
  );
}
