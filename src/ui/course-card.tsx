import Link from "next/link";
import type { ReactNode } from "react";

import { plural, t } from "@/messages/format";
import { ui } from "@/messages/es/ui";

import { CourseArt } from "./course-cover";
import { cx } from "./cx";
import { Rosette } from "./flower";

// Tarjeta de curso (`CourseCard`, diseño, sección 5.3; T-210): la portada y, debajo, el título, el
// maestro y una línea con la práctica, el nivel y cuántas lecciones. Variantes: estándar, con progreso
// (la de «continuar viendo») y con aviso de curso abierto.
//
// Toda la tarjeta es un solo enlace, y su nombre va entero en un texto que solo se lee: lo
// visible queda fuera del árbol de accesibilidad, como en la fila de lección. Por eso lo que dice
// la barra de avance (cuántas van) va también en el nombre.
//
// Desde T-616 (segunda vuelta del prototipo; decisión del carril A sin confirmar, que cambia el 03 §5.3):
// - la portada es la «arte» (`CourseArt`), un cartel con el título dentro (tercera vuelta): debajo de la tarjeta
//   van solo el maestro y la línea de datos. Vertical 4:5 en las filas y la rejilla, 16:9 en la destacada (`shape`);
// - con avance, la barra en oro sobre la portada y, en la línea de abajo, la roseta de la flor de la vida (en
//   trazo a medias, en oro al terminar) junto a «Lección N de M»: así la esquina queda libre para `corner`;
// - la portada se siembra con el curso (`courseKey`, o su título), no con el enlace: el mismo curso se ve igual
//   en la ficha y en «Continuar viendo», que enlaza a la lección;
// - `corner` es lo que va sobre la esquina de la portada, fuera del enlace (un botón dentro de un enlace no
//   vale): «Guardar en mi lista» como botón de icono. Va como hermano del enlace, encima de la portada;
// - al pasar el cursor la portada sube 4 px y su borde de luz aclara; con movimiento reducido no sube.

export interface CourseCardProps {
  href: string;
  title: string;
  teacherName: string;
  /** El orden en el catálogo (`position`), o si no el `slug`, elige el motivo de la portada (motifs.tsx). */
  practice: { name: string; tone: number; slug?: string; position?: number } | null;
  levelName: string | null;
  lessonCount: number;
  isOpen?: boolean;
  /** La de «continuar viendo»: cuántas terminó y la lección sugerida. */
  progress?: { completed: number; total: number; lessonNumber: number };
  shape?: "portrait" | "wide";
  /** Lo que va sobre la esquina de la portada, fuera del enlace. */
  corner?: ReactNode;
  /** El curso (su slug): siembra la portada. Sin él, el título. Nunca el enlace, que cambia según a dónde lleva. */
  courseKey?: string;
  className?: string;
}

export function CourseCard({
  href,
  title,
  teacherName,
  practice,
  levelName,
  lessonCount,
  isOpen = false,
  progress,
  shape = "portrait",
  corner,
  courseKey,
  className,
}: CourseCardProps) {
  const text = ui.courseCard;
  const name =
    progress === undefined
      ? t(text.name, { title, teacher: teacherName })
      : t(text.nameWithProgress, {
          title,
          teacher: teacherName,
          number: progress.lessonNumber,
          total: progress.total,
          completed: t(plural(progress.total, text.completedOf), { completed: Math.min(progress.completed, progress.total), total: progress.total }),
        });
  const meta = [practice?.name, levelName, t(plural(lessonCount, text.lessons), { count: lessonCount })].filter(
    (part): part is string => typeof part === "string",
  );
  return (
    <div className={cx("group relative", className)}>
      <Link href={href} className="flex flex-col gap-4 rounded-lg outline-offset-4">
        <span className="sr-only">{name}</span>
        <span
          aria-hidden="true"
          className="relative block overflow-hidden rounded-lg edge-light shadow-raised transition duration-(--duration-base) ease-standard group-hover:edge-bright motion-safe:group-hover:-translate-y-1"
        >
          <CourseArt
            title={title}
            practiceName={practice?.name ?? null}
            practiceKey={practice?.position ?? practice?.slug ?? practice?.name ?? null}
            tone={practice?.tone ?? null}
            seed={courseKey ?? title}
            shape={shape}
            corner={corner !== undefined}
            badge={isOpen ? <span className="rounded-sm bg-bg px-2 py-1 text-label text-text uppercase">{text.open}</span> : undefined}
          />
          {progress !== undefined && (
            <progress
              value={Math.min(progress.completed, progress.total)}
              max={Math.max(progress.total, 1)}
              className="progress-bar progress-bar-thin absolute right-0 bottom-0 left-0 w-full"
            />
          )}
        </span>
        <span aria-hidden="true" className="flex flex-col gap-1">
          <span className="text-body text-text-2">{teacherName}</span>
          {progress === undefined ? (
            <span className="text-body-s text-text-3">{meta.join(" · ")}</span>
          ) : (
            <span className="flex items-center gap-2 text-body-s text-text-3">
              <Rosette complete={progress.completed >= progress.total} className="size-5" />
              {t(text.lessonOf, { number: progress.lessonNumber, total: progress.total })}
            </span>
          )}
        </span>
      </Link>
      {/* Sube con la portada al pasar el cursor, para no quedar desfasada. */}
      {corner !== undefined && (
        <div className="absolute top-2 right-2 transition duration-(--duration-base) ease-standard motion-safe:group-hover:-translate-y-1">{corner}</div>
      )}
    </div>
  );
}
