import { expect, test, type Browser, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { actionFields, hydrated, postAction, type Field } from "./support/actions";
import {
  ageAuthRecoveryMail,
  ageLastMails,
  clearCounters,
  fillAddressCounters,
  lastMailTo,
  mailsTo,
  ownerQuery,
  parameter,
  person,
  SESSION_COOKIE,
  sessionCount,
  testEmail,
  tokenHashIn,
  waitForMails,
  type Person,
} from "./support/stack";

// Recuperar la contraseña, de extremo a extremo (FL-06; diseño PA-13): la aplicación
// compilada contra la base, el Auth y el buzón locales. El enlace sale del buzón.
//
// La llamada a Auth corre detrás de la respuesta: «no llegó ningún correo» se afirma después
// de esperar un correo de control, pedido más tarde.

test.beforeEach(clearCounters);

const NEW_PASSWORD = "otra-clave-de-prueba-7";
const SENT = "Si ese correo tiene cuenta, te mandamos un enlace. Dura 1 hora.";
const CHANGED = "Tu contraseña se cambió y cerramos todas tus sesiones. Entra con la nueva.";

async function inContext<T>(browser: Browser, options: Parameters<Browser["newContext"]>[0], work: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await work(await context.newPage());
  } finally {
    await context.close();
  }
}

async function signIn(page: Page, who: Pick<Person, "email" | "password">): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

async function requestRecovery(page: Page, email: string): Promise<void> {
  await page.goto("/recuperar");
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Mandarme el enlace" }).click();
}

/** Pide la recuperación y devuelve la huella del enlace que llegó al buzón. */
async function recoveryLink(page: Page, email: string): Promise<string> {
  await requestRecovery(page, email);
  await expect(page.getByText(SENT)).toBeVisible();
  return tokenHashIn(await lastMailTo(email), "recuperar");
}

async function savePassword(page: Page, password: string): Promise<void> {
  await page.getByLabel("Contraseña nueva").fill(password);
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
}

/** Un correo de control: una recuperación pedida ahora para otra cuenta, y esperada hasta que llega. */
async function controlMail(browser: Browser): Promise<void> {
  const other = await person();
  await inContext(browser, {}, async (page) => {
    await requestRecovery(page, other.email);
    await expect(page.getByText(SENT)).toBeVisible();
    await waitForMails(other.email, 1);
  });
}

