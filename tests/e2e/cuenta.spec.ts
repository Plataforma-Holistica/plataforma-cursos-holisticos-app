import { expect, test, type Browser, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { actionFields, hydrated, postAction } from "./support/actions";
import { clearCounters, forgetNotedSessions, ownerQuery, person, SESSION_COOKIE, sessionCount, type Person } from "./support/stack";

// La pantalla de la cuenta (diseño, PA-25; flujo de la app, FL-27): lo que la persona ve de
// su cuenta y el cambio de nombre, con JavaScript y sin él, y lo que la acción hace con lo
// que su pantalla nunca mandaría.

test.beforeEach(clearCounters);

const SAVED = "Guardado.";
const EMPTY = "Escribe tu nombre.";
const INVALID = "Ese nombre tiene caracteres que no podemos guardar. Escríbelo de nuevo.";

async function signIn(page: Page, who: Pick<Person, "email" | "password">, path = "/entrar"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Entra y abre la pantalla de la cuenta. */
async function openAccount(page: Page, who: Person): Promise<void> {
  await signIn(page, who);
  await expect(page).toHaveURL("/inicio");
  await page.goto("/cuenta");
  await expect(page.getByRole("heading", { level: 1, name: "Cuenta" })).toBeVisible();
}

// Por su papel: el bloque del nombre es una región que también se llama «Nombre».
const nameField = (page: Page) => page.getByRole("textbox", { name: "Nombre" });
const saveButton = (page: Page) => page.getByRole("button", { name: "Guardar" });

const profileName = async (id: string) =>
  (await ownerQuery<{ display_name: string | null }>("select display_name from public.profiles where id = $1", [id]))[0]
    ?.display_name ?? null;

const sessionCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE);

async function inContext<T>(browser: Browser, options: Parameters<Browser["newContext"]>[0], work: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await work(await context.newPage());
  } finally {
    await context.close();
  }
}

test("del inicio se llega a la cuenta, que muestra el nombre y el correo, y se vuelve @telefono", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");

  await page.getByRole("link", { name: "Cuenta" }).click();
  await expect(page).toHaveURL("/cuenta");
  await expect(page).toHaveTitle("Cuenta · La Plataforma");
  await expect(page.getByRole("heading", { level: 1, name: "Cuenta" })).toBeVisible();
  await expect(nameField(page)).toHaveValue("Ana de Prueba");
  const email = page.getByRole("region", { name: "Correo" });
  await expect(email).toContainText(ana.email);
  // El correo se ve, y no hay dónde escribir otro.
  await expect(email.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(1);

  await page.getByRole("link", { name: "Volver al inicio" }).click();
  await expect(page).toHaveURL("/inicio");
});

test("guardar el nombre: lo dice ahí mismo, queda en la base, y sigue al recargar y al volver atrás", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  await page.getByRole("link", { name: "Cuenta" }).click();
  await expect(page).toHaveURL("/cuenta");
  await hydrated(page);

  await nameField(page).fill("  Beatriz de Prueba ");
  await saveButton(page).click();

  await expect(page.getByText(SAVED)).toBeVisible();
  await expect(page).toHaveURL("/cuenta");
  // El campo queda con el nombre como se guardó, sin los espacios de los extremos.
  await expect(nameField(page)).toHaveValue("Beatriz de Prueba");
  expect(await profileName(ana.id)).toBe("Beatriz de Prueba");

  // Lo que la página trae del servidor ya es el nombre nuevo: al irse y volver atrás no sale el de antes.
  await page.getByRole("link", { name: "Volver al inicio" }).click();
  await expect(page).toHaveURL("/inicio");
  await page.goBack();
  await expect(page).toHaveURL("/cuenta");
  await expect(nameField(page)).toHaveValue("Beatriz de Prueba");

  await page.reload();
  await expect(nameField(page)).toHaveValue("Beatriz de Prueba");
  await expect(page.getByText(SAVED)).toHaveCount(0);
});

