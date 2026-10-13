import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { totpCode, wrongCode } from "../../integration/helpers/totp";
import { a11yViolations } from "../support/a11y";
import { actionFields, postAction } from "../support/actions";
import {
  clearCounters,
  lastMailTo,
  ownerQuery,
  parameter,
  person,
  SESSION_COOKIE,
  sessionCount,
  testEmail,
  tokenHashIn,
  userIdOf,
  type Person,
} from "../support/stack";

// El camino de quien es del equipo, de extremo a extremo (RF-105, RF-106, RF-712; diseño
// PA-12 y PA-60; flujo de la app §6.2): invitada, prueba su buzón, configura su segundo
// factor (que es aceptar la invitación), entra de nuevo, da su código y llega a
// administración.
//
// Esto deja residuo: invitar, atar el factor y dar capacidades escriben en la auditoría, que
// no admite borrado, y las pruebas de base cuentan esos renglones. Por eso no corre con las
// demás: `pnpm test:e2e:equipo` lo corre aparte y rehace la base al terminar.

test.beforeEach(clearCounters);
// Un código no se da dos veces: entre configurar y entrar hay que esperar al siguiente.
test.describe.configure({ timeout: 150_000 });

const PASSWORD = "una-clave-de-prueba-9";
const NEW_PASSWORD = "otra-clave-de-prueba-7";
const SETUP = "/entrar/segundo-factor/configurar";
const READY = "Tu segundo factor quedó configurado. Entra con tu contraseña y escribe el código de tu aplicación.";
const WRONG = "Ese código no coincide. Revisa que sea el más reciente.";

