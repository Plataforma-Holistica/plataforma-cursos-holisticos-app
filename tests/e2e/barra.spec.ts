import { expect, test, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { hydrated } from "./support/actions";
import { goToAccount, openPersonMenu, signOutFromBar } from "./support/nav";
import { clearCounters, person, sessionCount, type Person } from "./support/stack";

// La barra única del alumno (T-616, solicitud 2; quejas de Sergio del 2026-11-10): la misma en el inicio, explorar y
// la cuenta, fija arriba, con el menú de la persona; en el teléfono, además abajo. Quien solo es alumno no ve
// «Mi portal» ni «Administración», y si pide administración se le contesta lo mismo que una ruta que no existe.
// Los accesos de quien es maestro o del equipo los prueba el camino del equipo, que tiene esas cuentas.

test.beforeEach(clearCounters);

async function signIn(page: Page, who: Pick<Person, "email" | "password">): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/inicio");
}

const bar = (page: Page) => page.locator("[data-student-nav]");
const sideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test("la alumna ve la barra en el inicio, explorar, la cuenta y sus comentarios, sin accesos por rol @telefono", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  for (const path of ["/inicio", "/explorar", "/cuenta", "/cuenta/comentarios"]) {
    await page.goto(path);
    await expect(bar(page), path).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Inicio" }), path).toBeVisible();
    await expect(page.getByRole("link", { name: "Mi portal" }), path).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Administración" }), path).toHaveCount(0);
    expect(await sideScroll(page), path).toBe(false);
  }
  // Pedir administración le contesta lo mismo que una ruta que no existe (PA-19).
  const admin = await page.goto("/admin");
  expect(admin?.status()).toBe(404);
});

test("en computadora la barra se queda arriba al desplazar, y el menú lleva el correo con que se entró", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  // La cuenta es más alta que la ventana: sí se desplaza.
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto("/cuenta");
  await hydrated(page);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect.poll(() => bar(page).evaluate((element) => element.getBoundingClientRect().top)).toBe(0);
  await openPersonMenu(page);
  const menu = bar(page).locator("details");
  await expect(menu.getByText(ana.email, { exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Mis comentarios" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  // Escape lo cierra y el foco vuelve a «Tu cuenta».
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(menu.locator("summary")).toBeFocused();
});

test("desde la cuenta se vuelve por la barra, y «Mi lista» lleva a su bloque del inicio @telefono", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await goToAccount(page);
  await expect(page).toHaveURL("/cuenta");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Mi lista" }).click();
  await expect(page).toHaveURL("/inicio#bloque-mi-lista");
  // Sin nada guardado lo dice, solo al llegar por la barra, y el bloque toma el foco.
  await expect(page.getByText(/Todavía no guardas ningún curso/)).toBeVisible();
  await expect(page.locator("#bloque-mi-lista")).toBeFocused();
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Explorar" }).click();
  await expect(page).toHaveURL(/\/explorar/);
});

test("«Mi lista» desde el mismo inicio: llega al bloque, y «Atrás» después de otra pantalla vuelve al inicio @telefono", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await hydrated(page);
  const principal = page.getByRole("navigation", { name: "Principal" });
  await principal.getByRole("link", { name: "Mi lista" }).click();
  await expect(page).toHaveURL("/inicio#bloque-mi-lista");
  await expect(page.getByText(/Todavía no guardas ningún curso/)).toBeVisible();
  await expect(page.locator("#bloque-mi-lista")).toBeFocused();
  await principal.getByRole("link", { name: "Explorar" }).click();
  await expect(page).toHaveURL(/\/explorar/);
  await expect(page.getByRole("heading", { level: 1, name: "Explorar" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/inicio#bloque-mi-lista");
  await expect(page.getByRole("heading", { level: 1, name: /^Hola/ })).toBeVisible();
});

test("en el teléfono, en Explorar, el buscador pegado no tapa el menú de la persona @telefono", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  const ana = await person();
  await signIn(page, ana);
  await page.goto("/explorar");
  await hydrated(page);
  await openPersonMenu(page);
  // Pulsar falla si otra cosa recibe el clic encima del enlace.
  await bar(page).locator("details").getByRole("link", { name: "Mis comentarios" }).click();
  await expect(page).toHaveURL("/cuenta/comentarios");
});

for (const width of [390, 320]) {
  test(`a ${width} px de ancho no hay desplazamiento a los lados, y el menú cabe @telefono`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    const ana = await person();
    await signIn(page, ana);
    await openPersonMenu(page);
    expect(await sideScroll(page)).toBe(false);
    const box = await bar(page).locator("details > div").boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(width);
    // La lista de abajo es fija: salirse no daría desplazamiento. Cada enlace dentro de la ventana.
    for (const link of await page.getByRole("navigation", { name: "Principal" }).getByRole("link").all()) {
      const each = await link.boundingBox();
      expect(each?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((each?.x ?? 0) + (each?.width ?? Infinity)).toBeLessThanOrEqual(width);
    }
  });
}

for (const javaScript of [true, false]) {
  test(`cerrar sesión desde el menú de la barra ${javaScript ? "con" : "sin"} JavaScript`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: javaScript });
    const page = await context.newPage();
    try {
      const ana = await person();
      await signIn(page, ana);
      expect(await sessionCount(ana.id)).toBe(1);
      await signOutFromBar(page);
      await expect(page).toHaveURL("/");
      expect(await sessionCount(ana.id)).toBe(0);
    } finally {
      await context.close();
    }
  });
}
