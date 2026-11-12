import { expect, test } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { clearCounters, person } from "./support/stack";

// La portada pública (PA-01; T-614, parte 2), de extremo a extremo: la aplicación compilada contra la
// base local. En la corrida de siempre el catálogo está vacío (nadie corrió `db:courses`), así que se
// prueba la portada con su estado vacío; las filas las prueba tests/ui/landing-page.test.tsx.

test.beforeEach(clearCounters);

/** RNF-02 y el diseño, sección 3.12: la foto de la cabecera no pasa de 200 KB en el ancho del teléfono. */
const HERO_MAX_BYTES = 200 * 1024;

test("el visitante ve la portada con su foto, y «Crear cuenta» lo lleva al registro @telefono", async ({ page }) => {
  const photo = page.waitForResponse((response) => response.url().includes("/_next/image") && response.url().includes("portada-muelle"));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Aprende con quienes practican lo que enseñan" })).toBeVisible();
  await expect(page).toHaveTitle("Escuela de Misterios");

  // La foto llega en AVIF y, en el ancho del teléfono, sin pasar del tope.
  const served = await photo;
  expect(served.headers()["content-type"]).toBe("image/avif");
  const bytes = (await served.body()).length;
  if ((page.viewportSize()?.width ?? 0) < 640) expect(bytes).toBeLessThanOrEqual(HERO_MAX_BYTES);

  await page.getByRole("main").getByRole("link", { name: "Crear cuenta" }).click();
  await expect(page).toHaveURL("/registro");
});

test("la barra va transparente arriba y sólida al desplazar", async ({ page }) => {
  await page.goto("/");
  const bar = page.getByRole("banner");
  await expect(bar).toHaveAttribute("data-solid", "false");
  await page.mouse.wheel(0, 600);
  await expect(bar).toHaveAttribute("data-solid", "true");
  await expect(bar).toHaveCSS("position", "fixed");
});

test("con el catálogo vacío lo dice, y la portada pasa las reglas de accesibilidad @telefono", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Estamos preparando los primeros cursos.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});

test("quien tiene sesión no ve la portada: va a su inicio", async ({ page }) => {
  const ana = await person();
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(ana.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(ana.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/inicio");
  await page.goto("/");
  await expect(page).toHaveURL("/inicio");
});

test("«Planes» en la barra lleva a los planes, que lo marcan; en el teléfono va en el pie, y a 320 px la barra cabe @telefono", async ({ page }) => {
  // T-616, solicitud 4 (pedido de Sergio del 2026-11-11: los planes antes de crear cuenta).
  await page.goto("/");
  const wide = (page.viewportSize()?.width ?? 0) >= 640;
  const link = wide ? page.getByRole("banner").getByRole("link", { name: "Planes" }) : page.getByRole("contentinfo").getByRole("link", { name: "Planes" });
  await link.click();
  await expect(page).toHaveURL("/planes");
  if (wide) await expect(page.getByRole("banner").getByRole("link", { name: "Planes" })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const each of await page.getByRole("banner").getByRole("link").all()) {
    if (!(await each.isVisible())) continue;
    const box = await each.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? Infinity) <= 320).toBe(true);
  }
});

test("las pantallas sueltas llevan el logotipo arriba: un texto legal y la de no encontrado", async ({ page }) => {
  // T-616, solicitud 4 (pedido de Sergio del 2026-11-11: el logotipo en toda página).
  for (const path of ["/legal/terminos", "/no-existe-esta-ruta"]) {
    await page.goto(path);
    const logo = page.getByRole("banner").getByRole("link", { name: "Escuela de Misterios" });
    await expect(logo, path).toBeVisible();
    await expect(logo, path).toHaveAttribute("href", "/");
  }
});
