import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { actionFields, hydrated, postAction, type Field } from "./support/actions";
import {
  ageLastMails,
  clearCounters,
  currentTextIds,
  fillAddressCounters,
  grantedDocTypes,
  lastMailTo,
  mailsTo,
  ownerQuery,
  parameter,
  PENDING_COOKIE,
  person,
  SESSION_COOKIE,
  sessionCount,
  testEmail,
  tokenHashIn,
  userIdOf,
  waitForMails,
} from "./support/stack";

// El registro, de extremo a extremo (FL-02 y FL-03; diseño PA-10 y PA-14): la aplicación
// compilada contra la base, el Auth y el buzón locales. El enlace sale del buzón, como le
// llegaría a una persona.
//
// La llamada a Auth corre detrás de la respuesta. Por eso «no llegó ningún correo» se afirma
// después de esperar un correo de control, pedido más tarde: sin eso no probaría nada. Y por
// eso cada caso espera sus correos antes de terminar: la limpieza no debe ganarle a un alta
// que viene en camino.

test.beforeEach(clearCounters);

const PASSWORD = "una-clave-de-prueba-9";
const LEGAL = /^Acepto los Términos.*y el Aviso de privacidad/;
const HISTORY = "Doy mi permiso para que La Plataforma guarde mi historial de cursos con esos fines.";
const ADULT = "Tengo 18 años cumplidos o más.";
const SENT_GENERIC = "Te mandamos un enlace al correo que escribiste. Ábrelo para completar tu cuenta.";
const sentTo = (email: string) => `Te mandamos un enlace a ${email}. Ábrelo para completar tu cuenta.`;

const cookieOf = async (context: BrowserContext, name: string) => (await context.cookies()).find((cookie) => cookie.name === name);

const profileOf = async (id: string) =>
  (
    await ownerQuery<{ display_name: string | null; adult_declared_at: string | null }>(
      "select display_name, adult_declared_at::text as adult_declared_at from public.profiles where id = $1",
      [id],
    )
  )[0];

async function requestSignUp(page: Page, email: string): Promise<void> {
  await page.goto("/registro");
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
}

/** Pide un registro y devuelve la huella del enlace que llegó al buzón. */
async function signUpLink(page: Page, email: string): Promise<string> {
  await requestSignUp(page, email);
  await expect(page).toHaveURL("/verificar");
  return tokenHashIn(await lastMailTo(email), "verificar");
}

async function fillAccount(page: Page, name = "Ana de Prueba", password = PASSWORD): Promise<void> {
  await page.getByLabel("Nombre").fill(name);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
}

async function tickEverything(page: Page): Promise<void> {
  await page.getByLabel(ADULT).check();
  await page.getByRole("checkbox", { name: LEGAL }).check();
  await page.getByLabel(HISTORY).check();
}

const confirm = (page: Page) => page.getByRole("button", { name: "Confirmar mi correo" }).click();

