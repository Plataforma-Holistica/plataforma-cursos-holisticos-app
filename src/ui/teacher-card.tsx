import Image from "next/image";
import Link from "next/link";

import { t } from "@/messages/format";
import { ui } from "@/messages/es/ui";

import { toneClasses } from "./course-cover";
import { cx } from "./cx";
import { practicePhoto } from "./photos/choice";

// Tarjeta de maestro (`TeacherCard`, diseño, sección 5.3; T-210), vertical 2:3 para el carrusel
// «Por maestro». Mientras no haya retratos (PA-66), lleva la foto de ambiente de su primera práctica
// (diseño, sección 3.12; T-614, parte 4), decorativa; sin práctica, la inicial sobre el tono neutro.
// Debajo, el nombre y sus prácticas. Un solo enlace, con su nombre entero en un texto que solo se lee.

export interface TeacherCardProps {
  href: string;
  name: string;
  practices: readonly string[];
  tone: number | null;
  /** El orden en el catálogo de su primera práctica: elige su foto (`practicePhoto`). */
  practicePosition: number | null;
  /** Desde T-616 (segunda vuelta; decisión del carril A sin confirmar, que cambia el 03 §4.3): `round`, el retrato en un círculo con un anillo fino de oro apagado, para la banda «Por maestro» del inicio. */
  shape?: "portrait" | "round";
  className?: string;
}

export function TeacherCard({ href, name, practices, tone, practicePosition, shape = "portrait", className }: TeacherCardProps) {
  const text = ui.teacherCard;
  const label = practices.length > 0 ? t(text.name, { name, practices: practices.join(", ") }) : t(text.nameWithoutPractices, { name });
  const initial = [...name.trim()][0]?.toUpperCase() ?? "";
  const photo = practicePhoto(practicePosition);
  if (shape === "round") {
    return (
      <Link href={href} className={cx("group flex flex-col items-center gap-4 rounded-lg p-2 text-center outline-offset-4", className)}>
        <span className="sr-only">{label}</span>
        <span
          aria-hidden="true"
          className={cx(
            "@container relative flex size-32 items-center justify-center overflow-hidden rounded-full bg-linear-to-t ring-1 ring-accent-muted ring-offset-4 ring-offset-surface-1 transition duration-(--duration-base) ease-standard group-hover:ring-accent motion-safe:group-hover:-translate-y-1 sm:size-36",
            toneClasses(tone),
          )}
        >
          {photo === null ? (
            <span className="font-display text-cover-initial text-text">{initial}</span>
          ) : (
            <Image src={photo} alt="" fill sizes="144px" className="object-cover" />
          )}
        </span>
        <span aria-hidden="true" className="flex flex-col gap-1">
          <span className="font-display text-h3 text-text">{name}</span>
          {practices.length > 0 && <span className="text-caption text-text-2">{practices.join(" · ")}</span>}
        </span>
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className={cx("group flex flex-col gap-3 rounded-md outline-offset-4 transition-transform duration-(--duration-fast) ease-standard motion-safe:hover:scale-103", className)}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={cx("@container relative flex aspect-2/3 items-center justify-center overflow-hidden rounded-md bg-linear-to-t group-hover:shadow-raised", toneClasses(tone))}
      >
        {photo === null ? (
          <span className="font-display text-cover-initial text-text">{initial}</span>
        ) : (
          <Image src={photo} alt="" fill sizes="(min-width: 640px) 176px, 42vw" className="object-cover" />
        )}
      </span>
      <span aria-hidden="true" className="flex flex-col gap-1">
        <span className="text-h3 text-text">{name}</span>
        {practices.length > 0 && <span className="text-label text-text-2 uppercase">{practices.join(" · ")}</span>}
      </span>
    </Link>
  );
}
