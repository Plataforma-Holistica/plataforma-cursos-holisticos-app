import { cx } from "./cx";

// La flor de la vida, la geometría de la casa (T-616; diseño §2 del plan del rediseño). La misma del
// icono del sitio (`src/app/icon.svg`), en tres lugares con sentido y en ningún otro:
//
// - la filigrana de una cabecera (`Filigree`): la flor entera, de trazo fino en el tono del borde, recortada;
// - la marca de un curso (`Rosette`): la roseta del centro, en oro si se terminó y en trazo si va a medias;
// - los estados vacíos y de espera (`FlowerState`, en flower-state.tsx), con la semilla.
//
// Además, delante del nombre en la barra (`FlowerMark`), que es el logotipo. Toda flor es decorativa
// (`aria-hidden`): lo que dice, lo dice un texto al lado.
//
// La geometría se calcula, no se copia: círculos de radio R en una red hexagonal. La semilla son el del
// centro y seis alrededor, a R; la flor suma la segunda vuelta, seis a 2R y seis a R·√3. Cada pétalo de la
// roseta es la lente entre el centro y uno de los seis, dos arcos de radio R. Los gruesos del trazo son
// de la geometría (unidades del dibujo), como los radios.

const R = 10;

const round = (value: number) => Math.round(value * 1000) / 1000;

function at(degrees: number, distance: number): readonly [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [round(distance * Math.cos(radians)), round(distance * Math.sin(radians))];
}

/** Las seis direcciones, empezando arriba. */
const RING = [0, 1, 2, 3, 4, 5].map((step) => -90 + 60 * step);

const SEED = RING.map((degrees) => at(degrees, R));

const FLOWER: readonly (readonly [number, number])[] = [
  [0, 0],
  ...SEED,
  ...RING.map((degrees) => at(degrees, 2 * R)),
  ...RING.map((degrees) => at(degrees + 30, Math.sqrt(3) * R)),
];

const PETALS = SEED.map(([x, y]) => `M0 0A${R} ${R} 0 0 1 ${x} ${y}A${R} ${R} 0 0 1 0 0Z`).join("");

/** La roseta: el círculo del centro y sus seis pétalos. */
function RosettePaths({ className, width }: { className?: string; width: number }) {
  return (
    <g className={className} strokeWidth={width} strokeLinejoin="round">
      <circle r={R} />
      <path d={PETALS} />
    </g>
  );
}

/** Los tonos y gruesos de la semilla, por lugar: el logotipo, un estado y una espera. */
const SEEDS = {
  mark: { ring: "stroke-text-2", rosette: "stroke-accent", ringWidth: 1.7, rosetteWidth: 2 },
  state: { ring: "stroke-text-3", rosette: "stroke-accent-muted", ringWidth: 0.8, rosetteWidth: 1 },
  waiting: { ring: "stroke-text-disabled", rosette: "stroke-accent-muted", ringWidth: 0.8, rosetteWidth: 1 },
} as const;

/** La semilla de la vida: los seis de alrededor en un tono y la roseta del centro en otro. */
function Seed({ variant }: { variant: keyof typeof SEEDS }) {
  const seed = SEEDS[variant];
  return (
    <>
      <g className={seed.ring} strokeWidth={seed.ringWidth}>
        {SEED.map(([x, y]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r={R} />
        ))}
      </g>
      <RosettePaths className={seed.rosette} width={seed.rosetteWidth} />
    </>
  );
}

/** El logotipo de la barra: la semilla, como el icono del sitio. Mide en `em`, con el nombre. */
export function FlowerMark({ className }: { className?: string }) {
  return (
    <svg data-brand-mark aria-hidden="true" focusable="false" viewBox="-21 -21 42 42" className={cx("size-brand-mark shrink-0 fill-none", className)}>
      <Seed variant="mark" />
    </svg>
  );
}

/** La marca de un curso: en oro si se terminó, en trazo si va a medias. El tamaño lo pone quien la usa. */
export function Rosette({ complete, className }: { complete: boolean; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="-11.5 -11.5 23 23" className={cx("shrink-0 fill-none", className)}>
      <RosettePaths className={complete ? "fill-accent-subtle stroke-accent" : "stroke-text-2"} width={complete ? 1.6 : 1.2} />
    </svg>
  );
}

/**
 * La filigrana: la flor entera, de un píxel, casi invisible. En una cabecera va en el tono del borde;
 * sobre una portada «arte» (`variant="light"`), en el del texto, muy tenue. La posición y el tamaño los
 * pone quien la usa.
 */
export function Filigree({ variant = "border", className }: { variant?: "border" | "light"; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="-31 -31 62 62"
      className={cx("pointer-events-none fill-none", variant === "border" ? "stroke-filigree" : "stroke-text opacity-10", className)}
    >
      {FLOWER.map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r={R} vectorEffect="non-scaling-stroke" />
      ))}
      <circle r={3 * R} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** La semilla de un estado vacío o de espera. En espera, la vuelta de afuera va más callada. */
export function SeedMark({ waiting = false, className }: { waiting?: boolean; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="-21 -21 42 42" className={cx("shrink-0 fill-none", className)}>
      <Seed variant={waiting ? "waiting" : "state"} />
    </svg>
  );
}
