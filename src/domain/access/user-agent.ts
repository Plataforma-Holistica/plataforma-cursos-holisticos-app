// De qué navegador y de qué sistema dice ser una sesión (RF-109), a partir de la cabecera
// `User-Agent` de la petición que la abrió.
//
// Es para que una persona reconozca sus sesiones en la lista de su cuenta («Chrome en
// Windows»). No decide nada: la cabecera la escribe quien pide, y puede decir lo que quiera.
// Lo que no se reconoce queda en nulo, y la pantalla dice «desconocido».

export const BROWSERS = ["edge", "opera", "samsung", "firefox", "chrome", "safari"] as const;
export const SYSTEMS = ["ios", "android", "chromeos", "windows", "macos", "linux"] as const;

export type Browser = (typeof BROWSERS)[number];
export type System = (typeof SYSTEMS)[number];

export interface Device {
  browser: Browser | null;
  system: System | null;
}

/** Más allá de esto no se mira: es un texto de fuera, y lo que importa va al principio. */
const MAX_LENGTH = 512;

// El orden es la regla: casi todos los navegadores dicen además ser Chrome y Safari, así que
// primero van los que se montan sobre otro, y Safari al final, que solo lo es quien además
// trae «Version/». Cada nombre se busca como palabra: «MiEdg/2» no es Edge.
const BROWSER_MARKS: readonly (readonly [Browser, RegExp])[] = [
  ["edge", /(?<![\w-])(?:Edg|Edge|EdgA|EdgiOS)\/\d/],
  ["opera", /(?<![\w-])(?:OPR|OPiOS|Opera)\/\d/],
  ["samsung", /(?<![\w-])SamsungBrowser\/\d/],
  ["firefox", /(?<![\w-])(?:Firefox|FxiOS)\/\d/],
  ["chrome", /(?<![\w-])(?:Chrome|CriOS)\/\d/],
  ["safari", /(?<![\w-])Version\/\d.*(?<![\w-])Safari\/\d/],
];

// También en orden: un iPhone dice «like Mac OS X», y Android y ChromeOS dicen «Linux».
const SYSTEM_MARKS: readonly (readonly [System, RegExp])[] = [
  ["ios", /(?<![\w-])(?:iPhone|iPad|iPod)\b/],
  ["android", /(?<![\w-])Android\b/],
  ["chromeos", /(?<![\w-])CrOS\b/],
  ["windows", /(?<![\w-])Windows\b/],
  ["macos", /(?<![\w-])(?:Macintosh|Mac OS X)\b/],
  ["linux", /(?<![\w-])Linux\b/],
];

const firstMatch = <Name>(marks: readonly (readonly [Name, RegExp])[], text: string): Name | null =>
  marks.find(([, mark]) => mark.test(text))?.[0] ?? null;

export function describeUserAgent(userAgent: string | null): Device {
  const text = (userAgent ?? "").slice(0, MAX_LENGTH);
  return { browser: firstMatch(BROWSER_MARKS, text), system: firstMatch(SYSTEM_MARKS, text) };
}
