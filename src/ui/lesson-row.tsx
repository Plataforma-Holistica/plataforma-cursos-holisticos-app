import { Circle, CircleCheck, CirclePlay, LoaderCircle, Lock } from "lucide";
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
// Estados: sin empezar (círculo vacío), a medias (un arco en acento), terminada (palomita) y, la
// que se está viendo, en reproducción, que se suma a terminada y tapa a medias (T-206). Y, para el
// visitante de un curso que pide suscripción, con candado: «Requiere suscripción» (T-210). Sigue
// siendo un enlace: la lección manda a entrar.

export interface LessonRowProps {
  href: string;
  number: number;
  title: string;
  /** La duración ya escrita para la gente («6 min»): la arma la pantalla. */
  duration: string;
  /** La que se está viendo: va marcada y es la página actual. */
  current?: boolean;
  /** Lo que lleva quien mira (T-206), o el candado del visitante (T-210). */
  state?: "not_started" | "in_progress" | "completed" | "locked";
}

type Words = (typeof ui)["lessonRow"];
type NameKey = "name" | "nameInProgress" | "nameCompleted" | "nameLocked" | "namePlaying" | "nameCompletedPlaying";
type CaptionKey = "durationInProgress" | "durationCompleted" | "durationLocked" | "durationPlaying" | "durationCompletedPlaying";

/** El nombre y lo que se lee bajo el título, según el estado y si es la que se está viendo. */
function wording(state: NonNullable<LessonRowProps["state"]>, current: boolean): { name: Words[NameKey]; caption: Words[CaptionKey] | null } {
  const text = ui.lessonRow;
  if (current) {
    return state === "completed"
      ? { name: text.nameCompletedPlaying, caption: text.durationCompletedPlaying }
      : { name: text.namePlaying, caption: text.durationPlaying };
  }
  if (state === "completed") return { name: text.nameCompleted, caption: text.durationCompleted };
  if (state === "in_progress") return { name: text.nameInProgress, caption: text.durationInProgress };
  if (state === "locked") return { name: text.nameLocked, caption: text.durationLocked };
  return { name: text.name, caption: null };
}

const ICONS = { not_started: Circle, in_progress: LoaderCircle, completed: CircleCheck, locked: Lock } as const;

export function LessonRow({ href, number, title, duration, current = false, state = "not_started" }: LessonRowProps) {
  const words = wording(state, current);
  const name = t(words.name, { number, title, duration });
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
      <Icon
        icon={current ? CirclePlay : ICONS[state]}
        size={20}
        className={current || state === "in_progress" || state === "completed" ? "mt-0.5 text-accent" : "mt-0.5 text-text-3"}
      />
      <span aria-hidden="true" className="w-6 shrink-0 text-body-s text-text-2 tabular-nums">
        {number}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-s text-text">{title}</span>
        <span className="text-caption text-text-3">{words.caption === null ? duration : t(words.caption, { duration })}</span>
      </span>
    </Link>
  );
}
