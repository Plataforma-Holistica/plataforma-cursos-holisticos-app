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