async function inContext<T>(browser: Browser, options: Parameters<Browser["newContext"]>[0], work: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await work(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * Un correo de control: un registro nuevo, pedido ahora desde otro navegador, y esperado
 * hasta que llega. Lo que se pidió antes ya tuvo tiempo de salir.
 */
async function controlMail(browser: Browser): Promise<void> {
  await inContext(browser, {}, async (page) => {
    const email = testEmail();
    await requestSignUp(page, email);
    await expect(page).toHaveURL("/verificar");
    await waitForMails(email, 1);
  });
}

/** Atrasa la hora del último envío que este navegador tiene anotada: así «Reenviar» se pinta habilitado. */
async function backdatePending(context: BrowserContext, seconds: number): Promise<void> {
  const cookie = await cookieOf(context, PENDING_COOKIE);
  if (!cookie) throw new Error("Este navegador no tiene anotado ningún registro.");
  const stored = JSON.parse(Buffer.from(cookie.value, "base64url").toString("utf8")) as { e: string; t: number };
  const value = Buffer.from(JSON.stringify({ e: stored.e, t: stored.t - seconds * 1_000 }), "utf8").toString("base64url");
  await context.addCookies([{ ...cookie, value }]);
}

test("registro completo: el correo, «Revisa tu correo», el enlace del buzón, el formulario, y queda dentro @telefono", async ({ page, context }) => {
  const email = testEmail();
  await page.goto("/registro");
  await expect(page.getByRole("heading", { level: 1, name: "Crea tu cuenta" })).toBeVisible();
  await expect(page).toHaveTitle("Crear cuenta · La Plataforma");
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();

  // Siempre lleva a «Revisa tu correo», y no abre sesión.
  await expect(page).toHaveURL("/verificar");
  await expect(page.getByRole("heading", { level: 1, name: "Revisa tu correo" })).toBeVisible();
  await expect(page.getByText(sentTo(email))).toBeVisible();
  const lifetime = await parameter("VIGENCIA_ENLACE_CONTRASENA");
  await expect(page.getByText(lifetime === 60 ? "Dura 1 hora." : `Dura ${lifetime} minutos.`)).toBeVisible();
  expect(await cookieOf(context, SESSION_COOKIE)).toBeUndefined();
  // El correo viaja en una cookie corta que el código de la página no puede leer, no en la dirección.
  const pending = await cookieOf(context, PENDING_COOKIE);
  expect(pending).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  // Dura lo que el enlace: ni es de sesión, ni vive más.
  const life = (pending?.expires ?? 0) - Date.now() / 1_000;
  expect(life).toBeGreaterThan(lifetime * 60 - 60);
  expect(life).toBeLessThanOrEqual(lifetime * 60 + 5);
  expect(page.url()).not.toContain(encodeURIComponent(email));
  // Recién enviado, «Reenviar» espera, y lo dice.
  await expect(page.getByRole("button", { name: "Reenviar" })).toBeDisabled();
  await expect(page.getByText("Podrás reenviarlo en 1 minuto.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // El enlace, como llega al buzón.
  const token = tokenHashIn(await lastMailTo(email), "verificar");
  const userId = await userIdOf(email);
  await page.goto(`/verificar/${token}`);
  await expect(page.getByRole("heading", { level: 1, name: "Completa tu cuenta" })).toBeVisible();
  await expect(page).toHaveTitle("Completa tu cuenta · La Plataforma");
  // Ninguna casilla viene marcada.
  for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
  expect(await a11yViolations(page)).toEqual([]);

  await fillAccount(page);
  await tickEverything(page);
  await confirm(page);

  // Un solo envío confirma el correo, fija la contraseña, guarda todo y deja dentro.
  await expect(page).toHaveURL("/inicio");
  await expect(page.getByText(`Entraste como ${email}.`)).toBeVisible();
  expect(await cookieOf(context, SESSION_COOKIE)).toMatchObject({ httpOnly: true });
  expect(await sessionCount(userId)).toBe(1);
  const profile = await profileOf(userId);
  expect(profile?.display_name).toBe("Ana de Prueba");
  expect(profile?.adult_declared_at).not.toBeNull();
  expect(await grantedDocTypes(userId)).toEqual(["course_history_consent", "student_privacy_notice", "terms"]);
  // La cuenta ya se completó en este navegador: no queda ningún correo por revisar.
  expect(await cookieOf(context, PENDING_COOKIE)).toBeUndefined();

  // Y la contraseña que eligió es con la que entra después.
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/inicio");
});

test("registrar un correo que ya tiene cuenta da la misma pantalla, y no le llega ningún correo", async ({ page, browser }) => {
  const ana = await person();
  await requestSignUp(page, ana.email);
  await expect(page).toHaveURL("/verificar");
  await expect(page.getByText(sentTo(ana.email))).toBeVisible();
  // La línea para quien ya tenía cuenta, que va siempre.
  await expect(page.getByText(/¿Ya tenías cuenta\?/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Entra", exact: true })).toHaveAttribute("href", "/entrar");
  await expect(page.getByRole("link", { name: "recupera tu contraseña" })).toHaveAttribute("href", "/recuperar");

  await controlMail(browser);
  expect(await mailsTo(ana.email)).toHaveLength(0);
  // Y su cuenta sigue como estaba: entra con su contraseña de siempre.
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(ana.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(ana.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/inicio");
  // Quien entra ya no tiene un correo por revisar en este navegador.
  expect(await cookieOf(page.context(), PENDING_COOKIE)).toBeUndefined();
  await page.goto("/verificar");
  await expect(page.getByText(SENT_GENERIC)).toBeVisible();
});

test("un correo sin forma se marca en el campo y no se pide nada", async ({ page }) => {
  await page.goto("/registro");
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "por corregir" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Escribe tu correo." })).toBeVisible();

  await hydrated(page);
  await page.getByLabel("Correo").fill("ana-sin-arroba");
  await page.getByLabel("Correo").blur();
  await expect(page.getByText("Ese correo no tiene forma de correo. Revísalo.").first()).toBeVisible();
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page).toHaveURL("/registro");
  await expect(page.getByLabel("Correo")).toHaveValue("ana-sin-arroba");
  expect(await ownerQuery("select 1 from private.rate_limit_counters")).toHaveLength(0);
});

test("pasado el tope por dirección, el registro pide esperar y no manda nada", async ({ page, browser }) => {
  // Un registro de verdad deja el contador de esta dirección; después se lleva al tope.
  const first = testEmail();
  await signUpLink(page, first);
  expect(await fillAddressCounters("signup", await parameter("TOPE_REGISTROS_HORA"))).toBeGreaterThan(0);

  const blocked = testEmail();
  await requestSignUp(page, blocked);
  await expect(page.getByRole("alert").filter({ hasText: "Espera un momento antes de intentarlo de nuevo." })).toBeVisible();
  await expect(page).toHaveURL("/registro");
  await expect(page.getByLabel("Correo")).toHaveValue(blocked);
  expect(await ownerQuery("select 1 from auth.users where email = $1", [blocked])).toHaveLength(0);

  // «Reenviar» pasa por el mismo tope.
  await page.goto("/verificar");
  await backdatePending(page.context(), 120);
  await page.reload();
  await page.getByRole("button", { name: "Reenviar" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Espera un momento antes de intentarlo de nuevo." })).toBeVisible();
  await expect(page.getByText("Listo, lo mandamos otra vez.")).toHaveCount(0);

  await clearCounters();
  await controlMail(browser);
  expect(await mailsTo(blocked)).toHaveLength(0);
  expect(await mailsTo(first)).toHaveLength(1);
});

test("«Reenviar» manda otro enlace y el anterior deja de servir; antes de la espera contesta igual y no manda nada", async ({ page, context, browser }) => {
  const email = testEmail();
  const firstToken = await signUpLink(page, email);
  await expect(page.getByRole("button", { name: "Reenviar" })).toBeDisabled();

  // Como si el navegador ya hubiera esperado, pero el servicio no: la espera de verdad es suya.
  await backdatePending(context, 120);
  await page.reload();
  await page.getByRole("button", { name: "Reenviar" }).click();
  await expect(page.getByText("Listo, lo mandamos otra vez.")).toBeVisible();
  // Tras reenviar, el botón vuelve a esperar.
  await expect(page.getByRole("button", { name: "Reenviar" })).toBeDisabled();
  await controlMail(browser);
  expect(await mailsTo(email)).toHaveLength(1);

  // Pasada la espera de verdad, sí sale otro correo, con otro enlace.
  expect(await ageLastMails((await parameter("ESPERA_REENVIO")) + 1)).toBeGreaterThan(0);
  await backdatePending(context, 120);
  await page.reload();
  await page.getByRole("button", { name: "Reenviar" }).click();
  await expect(page.getByText("Listo, lo mandamos otra vez.")).toBeVisible();
  const secondToken = tokenHashIn(await lastMailTo(email, 2), "verificar");
  expect(secondToken).not.toBe(firstToken);

  // El enlace anterior ya no sirve: se descubre al enviar, no al abrir.
  await page.goto(`/verificar/${firstToken}`);
  await expect(page.getByRole("heading", { level: 1, name: "Completa tu cuenta" })).toBeVisible();
  await fillAccount(page);
  await tickEverything(page);
  await confirm(page);
  await expect(page.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/registro");
  await expect(page.getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
  expect(await a11yViolations(page)).toEqual([]);

  // El nuevo, sí.
  await page.goto(`/verificar/${secondToken}`);
  await fillAccount(page);
  await tickEverything(page);
  await confirm(page);
  await expect(page).toHaveURL("/inicio");
});

test("«Ese no es mi correo» olvida el correo anotado y regresa al registro", async ({ page, context }) => {
  const email = testEmail();
  await signUpLink(page, email);
  await page.getByRole("button", { name: "Ese no es mi correo" }).click();
  await expect(page).toHaveURL("/registro");
  expect(await cookieOf(context, PENDING_COOKIE)).toBeUndefined();

  // Sin correo anotado, «Revisa tu correo» no tiene a quién reenviar.
  await page.goto("/verificar");
  await expect(page.getByText(SENT_GENERIC)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reenviar" })).toHaveCount(0);
  await page.getByRole("link", { name: "Escribir mi correo otra vez" }).click();
  await expect(page).toHaveURL("/registro");
  expect(await a11yViolations(page)).toEqual([]);

  // La cuenta del correo equivocado se quedó sin verificar: no sirve para entrar.
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
});

test("una cookie de registro que este código no escribió cuenta como ausente", async ({ page, context }) => {
  for (const value of ["no-es-base64-de-nada", Buffer.from('{"e":"ana@prueba.test","t":1,"x":1}').toString("base64url"), Buffer.from('{"e":"Ana@Prueba.test","t":1}').toString("base64url")]) {
    await context.addCookies([{ name: PENDING_COOKIE, value, url: "http://localhost:3000" }]);
    await page.goto("/verificar");
    await expect(page.getByText(SENT_GENERIC)).toBeVisible();
    await expect(page.getByRole("button", { name: "Reenviar" })).toHaveCount(0);
  }
});

test("quien pidió el registro no queda dentro; quien abre el enlace en otro navegador elige la contraseña y entra", async ({ page, browser }) => {
  const email = testEmail();
  const token = await signUpLink(page, email);

  await inContext(browser, {}, async (other) => {
    await other.goto(`/verificar/${token}`);
    await fillAccount(other, "Quien abrió el enlace");
    await tickEverything(other);
    await confirm(other);
    await expect(other).toHaveURL("/inicio");
    // Lo primero que ve le dice con qué cuenta entró.
    await expect(other.getByText(`Entraste como ${email}.`)).toBeVisible();
  });

  // El navegador que pidió el registro no tiene sesión.
  await page.goto("/inicio");
  await expect(page).toHaveURL("/entrar?volver=%2Finicio");
});

test("abrir el enlace no lo gasta, y los datos inválidos tampoco; usado, dice que ya no sirve y ofrece entrar", async ({ page, browser }) => {
  const email = testEmail();
  const token = await signUpLink(page, email);
  const userId = await userIdOf(email);

  // Abrirlo dos veces, como haría el lector de enlaces de un correo.
  for (let opened = 0; opened < 2; opened += 1) {
    const response = await page.goto(`/verificar/${token}`);
    expect(response?.status()).toBe(200);
  }
  await hydrated(page);

  // Con JavaScript, lo que falta se dice antes de enviar, sin perder lo escrito ni lo marcado.
  await fillAccount(page, "Ana de Prueba", "corta");
  await page.getByLabel(ADULT).check();
  await confirm(page);
  const summary = page.getByRole("alert").filter({ hasText: "Hay 3 datos por corregir" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Tu contraseña necesita 8 caracteres o más." })).toBeVisible();
  await expect(summary.getByRole("link", { name: "Falta aceptar los Términos y el Aviso de privacidad." })).toBeVisible();
  await expect(summary.getByRole("link", { name: "Falta tu permiso para guardar tu historial de cursos." })).toBeVisible();
  await expect(page.getByLabel("Nombre")).toHaveValue("Ana de Prueba");
  await expect(page.getByLabel(ADULT)).toBeChecked();
  expect(await a11yViolations(page)).toEqual([]);

  // Sin JavaScript revisa el servidor, antes de canjear nada.
  await inContext(browser, { javaScriptEnabled: false }, async (plain) => {
    await plain.goto(`/verificar/${token}`);
    await fillAccount(plain, "Ana de Prueba", "corta");
    await tickEverything(plain);
    await confirm(plain);
    await expect(plain.getByText("Tu contraseña necesita 8 caracteres o más.").first()).toBeVisible();
    await expect(plain.getByLabel("Nombre")).toHaveValue("Ana de Prueba");
    await expect(plain.getByLabel("Contraseña", { exact: true })).toHaveValue("");
  });
  expect((await profileOf(userId))?.display_name).toBeNull();
  expect(await sessionCount(userId)).toBe(0);

  // El enlace sigue sirviendo.
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await tickEverything(page);
  await confirm(page);
  await expect(page).toHaveURL("/inicio");

  // Usado, ya no sirve: quien envía dos veces ya tiene su cuenta, y la salida es entrar.
  await inContext(browser, {}, async (again) => {
    await again.goto(`/verificar/${token}`);
    await expect(again.getByRole("heading", { level: 1, name: "Completa tu cuenta" })).toBeVisible();
    await fillAccount(again, "Otra persona", "otra-clave-distinta-1");
    await tickEverything(again);
    await confirm(again);
    await expect(again.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
    await expect(again.getByRole("link", { name: "Entrar", exact: true })).toHaveAttribute("href", "/entrar");
  });
  // Y no cambió nada de la cuenta.
  expect((await profileOf(userId))?.display_name).toBe("Ana de Prueba");
});

test("sin JavaScript también se registra y se completa la cuenta", async ({ browser }) => {
  const email = testEmail();
  await inContext(browser, { javaScriptEnabled: false }, async (page) => {
    // Un correo sin forma vuelve con su error, y lo escrito se conserva.
    await requestSignUp(page, "ana-sin-arroba");
    await expect(page.getByText("Ese correo no tiene forma de correo. Revísalo.").first()).toBeVisible();
    await expect(page.getByLabel("Correo")).toHaveValue("ana-sin-arroba");

    const token = await signUpLink(page, email);
    await expect(page.getByText(sentTo(email))).toBeVisible();
    // Sin JavaScript el botón llega deshabilitado, con su razón escrita.
    await expect(page.getByRole("button", { name: "Reenviar" })).toBeDisabled();
    await expect(page.getByText("Podrás reenviarlo en 1 minuto.")).toBeVisible();

    await page.goto(`/verificar/${token}`);
    // Falta una casilla: el servidor dice cuál, y conserva el nombre.
    await fillAccount(page, "Ana sin JavaScript");
    await page.getByLabel(ADULT).check();
    await page.getByRole("checkbox", { name: LEGAL }).check();
    await confirm(page);
    await expect(page.getByText("Hay 1 dato por corregir")).toBeVisible();
    await expect(page.getByRole("link", { name: "Falta tu permiso para guardar tu historial de cursos." })).toBeVisible();
    await expect(page.getByLabel("Nombre")).toHaveValue("Ana sin JavaScript");

    await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
    await tickEverything(page);
    await confirm(page);
    await expect(page).toHaveURL("/inicio");
    await expect(page.getByText(`Entraste como ${email}.`)).toBeVisible();
  });
  const userId = await userIdOf(email);
  expect((await profileOf(userId))?.display_name).toBe("Ana sin JavaScript");
  expect(await grantedDocTypes(userId)).toHaveLength(3);
});

for (const javaScript of [true, false]) {
  test(`aceptar un texto que ya no es el vigente no gasta el enlace, y la pantalla queda con el vigente (${javaScript ? "con" : "sin"} JavaScript)`, async ({ browser, page: requester }) => {
    const email = testEmail();
    const token = await signUpLink(requester, email);
    const userId = await userIdOf(email);
    const real = (await currentTextIds()).terms ?? "";
    const stale = randomUUID();

    await inContext(browser, { javaScriptEnabled: javaScript }, async (page) => {
      // La pantalla que la persona tiene abierta trae el texto de antes: como si el vigente
      // hubiera cambiado mientras leía.
      await page.route(`**/verificar/${token}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        return route.fulfill({ response, body: (await response.text()).replaceAll(real, stale) });
      });
      await page.goto(`/verificar/${token}`);
      await page.unroute(`**/verificar/${token}`);
      await expect(page.locator(`input[name="shown"][value="terms=${stale}"]`)).toHaveCount(1);

      await fillAccount(page);
      await tickEverything(page);
      await confirm(page);

      await expect(page.getByText("Actualizamos un texto mientras llenabas el formulario. Léelo y marca de nuevo.")).toBeVisible();
      expect(await grantedDocTypes(userId)).toEqual([]);
      expect(await sessionCount(userId)).toBe(0);
      // La pantalla quedó con el texto vigente, sin casillas marcadas y con el nombre.
      await expect(page.locator(`input[name="shown"][value="terms=${real}"]`)).toHaveCount(1);
      for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
      await expect(page.getByLabel("Nombre")).toHaveValue("Ana de Prueba");

      // El enlace no se gastó: marcar de nuevo y enviar funciona.
      await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
      await tickEverything(page);
      await confirm(page);
      await expect(page).toHaveURL("/inicio");
      expect(await grantedDocTypes(userId)).toHaveLength(3);
    });
  });
}

test("una dirección que no tiene forma de enlace pinta «Ese enlace ya no sirve», sin formulario", async ({ page }) => {
  await page.goto("/verificar/corto");
  await expect(page.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
  await expect(page.getByLabel("Nombre")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/registro");
});

test("un enlace inventado se ve como uno de verdad hasta que se envía", async ({ page }) => {
  await page.goto(`/verificar/${"a".repeat(56)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Completa tu cuenta" })).toBeVisible();
  await fillAccount(page);
  await tickEverything(page);
  await confirm(page);
  await expect(page.getByRole("heading", { level: 1, name: "Ese enlace ya no sirve" })).toBeVisible();
});

test("quien ya entró no vuelve a ver el registro, pero sí puede abrir un enlace del correo", async ({ page }) => {
  const ana = await person();
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(ana.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(ana.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/inicio");

  await page.goto("/registro");
  await expect(page).toHaveURL("/inicio");
  await page.goto("/verificar");
  await expect(page.getByRole("heading", { level: 1, name: "Revisa tu correo" })).toBeVisible();
  await page.goto(`/verificar/${"b".repeat(56)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Completa tu cuenta" })).toBeVisible();
});

test("las páginas con la huella de un enlace no la dejan salir a otro sitio, y ninguna se guarda en caché", async ({ page }) => {
  for (const path of [`/verificar/${"c".repeat(56)}`, `/recuperar/${"c".repeat(56)}`, "/verificar/corto", "/recuperar/corto"]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    // No es `no-referrer`: con ella el formulario sin JavaScript llegaría con origen nulo.
    expect(response.headers()["referrer-policy"], path).toBe("same-origin");
    expect(response.headers()["cache-control"], path).toMatch(/no-store/);
  }
  for (const path of ["/registro", "/verificar", "/recuperar"]) {
    const response = await page.request.get(path);
    expect(response.headers()["cache-control"], path).toMatch(/no-store/);
  }
  // Las páginas sin huella siguen con la política de siempre.
  expect((await page.request.get("/registro")).headers()["referrer-policy"]).not.toBe("no-referrer");
});

test("las acciones del registro aguantan un formulario que su pantalla nunca mandaría", async ({ page, request }) => {
  const signUp = actionFields(await (await page.request.get("/registro")).text());
  const file = { name: "correo.txt", mimeType: "text/plain", buffer: Buffer.from("ana@prueba.test") };
  const emails: Record<string, Field>[] = [{}, { email: file }, { email: "x".repeat(5_000) }, { email: "ana@prueba.test\u0000" }];
  for (const fields of emails) {
    const response = await postAction(request, "/registro", { ...signUp, ...fields });
    // La acción sí corrió, y contestó con la pantalla y su error: no es que no se haya llamado.
    expect(response.status(), JSON.stringify(Object.keys(fields))).toBe(200);
    expect(response.headers().location).toBeUndefined();
    expect(await response.text()).toMatch(/Escribe tu correo\.|Ese correo no tiene forma de correo/);
  }
  expect(await ownerQuery("select 1 from private.rate_limit_counters")).toHaveLength(0);

  const token = "d".repeat(56);
  const complete = actionFields(await (await page.request.get(`/verificar/${token}`)).text());
  const odd: Record<string, Field>[] = [
    { token: file, name: file, password: file },
    { name: "Ana", password: PASSWORD, adult: "on", shown: "terms=no-es-un-identificador", "accept:legal": "on" },
    { token: "corto", name: "Ana", password: PASSWORD },
    { token: "x".repeat(5_000) },
  ];
  for (const fields of odd) {
    const response = await postAction(request, `/verificar/${token}`, { ...complete, ...fields });
    expect(response.status(), JSON.stringify(Object.keys(fields))).toBe(200);
    expect(response.headers().location).toBeUndefined();
    const body = await response.text();
    expect(body).not.toContain(PASSWORD);
    // La acción sí corrió: contestó con sus errores, con el aviso del texto que cambió o con
    // «ese enlace ya no sirve».
    expect(body).toMatch(/por corregir|Actualizamos un texto|Ese enlace ya no sirve/);
  }
});

test("pedir un registro desde otro sitio se rechaza y no deja rastro", async ({ page, request, browser }) => {
  const fields = actionFields(await (await page.request.get("/registro")).text());
  const email = testEmail();
  for (const origin of ["https://otro.example", "http://localhost:3001", "null"]) {
    const rejected = await postAction(request, "/registro", { ...fields, email }, origin);
    expect(rejected.status(), origin).toBeGreaterThanOrEqual(400);
    expect(await ownerQuery("select 1 from private.rate_limit_counters"), origin).toHaveLength(0);
  }
  await controlMail(browser);
  expect(await mailsTo(email)).toHaveLength(0);
  expect(await ownerQuery("select 1 from auth.users where email = $1", [email])).toHaveLength(0);
});
