import { expect, test, type Browser, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { actionFields, hydrated, postAction } from "./support/actions";
import { clearCounters, forgetNotedSessions, ownerQuery, person, SESSION_COOKIE, sessionCount, type Person } from "./support/stack";

// La pantalla de la cuenta (diseño, PA-25; flujo de la app, FL-27): lo que la persona ve de
// su cuenta, el cambio de nombre y las sesiones abiertas, con JavaScript y sin él, y lo que
// cada acción hace con lo que su pantalla nunca mandaría.

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

// ---------------------------------------------------------------------------------------
// Las sesiones abiertas (FL-27, paso 4).

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
const CLOSED_ONE = "Cerramos esa sesión.";
const CLOSED_OTHERS = "Cerramos tus demás sesiones.";

const sessionsBlock = (page: Page) => page.getByRole("region", { name: "Sesiones abiertas" });
const sessionRows = (page: Page) => sessionsBlock(page).getByRole("listitem");
const closeButton = (page: Page, device: string) => sessionsBlock(page).getByRole("button", { name: new RegExp(`^Cerrar la sesión de ${device}`) });

/** Los identificadores de las sesiones de una cuenta en Auth, de la más antigua a la más nueva. */
const sessionIds = async (userId: string) =>
  (await ownerQuery<{ id: string }>("select id::text as id from auth.sessions where user_id = $1 order by created_at, id", [userId])).map(
    (row) => row.id,
  );

/** Otro navegador con la sesión de esa persona ya abierta. Hay que cerrarlo al terminar. */
async function anotherBrowser(browser: Browser, who: Person, options: Parameters<Browser["newContext"]>[0] = {}): Promise<Page> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, who);
  await expect(page).toHaveURL("/inicio");
  return page;
}

test("las sesiones abiertas se ven con su navegador, y cerrar una la saca de ese navegador en el acto @telefono", async ({ page, browser }) => {
  const ana = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  try {
    await openAccount(page, ana);
    await hydrated(page);

    await expect(sessionRows(page)).toHaveCount(2);
    // La de ahora lo dice y no lleva botón; la otra dice de dónde es.
    const mine = sessionRows(page).filter({ hasText: "Esta sesión" });
    await expect(mine).toHaveCount(1);
    await expect(mine.getByRole("button")).toHaveCount(0);
    const theirs = sessionRows(page).filter({ hasText: "Safari en iPhone o iPad" });
    await expect(theirs).toContainText(/Se abrió el \d{1,2} de \p{L}+ de \d{4}\./u);
    await expect(theirs).toContainText(/Última actividad: \d{1,2} de \p{L}+ de \d{4}\./u);
    expect(await a11yViolations(page)).toEqual([]);

    await closeButton(page, "Safari en iPhone o iPad").click();

    await expect(sessionsBlock(page).getByText(CLOSED_ONE)).toBeVisible();
    await expect(page).toHaveURL("/cuenta");
    await expect(sessionRows(page)).toHaveCount(1);
    await expect(sessionsBlock(page).getByText("No tienes otras sesiones abiertas.")).toBeVisible();
    expect(await sessionCount(ana.id)).toBe(1);
    expect(await a11yViolations(page)).toEqual([]);

    // En el otro navegador la sesión ya no vale: lo siguiente que pide lo manda a entrar.
    await phone.goto("/inicio");
    await expect(phone).toHaveURL("/entrar");
    // Y en este sigue todo igual.
    await page.reload();
    await expect(nameField(page)).toHaveValue("Ana de Prueba");
    await expect(sessionRows(page)).toHaveCount(1);
  } finally {
    await phone.context().close();
  }
});

