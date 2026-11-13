import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Lo que la hoja de tokens promete y no se ve en una prueba de componente.

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

const css = read("src/ui/theme.css");
const layout = read("src/app/layout.tsx");

describe("hoja de tokens", () => {
  it("la barra inferior del alumno se retira mientras el reproductor ocupa la ventana (PA-22; T-614)", () => {
    expect(css).toMatch(/@utility student-bottom-bar \{\s*:where\(\.player-locked\) & \{\s*display: none;/);
    expect(read("src/app/_catalog/nav.tsx")).toMatch(/className="student-bottom-bar fixed /);
  });

  it("la barra de arriba del alumno también se retira con el reproductor (T-616)", () => {
    expect(css).toMatch(/@utility student-top-bar \{\s*:where\(\.player-locked\) & \{\s*display: none;/);
    expect(read("src/app/_catalog/nav.tsx")).toMatch(/className="student-top-bar /);
  });

  it("el color del tema que lee el navegador es el token del fondo", () => {
    const background = /--bg:\s*(#[0-9A-Fa-f]{6})/.exec(css)?.[1];
    const themeColor = /themeColor:\s*"(#[0-9A-Fa-f]{6})"/.exec(layout)?.[1];
    expect(background).toBeDefined();
    expect(themeColor?.toLowerCase()).toBe(background?.toLowerCase());
  });

  it("borra la paleta y las escalas de fábrica: solo existen los tokens del diseño", () => {
    for (const namespace of ["color", "font-weight", "text", "radius", "shadow", "ease"]) {
      expect(css, `--${namespace}-*`).toContain(`--${namespace}-*: initial;`);
    }
  });

  it("un solo tema, oscuro: sin variantes de tema claro", () => {
    expect(css).toContain("color-scheme: dark;");
    expect(css).not.toMatch(/prefers-color-scheme/);
  });

  it("solo los tres pesos permitidos", () => {
    const weights = [...css.matchAll(/--font-weight: (\d+);|--font-weight-[a-z]+: (\d+);/g)].map(
      (match) => match[1] ?? match[2],
    );
    expect(new Set(weights)).toEqual(new Set(["400", "600", "700"]));
  });

  it("el foco se ve siempre y respeta el movimiento reducido", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus\)/);
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("las tipografías no se escriben en la hoja: las pone next/font", () => {
    expect(css).not.toMatch(/--brand-font-(display|text):/);
    expect(read("src/app/fonts.ts")).toMatch(/variable: "--brand-font-display"/);
    expect(read("src/app/fonts.ts")).toMatch(/variable: "--brand-font-text"/);
  });
});

/** El bloque entero que abre `header` dentro de `text`, con lo anidado (las llaves se cuentan). Vacío si no está. */
function blockAt(text: string, header: string): string {
  const start = text.indexOf(`${header} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let index = text.indexOf("{", start); index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`${header} no cierra.`);
}

/** El bloque entero de una utilidad, con sus reglas anidadas. */
function utilityBlock(name: string): string {
  const block = blockAt(css, `@utility ${name}`);
  if (block === "") throw new Error(`La hoja no define @utility ${name}.`);
  return block;
}

/** El cuerpo de la regla anidada que empieza con ese selector, dentro de un bloque. */
function ruleBody(block: string, selector: string): string {
  const start = block.indexOf(`${selector} {`);
  if (start < 0) return "";
  return block.slice(block.indexOf("{", start) + 1, block.indexOf("}", start));
}

// T-616, 3b-2: el reproductor en el oro de la marca, con los menús de Mux oscuros (decisión del carril A del 2026-11-12). El
// oro llega por la variable del tema de Mux y por las partes que exporta (`::part`), porque sus controles viven en su sombra.
describe("el reproductor en oro (T-616, 3b-2)", () => {
  const mux = utilityBlock("player-mux");

  it("el acento de Mux es el de la marca, y lo de antes sigue primero (lo lee media.test.ts)", () => {
    // En el cuerpo de la utilidad, no dentro de una regla anidada (como la de la pantalla completa propia), y sin comentarios.
    const topLevel = mux
      .slice(mux.indexOf("{") + 1, -1)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/[^;{}]+\{[^{}]*\}/g, "");
    expect(topLevel).toContain("--media-accent-color: var(--accent);");
    expect(mux).toMatch(/@utility player-mux \{[^}]*--rendition-menu-button: none;/);
  });

  it("donde el oro es fondo, el icono va en on-accent: los botones de la barra y el central grande", () => {
    expect(ruleBody(mux, "&::part(bottom button):hover")).toContain("--media-icon-color: var(--on-accent);");
    expect(ruleBody(mux, "&::part(pre-play):hover")).toContain("--media-icon-color: var(--on-accent);");
    // El «1x» de la velocidad y el tiempo pintan texto: su color, no el del tooltip.
    expect(ruleBody(mux, "&::part(playback-rate button):hover")).toContain("color: var(--on-accent);");
    expect(ruleBody(mux, "&::part(time display):hover")).toContain("color: var(--on-accent);");
  });

  // Revisión de la 154 (carril A): en una pantalla táctil, `:hover` se queda puesto después del toque y el botón seguiría en oro.
  it("lo de pasar el cursor, solo donde hay cursor (`hover: hover`)", () => {
    const pointer = blockAt(mux, "@media (hover: hover)");
    expect(pointer, "falta el bloque @media (hover: hover)").not.toBe("");
    for (const selector of ["&::part(bottom button):hover", "&::part(pre-play):hover", "&::part(playback-rate button):hover", "&::part(time display):hover"]) {
      expect(pointer, selector).toContain(`${selector} {`);
    }
    // Fuera del bloque, ninguna regla con `:hover` (los comentarios no cuentan).
    expect(mux.replace(pointer, "").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/:hover/);
  });

  it("ni el central del teléfono (transparente al pasar) ni los tooltips se oscurecen", () => {
    // `::part(button)` a secas también toma el central del teléfono, donde el fondo al pasar no es oro.
    expect(mux).not.toMatch(/::part\(button\):hover/);
    // `--media-text-color` se hereda al tooltip de cada botón, que va sobre casi negro.
    for (const selector of ["&::part(bottom button):hover", "&::part(pre-play):hover", "&::part(playback-rate button):hover", "&::part(time display):hover"]) {
      expect(ruleBody(mux, selector), selector).not.toContain("--media-text-color");
    }
  });

  it("lo cargado y la pista, translúcidos: el avance en oro se distingue de los dos", () => {
    const range = ruleBody(mux, "&::part(time range)");
    expect(range).toMatch(/--media-time-range-buffered-color: rgb\(255 255 255 \/ [\d.]+\);/);
    expect(range).toMatch(/--media-range-track-background: rgb\(255 255 255 \/ [\d.]+\);/);
  });

  it("los menús oscuros, con su borde y el contorno en oro; lo elegido de la velocidad, después y en surface-3", () => {
    const menu = ruleBody(mux, "&::part(menu)");
    expect(menu).toContain("--media-menu-background: var(--surface-2);");
    expect(menu).toContain("--media-text-color: var(--text);");
    expect(menu).toContain("--media-menu-item-hover-outline: var(--accent) solid 1px;");
    expect(menu).toContain("border-color: var(--border);");
    const rate = ruleBody(mux, "&::part(menu playback-rate)");
    expect(rate).toContain("--media-menu-item-checked-background: var(--surface-3);");
    // Misma especificidad: la de la velocidad gana por ir después.
    expect(mux.indexOf("&::part(menu playback-rate)")).toBeGreaterThan(mux.indexOf("&::part(menu) {"));
  });
});