test("recuperación completa: pedir, abrir el enlace del buzón, guardar, y entrar con la nueva @telefono", async ({ page, browser, context }) => {
  const ana = await person();
  expect(await parameter("VIGENCIA_ENLACE_CONTRASENA")).toBe(60);

  // Una sesión abierta en otro navegador, que tiene que quedar fuera.
  const elsewhere = await browser.newContext();
  const otherPage = await elsewhere.newPage();
  await signIn(otherPage, ana);
  await expect(otherPage).toHaveURL("/inicio");
  expect(await sessionCount(ana.id)).toBe(1);

  await page.goto("/entrar");
  await page.getByRole("link", { name: "Olvidé mi contraseña" }).click();
  await expect(page).toHaveURL("/recuperar");
  await expect(page.getByRole("heading", { level: 1, name: "Recupera tu contraseña" })).toBeVisible();
  await expect(page).toHaveTitle("Recuperar contraseña · La Plataforma");
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByLabel("Correo").fill(ana.email);
  await page.getByRole("button", { name: "Mandarme el enlace" }).click();
  await expect(page.getByText(SENT)).toBeVisible();
  // La pantalla no cambia de lugar, y no repite el correo.
  await expect(page).toHaveURL("/recuperar");
  await expect(page.getByLabel("Correo")).toHaveValue("");
  expect(await a11yViolations(page)).toEqual([]);

  const mail = await lastMailTo(ana.email);
  expect(mail.subject).toBe("Cambia tu contraseña");
  const token = tokenHashIn(mail, "recuperar");

  await page.goto(`/recuperar/${token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Elige tu contraseña nueva" })).toBeVisible();
  await expect(page).toHaveTitle("Contraseña nueva · La Plataforma");
  expect(await a11yViolations(page)).toEqual([]);
  // Abrir el enlace no cerró nada.
  expect(await sessionCount(ana.id)).toBe(1);

  await savePassword(page, NEW_PASSWORD);

  // Va a entrar, con el aviso, y sin sesión: la persona entra con su contraseña nueva.
  await expect(page).toHaveURL("/entrar");
  await expect(page.getByText(CHANGED)).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)).toBeUndefined();
  expect(await sessionCount(ana.id)).toBe(0);
  expect(await a11yViolations(page)).toEqual([]);

  // La contraseña vieja ya no entra; la nueva, sí.
  await signIn(page, ana);
  await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
  await signIn(page, { email: ana.email, password: NEW_PASSWORD });
  await expect(page).toHaveURL("/inicio");

  // La sesión del otro navegador quedó fuera.
  await otherPage.goto("/inicio");
  await expect(otherPage).toHaveURL(/\/entrar/);
  await elsewhere.close();

  // Y llega el aviso de que la contraseña cambió (CO-26).
  const mails = await waitForMails(ana.email, 2);
  expect(mails.map((each) => each.subject)).toContain("Tu contraseña cambió");
});

test("el aviso de éxito no sale por abrir la pantalla de entrar desde cualquier enlace", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page.getByRole("heading", { level: 1, name: "Inicia sesión" })).toBeVisible();
  await expect(page.getByText(CHANGED)).toHaveCount(0);
});

test("recuperar un correo sin cuenta contesta lo mismo, y no manda nada", async ({ page, browser }) => {
  const nobody = testEmail();
  await requestRecovery(page, nobody);
  await expect(page.getByText(SENT)).toBeVisible();
  await expect(page).toHaveURL("/recuperar");

  await controlMail(browser);
  expect(await mailsTo(nobody)).toHaveLength(0);
  // Pedir la recuperación de un correo sin cuenta no le crea ninguna.
  expect(await ownerQuery("select 1 from auth.users where email = $1", [nobody])).toHaveLength(0);
});

test("antes de la espera, pedir otro enlace contesta lo mismo y no manda nada; pasada, sí", async ({ page, browser }) => {
  const ana = await person();
  const first = await recoveryLink(page, ana.email);
  const wait = (await parameter("ESPERA_REENVIO")) + 1;
  const lastMailRows = () =>
    ownerQuery<{ bucket: string }>("select bucket from private.rate_limit_counters where bucket like 'mail:recover:last:%'");

  // Auth lleva su propia espera entre dos correos a la misma cuenta. Se le quita de en medio
  // antes de la segunda petición: así, si no sale otro correo, es porque la aplicación no lo
  // pidió, y no porque Auth lo haya rechazado.
  await ageAuthRecoveryMail(ana.email, wait);
  expect(await lastMailRows()).toHaveLength(1);
  await requestRecovery(page, ana.email);
  await expect(page.getByText(SENT)).toBeVisible();
  await controlMail(browser);
  expect(await mailsTo(ana.email)).toHaveLength(1);
  // El envío anotado sigue anotado: no se deshizo, que es lo que pasa cuando Auth rechaza.
  // Son dos filas: la de Ana y la del correo de control.
  expect(await lastMailRows()).toHaveLength(2);

  expect(await ageLastMails(wait)).toBe(2);
  await ageAuthRecoveryMail(ana.email, wait);
  await requestRecovery(page, ana.email);
  await expect(page.getByText(SENT)).toBeVisible();
  const second = tokenHashIn(await lastMailTo(ana.email, 2), "recuperar");
  expect(second).not.toBe(first);
});

test("pasado el tope por dirección, la recuperación pide esperar y no manda nada", async ({ page, browser }) => {
  const ana = await person();
  const otra = await person();
  await recoveryLink(page, ana.email);
  expect(await fillAddressCounters("recover", await parameter("TOPE_REGISTROS_HORA"))).toBeGreaterThan(0);

  await requestRecovery(page, otra.email);
  await expect(page.getByRole("alert").filter({ hasText: "Espera un momento antes de intentarlo de nuevo." })).toBeVisible();
  await expect(page.getByText(SENT)).toHaveCount(0);
  await expect(page.getByLabel("Correo")).toHaveValue(otra.email);

  // El tope de la recuperación es suyo: no le cierra el registro a nadie.
  await page.goto("/registro");
  const nueva = testEmail();
  await page.getByLabel("Correo").fill(nueva);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page).toHaveURL("/verificar");
  await waitForMails(nueva, 1);

  await clearCounters();
  await controlMail(browser);
  expect(await mailsTo(otra.email)).toHaveLength(0);
});

test("un correo sin forma se marca en el campo y no se pide nada", async ({ page }) => {
  await page.goto("/recuperar");
  await page.getByRole("button", { name: "Mandarme el enlace" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "por corregir" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Escribe tu correo." })).toBeVisible();
  expect(await ownerQuery("select 1 from private.rate_limit_counters")).toHaveLength(0);
});

test("una contraseña que no cumple la regla no gasta el enlace; usado, dice que ya no sirve y deja pedir otro", async ({ page, browser }) => {
  const ana = await person();
  const token = await recoveryLink(page, ana.email);

  // Abrirlo dos veces no lo gasta.
  for (let opened = 0; opened < 2; opened += 1) {
    expect((await page.goto(`/recuperar/${token}`))?.status()).toBe(200);
  }
  await hydrated(page);

  // Con JavaScript, la regla se marca al cumplirse, y una contraseña corta no se envía.
  await page.getByLabel("Contraseña nueva").fill("corta");
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "por corregir" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Tu contraseña necesita 8 caracteres o más." })).toBeVisible();
  await expect(page.getByLabel("Contraseña nueva")).toHaveValue("corta");
  expect(await a11yViolations(page)).toEqual([]);

  // Sin JavaScript revisa el servidor, antes de canjear nada.
  await inContext(browser, { javaScriptEnabled: false }, async (plain) => {
    await plain.goto(`/recuperar/${token}`);
    await savePassword(plain, "corta");
    await expect(plain.getByText("Tu contraseña necesita 8 caracteres o más.").first()).toBeVisible();
    await expect(plain.getByLabel("Contraseña nueva")).toHaveValue("");
    await expect(plain).toHaveURL(`/recuperar/${token}`);
  });

  // La contraseña de siempre sigue sirviendo: nada cambió.
  await inContext(browser, {}, async (other) => {
    await signIn(other, ana);
    await expect(other).toHaveURL("/inicio");
  });

  // El enlace sigue sirviendo.
  await savePassword(page, NEW_PASSWORD);
  await expect(page).toHaveURL("/entrar");
  await expect(page.getByText(CHANGED)).toBeVisible();

  // Usado, ya no sirve: se descubre al guardar.
  await page.goto(`/recuperar/${token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Elige tu contraseña nueva" })).toBeVisible();
  await savePassword(page, "una-tercera-clave-3");
  await expect(page.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("link", { name: "Pedir otro" }).click();
  await expect(page).toHaveURL("/recuperar");

  // Y la contraseña que quedó es la del primer guardado.
  await signIn(page, { email: ana.email, password: NEW_PASSWORD });
  await expect(page).toHaveURL("/inicio");
});

test("el mensaje al salir del campo no le quita el clic a quien tarda en soltar el botón", async ({ page }) => {
  await page.goto(`/recuperar/${"g".repeat(56)}`);
  await hydrated(page);
  await page.getByLabel("Contraseña nueva").fill("corta");
  // Una persona tarda en soltar el botón del ratón; un guion, no. Al bajarlo, el foco sale
  // del campo. Si el mensaje del campo se pintara en ese momento, el botón se recorrería y
  // el clic caería en otro lado: no pasaría nada.
  // El clic va pegado al borde de arriba del botón: con que el botón baje unos pixeles, el
  // puntero ya no está sobre él. Así el caso no depende de cuánto mida el mensaje.
  await page.getByRole("button", { name: "Guardar contraseña" }).click({ delay: 500, position: { x: 12, y: 3 } });
  const summary = page.getByRole("alert").filter({ hasText: "por corregir" });
  await expect(summary).toBeFocused();
  await expect(page.getByLabel("Contraseña nueva")).toHaveAttribute("aria-invalid", "true");
});

test("sin JavaScript también se recupera la contraseña", async ({ browser }) => {
  const ana = await person();
  await inContext(browser, { javaScriptEnabled: false }, async (page) => {
    await requestRecovery(page, "ana-sin-arroba");
    await expect(page.getByText("Ese correo no tiene forma de correo. Revísalo.").first()).toBeVisible();
    await expect(page.getByLabel("Correo")).toHaveValue("ana-sin-arroba");

    const token = await recoveryLink(page, ana.email);
    await page.goto(`/recuperar/${token}`);
    await savePassword(page, NEW_PASSWORD);
    await expect(page).toHaveURL("/entrar");
    await expect(page.getByText(CHANGED)).toBeVisible();

    await signIn(page, { email: ana.email, password: NEW_PASSWORD });
    await expect(page).toHaveURL("/inicio");
  });
});

test("quien no fijó su contraseña desde su buzón la elige recuperándola, y al entrar completa su cuenta", async ({ page }) => {
  const sinReclamar = await person("unclaimed");
  await signIn(page, sinReclamar);
  await expect(page).toHaveURL("/recuperar");
  await expect(page.getByText("Para entrar a esta cuenta hay que elegir su contraseña desde tu correo.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByLabel("Correo").fill(sinReclamar.email);
  await page.getByRole("button", { name: "Mandarme el enlace" }).click();
  await expect(page.getByText(SENT)).toBeVisible();
  // El aviso con el que se llegó ya no vuelve a salir.
  await expect(page.getByText("Para entrar a esta cuenta hay que elegir su contraseña desde tu correo.")).toHaveCount(0);
  expect((await page.context().cookies()).find((cookie) => cookie.name === "plataforma-aviso")).toBeUndefined();

  const token = tokenHashIn(await lastMailTo(sinReclamar.email), "recuperar");
  await page.goto(`/recuperar/${token}`);
  await savePassword(page, NEW_PASSWORD);
  await expect(page).toHaveURL("/entrar");

  // Ya entra, y antes que nada se le pide lo que le falta a su cuenta (FL-06, A1).
  await signIn(page, { email: sinReclamar.email, password: NEW_PASSWORD });
  await expect(page).toHaveURL("/consentimientos");
});

test("una dirección que no tiene forma de enlace pinta «Ese enlace ya no sirve», y un enlace inventado lo dice al guardar", async ({ page }) => {
  await page.goto("/recuperar/corto");
  await expect(page.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
  await expect(page.getByLabel("Contraseña nueva")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Pedir otro" })).toHaveAttribute("href", "/recuperar");

  await page.goto(`/recuperar/${"e".repeat(56)}`);
  await savePassword(page, NEW_PASSWORD);
  await expect(page.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
});

test("quien tiene sesión también puede pedir la recuperación y abrir su enlace", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  await page.goto("/recuperar");
  await expect(page.getByRole("heading", { level: 1, name: "Recupera tu contraseña" })).toBeVisible();

  const token = await recoveryLink(page, ana.email);
  await page.goto(`/recuperar/${token}`);
  await savePassword(page, NEW_PASSWORD);
  // Se cierran todas las sesiones de la cuenta, también la de este navegador.
  await expect(page).toHaveURL("/entrar");
  await expect(page.getByText(CHANGED)).toBeVisible();
  expect(await sessionCount(ana.id)).toBe(0);
  await page.goto("/inicio");
  await expect(page).toHaveURL(/\/entrar/);
});

test("las acciones de la recuperación aguantan un formulario que su pantalla nunca mandaría", async ({ page, request }) => {
  const ask = actionFields(await (await page.request.get("/recuperar")).text());
  const file = { name: "correo.txt", mimeType: "text/plain", buffer: Buffer.from("ana@prueba.test") };
  const emails: Record<string, Field>[] = [{}, { email: file }, { email: "x".repeat(5_000) }];
  for (const fields of emails) {
    const response = await postAction(request, "/recuperar", { ...ask, ...fields });
    // La acción sí corrió, y contestó con la pantalla y su error: no es que no se haya llamado.
    expect(response.status(), JSON.stringify(Object.keys(fields))).toBe(200);
    expect(await response.text()).toContain("Escribe tu correo.");
  }
  expect(await ownerQuery("select 1 from private.rate_limit_counters")).toHaveLength(0);
  // Y con un correo de verdad, la misma puerta sí llega al servicio.
  const real = await postAction(request, "/recuperar", { ...ask, email: testEmail() });
  expect(real.status()).toBe(200);
  expect(await real.text()).toContain("Si ese correo tiene cuenta");
  expect((await ownerQuery("select 1 from private.rate_limit_counters")).length).toBeGreaterThan(0);

  const token = "f".repeat(56);
  const change = actionFields(await (await page.request.get(`/recuperar/${token}`)).text());
  const odd: Record<string, Field>[] = [
    { token: file, password: file },
    { token: "corto", password: NEW_PASSWORD },
    { token: "x".repeat(5_000), password: NEW_PASSWORD },
    { password: "x".repeat(5_000) },
  ];
  for (const fields of odd) {
    const response = await postAction(request, `/recuperar/${token}`, { ...change, ...fields });
    expect(response.status(), JSON.stringify(Object.keys(fields))).toBe(200);
    expect(response.headers().location).toBeUndefined();
    const body = await response.text();
    expect(body).not.toContain(NEW_PASSWORD);
    // La acción sí corrió: contestó con un error de la contraseña o con «ese enlace ya no sirve».
    expect(body).toMatch(/Ese enlace ya no sirve|Esa contraseña es demasiado larga|Tu contraseña necesita/);
  }
});

test("recuperar una cuenta con otra abierta en ese navegador la cierra, y lleva a entrar con el aviso", async ({ page, context }) => {
  const ana = await person();
  const otra = await person();
  // El enlace de Ana se pide desde un navegador sin sesión.
  const token = await recoveryLink(page, ana.email);

  // Y se abre en uno donde está abierta la cuenta de otra persona.
  await signIn(page, otra);
  await expect(page).toHaveURL("/inicio");
  await page.goto(`/recuperar/${token}`);
  await savePassword(page, NEW_PASSWORD);

  // No se queda dentro de la otra cuenta sin que nada se lo diga: llega a entrar, con el aviso.
  await expect(page).toHaveURL("/entrar");
  await expect(page.getByText(CHANGED)).toBeVisible();
  expect((await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)).toBeUndefined();
  expect(await sessionCount(otra.id)).toBe(0);

  await signIn(page, { email: ana.email, password: NEW_PASSWORD });
  await expect(page).toHaveURL("/inicio");
  await expect(page.getByText(`Entraste como ${ana.email}.`)).toBeVisible();
});

test("pedir una recuperación desde otro sitio se rechaza y no deja rastro", async ({ page, request, browser }) => {
  const ana = await person();
  const fields = actionFields(await (await page.request.get("/recuperar")).text());
  for (const origin of ["https://otro.example", "http://localhost:3001", "null"]) {
    const rejected = await postAction(request, "/recuperar", { ...fields, email: ana.email }, origin);
    expect(rejected.status(), origin).toBeGreaterThanOrEqual(400);
    expect(await ownerQuery("select 1 from private.rate_limit_counters"), origin).toHaveLength(0);
  }
  await controlMail(browser);
  expect(await mailsTo(ana.email)).toHaveLength(0);
});

for (const javaScriptEnabled of [true, false]) {
  test(`recuperar deja el resguardo del buzón en ese navegador, y solo ahí (${javaScriptEnabled ? "con" : "sin"} JavaScript)`, async ({ browser }) => {
    const ana = await person();
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      const page = await context.newPage();
      const token = await recoveryLink(page, ana.email);
      const ticketOf = async () => (await context.cookies()).find((cookie) => cookie.name === "plataforma-resguardo");
      // Pedir el enlace no prueba nada: abrirlo y fijar la contraseña, sí.
      expect(await ticketOf()).toBeUndefined();
      await page.goto(`/recuperar/${token}`);
      expect(await ticketOf()).toBeUndefined();
      await savePassword(page, NEW_PASSWORD);
      await expect(page).toHaveURL("/entrar");
      await expect(page.getByText(CHANGED)).toBeVisible();

      const ticket = await ticketOf();
      expect(ticket).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
      expect(ticket?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Dura lo que dice su parámetro: ni es de sesión, ni vive más.
      const life = (ticket?.expires ?? 0) - Date.now() / 1_000;
      const lifetime = (await parameter("VIGENCIA_PRUEBA_BUZON_MINUTOS")) * 60;
      expect(life).toBeGreaterThan(lifetime - 60);
      expect(life).toBeLessThanOrEqual(lifetime + 5);
      // Recuperar no abre sesión: el resguardo no es una.
      expect((await context.cookies()).find((cookie) => cookie.name === "plataforma-sesion")).toBeUndefined();
      // El aviso «tu contraseña cambió» también llega: se espera antes de terminar.
      await waitForMails(ana.email, 2);
    } finally {
      await context.close();
    }
  });
}

