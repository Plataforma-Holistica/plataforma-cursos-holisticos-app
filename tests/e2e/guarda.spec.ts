import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { a11yViolations } from "./support/a11y";
import { hydrated } from "./support/actions";
import {
  clearCounters,
  currentTextIds,
  forgetNotedSessions,
  grantedDocTypes,
  ownerQuery,
  person,
  SESSION_COOKIE,
  sessionCount,
  type Person,
} from "./support/stack";

// La guarda de sesión en las pantallas (flujo de la app §6.2; diseño PA-15): quién llega a
// qué, y lo que se le pide antes a una cuenta a la que le falta algo.

test.beforeEach(clearCounters);

async function signIn(page: Page, who: Pick<Person, "email" | "password">): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const sessionCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE);

const profileName = async (id: string) =>
  (await ownerQuery<{ display_name: string | null }>("select display_name from public.profiles where id = $1", [id]))[0]
    ?.display_name ?? null;

const HISTORY = "Doy mi permiso para que La Plataforma guarde mi historial de cursos con esos fines.";

async function tickEverything(page: Page): Promise<void> {
  await page.getByLabel("Tengo 18 años cumplidos o más.").check();
  await page.getByRole("checkbox", { name: /Leí y acepto: Términos/ }).check();
  await page.getByRole("checkbox", { name: /Leí y acepto: Aviso de privacidad/ }).check();
  await page.getByLabel(HISTORY).check();
}

test("a una cuenta sin completar se le pide lo que falta antes que cualquier otra pantalla @telefono", async ({ page }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva);

  await expect(page).toHaveURL("/consentimientos");
  await expect(page.getByRole("heading", { level: 1, name: "Completa tu cuenta" })).toBeVisible();
  await expect(page).toHaveTitle("Antes de seguir · La Plataforma");
  // Ninguna casilla viene marcada.
  for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
  // El historial se lee completo, junto a su casilla: cada párrafo del texto de la base.
  const [history] = await ownerQuery<{ body: string }>(
    "select body from public.legal_documents where id = private.current_legal_document('course_history_consent')",
  );
  const paragraphs = (history?.body ?? "").split(/\n\s*\n/).filter((block) => block.trim() !== "" && !block.startsWith("#"));
  expect(paragraphs.length).toBeGreaterThan(1);
  for (const paragraph of paragraphs) {
    await expect(page.getByRole("group", { name: /Tu historial de cursos/ })).toContainText(paragraph.replace(/\s+/g, " ").trim());
  }

  // Escribir la dirección a mano no se la salta, y recuerda a dónde iba.
  await page.goto("/inicio");
  await expect(page).toHaveURL("/consentimientos?volver=%2Finicio");

  await page.getByLabel("Nombre").fill("Ana de Prueba");
  await tickEverything(page);
  await page.getByRole("button", { name: "Aceptar y seguir" }).click();

  await expect(page).toHaveURL("/inicio");
  expect(await profileName(nueva.id)).toBe("Ana de Prueba");
  expect(await grantedDocTypes(nueva.id)).toEqual(["course_history_consent", "student_privacy_notice", "terms"]);
  // La evidencia de cada consentimiento: desde qué navegador se dio, y que fue en esta pantalla.
  const evidence = await ownerQuery<{ origin: string; user_agent: string | null }>(
    "select distinct origin, user_agent from public.consents where profile_id = $1",
    [nueva.id],
  );
  expect(evidence).toEqual([{ origin: "login_prompt", user_agent: await page.evaluate(() => navigator.userAgent) }]);

  // Ya completa, la pantalla que pedía lo que faltaba la manda a su inicio.
  await page.goto("/consentimientos");
  await expect(page).toHaveURL("/inicio");
});