test("un nombre que no se puede guardar se dice antes de enviar, y nada sale hacia el servidor", async ({ page }) => {
  const ana = await person();
  await openAccount(page, ana);
  await hydrated(page);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });

  await nameField(page).fill("");
  await saveButton(page).click();
  const summary = page.getByRole("alert").filter({ hasText: EMPTY });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: EMPTY })).toHaveAttribute("href", "#cuenta-nombre");
  await expect(nameField(page)).toHaveAttribute("aria-invalid", "true");
  expect(posts).toEqual([]);

  // Al salir del campo, un nombre que no se puede guardar se marca sin esperar al envío.
  await nameField(page).fill("...");
  await page.getByRole("link", { name: "Volver al inicio" }).focus();
  await expect(page.getByText(INVALID)).toBeVisible();
  expect(await profileName(ana.id)).toBe("Ana de Prueba");

  await nameField(page).fill("Beatriz");
  await saveButton(page).click();
  await expect(page.getByText(SAVED)).toBeVisible();
  // Dentro de la pantalla: fuera de ella vive el anunciador de rutas de Next, que también es una alerta.
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(await profileName(ana.id)).toBe("Beatriz");
});

test("solo con el teclado: se llega al campo, se guarda con Intro y el foco no se pierde", async ({ page }) => {
  const ana = await person();
  await openAccount(page, ana);
  await hydrated(page);

  // El campo del nombre es lo primero a lo que se llega después del salto al contenido.
  for (let presses = 0; presses < 4; presses += 1) {
    await page.keyboard.press("Tab");
    if (await nameField(page).evaluate((field) => field === document.activeElement)) break;
  }
  await expect(nameField(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Carla de Prueba");
  await page.keyboard.press("Enter");

  await expect(page.getByText(SAVED)).toBeVisible();
  expect(await profileName(ana.id)).toBe("Carla de Prueba");
  // Quien guardó desde el campo sigue en el campo: puede corregir y volver a guardar sin buscarlo.
  await expect(nameField(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Carla");
  await page.keyboard.press("Enter");
  await expect.poll(() => profileName(ana.id)).toBe("Carla");
  await expect(nameField(page)).toBeFocused();

  // Y quien guardó desde el botón sigue en el botón.
  await page.keyboard.press("Tab");
  await expect(saveButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(SAVED)).toBeVisible();
  await expect(saveButton(page)).toBeFocused();
});

test("sin JavaScript se guarda igual, y la respuesta deja a la persona en el bloque que envió @telefono", async ({ browser }, testInfo) => {
  const ana = await person();
  // Una ventana baja: sin ir al bloque, lo que el servidor contestó quedaría fuera de la vista.
  const viewport = { width: testInfo.project.use.viewport?.width ?? 390, height: 260 };
  await inContext(browser, { javaScriptEnabled: false, viewport }, async (page) => {
    await openAccount(page, ana);

    await nameField(page).fill("  Ana sin JavaScript ");
    await saveButton(page).click();
    await expect(page).toHaveURL("/cuenta#bloque-nombre");
    await expect(page.getByText(SAVED)).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(nameField(page)).toHaveValue("Ana sin JavaScript");
    expect(await profileName(ana.id)).toBe("Ana sin JavaScript");

    // Lo que no se puede guardar vuelve con su resumen, lo escrito intacto y la base como estaba.
    await nameField(page).fill("...");
    await saveButton(page).click();
    await expect(page.getByRole("link", { name: INVALID })).toBeInViewport();
    await expect(nameField(page)).toHaveValue("...");
    await expect(page.getByText(SAVED)).toHaveCount(0);

    await nameField(page).fill("");
    await saveButton(page).click();
    await expect(page.getByRole("link", { name: EMPTY })).toBeInViewport();
    expect(await profileName(ana.id)).toBe("Ana sin JavaScript");
  });
});

test("la pantalla de la cuenta pasa las reglas de accesibilidad en reposo, con un error y al guardar @telefono", async ({ page }) => {
  const ana = await person();
  await openAccount(page, ana);
  await hydrated(page);
  expect(await a11yViolations(page)).toEqual([]);

  await nameField(page).fill("");
  await saveButton(page).click();
  await expect(page.getByRole("alert").filter({ hasText: EMPTY })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  await nameField(page).fill("Beatriz");
  await saveButton(page).click();
  await expect(page.getByText(SAVED)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});

test("sin sesión, la cuenta manda a entrar, y al entrar se llega a la cuenta", async ({ page }) => {
  const ana = await person();
  await page.goto("/cuenta");
  await expect(page).toHaveURL("/entrar?volver=%2Fcuenta");

  await page.getByLabel("Correo").fill(ana.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(ana.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/cuenta");
  await expect(nameField(page)).toHaveValue("Ana de Prueba");
});

test("a una cuenta sin completar se le pide primero lo que falta, y después llega a la cuenta", async ({ page }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva, "/entrar?volver=%2Fcuenta");
  await expect(page).toHaveURL("/consentimientos?volver=%2Fcuenta");
  // Tampoco escribiendo la dirección a mano.
  await page.goto("/cuenta");
  await expect(page).toHaveURL("/consentimientos?volver=%2Fcuenta");

  await page.getByLabel("Nombre").fill("Ana de Prueba");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Aceptar y seguir" }).click();
  await expect(page).toHaveURL("/cuenta");
  await expect(nameField(page)).toHaveValue("Ana de Prueba");
});

for (const javaScript of [true, false]) {
  test(`si la sesión deja de valer mientras se escribe, guardar la cierra, manda a entrar y no cambia nada (${javaScript ? "con" : "sin"} JavaScript)`, async ({ browser }) => {
    const ana = await person();
    await inContext(browser, { javaScriptEnabled: javaScript }, async (page) => {
      await openAccount(page, ana);
      if (javaScript) await hydrated(page);
      expect(await forgetNotedSessions(ana.id)).toBe(1);

      await nameField(page).fill("Beatriz");
      await saveButton(page).click();

      // Sin JavaScript el navegador conserva el ancla del bloque al seguir la redirección.
      // No estorba: en la pantalla de entrar no apunta a nada.
      await expect(page).toHaveURL(javaScript ? "/entrar" : "/entrar#bloque-nombre");
      await expect(page.getByRole("heading", { level: 1, name: "Inicia sesión" })).toBeVisible();
      await expect(page.locator("#bloque-nombre")).toHaveCount(0);
      expect(await sessionCookie(page)).toBeUndefined();
      expect(await sessionCount(ana.id)).toBe(0);
      expect(await profileName(ana.id)).toBe("Ana de Prueba");
    });
  });
}

test("la acción de cambiar el nombre no hace nada para quien no trae sesión", async ({ page, request }) => {
  const ana = await person();
  await openAccount(page, ana);
  // Los campos de la acción, tomados de una sesión de verdad, enviados sin ninguna cookie.
  const hidden = actionFields(await (await page.request.get("/cuenta")).text());

  const response = await postAction(request, "/cuenta", { ...hidden, name: "Intrusa" });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe("/entrar?volver=%2Fcuenta");
  expect(await profileName(ana.id)).toBe("Ana de Prueba");
});

test("la acción enviada desde otro sitio se rechaza aunque traiga la sesión, y desde el propio sí guarda", async ({ page }) => {
  const ana = await person();
  await openAccount(page, ana);
  const hidden = actionFields(await (await page.request.get("/cuenta")).text());

  for (const origin of ["https://otro.example", "http://localhost:3001", "null"]) {
    const rejected = await postAction(page.request, "/cuenta", { ...hidden, name: "Desde fuera" }, origin);
    expect(rejected.status(), origin).toBeGreaterThanOrEqual(400);
    expect(await profileName(ana.id), origin).toBe("Ana de Prueba");
  }

  const accepted = await postAction(page.request, "/cuenta", { ...hidden, name: "Desde dentro" });
  expect(accepted.status()).toBe(200);
  expect(await profileName(ana.id)).toBe("Desde dentro");
});

test("la acción aguanta un formulario que su pantalla nunca mandaría, y solo escribe en la cuenta de la sesión", async ({ page }) => {
  const ana = await person();
  const otra = await person();
  await openAccount(page, ana);
  const hidden = actionFields(await (await page.request.get("/cuenta")).text());
  const file = { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("Intrusa") };

  // Ni guarda ni truena: contesta su pantalla, con el dato por corregir.
  for (const fields of [{ ...hidden }, { ...hidden, name: file }, { ...hidden, name: "x".repeat(501) }, { ...hidden, name: "x".repeat(50_000) }]) {
    const response = await postAction(page.request, "/cuenta", fields);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(EMPTY);
  }
  expect(await profileName(ana.id)).toBe("Ana de Prueba");

  // Lo que diga el formulario sobre de quién es la cuenta no se lee.
  const pointed = await postAction(page.request, "/cuenta", {
    ...hidden,
    name: "Beatriz",
    id: otra.id,
    userId: otra.id,
    profile_id: otra.id,
    email: otra.email,
    volver: "//otro.example",
  });
  expect(pointed.status()).toBe(200);
  expect(await profileName(ana.id)).toBe("Beatriz");
  expect(await profileName(otra.id)).toBe("Ana de Prueba");
});

test("la pantalla de la cuenta no se guarda en caché", async ({ page }) => {
  const ana = await person();
  await openAccount(page, ana);
  expect((await page.request.get("/cuenta")).headers()["cache-control"]).toMatch(/no-store/);
});
