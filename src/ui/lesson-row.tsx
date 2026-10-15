import { Circle, CirclePlay } from "lucide";
import Link from "next/link";

import { t } from "@/messages/format";
import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { Icon } from "./icon";

// Fila de lección (`LessonRow`, diseño, sección 5.3): una lección dentro del temario (PA-02,
// PA-22). Número, título, duración y estado, y es un enlace. Su nombre va entero en un texto
// que solo se lee, y lo visible queda fuera del árbol de accesibilidad: así no depende de cómo
// junte cada navegador los espacios entre fragmentos. Dice lo mismo que se ve (WCAG 2.5.3):
// «Lección 3, Respiración en cuatro tiempos, 6 min, reproduciendo».
//
// Estados de hoy: sin empezar y en reproducción. «A medias» y «Terminada» llegan con el avance
// (T-206), y «Requiere suscripción», con la ficha del curso para el visitante (T-210).

export interface LessonRowProps {
  href: string;
  number: number;
  title: string;
  /** La duración ya escrita para la gente («6 min»): la arma la pantalla. */
  duration: string;
  /** La que se está viendo: va marcada y es la página actual. */
  current?: boolean;
}

export function LessonRow({ href, number, title, duration, current = false }: LessonRowProps) {
  const text = ui.lessonRow;
  const name = t(current ? text.namePlaying : text.name, { number, title, duration });
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "flex min-h-touch items-start gap-3 px-3 py-2 transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-2",
        current && "bg-accent-subtle",
      )}
    >
      <span className="sr-only">{name}</span>
      <Icon icon={current ? CirclePlay : Circle} size={20} className={current ? "mt-0.5 text-accent" : "mt-0.5 text-text-3"} />
      <span aria-hidden="true" className="w-6 shrink-0 text-body-s text-text-2 tabular-nums">
        {number}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-s text-text">{title}</span>
        <span className="text-caption text-text-3">{current ? t(text.durationPlaying, { duration }) : duration}</span>
      </span>
    </Link>
  );
}
