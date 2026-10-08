import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Lo que la hoja de tokens promete y no se ve en una prueba de componente.

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

const css = read("src/ui/theme.css");
const layout = read("src/app/layout.tsx");

describe("hoja de tokens", () => {
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
