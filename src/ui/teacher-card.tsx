import Link from "next/link";

import { t } from "@/messages/format";
import { ui } from "@/messages/es/ui";

import { toneClasses } from "./course-cover";
import { cx } from "./cx";

// Tarjeta de maestro (`TeacherCard`, diseño, sección 5.3; T-210), vertical 2:3 para el carrusel
// «Por maestro». Mientras no haya retratos (PA-66), lleva la inicial sobre el tono de su primera
// práctica (PA-03, «sin retrato»). Debajo, el nombre y sus prácticas. Un solo enlace, con su
// nombre entero en un texto que solo se lee.

export interface TeacherCardProps {
  href: string;
  name: string;
  practices: readonly string[];
  tone: number | null;
  className?: string;
}

export function TeacherCard({ href, name, practices, tone, className }: TeacherCardProps) {
  const text = ui.teacherCard;
  const label = practices.length > 0 ? t(text.name, { name, practices: practices.join(", ") }) : t(text.nameWithoutPractices, { name });
  const initial = [...name.trim()][0]?.toUpperCase() ?? "";
  return (
    <Link
      href={href}
      className={cx("group flex flex-col gap-3 rounded-md outline-offset-4 transition-transform duration-(--duration-fast) ease-standard motion-safe:hover:scale-103", className)}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className={cx("@container flex aspect-2/3 items-center justify-center overflow-hidden rounded-md bg-linear-to-t group-hover:shadow-raised", toneClasses(tone))}
      >
        <span className="font-display text-cover-initial text-text">{initial}</span>
      </span>
      <span aria-hidden="true" className="flex flex-col gap-1">
        <span className="text-h3 text-text">{name}</span>
        {practices.length > 0 && <span className="text-label text-text-2 uppercase">{practices.join(" · ")}</span>}
      </span>
    </Link>
  );
}
