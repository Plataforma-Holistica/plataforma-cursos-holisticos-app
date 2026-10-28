import { cx } from "./cx";

// Portada generada por sistema (diseño, sección 4; T-210): ningún maestro sube una miniatura. Se
// compone con el título, el maestro y la práctica, sobre un degradado del tono profundo al medio
// de la práctica. Mientras no haya retratos (los carga contenido en PA-66), va sin retrato.
//
// Es decorativa: la tarjeta o el encabezado que la llevan dicen lo mismo con su propio texto, así
// que queda fuera del árbol de accesibilidad. El tamaño del título se mide contra el ancho de la
// portada, en tres pasos según su largo (4.3).

// Escritas enteras: Tailwind no ve una clase armada con texto.
const TONES: Record<number, string> = {
  1: "from-cover-1-deep to-cover-1",
  2: "from-cover-2-deep to-cover-2",
  3: "from-cover-3-deep to-cover-3",
  4: "from-cover-4-deep to-cover-4",
  5: "from-cover-5-deep to-cover-5",
  6: "from-cover-6-deep to-cover-6",
  7: "from-cover-7-deep to-cover-7",
  8: "from-cover-8-deep to-cover-8",
};

/** El tono de un curso sin práctica: índigo, el del sistema. */
export const NEUTRAL_TONE = 6;

/** Las clases del degradado de un tono, para quien pinta otra superficie con él (la tarjeta de maestro). */
export function toneClasses(tone: number | null): string {
  return TONES[tone ?? NEUTRAL_TONE] ?? (TONES[NEUTRAL_TONE] as string);
}

function titleSize(title: string): string {
  const length = [...title].length;
  if (length <= 24) return "text-cover-l";
  if (length <= 44) return "text-cover-m";
  return "text-cover-s";
}

export interface CourseCoverProps {
  title: string;
  teacherName: string;
  practiceName: string | null;
  tone: number | null;
  className?: string;
}

export function CourseCover({ title, teacherName, practiceName, tone, className }: CourseCoverProps) {
  return (
    <div aria-hidden="true" className={cx("@container relative aspect-video overflow-hidden bg-linear-to-r", toneClasses(tone), className)}>
      <div className="absolute inset-y-0 left-0 flex w-7/12 flex-col justify-between p-cover text-text">
        {practiceName !== null ? <p className="text-cover-label uppercase">{practiceName}</p> : <span />}
        <p className={cx("font-display line-clamp-3 text-balance", titleSize(title))}>{title}</p>
        <p className="font-text text-cover-name">{teacherName}</p>
      </div>
    </div>
  );
}
