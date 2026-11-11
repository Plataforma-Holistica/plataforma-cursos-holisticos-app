import type { ReactNode } from "react";

import { cx } from "./cx";
import { Motif, motifFor } from "./motifs";

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

/**
 * El tamaño del título de un cartel vertical: los mismos tres pasos, más grandes (todo el ancho es suyo). Mira
 * además la palabra más larga, que no se puede partir entre renglones: «Autoconocimiento» a 12cqw no cabe.
 * Un título con una palabra de 14 caracteres o más se corta además con guion (`hyphens-auto`, con el `lang="es-MX"` del
 * documento), como red.
 */
/** La palabra más larga de un título, en caracteres. */
const longestWord = (title: string) => Math.max(0, ...title.split(/\s+/u).map((word) => [...word].length));

/** El corte con guion es solo la red de una palabra que no cabe: en las demás, partía palabras cortas sin necesidad. */
const HYPHENATE_FROM = 14;

function posterSize(title: string): string {
  const length = [...title].length;
  const longest = longestWord(title);
  if (length <= 24 && longest <= 10) return "text-poster-l";
  if (length <= 44 && longest <= 13) return "text-poster-m";
  return "text-poster-s";
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

// La portada «arte» de la tarjeta (T-616; decisión del carril A sin confirmar, que cambia las secciones 4.3 y
// 5.3 del diseño): un cartel. El tono de la práctica, desaturado, en un degradado radial hacia el fondo de la
// casa, con grano muy tenue; arriba, el motivo geométrico de su práctica (motifs.tsx: el motivo sale de la
// práctica, y su ángulo, su escala y su recorte, del curso) y el nombre de la práctica; abajo a la izquierda,
// el título en la letra de títulos angosta, sobre un velo que sube desde abajo. Así la portada se compone con
// título y práctica (03 §4); el maestro va debajo de la tarjeta. El foco de luz también cambia de lugar con el
// curso (`artFocus`). La flor de la vida no va en las portadas: queda para el logotipo, las cabeceras, la
// roseta y los estados. Va aparte de `CourseCover`, que sigue igual en la ficha y en la lección.
//
// La práctica va en el color del texto, con un velo corto arriba: en el segundo tono no llegaba a 4.5 sobre el
// foco más claro. Con algo en la esquina (el marcador de Mi lista, `corner`), deja su lugar y se corta con
// puntos suspensivos antes que tocarlo.

const ART: Record<number, string> = {
  1: "art-1",
  2: "art-2",
  3: "art-3",
  4: "art-4",
  5: "art-5",
  6: "art-6",
  7: "art-7",
  8: "art-8",
};

/** Dónde cae el foco de luz: arriba a la izquierda, a la derecha o al centro. */
const FOCI = ["art-focus-start", "art-focus-end", "art-focus-center"] as const;

/** La posición del foco de un curso: la misma siempre para el mismo curso. */
export function artFocus(seed: string): (typeof FOCI)[number] {
  let sum = 0;
  for (const char of seed) sum = (sum * 31 + (char.codePointAt(0) ?? 0)) % 997;
  return FOCI[sum % FOCI.length] ?? FOCI[0];
}

const SHAPES = {
  /** Las filas y la rejilla. */
  portrait: "aspect-4/5",
  /** La destacada, las fichas de práctica y las miniaturas. */
  wide: "aspect-video",
} as const;

export interface CourseArtProps {
  /** El título dentro de la portada. Sin él (la destacada, una ficha de práctica), la portada es solo ambiente. */
  title?: string;
  practiceName: string | null;
  /** Lo que elige el motivo: el orden de la práctica en el catálogo, o su identificador (motifs.tsx). */
  practiceKey?: number | string | null;
  tone: number | null;
  /** Lo que siembra el foco de luz y la posición del motivo: el curso (su enlace o su slug). */
  seed?: string;
  shape?: keyof typeof SHAPES;
  /** Hay algo sobre la esquina de arriba a la derecha: la práctica le deja su lugar. */
  corner?: boolean;
  /** Una etiqueta bajo la práctica (el aviso de curso abierto): va en el flujo, nunca encima del texto. */
  badge?: ReactNode;
  className?: string;
}

export function CourseArt({ title, practiceName, practiceKey, tone, seed = "", shape = "portrait", corner = false, badge, className }: CourseArtProps) {
  return (
    <div aria-hidden="true" className={cx("@container relative overflow-hidden grain", ART[tone ?? NEUTRAL_TONE], artFocus(seed), SHAPES[shape], className)}>
      <Motif kind={motifFor(practiceKey ?? practiceName ?? "")} courseKey={seed} className="absolute inset-x-0 top-0 h-3/5 w-full opacity-15" />
      {practiceName !== null && <span className="absolute inset-x-0 top-0 h-1/4 bg-linear-to-b from-bg/45 to-transparent" />}
      {title !== undefined && <span className="absolute inset-x-0 bottom-0 h-2/3 bg-linear-to-t from-bg/85 via-bg/40 to-transparent" />}
      <div className="relative flex h-full flex-col justify-between p-cover">
        <div className="flex flex-col items-start gap-2">
          {practiceName !== null && <p className={cx("w-full truncate eyebrow text-text", corner && "pr-12")}>{practiceName}</p>}
          {badge}
        </div>
        {title !== undefined && (
          <p
            className={cx(
              "font-display font-bold display-narrow line-clamp-3 text-balance text-text",
              shape === "portrait" ? posterSize(title) : titleSize(title),
              longestWord(title) >= HYPHENATE_FROM && "hyphens-auto",
            )}
          >
            {title}
          </p>
        )}
      </div>
    </div>
  );
}