/** Invita a ese correo a administración, como lo hace el arranque: el dueño, declarado sistema. */
async function invite(email: string, capabilities: string): Promise<string> {
  const rows = await ownerQuery<{ state: string }>(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as kind)
     select private.system_invite_admin($1, $2::public.capability[]) as state from declared`,
    [email, capabilities],
  );
  return rows[0]?.state ?? "";
}

const factorsOf = (userId: string) =>
  ownerQuery<{ id: string; status: string }>("select id::text as id, status::text as status from auth.mfa_factors where user_id = $1 order by created_at", [
    userId,
  ]);

const teamOf = async (userId: string) => ({
  bound: (await ownerQuery<{ factor: string }>("select factor_id::text as factor from private.admin_factors where profile_id = $1", [userId])).map(
    (row) => row.factor,
  ),
  capabilities: (
    await ownerQuery<{ capability: string }>(
      "select capability::text as capability from public.admin_capabilities where profile_id = $1 and revoked_at is null order by 1",
      [userId],
    )
  ).map((row) => row.capability),
});

async function signIn(page: Page, who: Pick<Person, "email" | "password">, path = "/entrar"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Registra ese correo desde el enlace de su buzón, en ese navegador, y la deja dentro. */
async function register(page: Page, email: string): Promise<void> {
  await page.goto("/registro");
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  // Con margen: es lo primero que se le pide a una aplicación recién levantada, que todavía
  // no abre su primera conexión a la base ni le ha hablado a Auth.
  await expect(page).toHaveURL("/verificar", { timeout: 20_000 });
  await page.goto(`/verificar/${tokenHashIn(await lastMailTo(email), "verificar")}`);
  await page.getByLabel("Nombre").fill("Ana de Prueba");
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Tengo 18 años cumplidos o más.").check();
  await page.getByRole("checkbox", { name: /^Acepto los Términos.*y el Aviso de privacidad/ }).check();
  await page.getByLabel("Doy mi permiso para que La Plataforma guarde mi historial de cursos con esos fines.").check();
  await page.getByRole("button", { name: "Confirmar mi correo" }).click();
}

/** Un código de ese secreto que no sea ninguno de los ya dados: Auth no acepta el mismo dos veces. */
async function nextCode(secret: string, used: string[]): Promise<string> {
  for (;;) {
    const code = totpCode(secret);
    if (!used.includes(code)) {
      used.push(code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const sessionCookie = async (context: BrowserContext) => (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE);

async function inContext<T>(browser: Browser, options: Parameters<Browser["newContext"]>[0], work: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await work(await context.newPage(), context);
  } finally {
    await context.close();
  }
}

test("invitada con cuenta nueva: se registra, configura su segundo factor, entra de nuevo, da su código y llega a administración", async ({
  page,
  context,
  browser,
}) => {
  const email = testEmail();
  expect(await invite(email, "{config,support}")).toMatch(/^invited/);
  const used: string[] = [];

  // Al terminar su registro queda dentro, con el buzón probado, y va directo a configurar.
  await register(page, email);
  await expect(page).toHaveURL(SETUP);
  const id = await userIdOf(email);
  await expect(page.getByRole("heading", { level: 1, name: "Configura tu segundo factor" })).toBeVisible();
  await expect(page).toHaveTitle("La Plataforma");
  expect(await a11yViolations(page)).toEqual([]);
  // Nada se dio de alta por abrir la página.
  expect(await factorsOf(id)).toEqual([]);

  await page.getByRole("button", { name: "Empezar" }).click();
  const qr = page.getByRole("img", { name: "Código QR con la clave de tu segundo factor" });
  await expect(qr).toBeVisible();
  // La imagen que Auth manda pasó la lista de permitidos, y se pinta como imagen de datos.
  expect(await qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(await qr.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  const secret = (await page.locator("main code").innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await expect(page.getByRole("link", { name: "Abrir en mi aplicación de códigos" })).toHaveAttribute("href", new RegExp(`^otpauth://totp/.*secret=${secret}`));
  // La clave no está en ningún campo, visible u oculto.
  expect(await page.locator("input").evaluateAll((inputs, key) => inputs.filter((input) => (input as HTMLInputElement).value.includes(key)).length, secret)).toBe(0);
  expect(await a11yViolations(page)).toEqual([]);
  expect(await factorsOf(id)).toMatchObject([{ status: "unverified" }]);

  // Un código equivocado no ata nada. La clave deja de pintarse, y el campo sigue ahí.
  await page.getByLabel("Código").fill(wrongCode(secret));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("alert").getByRole("link", { name: WRONG })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(secret);
  expect(await teamOf(id)).toEqual({ bound: [], capabilities: [] });

  // Una copia de la cookie de antes de aceptar: no debe servir después.
  const before = await sessionCookie(context);
  if (!before) throw new Error("No hay sesión antes de aceptar.");

  await page.getByLabel("Código").fill(await nextCode(secret, used));
  await page.getByRole("button", { name: "Continuar" }).click();

  // Aceptada: queda sin sesión, en la pantalla de entrar, con su aviso.
  await expect(page).toHaveURL("/entrar");
  await expect(page.getByText(READY)).toBeVisible();
  expect(await sessionCookie(context)).toBeUndefined();
  expect(await sessionCount(id)).toBe(0);
  const team = await teamOf(id);
  expect(team.capabilities).toEqual(["config", "support"]);
  expect(await factorsOf(id)).toEqual([{ id: team.bound[0], status: "verified" }]);

  // La cookie copiada ya no entra a ningún lado: la base cerró esa sesión al aceptar. Su
  // token todavía verifica, así que el paso previo la deja pasar: quien la rechaza es la
  // guarda de la página, que la manda a cerrar.
  await inContext(browser, {}, async (other, otherContext) => {
    await otherContext.addCookies([before]);
    await other.goto("/admin");
    await expect(other).toHaveURL("/entrar");
    await expect(other.getByRole("heading", { level: 1, name: "Inicia sesión" })).toBeVisible();
    expect(await sessionCookie(otherContext)).toBeUndefined();
    // Y con la cookie puesta otra vez, tampoco su inicio.
    await otherContext.addCookies([before]);
    await other.goto("/inicio");
    await expect(other).toHaveURL("/entrar");
  });

  // Entra con su contraseña: está a un código de administración, y se le pide.
  await signIn(page, { email, password: PASSWORD });
  await expect(page).toHaveURL("/entrar/segundo-factor");
  await expect(page.getByRole("heading", { level: 1, name: "Escribe tu código" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  // Sin el código no entra a administración: la guarda la devuelve aquí, guardando a dónde iba.
  await page.goto("/admin/equipo");
  await expect(page).toHaveURL("/entrar/segundo-factor?volver=%2Fadmin%2Fequipo");
  // Tampoco pidiendo la página por partes, como la pide el navegador ya dentro de la aplicación.
  const partial = await page.request.get("/admin", { headers: { RSC: "1" } });
  expect(await partial.text()).not.toMatch(/Tus capacidades|No tienes pendientes/);
  // Y el segundo factor solo se pide en administración: su inicio y su cuenta siguen abiertos.
  await page.goto("/inicio");
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();

  // La acción de dar el código, llamada directo con la sesión de una alumna: no verifica
  // nada, y la manda a la misma pantalla, donde la guarda le contesta que no existe.
  const codeFields = actionFields(await (await page.request.get("/entrar/segundo-factor")).text());
  const alumna = await person();
  await inContext(browser, {}, async (other, otherContext) => {
    await signIn(other, alumna);
    await expect(other).toHaveURL("/inicio");
    const given = await postAction(otherContext.request, "/entrar/segundo-factor", { ...codeFields, code: totpCode(secret), volver: "/admin" });
    expect(given.status()).toBe(303);
    expect(given.headers().location).toBe("/entrar/segundo-factor?volver=%2Fadmin");
    expect((await otherContext.request.get("/admin")).status()).toBe(404);
    expect(await teamOf(alumna.id)).toEqual({ bound: [], capabilities: [] });
  });
  // Y sin ninguna sesión, a entrar.
  await inContext(browser, {}, async (_other, otherContext) => {
    const given = await postAction(otherContext.request, "/entrar/segundo-factor", { ...codeFields, code: totpCode(secret), volver: "/admin" });
    expect(given.status()).toBe(303);
    expect(given.headers().location).toBe("/entrar?volver=%2Fadmin");
  });

  await page.goto("/entrar/segundo-factor");
  await page.getByLabel("Código").fill(wrongCode(secret));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("alert").getByRole("link", { name: WRONG })).toBeVisible();
  await expect(page).toHaveURL("/entrar/segundo-factor");

  await page.getByLabel("Código").fill(await nextCode(secret, used));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Administración" })).toBeVisible();
  await expect(page.getByText(`Entraste como ${email}.`)).toBeVisible();
  await expect(page.getByText("No tienes pendientes.")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveText(["Soporte", "Configuración"]);
  expect(await a11yViolations(page)).toEqual([]);
  expect((await page.request.get("/admin")).headers()["cache-control"]).toMatch(/no-store/);

  // Lo que cuelga de administración y no tiene página no existe, también para ella.
  const missing = await page.request.get("/admin/no-existe");
  expect(missing.status()).toBe(404);
  // Con el código dado, las pantallas del segundo factor la devuelven a administración.
  await page.goto("/entrar/segundo-factor");
  await expect(page).toHaveURL("/admin");
  await page.goto(SETUP);
  await expect(page).toHaveURL("/admin");

  // Sale. Al volver a pedir administración entra, da su código, y regresa a donde iba.
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL("/");
  await signIn(page, { email, password: PASSWORD }, "/entrar?volver=%2Fadmin%2Fequipo");
  await expect(page).toHaveURL("/entrar/segundo-factor?volver=%2Fadmin%2Fequipo");
  await page.getByLabel("Código").fill(await nextCode(secret, used));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL("/admin/equipo");
  await expect(page.getByRole("heading", { level: 1, name: "No encontramos esa página" })).toBeVisible();
});

test("sin JavaScript también se configura el segundo factor, y la clave no viaja en ningún campo", async ({ browser }) => {
  const email = testEmail();
  expect(await invite(email, "{content}")).toMatch(/^invited/);
  const used: string[] = [];

  await inContext(browser, { javaScriptEnabled: false }, async (page, context) => {
    await register(page, email);
    await expect(page).toHaveURL(SETUP);
    const id = await userIdOf(email);

    await page.getByRole("button", { name: "Empezar" }).click();
    await expect(page.getByRole("img", { name: "Código QR con la clave de tu segundo factor" })).toBeVisible();
    const secret = (await page.locator("main code").innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    // Sin JavaScript, el estado de una acción viaja dentro de todo formulario ligado a ella.
    // La respuesta de «Empezar» trae la clave: no debe haber ningún formulario de esa acción,
    // ni la clave en ningún campo del documento, visible u oculto.
    const html = await page.content();
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).not.toContain(secret);
      expect(input).not.toContain("otpauth");
    }
    await expect(page.getByRole("button", { name: /^Empezar/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Empezar de nuevo" })).toHaveAttribute("href", SETUP);

    // Un código equivocado: la página vuelve sin la clave, con el campo y el aviso.
    await page.getByLabel("Código").fill(wrongCode(secret));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL(SETUP);
    await expect(page.getByText(WRONG).first()).toBeVisible();
    expect(await page.content()).not.toContain(secret);
    await expect(page.getByText(/Ya empezaste a configurarlo en este navegador\./)).toBeVisible();
    // Aquí «Empezar de nuevo» sí es un formulario: su estado ya no trae ninguna clave.
    await expect(page.getByRole("button", { name: "Empezar de nuevo" })).toBeVisible();

    // Recargar no cambia la clave ni da de alta otro factor: la página no escribe nada.
    const [factor] = await factorsOf(id);
    await page.reload();
    expect(await factorsOf(id)).toEqual([factor]);

    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");
    await expect(page.getByText(READY)).toBeVisible();
    expect(await sessionCookie(context)).toBeUndefined();
    expect((await teamOf(id)).capabilities).toEqual(["content"]);

    await signIn(page, { email, password: PASSWORD });
    await expect(page).toHaveURL("/entrar/segundo-factor");
    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/admin");
    await expect(page.getByRole("listitem")).toHaveText(["Contenido"]);
  });
});

test("invitada con cuenta existente: entra, se le pide probar su buzón, recupera su contraseña y ya puede empezar", async ({ page, context }) => {
  const ana = await person();
  expect(await invite(ana.email, "{moderation}")).toBe("invited_existing");

  // Saber la contraseña no basta: este navegador no ha abierto un enlace de su correo.
  await signIn(page, ana);
  await expect(page).toHaveURL(SETUP);
  await expect(page.getByRole("heading", { level: 1, name: "Primero abre el enlace de tu correo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Empezar" })).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);
  // Sus otras pantallas siguen abiertas: no queda encerrada.
  await page.getByRole("link", { name: "Ir a mi inicio" }).click();
  await expect(page).toHaveURL("/inicio");
  // Y administración la devuelve a la pantalla que le explica.
  await page.goto("/admin");
  await expect(page).toHaveURL(SETUP);

  await page.getByRole("link", { name: "Recuperar mi contraseña" }).click();
  await expect(page).toHaveURL("/recuperar");
  await page.getByLabel("Correo").fill(ana.email);
  await page.getByRole("button", { name: "Mandarme el enlace" }).click();
  await expect(page.getByText(/Si ese correo tiene cuenta, te mandamos un enlace\./)).toBeVisible();
  await page.goto(`/recuperar/${tokenHashIn(await lastMailTo(ana.email), "recuperar")}`);
  await page.getByLabel("Contraseña nueva").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await expect(page).toHaveURL("/entrar");

  // Con el buzón probado en este navegador, entrar la lleva a «Empezar».
  await signIn(page, { email: ana.email, password: NEW_PASSWORD });
  await expect(page).toHaveURL(SETUP);
  await expect(page.getByRole("heading", { level: 1, name: "Configura tu segundo factor" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Empezar" })).toBeVisible();

  // «Cerrar sesión» se lleva el resguardo: al volver a entrar hay que probar el buzón otra vez.
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await expect(page).toHaveURL("/");
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain("plataforma-resguardo");
  await signIn(page, { email: ana.email, password: NEW_PASSWORD });
  await expect(page).toHaveURL(SETUP);
  await expect(page.getByRole("heading", { level: 1, name: "Primero abre el enlace de tu correo" })).toBeVisible();
});

test("las acciones de configurar, llamadas directo por quien no es del equipo, no hacen nada", async ({ page, browser }) => {
  // Los campos con que React nombra las acciones salen de la página de alguien invitada.
  const email = testEmail();
  expect(await invite(email, "{support}")).toMatch(/^invited/);
  await register(page, email);
  await expect(page).toHaveURL(SETUP);
  const startFields = actionFields(await (await page.request.get(SETUP)).text());
  // Ya empezado, la página trae el formulario de confirmar: es el primero.
  await page.getByRole("button", { name: "Empezar" }).click();
  await expect(page.locator("main code")).toBeVisible();
  const invitedId = await userIdOf(email);
  const [started] = await factorsOf(invitedId);
  if (!started) throw new Error("La invitada no tiene un factor empezado.");
  const confirmFields = actionFields(await (await page.request.get(SETUP)).text());
  expect(Object.keys(confirmFields)).toContain("painted");

  const alumna = await person();
  await inContext(browser, {}, async (other, otherContext) => {
    await signIn(other, alumna);
    await expect(other).toHaveURL("/inicio");

    // «Empezar», con la sesión de una alumna: no da de alta nada, y la manda a la misma
    // ruta, donde la guarda le contesta que no existe.
    const begun = await postAction(otherContext.request, SETUP, startFields);
    expect(begun.status()).toBe(303);
    expect(begun.headers().location).toBe(SETUP);
    expect(await factorsOf(alumna.id)).toEqual([]);
    expect((await otherContext.cookies()).map((cookie) => cookie.name)).not.toContain("plataforma-factor");
    expect((await otherContext.request.get(SETUP)).status()).toBe(404);
    expect(await teamOf(alumna.id)).toEqual({ bound: [], capabilities: [] });

    // Confirmar, con el factor de la invitada como «lo pintado»: tampoco. Lo pintado solo se
    // compara, y la alumna no tiene invitación: no se verifica nada ni se ata nada.
    const confirmed = await postAction(otherContext.request, SETUP, { ...confirmFields, code: "123456", painted: started.id });
    expect(confirmed.status()).toBe(303);
    expect(confirmed.headers().location).toBe(SETUP);
    expect(await factorsOf(alumna.id)).toEqual([]);
    expect(await teamOf(alumna.id)).toEqual({ bound: [], capabilities: [] });
    // El factor de la invitada sigue como estaba, sin verificar y sin atar.
    expect(await factorsOf(invitedId)).toEqual([started]);
    expect(await teamOf(invitedId)).toEqual({ bound: [], capabilities: [] });
    // Y sigue con su sesión.
    await other.goto("/inicio");
    await expect(other.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
  });

  // Sin ninguna sesión: a entrar, y tampoco pasa nada.
  await inContext(browser, {}, async (_other, otherContext) => {
    for (const fields of [startFields, { ...confirmFields, code: "123456", painted: started.id }]) {
      const answered = await postAction(otherContext.request, SETUP, fields);
      expect(answered.status()).toBe(303);
      expect(answered.headers().location).toBe("/entrar");
    }
    expect(await factorsOf(invitedId)).toEqual([started]);
  });
});

test("demasiados códigos equivocados: se cierran todas sus sesiones, y la pantalla de entrar lo dice", async ({ browser }) => {
  const email = testEmail();
  expect(await invite(email, "{finance}")).toMatch(/^invited/);
  const used: string[] = [];
  const limit = await parameter("INTENTOS_ANTES_DE_FRENO");

  // Sin JavaScript: cada envío es una carga completa, y se sabe cuándo terminó.
  await inContext(browser, { javaScriptEnabled: false }, async (page, context) => {
    await register(page, email);
    await expect(page).toHaveURL(SETUP);
    const id = await userIdOf(email);
    await page.getByRole("button", { name: "Empezar" }).click();
    const secret = (await page.locator("main code").innerText()).trim();
    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");

    await signIn(page, { email, password: PASSWORD });
    await expect(page).toHaveURL("/entrar/segundo-factor");

    // Códigos equivocados, uno tras otro, hasta que el freno rechaza.
    let tries = 0;
    while (new URL(page.url()).pathname === "/entrar/segundo-factor" && tries < limit + 4) {
      await page.getByLabel("Código").fill(wrongCode(secret));
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Continuar" }).click()]);
      tries += 1;
    }
    // Los primeros solo dicen que no coincide; pasado el límite, el freno rechaza.
    expect(tries).toBeGreaterThanOrEqual(limit);
    await expect(page).toHaveURL("/entrar");
    await expect(page.getByText(/Hubo demasiados códigos equivocados y cerramos tus sesiones\./)).toBeVisible();
    expect(await sessionCookie(context)).toBeUndefined();
    expect(await sessionCount(id)).toBe(0);
    // Sigue siendo del equipo: nada de eso le quitó su atadura ni sus capacidades.
    expect((await teamOf(id)).capabilities).toEqual(["finance"]);
    expect((await teamOf(id)).bound).toHaveLength(1);
  });
});