test("después de completar la cuenta se va a donde se iba", async ({ page }) => {
  const nueva = await person("claimed");
  await page.goto("/entrar?volver=%2Finicio%3Fpestana%3D2");
  await page.getByLabel("Correo").fill(nueva.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(nueva.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL("/consentimientos?volver=%2Finicio%3Fpestana%3D2");

  await page.getByLabel("Nombre").fill("Ana de Prueba");
  await tickEverything(page);
  await page.getByRole("button", { name: "Aceptar y seguir" }).click();
  await expect(page).toHaveURL("/inicio?pestana=2");
});

test("lo que falta se dice antes de enviar, sin perder lo ya marcado", async ({ page }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva);
  await expect(page).toHaveURL("/consentimientos");
  await hydrated(page);

  await page.getByLabel("Tengo 18 años cumplidos o más.").check();
  await page.getByRole("button", { name: "Aceptar y seguir" }).click();

  const summary = page.getByRole("alert").filter({ hasText: "Hay 4 datos por corregir" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Escribe tu nombre." })).toBeVisible();
  await expect(summary.getByRole("link", { name: /Falta aceptar: Términos/ })).toBeVisible();
  await expect(summary.getByRole("link", { name: /Falta aceptar: Aviso de privacidad/ })).toBeVisible();
  await expect(summary.getByRole("link", { name: /Falta aceptar: Tu historial de cursos/ })).toBeVisible();
  await expect(page.getByLabel("Tengo 18 años cumplidos o más.")).toBeChecked();
  // Nada se guardó.
  expect(await grantedDocTypes(nueva.id)).toEqual([]);
  expect(await a11yViolations(page)).toEqual([]);

  // Al salir del campo, un nombre que no se puede guardar se marca sin esperar al envío.
  await page.getByLabel("Nombre").fill("---");
  await page.getByLabel(HISTORY).focus();
  await expect(page.getByText("Ese nombre tiene caracteres que no podemos guardar. Escríbelo de nuevo.")).toBeVisible();
});

test("«Cerrar sesión» es la otra salida de esa pantalla", async ({ page }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva);
  await expect(page).toHaveURL("/consentimientos");
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL("/");
  expect(await sessionCookie(page)).toBeUndefined();
  expect(await sessionCount(nueva.id)).toBe(0);
});

async function withoutJavaScript<T>(browser: Browser, work: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    return await work(await context.newPage());
  } finally {
    await context.close();
  }
}

test("sin JavaScript también se entra, se completa la cuenta y se sale", async ({ browser }) => {
  const nueva = await person("claimed");
  await withoutJavaScript(browser, async (page) => {
    await signIn(page, { email: nueva.email, password: "equivocada-1" });
    await expect(page.getByText("El correo o la contraseña no coinciden.")).toBeVisible();
    await expect(page.getByLabel("Correo")).toHaveValue(nueva.email);

    await signIn(page, nueva);
    await expect(page).toHaveURL("/consentimientos");

    // Sin JavaScript revisa el servidor: dice qué falta, y conserva el nombre.
    await page.getByLabel("Nombre").fill("Ana sin JavaScript");
    await page.getByLabel("Tengo 18 años cumplidos o más.").check();
    await page.getByRole("button", { name: "Aceptar y seguir" }).click();
    await expect(page.getByText("Hay 3 datos por corregir")).toBeVisible();
    await expect(page.getByLabel("Nombre")).toHaveValue("Ana sin JavaScript");
    expect(await grantedDocTypes(nueva.id)).toEqual([]);

    await tickEverything(page);
    await page.getByRole("button", { name: "Aceptar y seguir" }).click();
    await expect(page).toHaveURL("/inicio");
    expect(await profileName(nueva.id)).toBe("Ana sin JavaScript");
    expect(await grantedDocTypes(nueva.id)).toHaveLength(3);

    await page.getByRole("button", { name: "Salir" }).click();
    await expect(page).toHaveURL("/");
    expect(await sessionCount(nueva.id)).toBe(0);
  });
});

for (const javaScript of [true, false]) {
  test(`aceptar un texto que ya no es el vigente no guarda nada, y la pantalla queda con el vigente (${javaScript ? "con" : "sin"} JavaScript)`, async ({ browser }) => {
    const nueva = await person("claimed");
    const real = (await currentTextIds()).terms ?? "";
    const stale = randomUUID();
    const context = await browser.newContext({ javaScriptEnabled: javaScript });
    const page = await context.newPage();
    try {
      await signIn(page, nueva);
      await expect(page).toHaveURL("/consentimientos");

      // La pantalla que la persona tiene abierta trae el texto de antes: como si el vigente
      // hubiera cambiado mientras leía.
      await page.route("**/consentimientos", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        return route.fulfill({ response, body: (await response.text()).replaceAll(real, stale) });
      });
      await page.reload();
      await page.unroute("**/consentimientos");
      await expect(page.locator(`input[name="shown"][value="terms=${stale}"]`)).toHaveCount(1);

      await page.getByLabel("Nombre").fill("Ana de Prueba");
      await tickEverything(page);
      await page.getByRole("button", { name: "Aceptar y seguir" }).click();

      await expect(page.getByText("Actualizamos un texto mientras llenabas el formulario. Léelo y marca de nuevo.")).toBeVisible();
      expect(await grantedDocTypes(nueva.id)).toEqual([]);
      expect(await profileName(nueva.id)).toBeNull();
      // La pantalla quedó con el texto vigente, y sin casillas marcadas.
      await expect(page.locator(`input[name="shown"][value="terms=${real}"]`)).toHaveCount(1);
      for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
      await expect(page.getByLabel("Nombre")).toHaveValue("Ana de Prueba");

      await tickEverything(page);
      await page.getByRole("button", { name: "Aceptar y seguir" }).click();
      await expect(page).toHaveURL("/inicio");
      expect(await grantedDocTypes(nueva.id)).toHaveLength(3);
    } finally {
      await context.close();
    }
  });
}

test("una sesión que la aplicación ya no reconoce no entra: se cierra y se manda a entrar", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  expect(await forgetNotedSessions(ana.id)).toBe(1);
  // En Auth la sesión sigue viva y su token verifica: lo único que cambió es que la
  // aplicación ya no la tiene anotada como suya.
  expect(await sessionCount(ana.id)).toBe(1);

  await page.goto("/inicio");
  await expect(page).toHaveURL("/entrar");
  expect(await sessionCookie(page)).toBeUndefined();
  expect(await sessionCount(ana.id)).toBe(0);
});

