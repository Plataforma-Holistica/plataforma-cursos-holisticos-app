import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LICENSES, PHOTO_CREDITS } from "@/ui/photos/credits";

// Los archivos de la marca provisional (diseño, sección 3.12; T-614): las fotos de ambiente con su
// registro de créditos, y el icono del sitio con los colores de los tokens.

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const PHOTOS = "src/ui/photos";
const IMAGE = /\.(jpe?g|png|webp|avif)$/i;

const photoFiles = readdirSync(root(PHOTOS)).filter((name) => IMAGE.test(name));

// El ancho de un JPEG, de su marco (SOFn): sin dependencias para leer una cabecera.
function jpegWidth(bytes: Buffer): number {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error("JPEG sin marcador donde se esperaba");
    const marker = bytes[at + 1] ?? 0;
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return bytes.readUInt16BE(at + 7);
    at += 2 + length;
  }
  throw new Error("JPEG sin marco");
}

describe("las fotos de ambiente", () => {
  it("hay fotos, y todas son JPEG", () => {
    expect(photoFiles.length).toBeGreaterThan(0);
    for (const name of photoFiles) expect(name).toMatch(/\.jpg$/);
  });

  it("cada foto tiene exactamente un crédito, y cada crédito su foto", () => {
    expect([...PHOTO_CREDITS.map((credit) => credit.file)].sort()).toEqual([...photoFiles].sort());
  });

  it.each(PHOTO_CREDITS.map((credit) => [credit.file, credit] as const))("%s: fuente, autor, licencia, enlace y fecha", (_, credit) => {
    expect(credit.author.trim()).not.toBe("");
    expect(credit.title.trim()).not.toBe("");
    expect(credit.license).toBe(LICENSES[credit.source]);
    if (credit.source === "Pexels") expect(credit.url).toMatch(/^https:\/\/www\.pexels\.com\/photo\/[a-z0-9-]+-\d+\/$/);
    else expect(credit.url).toMatch(/^https:\/\/unsplash\.com\/photos\/[A-Za-z0-9_-]+$/);
    expect(credit.downloaded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(credit.downloaded))).toBe(false);
  });

  it.each(photoFiles)("%s: con ancho para pantalla grande y sin pasar de 1.5 MB", (name) => {
    const path = root(`${PHOTOS}/${name}`);
    expect(jpegWidth(readFileSync(path))).toBeGreaterThanOrEqual(1600);
    expect(statSync(path).size).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});

describe("el icono del sitio", () => {
  const css = readFileSync(root("src/ui/theme.css"), "utf8");
  const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`))?.[1]?.toUpperCase();

  it("la pestaña es un SVG con el fondo, el texto y el acento de los tokens, y nada más", () => {
    const svg = readFileSync(root("src/app/icon.svg"), "utf8");
    const fills = [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((match) => match[1]?.toUpperCase());
    expect(fills).toEqual([token("bg"), token("text"), token("accent")]);
    expect(svg).not.toMatch(/<text|<image|href=/);
  });

  it("la pantalla de inicio del iPhone es un PNG de 180 por 180", () => {
    const png = readFileSync(root("src/app/apple-icon.png"));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