test("«Cerrar todas las demás» deja abierta solo esta sesión", async ({ page, browser }) => {
  const ana = await person();
  const otra = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  const laptop = await anotherBrowser(browser, ana, { userAgent: FIREFOX });
  const theirs = await anotherBrowser(browser, otra);
  try {
    await openAccount(page, ana);
    await hydrated(page);
    await expect(sessionRows(page)).toHaveCount(3);
    await expect(sessionRows(page).filter({ hasText: "Firefox en Linux" })).toHaveCount(1);

    await sessionsBlock(page).getByRole("button", { name: "Cerrar todas las demás" }).click();

    await expect(sessionsBlock(page).getByText(CLOSED_OTHERS)).toBeVisible();
    await expect(sessionRows(page)).toHaveCount(1);
    await expect(sessionsBlock(page).getByRole("button")).toHaveCount(0);
    expect(await sessionCount(ana.id)).toBe(1);

    for (const closed of [phone, laptop]) {
      await closed.goto("/inicio");
      await expect(closed).toHaveURL("/entrar");
    }
    // La de otra cuenta no se entera.
    await theirs.goto("/cuenta");
    await expect(theirs).toHaveURL("/cuenta");
    expect(await sessionCount(otra.id)).toBe(1);
  } finally {
    for (const other of [phone, laptop, theirs]) await other.context().close();
  }
});

test("cerrar una sesión solo con el teclado: el aviso toma el foco, y de ahí se sigue", async ({ page, browser }) => {
  const ana = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  try {
    await openAccount(page, ana);
    await hydrated(page);

    await closeButton(page, "Safari en iPhone o iPad").focus();
    await page.keyboard.press("Enter");

    const notice = sessionsBlock(page).getByText(CLOSED_ONE);
    await expect(notice).toBeVisible();
    // El botón que se pulsó se fue con su fila: el foco no cae al documento, va al aviso.
    await expect(sessionsBlock(page).locator('[tabindex="-1"]').filter({ hasText: CLOSED_ONE })).toBeFocused();
    expect(await sessionCount(ana.id)).toBe(1);
  } finally {
    await phone.context().close();
  }
});

test("sin JavaScript se cierran igual, y la respuesta deja a la persona en el bloque de las sesiones @telefono", async ({ browser }, testInfo) => {
  const ana = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  const laptop = await anotherBrowser(browser, ana, { userAgent: FIREFOX });
  // Una ventana baja: el bloque de las sesiones queda fuera de la vista al cargar la pantalla.
  const viewport = { width: testInfo.project.use.viewport?.width ?? 390, height: 320 };
  try {
    await inContext(browser, { javaScriptEnabled: false, viewport }, async (page) => {
      await openAccount(page, ana);
      await expect(sessionRows(page)).toHaveCount(3);

      await closeButton(page, "Safari en iPhone o iPad").click();
      await expect(page).toHaveURL("/cuenta#bloque-sesiones");
      await expect(sessionsBlock(page).getByText(CLOSED_ONE)).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await expect(sessionRows(page)).toHaveCount(2);
      // Lo escrito en el otro bloque no se manda: el nombre sigue siendo el guardado.
      expect(await profileName(ana.id)).toBe("Ana de Prueba");

      await sessionsBlock(page).getByRole("button", { name: "Cerrar todas las demás" }).click();
      await expect(sessionsBlock(page).getByText(CLOSED_OTHERS)).toBeInViewport();
      await expect(sessionRows(page)).toHaveCount(1);
      expect(await sessionCount(ana.id)).toBe(1);
    });
    for (const closed of [phone, laptop]) {
      await closed.goto("/inicio");
      await expect(closed).toHaveURL("/entrar");
    }
  } finally {
    for (const other of [phone, laptop]) await other.context().close();
  }
});

test("una sesión que se cerró desde otro navegador ya no cierra las demás", async ({ page, browser }) => {
  const ana = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  try {
    await openAccount(page, ana);
    await hydrated(page);
    // El otro navegador abre su pantalla de la cuenta cuando ya hay dos sesiones: trae su botón.
    await phone.goto("/cuenta");
    await hydrated(phone);
    await expect(sessionRows(phone)).toHaveCount(2);

    await closeButton(page, "Safari en iPhone o iPad").click();
    await expect(sessionsBlock(page).getByText(CLOSED_ONE)).toBeVisible();

    // El otro navegador todavía tiene la pantalla abierta, con su botón: al pulsarlo se
    // entera de que su sesión ya no vale, y no cierra la de nadie.
    await sessionsBlock(phone).getByRole("button", { name: "Cerrar todas las demás" }).click();
    await expect(phone).toHaveURL("/entrar");
    expect(await sessionCount(ana.id)).toBe(1);
    await page.reload();
    await expect(nameField(page)).toHaveValue("Ana de Prueba");
  } finally {
    await phone.context().close();
  }
});