test("la ruta que cierra sesiones no le cierra la suya a quien sí pasa", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  const before = await sessionCookie(page);

  await page.goto("/sesion/cerrar");
  await expect(page).toHaveURL("/inicio");
  expect((await sessionCookie(page))?.value).toBe(before?.value);
  expect(await sessionCount(ana.id)).toBe(1);

  // Una petición HEAD no corre la ruta: ni siquiera cuando la sesión sí habría que cerrarla.
  expect(await forgetNotedSessions(ana.id)).toBe(1);
  const head = await page.request.head("/sesion/cerrar", { maxRedirects: 0 });
  expect(head.status()).toBe(405);
  expect((await sessionCookie(page))?.value).toBe(before?.value);
  expect(await sessionCount(ana.id)).toBe(1);

  // Con esa misma sesión, la lectura sí la cierra.
  await page.goto("/sesion/cerrar");
  await expect(page).toHaveURL("/entrar");
  expect(await sessionCookie(page)).toBeUndefined();
  expect(await sessionCount(ana.id)).toBe(0);
});

test("sin sesión, la ruta que cierra sesiones solo manda a entrar", async ({ page }) => {
  await page.goto("/sesion/cerrar");
  await expect(page).toHaveURL("/entrar");
});

test("una acción enviada desde otro sitio se rechaza y no deja rastro", async ({ page }) => {
  const ana = await person();
  const html = await (await page.request.get("/entrar")).text();
  const form = /<form[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
  const hidden: Record<string, string> = {};
  for (const [input] of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(input)?.[1];
    const value = /value="([^"]*)"/.exec(input)?.[1] ?? "";
    const decode = (text: string) => text.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
    if (name) hidden[decode(name)] = decode(value);
  }
  // Sin los campos con que React nombra la acción, lo de abajo no probaría nada.
  expect(Object.keys(hidden).some((name) => name.startsWith("$ACTION"))).toBe(true);

  const counted = async () =>
    Number(
      (await ownerQuery<{ n: string }>(
        "select ((select count(*) from private.login_throttles) + (select count(*) from private.rate_limit_counters))::text as n",
      ))[0]?.n,
    );
  const send = (origin: string) =>
    page.request.post("/entrar", {
      multipart: { ...hidden, email: ana.email, password: "no-es-la-suya" },
      headers: { Origin: origin },
      maxRedirects: 0,
    });

  for (const origin of ["https://otro.example", "http://localhost:3001", "null"]) {
    const rejected = await send(origin);
    expect(rejected.status(), origin).toBeGreaterThanOrEqual(400);
    expect(await counted(), origin).toBe(0);
  }

  // El mismo envío, desde el propio sitio, sí llega al servicio y cuenta el intento.
  const accepted = await send("http://localhost:3000");
  expect(accepted.status()).toBeLessThan(400);
  expect(await counted()).toBeGreaterThan(0);
});

test("un texto legal se lee con su versión y su fecha, y uno que no existe no se encuentra @telefono", async ({ page }) => {
  await page.goto("/legal/terminos");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Términos y condiciones");
  await expect(page.getByText(/^Versión 0 · vigente desde el \d{1,2} de \p{L}+ de \d{4}$/u)).toBeVisible();
  await expect(page.getByText("Borrador sin validez legal. Solo existe en una base de desarrollo.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  for (const path of ["/legal/no-existe", "/legal/terms", "/legal/license_annex"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "No encontramos esa página" })).toBeVisible();
  }
});

test("las pantallas con sesión pasan las reglas de accesibilidad @telefono", async ({ page }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva);
  await expect(page).toHaveURL("/consentimientos");
  expect(await a11yViolations(page)).toEqual([]);

  await page.getByLabel("Nombre").fill("Ana de Prueba");
  await tickEverything(page);
  await page.getByRole("button", { name: "Aceptar y seguir" }).click();
  await expect(page).toHaveURL("/inicio");
  expect(await a11yViolations(page)).toEqual([]);
});

test("ninguna pantalla de la cuenta se guarda en caché", async ({ page }) => {
  for (const path of ["/entrar", "/legal/terminos"]) {
    const response = await page.request.get(path);
    expect(response.headers()["cache-control"], path).toMatch(/no-store/);
  }
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  expect((await page.request.get("/inicio")).headers()["cache-control"]).toMatch(/no-store/);
  // La redirección de la ruta que cierra sesiones, que pone su cabecera a mano.
  const closing = await page.request.get("/sesion/cerrar", { maxRedirects: 0 });
  expect(closing.status()).toBe(307);
  expect(closing.headers()["cache-control"]).toBe("private, no-cache, no-store, must-revalidate, max-age=0");

  const nueva = await person("claimed");
  await page.context().clearCookies();
  await signIn(page, nueva);
  await expect(page).toHaveURL("/consentimientos");
  expect((await page.request.get("/consentimientos")).headers()["cache-control"]).toMatch(/no-store/);
});
