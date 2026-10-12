import { expect, test, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { hydrated } from "./support/actions";
import { clearCounters, parameter, person, SESSION_COOKIE, sessionCount, type Person } from "./support/stack";

// Entrar y salir (FL-05; diseño PA-11), de extremo a extremo: la aplicación compilada
// contra la base y el Auth locales.

test.beforeEach(clearCounters);

async function fillSignIn(page: Page, who: Pick<Person, "email" | "password">): Promise<void> {
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
}

async function signIn(page: Page, who: Pick<Person, "email" | "password">, path = "/entrar"): Promise<void> {
  await page.goto(path);
  await fillSignIn(page, who);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const sessionCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE);

test("entra con su correo y su contraseña, llega a su inicio y sale @telefono", async ({ page }) => {
  const ana = await person();
  await page.goto("/entrar");
  await expect(page.getByRole("heading", { level: 1, name: "Inicia sesión" })).toBeVisible();
  await expect(page).toHaveTitle("Iniciar sesión · La Plataforma");
  await fillSignIn(page, ana);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL("/inicio");
  await expect(page.getByText(`Entraste como ${ana.email}`)).toBeVisible();
  const cookie = await sessionCookie(page);
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(await sessionCount(ana.id)).toBe(1);

  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL("/");
  expect(await sessionCookie(page)).toBeUndefined();
  expect(await sessionCount(ana.id)).toBe(0);

  // Sin sesión, su inicio vuelve a pedir entrar, y recuerda a dónde iba.
  await page.goto("/inicio");
  await expect(page).toHaveURL("/entrar?volver=%2Finicio");
});

test("con el correo o la contraseña equivocados dice lo mismo, exista o no la cuenta", async ({ page }) => {
  const ana = await person();
  await signIn(page, { email: ana.email, password: "no-es-la-suya" });
  const message = page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." });
  await expect(message).toBeVisible();
  await expect(page).toHaveURL("/entrar");
  // Lo escrito se conserva, menos la contraseña.
  await expect(page.getByLabel("Correo")).toHaveValue(ana.email);
  await expect(page.getByLabel("Contraseña", { exact: true })).toHaveValue("");
  expect(await sessionCookie(page)).toBeUndefined();

  await signIn(page, { email: "nadie-con-este-correo@prueba.test", password: "cualquiera-123" });
  await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
});

test("dos intentos fallidos seguidos, sin recargar, dejan un solo aviso", async ({ page }) => {
  const ana = await person();
  const message = page.getByText("El correo o la contraseña no coinciden.");
  await signIn(page, { email: ana.email, password: "no-es-la-suya" });
  await expect(message).toHaveCount(1);
  await hydrated(page);
  // Sobre la misma pantalla, sin volver a abrirla: el aviso del intento anterior no se queda.
  for (const wrong of ["tampoco-es-esta", "ni-esta-otra"]) {
    await page.getByLabel("Contraseña", { exact: true }).fill(wrong);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveValue("");
    await expect(message).toHaveCount(1);
  }
});

test("un campo vacío o un correo sin forma se marca en el campo, con un resumen que toma el foco", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByRole("button", { name: "Entrar" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "Hay 2 datos por corregir" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Escribe tu correo." })).toBeVisible();
  await expect(summary.getByRole("link", { name: "Escribe tu contraseña." })).toBeVisible();
  await expect(page.getByLabel("Correo")).toHaveAttribute("aria-invalid", "true");

  // Al salir del campo, un correo sin forma se marca sin esperar al envío.
  await hydrated(page);
  await page.getByLabel("Correo").fill("esto no es un correo");
  await page.getByLabel("Contraseña", { exact: true }).focus();
  await expect(page.getByText("Ese correo no tiene forma de correo. Revísalo.")).toBeVisible();
  await page.getByLabel("Correo").fill("ana@prueba.test");
  await page.getByLabel("Contraseña", { exact: true }).focus();
  await expect(page.getByText("Ese correo no tiene forma de correo. Revísalo.")).toBeHidden();
});

test("el fallo que agota los intentos frena, dice a qué hora y deshabilita el botón", async ({ page }) => {
  const ana = await person();
  const attempts = await parameter("INTENTOS_ANTES_DE_FRENO");
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await signIn(page, { email: ana.email, password: `equivocada-${attempt}` });
    await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
  }
  // El que agota los intentos todavía se evalúa; el siguiente ya no.
  await signIn(page, { email: ana.email, password: "equivocada-final" });
  await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
  await signIn(page, { email: ana.email, password: ana.password });
  await expect(page.getByRole("alert").filter({ hasText: /Demasiados intentos\. Podrás probar de nuevo a las \d{1,2}:\d{2}/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Entrar" })).toBeDisabled();
  expect(await sessionCookie(page)).toBeUndefined();
});

test("después de entrar va a donde iba, y solo si es una ruta propia y permitida", async ({ page, context }) => {
  const ana = await person();
  await signIn(page, ana, "/entrar?volver=%2Finicio%3Fpestana%3D2");
  await expect(page).toHaveURL("/inicio?pestana=2");

  for (const target of ["//otro.example", "/\\otro.example", "https://otro.example/inicio", "/%2e%2e//otro.example", "/entrar", "/sesion/cerrar"]) {
    await context.clearCookies();
    await clearCounters();
    await signIn(page, ana, `/entrar?volver=${encodeURIComponent(target)}`);
    await expect(page, `volver=${target}`).toHaveURL("/inicio");
  }
});

test("quien ya entró no vuelve a ver la pantalla de entrar", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  await page.goto("/entrar");
  await expect(page).toHaveURL("/inicio");
});

test("una cuenta cuya contraseña no se fijó desde su buzón no entra: se le manda a recuperarla", async ({ page }) => {
  const sinReclamar = await person("unclaimed");
  await signIn(page, sinReclamar);
  await expect(page).toHaveURL("/recuperar");
  // La pantalla de recuperar dice por qué se llegó ahí: el aviso viaja en una cookie corta,
  // con una clave, no en la dirección.
  const notice = (await page.context().cookies()).find((cookie) => cookie.name === "plataforma-aviso");
  expect(notice).toMatchObject({ value: "choose_password", httpOnly: true, sameSite: "Lax", path: "/" });
  // Dura lo justo para llegar a la pantalla siguiente: un minuto.
  const life = (notice?.expires ?? 0) - Date.now() / 1000;
  expect(life).toBeGreaterThan(30);
  expect(life).toBeLessThanOrEqual(61);
  expect(await sessionCookie(page)).toBeUndefined();
  expect(await sessionCount(sinReclamar.id)).toBe(0);
});

test("se puede entrar solo con el teclado", async ({ page }) => {
  const ana = await person();
  await page.goto("/entrar");
  // Lo primero que encuentra el teclado es «Saltar al contenido»; lo siguiente, el correo.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Correo")).toBeFocused();
  await page.keyboard.type(ana.email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Contraseña", { exact: true })).toBeFocused();
  await page.keyboard.type(ana.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/inicio");
});

test("la pantalla de entrar pasa las reglas de accesibilidad, también con un error a la vista @telefono", async ({ page }) => {
  await page.goto("/entrar");
  expect(await a11yViolations(page)).toEqual([]);
  await fillSignIn(page, { email: "nadie@prueba.test", password: "equivocada-1" });
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});