test("la acción de cerrar sesiones no hace nada para quien no trae sesión, ni desde otro sitio", async ({ page, browser, request }) => {
  const ana = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  try {
    await openAccount(page, ana);
    // El formulario de las sesiones es el segundo de la pantalla que lleva una acción.
    const hidden = actionFields(await (await page.request.get("/cuenta")).text(), 1);
    // El otro navegador entró primero: su sesión es la más antigua.
    const [theirs = ""] = await sessionIds(ana.id);

    // Sin ninguna cookie.
    for (const close of [theirs, "others"]) {
      const response = await postAction(request, "/cuenta", { ...hidden, close });
      expect(response.status(), close).toBe(303);
      expect(response.headers().location, close).toBe("/entrar?volver=%2Fcuenta");
    }
    // Con la cookie, desde otro sitio.
    for (const origin of ["https://otro.example", "http://localhost:3001", "null"]) {
      const rejected = await postAction(page.request, "/cuenta", { ...hidden, close: "others" }, origin);
      expect(rejected.status(), origin).toBeGreaterThanOrEqual(400);
    }
    expect(await sessionCount(ana.id)).toBe(2);

    // Y desde el propio sitio, con la cookie, sí.
    const accepted = await postAction(page.request, "/cuenta", { ...hidden, close: theirs });
    expect(accepted.status()).toBe(200);
    expect(await accepted.text()).toContain(CLOSED_ONE);
    expect(await sessionIds(ana.id)).toHaveLength(1);
  } finally {
    await phone.context().close();
  }
});

test("la acción de cerrar sesiones aguanta lo que su pantalla nunca mandaría, y solo toca la cuenta de la sesión", async ({ page, browser }) => {
  const ana = await person();
  const otra = await person();
  const phone = await anotherBrowser(browser, ana, { userAgent: IPHONE });
  const theirs = await anotherBrowser(browser, otra);
  try {
    await openAccount(page, ana);
    const hidden = actionFields(await (await page.request.get("/cuenta")).text(), 1);
    // El otro navegador entró primero: su sesión es la más antigua, y la de esta página, la segunda.
    const [minePhone = "", mine = ""] = await sessionIds(ana.id);
    const [foreign = ""] = await sessionIds(otra.id);
    const file = { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from(minePhone) };

    // Lo que no se entiende no cierra nada, y la pantalla contesta como si nada.
    for (const fields of [{ ...hidden }, { ...hidden, close: "" }, { ...hidden, close: file }, { ...hidden, close: "x".repeat(5_000) }]) {
      const response = await postAction(page.request, "/cuenta", fields);
      expect(response.status()).toBe(200);
    }
    // La sesión de otra cuenta, o algo que no es un identificador: aquí no está abierta.
    for (const close of [foreign, "' or true --", "todas"]) {
      const response = await postAction(page.request, "/cuenta", { ...hidden, close });
      expect(response.status(), close).toBe(200);
      expect(await response.text(), close).toContain("Esa sesión ya estaba cerrada.");
    }
    // Lo que el formulario diga sobre cuál se queda, o de quién es la cuenta, no se lee.
    const pointed = await postAction(page.request, "/cuenta", { ...hidden, close: "others", keep: foreign, userId: otra.id, profile_id: otra.id });
    expect(pointed.status()).toBe(200);
    expect(await sessionIds(ana.id)).toEqual([mine]);
    expect(await sessionIds(otra.id)).toEqual([foreign]);
    await theirs.goto("/cuenta");
    await expect(theirs).toHaveURL("/cuenta");

    // La sesión propia, mandada por aquí: se cierra y se borra su cookie, como «Salir».
    const own = await postAction(page.request, "/cuenta", { ...hidden, close: mine });
    expect(own.status()).toBe(303);
    expect(own.headers().location).toBe("/");
    expect(await sessionIds(ana.id)).toEqual([]);
    expect(await sessionCookie(page)).toBeUndefined();
  } finally {
    for (const other of [phone, theirs]) await other.context().close();
  }
});
