import { cx } from "./cx";

// Los motivos de las portadas (T-616, solicitud 1; condición del revisor del prototipo): cada portada lleva un
// dibujo geométrico de trazo fino, de la familia de la flor de la vida, para que ocho portadas juntas no parezcan
// imágenes sin cargar y dos de la misma práctica se distingan.
//
// - El motivo sale de la práctica (`motifFor`): por su orden en el catálogo (PA-67), como la foto de la práctica
//   (`practicePhoto`), para que ocho prácticas seguidas nunca repitan; sin orden, por un hash de su identificador.
//   Con el hash solo, cuatro prácticas repetían motivo más de la mitad de las veces (respiración y meditación
//   caían las dos en los círculos concéntricos).
// - El ángulo, la escala y el recorte salen de una semilla del curso (`placementFor`): el mismo curso se ve
//   siempre igual, y dos de la misma práctica no.
// - Es decorativo (`aria-hidden`), de un píxel (`non-scaling-stroke`), muy tenue, y ocupa la parte de arriba de
//   la portada: abajo va el título.
//
// La flor entera no es un motivo: queda para el logotipo, las cabeceras, la roseta y los estados.
//
// La geometría se calcula en un cuadro de -50 a 50; los números de los trazos son del dibujo, como los radios.

const round = (value: number) => Math.round(value * 100) / 100;

function at(degrees: number, distance: number): readonly [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [round(distance * Math.cos(radians)), round(distance * Math.sin(radians))];
}

const circle = (cx: number, cy: number, r: number) => `M${round(cx - r)} ${cy}a${r} ${r} 0 1 0 ${round(2 * r)} 0a${r} ${r} 0 1 0 ${round(-2 * r)} 0`;

/** Círculos que se cruzan: tres grandes en triángulo, dentro de uno mayor. */
const crossing = [...[90, 210, 330].map((degrees) => at(degrees, 15)).map(([x, y]) => circle(x, y, 26)), circle(0, 0, 41)].join("");

/** Ondas: siete líneas que ondulan, paralelas. */
const waves = Array.from({ length: 7 }, (_, line) => {
  const y = -42 + line * 14;
  const points = Array.from({ length: 51 }, (_, step) => {
    const x = -50 + step * 2;
    return `${x} ${round(y + 4 * Math.sin((x / 100) * 4 * Math.PI + line * 0.6))}`;
  });
  return `M${points.join("L")}`;
}).join("");

/** Círculos concéntricos. */
const concentric = Array.from({ length: 7 }, (_, ring) => circle(0, 0, 6 + ring * 7)).join("");

/** La semilla: siete círculos. */
const seed = [circle(0, 0, 16), ...[0, 60, 120, 180, 240, 300].map((degrees) => at(degrees - 90, 16)).map(([x, y]) => circle(x, y, 16))].join("");

/** Vesicas: una cadena de círculos que se cruzan por la mitad. */
const vesica = [-45, -22.5, 0, 22.5, 45].map((y) => circle(0, y, 22.5)).join("");

/** Rejilla de pétalos: lentes en filas, alternando horizontales y verticales. */
const petals = Array.from({ length: 5 }, (_, row) =>
  Array.from({ length: 5 }, (_, column) => {
    const x = -40 + column * 20;
    const y = -40 + row * 20;
    return (row + column) % 2 === 0 ? `M${x - 8} ${y}A9 9 0 0 1 ${x + 8} ${y}A9 9 0 0 1 ${x - 8} ${y}` : `M${x} ${y - 8}A9 9 0 0 1 ${x} ${y + 8}A9 9 0 0 1 ${x} ${y - 8}`;
  }).join(""),
).join("");

/** Espiral de arcos: una espiral logarítmica de tres vueltas. */
const spiral = `M${Array.from({ length: 181 }, (_, step) => {
  const theta = (step / 180) * 6 * Math.PI;
  const r = 1.2 * Math.exp(0.19 * theta);
  return `${round(r * Math.cos(theta))} ${round(r * Math.sin(theta))}`;
}).join("L")}`;

/** Rayos: veinticuatro desde un círculo chico hasta uno grande. */
const rays = [
  ...Array.from({ length: 24 }, (_, ray) => {
    const [x1, y1] = at(ray * 15, 10);
    const [x2, y2] = at(ray * 15, 46);
    return `M${x1} ${y1}L${x2} ${y2}`;
  }),
  circle(0, 0, 10),
  circle(0, 0, 46),
].join("");

/** Los ocho motivos, en el orden en que los reparte el hash. */
export const MOTIFS = { crossing, waves, concentric, seed, vesica, petals, spiral, rays } as const;

export type MotifKind = keyof typeof MOTIFS;

const KINDS = Object.keys(MOTIFS) as MotifKind[];

/** Un hash corto y estable de un texto: el mismo texto da siempre el mismo número. */
function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0;
  return value;
}

/** El motivo de una práctica: por su orden en el catálogo si se sabe, o por un hash de su identificador. */
export function motifFor(practice: number | string): MotifKind {
  const index = typeof practice === "number" ? Math.abs(Math.trunc(practice)) : hash(practice);
  return KINDS[index % KINDS.length] ?? "crossing";
}

/** Dónde cae el motivo en la portada de un curso: ángulo, escala y recorte. */
export function placementFor(courseKey: string): { rotate: number; scale: number; x: number; y: number } {
  const value = hash(courseKey);
  return {
    rotate: (value % 24) * 15,
    scale: 1.1 + ((value >>> 5) % 7) * 0.1,
    x: ((value >>> 9) % 9) * 5 - 20,
    y: ((value >>> 13) % 5) * 4 - 12,
  };
}

export function Motif({ kind, courseKey, className }: { kind: MotifKind; courseKey: string; className?: string }) {
  const { rotate, scale, x, y } = placementFor(courseKey);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="-50 -50 100 100"
      preserveAspectRatio="xMidYMid slice"
      className={cx("pointer-events-none fill-none stroke-text", className)}
    >
      <path d={MOTIFS[kind]} transform={`translate(${x} ${y}) rotate(${rotate}) scale(${round(scale)})`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
