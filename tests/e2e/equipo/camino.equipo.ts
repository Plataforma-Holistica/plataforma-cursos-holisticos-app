import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";

import { localOwnerUrl } from "../../integration/helpers/local";
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
  // Tiene configuración: esa sección es suya.
  await expect(page).toHaveURL("/admin/equipo");
  await expect(page.getByRole("heading", { level: 1, name: "Equipo de administración" })).toBeVisible();
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

// ---------------------------------------------------------------------------------------
// El equipo se administra a sí mismo (RF-712; diseño PA-86). Dos personas con configuración
// nacen con el guion del arranque, y desde la pantalla del equipo invitan, dan y quitan
// capacidades y restablecen un segundo factor. Los casos de abajo comparten a esas dos
// personas: crearlas es lo que más tarda.

const TEAM = "/admin/equipo";
const CODE_SHAPE = /^[2-9A-HJKMNP-Z]{4}(?:-[2-9A-HJKMNP-Z]{4}){3}$/;
const ALREADY_SENT = /Ya restableciste a esta persona después de abrir esta confirmación\./;

interface Member {
  email: string;
  password: string;
  id: string;
  /** La clave de su segundo factor, y los códigos de ella que ya se dieron. */
  secret: string;
  used: string[];
}

/** Corre el guion del arranque con esos correos, y devuelve lo que imprimió. */
function bootstrap(emails: string[]): string {
  return execFileSync(process.execPath, ["scripts/db-admins.mjs", ...emails], { encoding: "utf8" });
}

/** Una persona invitada con un correo nuevo: se registra y configura su segundo factor. Queda sin sesión. */
async function joinTeam(browser: Browser, email: string): Promise<Member> {
  return inContext(browser, {}, async (page) => {
    await register(page, email);
    await expect(page).toHaveURL(SETUP);
    await page.getByRole("button", { name: "Empezar" }).click();
    const secret = (await page.locator("main code").innerText()).trim();
    const used: string[] = [];
    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");
    await expect(page.getByText(READY)).toBeVisible();
    return { email, password: PASSWORD, id: await userIdOf(email), secret, used };
  });
}

/** Entra con su contraseña, da su código y llega a esa pantalla de administración. */
async function enterAdmin(page: Page, who: Member, path = TEAM): Promise<void> {
  await signIn(page, who, `/entrar?volver=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(`/entrar/segundo-factor?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Código").fill(await nextCode(who.secret, who.used));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(path);
}

/**
 * Quien fue restablecida vuelve: recupera su contraseña desde su correo, entra, y configura
 * un factor nuevo con el código que le dictaron. `mails` es cuántos correos lleva su buzón
 * contando el de esta recuperación.
 */
async function comeBack(browser: Browser, who: Member, dictated: string, mails: number): Promise<Member> {
  return inContext(browser, {}, async (page) => {
    await page.goto("/recuperar");
    await page.getByLabel("Correo").fill(who.email);
    await page.getByRole("button", { name: "Mandarme el enlace" }).click();
    await expect(page.getByText(/Si ese correo tiene cuenta, te mandamos un enlace\./)).toBeVisible();
    await page.goto(`/recuperar/${tokenHashIn(await lastMailTo(who.email, mails), "recuperar")}`);
    await page.getByLabel("Contraseña nueva").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Guardar contraseña" }).click();
    await expect(page).toHaveURL("/entrar");

    await signIn(page, { email: who.email, password: NEW_PASSWORD });
    await expect(page).toHaveURL(SETUP);
    await page.getByRole("button", { name: "Empezar" }).click();
    const secret = (await page.locator("main code").innerText()).trim();
    const used: string[] = [];

    // Sin el código dictado no se intenta nada: ni se verifica el de su aplicación.
    await page.getByLabel("Código", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL(SETUP);
    expect((await teamOf(who.id)).bound).toEqual([]);

    // Como se dicta por voz: en minúsculas y con espacios es el mismo.
    await page.getByLabel("Código que te dictaron").fill(dictated.toLowerCase().replaceAll("-", " "));
    await page.getByLabel("Código", { exact: true }).fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");
    await expect(page.getByText(READY)).toBeVisible();
    return { ...who, password: NEW_PASSWORD, secret, used };
  });
}

const invitationsTo = (email: string) =>
  ownerQuery<{ kind: string; live: boolean; handoff: string | null; by: string | null }>(
    `select kind, accepted_at is null and revoked_at is null as live, handoff, invited_by::text as by
     from private.admin_invitations where email = $1 order by created_at`,
    [email],
  );

/**
 * Deja al equipo en esas personas y nada más. Los casos de arriba dejan gente con
 * capacidades e invitaciones sin aceptar, y los de este grupo cuentan con saber cuántas
 * personas tienen configuración. Lo hace el dueño de la base, declarado sistema: es
 * preparación, no lo que se prueba. El mínimo de configuración se respeta: se quedan dos.
 */
async function onlyOnTeam(keep: Member[]): Promise<void> {
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as kind),
          invitations as (
            update private.admin_invitations i set revoked_at = now() from declared
            where i.accepted_at is null and i.revoked_at is null returning 1),
          capabilities as (
            update public.admin_capabilities c set revoked_at = now(), revoked_by = $1::uuid from declared
            where c.revoked_at is null and c.profile_id <> all($2::uuid[]) returning 1),
          factors as (
            delete from private.admin_factors f using declared where f.profile_id <> all($2::uuid[]) returning 1)
     select (select count(*) from invitations) + (select count(*) from capabilities) + (select count(*) from factors) as touched`,
    [keep[0]?.id, keep.map((each) => each.id)],
  );
}

/** Cuándo dio su código por última vez esa persona, como lo guarda Auth. */
const lastCodeOf = async (userId: string) =>
  (
    await ownerQuery<{ at: string | null }>(
      `select max(c.updated_at)::text as at from auth.mfa_amr_claims c join auth.sessions s on s.id = c.session_id
       where s.user_id = $1 and c.authentication_method = 'totp'`,
      [userId],
    )
  )[0]?.at ?? null;

const auditRows = async () => Number((await ownerQuery<{ n: string }>("select count(*)::text as n from public.audit_log"))[0]?.n);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test.describe.serial("el equipo se administra a sí mismo (PA-86)", () => {
  let ana: Member;
  let beto: Member;
  let carla: Member;

  test.beforeAll(async ({ browser }, info) => {
    info.setTimeout(240_000);
    await clearCounters();
    const [first, second] = [testEmail(), testEmail()];
    // El arranque: el guion invita a las dos primeras personas, con todas las capacidades.
    const printed = bootstrap([first, second]);
    expect(printed).toContain(`db:admins: ${first}: invited_new.`);
    expect(printed).toContain(`db:admins: ${second}: invited_new.`);
    expect(printed).toContain("pnpm db:reset");
    // Y no invita dos veces: termina mal, y dice qué contestó la base.
    let again = "";
    try {
      bootstrap([first]);
    } catch (error) {
      again = String((error as { stdout?: unknown }).stdout ?? "");
    }
    expect(again).toContain(`db:admins: ${first}: already_invited.`);
    ana = await joinTeam(browser, first);
    beto = await joinTeam(browser, second);
    expect((await teamOf(ana.id)).capabilities).toEqual(["config", "content", "finance", "moderation", "support"]);
    expect((await teamOf(beto.id)).capabilities).toEqual(["config", "content", "finance", "moderation", "support"]);
    // El equipo, en ellas dos: lo que dejaron los casos de arriba no es de este grupo.
    await onlyOnTeam([ana, beto]);
    const left = await ownerQuery<{ people: string; invitations: string }>(
      `select (select count(distinct profile_id) from public.admin_capabilities where revoked_at is null)::text as people,
              (select count(*) from private.admin_invitations where accepted_at is null and revoked_at is null)::text as invitations`,
    );
    expect(left).toEqual([{ people: "2", invitations: "0" }]);
    expect((await teamOf(ana.id)).bound).toHaveLength(1);
    expect((await teamOf(beto.id)).bound).toHaveLength(1);
  });

  test("con JavaScript: ve al equipo, invita, da y quita una capacidad, se le vence el código y restablece un segundo factor", async ({ page, browser }) => {
    test.setTimeout(480_000);
    await enterAdmin(page, ana, "/admin");
    await page.getByRole("link", { name: "Equipo de administración" }).click();
    await expect(page).toHaveURL(TEAM);
    await expect(page.getByRole("heading", { level: 1, name: "Equipo de administración" })).toBeVisible();
    // Sin título propio: no debe poder asomarse en el «no existe» de quien no es del equipo.
    await expect(page).toHaveTitle("La Plataforma");
    expect(await a11yViolations(page)).toEqual([]);
    expect((await page.request.get(TEAM)).headers()["cache-control"]).toMatch(/no-store/);

    const members = page.locator("#bloque-equipo-personas");
    const pending = page.locator("#bloque-equipo-invitaciones");
    const inviting = page.locator("#bloque-equipo-invitar");
    const resetting = page.locator("#bloque-equipo-restablecer");
    const rowOf = (email: string) => members.getByRole("listitem").filter({ hasText: email });

    // Acaba de dar su código: no se le pide otra vez, y los cambios están a la mano.
    await expect(page.getByRole("heading", { level: 2, name: "Tu código" })).toHaveCount(0);
    await expect(rowOf(ana.email).getByText("Tú", { exact: true })).toBeVisible();
    await expect(rowOf(beto.email).getByText("Tiene: Contenido, Finanzas, Moderación, Soporte, Configuración.")).toBeVisible();
    // Con dos personas con configuración, a ninguna se le puede quitar: no se ofrece, y dice por qué.
    await expect(members.getByRole("button", { name: /Quitar Configuración/ })).toHaveCount(0);
    await expect(members.getByText("No se le puede quitar Configuración: tienen que quedar otras dos cuentas activas con ella.")).toHaveCount(2);
    await expect(pending.getByText("No hay invitaciones pendientes.")).toBeVisible();

    // Invita a una tercera. No sale ningún correo: la pantalla le dice qué avisarle.
    const third = testEmail();
    await inviting.getByLabel("Correo de la persona").fill(`  ${third.toUpperCase()} `);
    await inviting.getByLabel("Soporte").check();
    await inviting.getByRole("button", { name: "Invitar" }).click();
    await expect(inviting.getByText(new RegExp(`Invitación creada para ${third.replaceAll(".", "\\.")}\\. Todavía no tiene cuenta`))).toBeVisible();
    await expect(inviting.getByLabel("Correo de la persona")).toHaveValue("");
    // El correo exacto: el botón de revocar también lo dice, para quien no ve la fila.
    await expect(pending.getByText(third, { exact: true })).toBeVisible();
    await expect(pending.getByText("Da: Soporte.")).toBeVisible();
    await expect(pending.getByText(`La hizo ${ana.email}.`)).toBeVisible();
    expect(await invitationsTo(third)).toEqual([{ kind: "grant", live: true, handoff: null, by: ana.id }]);
    expect(await a11yViolations(page)).toEqual([]);
    // Invitarla otra vez no hace nada, y lo dice sin perder lo escrito.
    await inviting.getByLabel("Correo de la persona").fill(third);
    await inviting.getByLabel("Finanzas").check();
    await inviting.getByRole("button", { name: "Invitar" }).click();
    await expect(inviting.getByText("Ese correo ya tiene una invitación vigente. Está en la lista de invitaciones pendientes.")).toBeVisible();
    await expect(inviting.getByLabel("Correo de la persona")).toHaveValue(third);
    await expect(inviting.getByLabel("Finanzas")).toBeChecked();
    expect(await invitationsTo(third)).toHaveLength(1);

    // La tercera acepta, en su navegador. Al volver a pedir la página, ya está en el equipo.
    carla = await joinTeam(browser, third);
    await page.reload();
    await expect(rowOf(third).getByText("Tiene: Soporte.")).toBeVisible();
    await expect(pending.getByText("No hay invitaciones pendientes.")).toBeVisible();

    // Darle una capacidad que no es configuración no pregunta.
    await rowOf(third).getByRole("button", { name: `Dar Contenido a ${third}` }).click();
    await expect(members.getByText("Capacidad dada.")).toBeVisible();
    await expect(rowOf(third).getByText("Tiene: Contenido, Soporte.")).toBeVisible();
    expect((await teamOf(carla.id)).capabilities).toEqual(["content", "support"]);

    // Quitársela sí: primero dice qué va a pasar, y todavía no pasa nada.
    await inContext(browser, {}, async (hers) => {
      await signIn(hers, carla);
      await expect(hers).toHaveURL("/entrar/segundo-factor");
    });
    expect(await sessionCount(carla.id)).toBeGreaterThan(0);
    await rowOf(third).getByRole("button", { name: `Quitar Contenido a ${third}` }).click();
    await expect(rowOf(third).getByText(`¿Quitar Contenido a ${third}?`)).toBeVisible();
    await expect(rowOf(third).getByText("Se cierran todas sus sesiones.")).toBeVisible();
    await expect(rowOf(third).getByText("Queda registrado con tu nombre.")).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
    expect((await teamOf(carla.id)).capabilities).toEqual(["content", "support"]);
    // «Cancelar» lo deja como estaba.
    await rowOf(third).getByRole("button", { name: "Cancelar" }).click();
    await expect(rowOf(third).getByText(`¿Quitar Contenido a ${third}?`)).toHaveCount(0);
    expect((await teamOf(carla.id)).capabilities).toEqual(["content", "support"]);
    await rowOf(third).getByRole("button", { name: `Quitar Contenido a ${third}` }).click();
    await rowOf(third).getByRole("button", { name: "Sí, quitar" }).click();
    await expect(members.getByText("Capacidad quitada. Se cerraron las sesiones de esa cuenta.")).toBeVisible();
    await expect(rowOf(third).getByText("Tiene: Soporte.")).toBeVisible();
    expect((await teamOf(carla.id)).capabilities).toEqual(["support"]);
    expect(await sessionCount(carla.id)).toBe(0);

    // Su código deja de ser reciente con la pantalla abierta. La lista se sigue viendo,
    // arriba se le pide el código, y ningún cambio se ofrece.
    await ownerQuery(
      `update auth.mfa_amr_claims c set updated_at = now() - interval '40 minutes'
       from auth.sessions s where c.session_id = s.id and s.user_id = $1 and c.authentication_method = 'totp'`,
      [ana.id],
    );
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: "Tu código" })).toBeVisible();
    await expect(rowOf(third).getByText("Tiene: Soporte.")).toBeVisible();
    await expect(members.getByRole("button")).toHaveCount(0);
    await expect(inviting.getByRole("button")).toHaveCount(0);
    await expect(resetting.getByRole("button")).toHaveCount(0);
    expect(await a11yViolations(page)).toEqual([]);
    // Un código equivocado no abre nada.
    // El campo, con su nombre exacto: el bloque se llama «Tu código».
    await page.getByLabel("Código", { exact: true }).fill(wrongCode(ana.secret));
    await page.getByRole("button", { name: "Comprobar" }).click();
    await expect(page.getByRole("alert").getByRole("link", { name: WRONG })).toBeVisible();
    await expect(members.getByRole("button")).toHaveCount(0);
    // Con el bueno, la pantalla vuelve con sus cambios, y ya no lo pide.
    await page.getByLabel("Código", { exact: true }).fill(await nextCode(ana.secret, ana.used));
    await page.getByRole("button", { name: "Comprobar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Tu código" })).toHaveCount(0);
    await expect(page).toHaveURL(TEAM);
    await expect(rowOf(third).getByRole("button", { name: `Dar Contenido a ${third}` })).toBeVisible();

    // Restablece el segundo factor de la tercera. Primero dice todo lo que va a pasar.
    await resetting.getByRole("button", { name: `Restablecer el segundo factor de ${third}` }).click();
    await expect(resetting.getByText(`¿Restablecer el segundo factor de ${third}?`)).toBeVisible();
    await expect(resetting.getByText(/Se borran su segundo factor y todas sus sesiones\./)).toBeVisible();
    await expect(resetting.getByText(/Te mostraremos un código una sola vez\./)).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
    expect((await teamOf(carla.id)).bound).toHaveLength(1);
    await resetting.getByRole("button", { name: "Sí, restablecer" }).click();
    const dictated = (await resetting.locator("code").innerText()).trim();
    expect(dictated).toMatch(CODE_SHAPE);
    await expect(resetting.getByText("Díctaselo por teléfono o en persona, no por correo. Se muestra una sola vez: si se pierde, restablece de nuevo.")).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
    // No está en ningún campo, y el bloque no pinta ningún formulario mientras lo muestra.
    expect(await page.locator("input").evaluateAll((inputs, key) => inputs.filter((input) => (input as HTMLInputElement).value.includes(key)).length, dictated)).toBe(0);
    await expect(resetting.locator("form")).toHaveCount(0);
    // La base quedó como se dijo, y de ese código solo guarda la huella.
    expect(await teamOf(carla.id)).toEqual({ bound: [], capabilities: ["support"] });
    expect(await factorsOf(carla.id)).toEqual([]);
    expect((await invitationsTo(third)).at(-1)).toEqual({ kind: "rebind", live: true, handoff: sha256(dictated.replaceAll("-", "")), by: ana.id });

    // «Ya lo dicté» vuelve a pedir la página: el código ya no está, y no se puede volver a ver.
    await resetting.getByRole("link", { name: "Ya lo dicté" }).click();
    await expect(page).toHaveURL(TEAM);
    await expect(page.getByText(dictated)).toHaveCount(0);
    await expect(rowOf(third).getByText("Sin segundo factor: tiene una invitación para configurarlo de nuevo.")).toBeVisible();
    await expect(pending.getByText("Para configurar de nuevo su segundo factor. No da capacidades.")).toBeVisible();
    // Sin su segundo factor no se le pueden dar capacidades: no se ofrece.
    await expect(rowOf(third).getByRole("button", { name: /^Dar / })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByText(dictated)).toHaveCount(0);

    // La tercera vuelve con el código que le dictaron.
    carla = await comeBack(browser, carla, dictated, 2);
    expect((await teamOf(carla.id)).bound).toHaveLength(1);
    await page.goto(TEAM);
    await expect(rowOf(third).getByText(/Sin segundo factor/)).toHaveCount(0);
    await expect(pending.getByText("No hay invitaciones pendientes.")).toBeVisible();

    // Y quien se quita una capacidad a sí misma queda fuera, con su aviso.
    await rowOf(ana.email).getByRole("button", { name: `Quitar Soporte a ${ana.email}` }).click();
    await expect(rowOf(ana.email).getByText("Es tu propia cuenta: también se cierra tu sesión, y tendrás que entrar de nuevo.")).toBeVisible();
    await rowOf(ana.email).getByRole("button", { name: "Sí, quitar" }).click();
    await expect(page).toHaveURL("/entrar");
    await expect(page.getByText("Quitaste una de tus capacidades y cerramos todas tus sesiones. Entra de nuevo.")).toBeVisible();
    expect(await sessionCount(ana.id)).toBe(0);
    expect((await teamOf(ana.id)).capabilities).toEqual(["config", "content", "finance", "moderation"]);
  });

  test("quien no puede administrar al equipo: sin configuración ve qué le falta, y las acciones llamadas directo no hacen nada", async ({ page, browser }) => {
    test.setTimeout(300_000);
    // Los campos con que React nombra cada acción salen de la página de quien sí puede. Con
    // una invitación pendiente, para que la página pinte también el formulario de ese bloque.
    await enterAdmin(page, ana);
    const bait = testEmail();
    const inviting = page.locator("#bloque-equipo-invitar");
    await inviting.getByLabel("Correo de la persona").fill(bait);
    await inviting.getByLabel("Soporte").check();
    await inviting.getByRole("button", { name: "Invitar" }).click();
    await expect(page.locator("#bloque-equipo-invitaciones").getByText(bait, { exact: true })).toBeVisible();
    const baitId = (await ownerQuery<{ id: string }>("select id::text as id from private.admin_invitations where email = $1", [bait]))[0]?.id ?? "";
    expect(baitId).not.toBe("");
    const html = await (await page.request.get(TEAM)).text();
    const inviteFields = actionFields(html, 0);
    const teamFields = actionFields(html, 1);
    const invitationFields = actionFields(html, 2);
    const resetFields = actionFields(html, 3);
    // A quien sí puede, un envío que no dice qué botón se pulsó no le hace nada.
    const empty = await postAction(page.context().request, TEAM, { ...teamFields, profile: beto.id, capability: "finance" });
    expect(empty.status()).toBe(200);
    expect((await teamOf(beto.id)).capabilities).toContain("finance");
    // «Tu código» solo se pinta cuando el código ya no es reciente: se envejece el de quien
    // mira para leer de ahí su formulario, que entonces es el primero de la página.
    await ownerQuery(
      `update auth.mfa_amr_claims c set updated_at = now() - interval '40 minutes'
       from auth.sessions s where c.session_id = s.id and s.user_id = $1 and c.authentication_method = 'totp'`,
      [ana.id],
    );
    const stale = await (await page.request.get(TEAM)).text();
    expect(stale.indexOf('id="bloque-equipo-codigo"')).toBeGreaterThan(-1);
    expect(stale.indexOf('id="bloque-equipo-codigo"')).toBeLessThan(stale.indexOf("<form"));
    const codeFields = actionFields(stale, 0);
    // Es otra acción que las de arriba. Que cada envío de abajo llegue a su servicio lo dice
    // su respuesta: uno que su acción no entiende no redirige.
    for (const other of [inviteFields, teamFields, invitationFields, resetFields]) expect(codeFields).not.toEqual(other);

    const audited = await auditRows();
    const victim = testEmail();
    // Con forma, para que cada envío llegue hasta su servicio: lo que lo detiene es la guarda.
    const attempts = (who: { id: string }): [string, Record<string, string>][] => [
      ["invitar", { ...inviteFields, email: victim, capability: "config" }],
      ["dar", { ...teamFields, do: `confirm:grant:${who.id}:config:` }],
      ["quitar", { ...teamFields, do: `confirm:revoke:${beto.id}:finance:` }],
      ["revocar una invitación", { ...invitationFields, do: `confirm:revoke:${baitId}` }],
      ["invitar de nuevo", { ...invitationFields, do: `confirm:reinvite:${baitId}` }],
      ["restablecer", { ...resetFields, do: `confirm:${beto.id}::0.0` }],
      ["dar el código otra vez", { ...codeFields, code: "123456" }],
    ];
    const untouched = async () => {
      expect(await invitationsTo(victim)).toEqual([]);
      expect(await invitationsTo(bait)).toEqual([{ kind: "grant", live: true, handoff: null, by: ana.id }]);
      expect((await teamOf(beto.id)).capabilities).toContain("finance");
      expect((await teamOf(beto.id)).bound).toHaveLength(1);
      expect(await auditRows()).toBe(audited);
    };

    // Una alumna: cada acción la manda a la sección, donde la guarda le contesta que no existe.
    const alumna = await person();
    await inContext(browser, {}, async (other, otherContext) => {
      await signIn(other, alumna);
      await expect(other).toHaveURL("/inicio");
      for (const [what, fields] of attempts(alumna)) {
        const answered = await postAction(otherContext.request, TEAM, fields);
        expect(answered.status(), what).toBe(303);
        expect(answered.headers().location, what).toBe(TEAM);
      }
      expect((await otherContext.request.get(TEAM)).status()).toBe(404);
      expect(await teamOf(alumna.id)).toEqual({ bound: [], capabilities: [] });
      expect((await otherContext.cookies()).map((cookie) => cookie.name)).not.toContain("plataforma-restablecer");
      await untouched();
    });

    // Sin ninguna sesión: lo mismo, y de ahí a entrar.
    await inContext(browser, {}, async (_other, otherContext) => {
      for (const [what, fields] of attempts(alumna)) {
        const answered = await postAction(otherContext.request, TEAM, fields);
        expect(answered.status(), what).toBe(303);
        expect(answered.headers().location, what).toBe(TEAM);
      }
      expect((await otherContext.request.get(TEAM, { maxRedirects: 0 })).headers().location).toBe("/entrar?volver=%2Fadmin%2Fequipo");
      await untouched();
    });

    // Alguien del equipo sin configuración: entra a administración, y esa sección le dice
    // qué capacidad le falta (PA-88). Tampoco sus envíos directos hacen nada.
    await inContext(browser, {}, async (hers, herContext) => {
      await enterAdmin(hers, carla, "/admin");
      await expect(hers.getByRole("listitem")).toHaveText(["Soporte"]);
      await expect(hers.getByRole("link", { name: "Equipo de administración" })).toHaveCount(0);
      await hers.goto(TEAM);
      await expect(hers.getByRole("heading", { level: 1, name: "Esta sección pide la capacidad de Configuración" })).toBeVisible();
      await expect(hers.getByText(ana.email)).toHaveCount(0);
      expect(await a11yViolations(hers)).toEqual([]);
      const given = await lastCodeOf(carla.id);
      expect(given).not.toBeNull();
      for (const [what, fields] of attempts(carla)) {
        const answered = await postAction(herContext.request, TEAM, fields);
        expect(answered.status(), what).toBe(303);
        expect(answered.headers().location, what).toBe(TEAM);
      }
      expect((await teamOf(carla.id)).capabilities).toEqual(["support"]);
      // Tampoco se le tomó el código que mandó: su sesión de equipo sigue como estaba.
      expect(await lastCodeOf(carla.id)).toBe(given);
      await untouched();
    });
  });

  test("sin JavaScript: da su código, invita, revoca, quita y restablece, y el código dictado no viaja en ningún formulario ni se repite al recargar", async ({ browser }) => {
    test.setTimeout(420_000);
    await inContext(browser, { javaScriptEnabled: false }, async (page, context) => {
      await enterAdmin(page, ana);
      await expect(page.getByRole("heading", { level: 1, name: "Equipo de administración" })).toBeVisible();
      const members = page.locator("#bloque-equipo-personas");
      const pending = page.locator("#bloque-equipo-invitaciones");
      const inviting = page.locator("#bloque-equipo-invitar");
      const resetting = page.locator("#bloque-equipo-restablecer");

      // Su código deja de ser reciente: arriba se le pide, y ningún cambio se ofrece.
      await ownerQuery(
        `update auth.mfa_amr_claims c set updated_at = now() - interval '40 minutes'
         from auth.sessions s where c.session_id = s.id and s.user_id = $1 and c.authentication_method = 'totp'`,
        [ana.id],
      );
      await page.goto(TEAM);
      const giving = page.locator("#bloque-equipo-codigo");
      await expect(giving.getByRole("heading", { level: 2, name: "Tu código" })).toBeVisible();
      await expect(members.getByRole("button")).toHaveCount(0);
      await expect(resetting.getByRole("button")).toHaveCount(0);
      // Sin forma de código: se dice en su bloque, y la página vuelve parada ahí.
      await giving.getByLabel("Código", { exact: true }).fill("12");
      await giving.getByRole("button", { name: "Comprobar" }).click();
      await expect(page).toHaveURL(`${TEAM}#bloque-equipo-codigo`);
      await expect(giving.getByRole("alert")).toBeVisible();
      await expect(members.getByRole("button")).toHaveCount(0);
      // Uno equivocado tampoco abre nada.
      await giving.getByLabel("Código", { exact: true }).fill(wrongCode(ana.secret));
      await giving.getByRole("button", { name: "Comprobar" }).click();
      await expect(giving.getByRole("alert").getByRole("link", { name: WRONG })).toBeVisible();
      await expect(members.getByRole("button")).toHaveCount(0);
      // Con el bueno la acción redirige a la misma página, que ya llega con sus cambios. El
      // navegador se lleva el ancla del bloque, que ahí ya no apunta a nada.
      await giving.getByLabel("Código", { exact: true }).fill(await nextCode(ana.secret, ana.used));
      await giving.getByRole("button", { name: "Comprobar" }).click();
      await expect(page).toHaveURL(/\/admin\/equipo(?:#bloque-equipo-codigo)?$/);
      await expect(page.locator("#bloque-equipo-codigo")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 2, name: "Tu código" })).toHaveCount(0);
      await expect(inviting.getByRole("button", { name: "Invitar" })).toBeVisible();

      // Invitar. La página vuelve parada en su bloque, con qué avisarle a la persona.
      const fourth = testEmail();
      await inviting.getByLabel("Correo de la persona").fill(fourth);
      await inviting.getByLabel("Moderación").check();
      await inviting.getByRole("button", { name: "Invitar" }).click();
      await expect(page).toHaveURL(`${TEAM}#bloque-equipo-invitar`);
      await expect(inviting.getByText(/Invitación creada para .* Todavía no tiene cuenta/)).toBeVisible();
      await expect(pending.getByText(fourth, { exact: true })).toBeVisible();
      expect(await invitationsTo(fourth)).toMatchObject([{ kind: "grant", live: true }]);

      // Sin correo, o sin capacidades: se dice en el formulario, y lo escrito vuelve.
      await inviting.getByLabel("Correo de la persona").fill("no-es-un-correo");
      await inviting.getByRole("button", { name: "Invitar" }).click();
      await expect(inviting.getByRole("alert").getByRole("link", { name: "Ese correo no tiene forma de correo. Revísalo." })).toBeVisible();
      await expect(inviting.getByRole("alert").getByRole("link", { name: "Elige al menos una capacidad." })).toBeVisible();
      await expect(inviting.getByLabel("Correo de la persona")).toHaveValue("no-es-un-correo");

      // Revocarla: dos pasos, con «Cancelar» de por medio.
      const row = pending.getByRole("listitem").filter({ hasText: fourth });
      await row.getByRole("button", { name: `Revocar la invitación de ${fourth}` }).click();
      await expect(page).toHaveURL(`${TEAM}#bloque-equipo-invitaciones`);
      await expect(row.getByText(`¿Revocar la invitación de ${fourth}?`)).toBeVisible();
      await row.getByRole("button", { name: "Cancelar" }).click();
      await expect(row.getByText(`¿Revocar la invitación de ${fourth}?`)).toHaveCount(0);
      expect(await invitationsTo(fourth)).toMatchObject([{ live: true }]);
      await row.getByRole("button", { name: `Revocar la invitación de ${fourth}` }).click();
      await row.getByRole("button", { name: "Sí, revocar" }).click();
      await expect(pending.getByText("Invitación revocada.")).toBeVisible();
      await expect(pending.getByText(fourth, { exact: true })).toHaveCount(0);
      expect(await invitationsTo(fourth)).toMatchObject([{ live: false }]);

      // Dar una capacidad, también sin JavaScript.
      const hers = members.getByRole("listitem").filter({ hasText: carla.email });
      await hers.getByRole("button", { name: `Dar Finanzas a ${carla.email}` }).click();
      await expect(page).toHaveURL(`${TEAM}#bloque-equipo-personas`);
      await expect(members.getByText("Capacidad dada.")).toBeVisible();
      expect((await teamOf(carla.id)).capabilities).toEqual(["finance", "support"]);

      // Quitar son dos pasos, y lo que se confirmó tiene que seguir siendo lo que pasaría.
      // Se pregunta por Soporte cuando todavía le queda otra capacidad...
      await hers.getByRole("button", { name: `Quitar Soporte a ${carla.email}` }).click();
      await expect(page).toHaveURL(`${TEAM}#bloque-equipo-personas`);
      await expect(hers.getByText(`¿Quitar Soporte a ${carla.email}?`)).toBeVisible();
      await expect(hers.getByText("Se cierran todas sus sesiones.")).toBeVisible();
      await expect(hers.getByText(/Es su última capacidad/)).toHaveCount(0);
      expect((await teamOf(carla.id)).capabilities).toEqual(["finance", "support"]);
      // ...y mientras tanto, en otra pestaña, se le quita la otra: también en dos pasos.
      const other = await context.newPage();
      await other.goto(TEAM);
      const theirs = other.locator("#bloque-equipo-personas").getByRole("listitem").filter({ hasText: carla.email });
      await theirs.getByRole("button", { name: `Quitar Finanzas a ${carla.email}` }).click();
      await theirs.getByRole("button", { name: "Sí, quitar" }).click();
      await expect(other.locator("#bloque-equipo-personas").getByText("Capacidad quitada. Se cerraron las sesiones de esa cuenta.")).toBeVisible();
      await other.close();
      expect((await teamOf(carla.id)).capabilities).toEqual(["support"]);
      // La confirmación que quedó abierta ya no dice lo que pasaría: no quita nada, lo avisa
      // y vuelve a preguntar con lo de ahora.
      await hers.getByRole("button", { name: "Sí, quitar" }).click();
      await expect(hers.getByText("La lista cambió mientras confirmabas. Revisa de nuevo lo que va a pasar.")).toBeVisible();
      await expect(hers.getByText(/Es su última capacidad: deja de ser del equipo\./)).toBeVisible();
      expect((await teamOf(carla.id)).capabilities).toEqual(["support"]);
      expect((await teamOf(carla.id)).bound).toHaveLength(1);
      // Confirmada con lo de ahora, sí: sale del equipo, y la base le quita su atadura.
      await hers.getByRole("button", { name: "Sí, quitar" }).click();
      await expect(members.getByText("Capacidad quitada. Se cerraron las sesiones de esa cuenta.")).toBeVisible();
      await expect(members.getByText(carla.email)).toHaveCount(0);
      expect(await teamOf(carla.id)).toEqual({ bound: [], capabilities: [] });

      // En otra pestaña se pide antes la misma confirmación, y se deja abierta.
      const earlier = await context.newPage();
      await earlier.goto(TEAM);
      const theirReset = earlier.locator("#bloque-equipo-restablecer");
      await theirReset.getByRole("button", { name: `Restablecer el segundo factor de ${beto.email}` }).click();
      await expect(theirReset.getByRole("button", { name: "Sí, restablecer" })).toBeVisible();

      // Restablecer a la única otra persona con configuración: se permite, avisando.
      await resetting.getByRole("button", { name: `Restablecer el segundo factor de ${beto.email}` }).click();
      await expect(page).toHaveURL(`${TEAM}#bloque-equipo-restablecer`);
      await expect(resetting.getByText("Es la única otra persona que puede cambiar el equipo: mientras no vuelva, quedarás como la única.")).toBeVisible();
      expect((await teamOf(beto.id)).bound).toHaveLength(1);

      await resetting.getByRole("button", { name: "Sí, restablecer" }).click();
      const dictated = (await resetting.locator("code").innerText()).trim();
      expect(dictated).toMatch(CODE_SHAPE);
      const first = (await invitationsTo(beto.email)).at(-1);
      expect(first).toEqual({ kind: "rebind", live: true, handoff: sha256(dictated.replaceAll("-", "")), by: ana.id });
      expect((await teamOf(beto.id)).bound).toEqual([]);

      // La confirmación de la otra pestaña lleva la versión de antes: ya no restablece, y el
      // código que se acaba de dictar sigue siendo el que vale.
      await theirReset.getByRole("button", { name: "Sí, restablecer" }).click();
      await expect(theirReset.getByText(ALREADY_SENT)).toBeVisible();
      await expect(theirReset.locator("code")).toHaveCount(0);
      await earlier.close();
      expect((await invitationsTo(beto.email)).at(-1)).toEqual(first);
      expect((await invitationsTo(beto.email)).filter((each) => each.kind === "rebind")).toHaveLength(1);
      // Ni una ni otra pestaña dejaron nada en el navegador.
      expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain("plataforma-restablecer");

      // Sin JavaScript, el estado de una acción viaja dentro de todo formulario ligado a ella.
      // La respuesta de restablecer trae el código: no debe estar en ningún campo del
      // documento, visible u oculto, ni haber un formulario en ese bloque.
      const document = await page.content();
      const inputs = [...document.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input).not.toContain(dictated);
        expect(input).not.toContain(dictated.replaceAll("-", ""));
      }
      await expect(resetting.locator("form")).toHaveCount(0);
      await expect(resetting.getByRole("link", { name: "Ya lo dicté" })).toHaveAttribute("href", TEAM);
      // Dónde sí está, contado en el documento entero. En el marcado, una sola vez: donde se
      // lee. Ninguna en un atributo, ni dentro de un formulario, un botón o un enlace.
      const times = (text: string) => text.split(dictated).length - 1;
      const scripts = [...document.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((match) => match[0]).join("\n");
      const markup = document.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      expect(times(markup)).toBe(1);
      expect(markup).toContain(`>${dictated}</code>`);
      expect(document).not.toContain(dictated.replaceAll("-", ""));
      // Un límite conocido, medido aquí para que un cambio de Next se note: en un envío sin
      // JavaScript el documento trae además el estado de la acción en los datos con que React
      // se montaría. Es el mismo documento que ya pinta el código, y no viaja de vuelta.
      expect(times(scripts)).toBe(1);

      // Recargar reenvía ese mismo formulario. No restablece otra vez: el código que ya se
      // dictó sigue siendo el que vale, y la pantalla dice que ese envío ya se hizo.
      await page.reload();
      await expect(resetting.getByText(ALREADY_SENT)).toBeVisible();
      await expect(page.getByText(dictated)).toHaveCount(0);
      expect(await page.content()).not.toContain(dictated);
      expect((await invitationsTo(beto.email)).at(-1)).toEqual(first);
      expect((await invitationsTo(beto.email)).filter((each) => each.kind === "rebind")).toHaveLength(1);
      // Y una carga completa, que es lo que ofrece el bloque, no lo trae en ninguna parte.
      await page.goto(TEAM);
      expect(await page.content()).not.toContain(dictated);
    });
  });

  // Lo que de verdad impide dos restablecimientos a la vez es el candado de la base: la
  // versión se compara dentro de él. Aquí van dos llamadas directas a la base, como las
  // haría el servidor a nombre de la misma persona, con la misma versión. Va en este proyecto
  // y no en la integración porque la primera tiene que confirmar, y la auditoría no admite
  // borrado: al terminar, la base se rehace.
  test("dos restablecimientos a la vez con la misma versión: el segundo espera el candado y no hace nada", async () => {
    test.setTimeout(60_000);
    // La sesión de equipo de quien restablece, con su código reciente.
    const [session] = await ownerQuery<{ id: string }>(
      `select s.id::text as id from auth.sessions s join private.app_sessions a on a.session_id = s.id
       where s.user_id = $1 and s.aal = 'aal2' order by s.created_at desc limit 1`,
      [ana.id],
    );
    if (!session) throw new Error("Quien restablece no tiene una sesión de equipo.");
    await ownerQuery(
      "update auth.mfa_amr_claims set updated_at = now() where session_id = $1 and authentication_method = 'totp'",
      [session.id],
    );
    const [current] = await ownerQuery<{ version: string }>("select private.reset_version($1) as version", [beto.id]);
    const version = current?.version ?? "";
    const audited = await auditRows();

    // Las dos conexiones son del dueño y toman el rol del servidor. La integración lo concede
    // dentro de su transacción, que se revierte; aquí son dos transacciones a la vez, y la
    // segunda esperaría a la primera por la concesión misma. Se concede antes y se quita al
    // final (y la base se rehace al terminar el proyecto).
    await ownerQuery("grant app_service to postgres with set true, inherit false");
    const first = new Client({ connectionString: localOwnerUrl() });
    const second = new Client({ connectionString: localOwnerUrl() });
    await first.connect();
    await second.connect();
    try {
      const asAna = async (client: Client) => {
        await client.query("begin");
        await client.query(
          "select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true), set_config('role', 'app_service', true)",
          [ana.id, session.id],
        );
      };
      const reset = (client: Client, secret: string) =>
        client.query<{ answer: string }>("select private.reset_second_factor($1, $2, $3) as answer", [beto.id, sha256(secret), version]);

      await asAna(first);
      expect((await reset(first, "PRIMERO")).rows[0]?.answer).toBe("reset");
      await asAna(second);
      const [{ pid } = { pid: 0 }] = (await second.query<{ pid: number }>("select pg_backend_pid() as pid")).rows;
      const waiting = reset(second, "SEGUNDO");
      // La segunda se queda esperando el candado del equipo mientras la primera no termina.
      await expect
        .poll(async () => (await ownerQuery<{ waiting: boolean }>(
          "select coalesce(wait_event_type = 'Lock', false) as waiting from pg_stat_activity where pid = $1",
          [pid],
        ))[0]?.waiting, { timeout: 10_000 })
        .toBe(true);
      await first.query("commit");
      // Cuando entra, la versión ya no es esa, y lo pendiente es de quien actúa: ya se envió.
      expect((await waiting).rows[0]?.answer).toBe("already_sent");
      await second.query("commit");
    } finally {
      await first.end();
      await second.end();
      await ownerQuery("revoke app_service from postgres");
    }
    // Una sola invitación para volver, con la huella del primero, y un solo restablecimiento
    // en la auditoría.
    const live = (await invitationsTo(beto.email)).filter((each) => each.live);
    expect(live).toEqual([{ kind: "rebind", live: true, handoff: sha256("PRIMERO"), by: ana.id }]);
    expect(await auditRows()).toBeGreaterThan(audited);
    const [counted] = await ownerQuery<{ n: number }>(
      "select count(*)::int as n from private.admin_invitations where profile_id = $1 and handoff = $2",
      [beto.id, sha256("SEGUNDO")],
    );
    expect(counted?.n).toBe(0);
  });

  // PA-67, las prácticas y los niveles (T-106). Van aquí porque escriben en la auditoría, y
  // porque usan a las mismas dos personas: las dos tienen Contenido.
  const CATALOG = "/admin/practicas";
  const practicesNow = async () =>
    (await ownerQuery<{ name: string; slug: string; active: boolean }>("select name, slug, is_active as active from public.practices order by position")).map(
      (row) => `${row.name}|${row.slug}|${row.active ? "activa" : "desactivada"}`,
    );
  const practiceId = async (name: string) =>
    (await ownerQuery<{ id: string; position: number }>("select id::text as id, position from public.practices where name = $1", [name]))[0];
  /** Envejece el código de esa persona: los cambios lo piden otra vez. */
  const ageCode = (userId: string) =>
    ownerQuery(
      `update auth.mfa_amr_claims c set updated_at = now() - interval '40 minutes'
       from auth.sessions s where c.session_id = s.id and s.user_id = $1 and c.authentication_method = 'totp'`,
      [userId],
    );

  test("prácticas y niveles con JavaScript: agrega, renombra con Enter, ordena, desactiva, reactiva y da su código cuando hace falta", async ({ page }) => {
    test.setTimeout(300_000);
    await enterAdmin(page, ana, "/admin");
    await page.getByRole("link", { name: "Prácticas y niveles" }).click();
    await expect(page).toHaveURL(CATALOG);
    await expect(page.getByRole("heading", { level: 1, name: "Prácticas y niveles" })).toBeVisible();
    const practices = page.locator("#bloque-catalogo-practicas");
    await expect(practices.getByText("Todavía no hay prácticas.")).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
    const audited = await auditRows();

    // Agregar, con el botón y con Enter: el campo queda vacío y con el foco, para seguir.
    const field = practices.getByLabel("Nombre de la práctica nueva");
    await field.fill("Yoga");
    await practices.getByRole("button", { name: "Agregar práctica" }).click();
    await expect(practices.getByText("Agregada: «Yoga».").first()).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await field.fill("Meditación");
    await field.press("Enter");
    await expect(practices.getByText("Agregada: «Meditación».").first()).toBeVisible();
    await field.fill("Respiración");
    await field.press("Enter");
    await expect(practices.getByText("Agregada: «Respiración».").first()).toBeVisible();
    // El mismo nombre, escrito de otra forma: en su campo, con lo escrito.
    await field.fill("YOGA");
    await field.press("Enter");
    await expect(practices.getByRole("link", { name: /Ya existe una práctica con ese nombre/ })).toBeVisible();
    await expect(field).toHaveValue("YOGA");
    expect(await practicesNow()).toEqual(["Yoga|yoga|activa", "Meditación|meditacion|activa", "Respiración|respiracion|activa"]);

    // Subir: el foco se queda en el mismo botón de esa fila, para seguir con el teclado.
    await practices.getByRole("button", { name: "Subir «Respiración»" }).click();
    await expect(practices.getByText("«Respiración» quedó en el lugar 2 de 3.").first()).toBeVisible();
    await expect(practices.getByRole("button", { name: "Subir «Respiración»" })).toBeFocused();
    expect(await practicesNow()).toEqual(["Yoga|yoga|activa", "Respiración|respiracion|activa", "Meditación|meditacion|activa"]);

    // Renombrar, y guardar con Enter: guarda esa fila, no mueve ninguna otra.
    await practices.getByRole("button", { name: "Renombrar «Yoga»" }).click();
    const renaming = practices.getByLabel("Nombre nuevo de «Yoga»");
    await expect(renaming).toBeFocused();
    await expect(practices.getByRole("button", { name: /^Bajar/ })).toHaveCount(0);
    await renaming.fill("Yoga suave");
    await renaming.press("Enter");
    await expect(practices.getByText("Nombre guardado.")).toBeVisible();
    // El slug no cambia: los enlaces guardados siguen sirviendo.
    expect(await practicesNow()).toEqual(["Yoga suave|yoga|activa", "Respiración|respiracion|activa", "Meditación|meditacion|activa"]);

    // Desactivar no pregunta. Agregar su nombre otra vez ofrece reactivarla, en su lugar.
    await practices.getByRole("button", { name: "Desactivar «Meditación»" }).click();
    // (El aviso antepone su tono para quien usa lector de pantalla: «Listo: …».)
    await expect(practices.getByText(/Desactivada\. Ya no se ofrece/)).toBeVisible();
    await field.fill("meditacion");
    await field.press("Enter");
    await expect(practices.getByText("«meditacion» ya existe, desactivada. Puedes reactivarla: vuelve a su lugar en la lista.")).toBeVisible();
    await practices.getByRole("button", { name: "Reactivar «meditacion»" }).click();
    await expect(practices.getByText("Reactivada, en el lugar que tenía.")).toBeVisible();
    expect(await practicesNow()).toEqual(["Yoga suave|yoga|activa", "Respiración|respiracion|activa", "Meditación|meditacion|activa"]);

    // Los niveles son otra lista.
    const levels = page.locator("#bloque-catalogo-niveles");
    await levels.getByLabel("Nombre del nivel nuevo").fill("Básico");
    await levels.getByRole("button", { name: "Agregar nivel" }).click();
    await expect(levels.getByText("Agregado: «Básico».").first()).toBeVisible();

    // Se le vence el código con la pantalla abierta: el cambio no pasa, se le dice, y la
    // página le pide el código arriba. Lo da, y vuelve a poder.
    await ageCode(ana.id);
    await practices.getByRole("button", { name: "Desactivar «Respiración»" }).click();
    await expect(practices.getByText("Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Tu código" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Agregar práctica" })).toHaveCount(0);
    expect(await practicesNow()).toContain("Respiración|respiracion|activa");
    // Exacto: la sección «Tu código» también se nombra con la palabra.
    await page.getByLabel("Código", { exact: true }).fill(await nextCode(ana.secret, ana.used));
    await page.getByRole("button", { name: "Comprobar" }).click();
    await expect(page).toHaveURL(CATALOG);
    await expect(page.getByRole("button", { name: "Agregar práctica" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Tu código" })).toHaveCount(0);
    // Y el aviso que pedía el código ya no se pinta: dejó de ser cierto.
    await expect(page.getByText("Tu código ya no es reciente.", { exact: false })).toHaveCount(0);

    expect(await auditRows()).toBeGreaterThan(audited);
    expect(await a11yViolations(page)).toEqual([]);
  });

  test("prácticas y niveles sin JavaScript: agrega, renombra con Enter, y un formulario reenviado no sube dos lugares", async ({ browser }) => {
    test.setTimeout(240_000);
    await inContext(browser, { javaScriptEnabled: false }, async (page, context) => {
      await enterAdmin(page, ana, CATALOG);
      const practices = page.locator("#bloque-catalogo-practicas");
      await practices.getByLabel("Nombre de la práctica nueva").fill("Tai chi");
      await practices.getByRole("button", { name: "Agregar práctica" }).click();
      await expect(practices.getByText("Agregada: «Tai chi».").first()).toBeVisible();
      await expect(practices.getByRole("button", { name: "Subir «Tai chi»" })).toBeVisible();

      // Renombrar con Enter, sin JavaScript: el primer botón del formulario es «Guardar».
      await practices.getByRole("button", { name: "Renombrar «Tai chi»" }).click();
      const renaming = practices.getByLabel("Nombre nuevo de «Tai chi»");
      await renaming.fill("Tai chi chuan");
      await renaming.press("Enter");
      await expect(practices.getByText("Nombre guardado.")).toBeVisible();
      const before = await practicesNow();
      expect(before.at(-1)).toBe("Tai chi chuan|tai-chi|activa");

      // El mismo «Subir», enviado dos veces (un doble clic, o recargar y reenviar): sube una.
      const taichi = await practiceId("Tai chi chuan");
      if (!taichi) throw new Error("Falta la práctica recién agregada.");
      const fields = actionFields(await (await context.request.get(CATALOG)).text(), 0);
      const up = { ...fields, do: `up:${taichi.id}:${taichi.position}` };
      expect((await postAction(context.request, CATALOG, up)).status()).toBe(200);
      const once = await practicesNow();
      expect(once.at(-2)).toBe("Tai chi chuan|tai-chi|activa");
      const again = await postAction(context.request, CATALOG, up);
      expect(again.status()).toBe(200);
      expect(await again.text()).toContain("La lista cambió mientras la veías.");
      expect(await practicesNow()).toEqual(once);
    });
  });

  test("prácticas y niveles: lo que usa un curso no se desactiva, y la pantalla dice cuántos lo usan", async ({ page }) => {
    test.setTimeout(240_000);
    // Preparación, no lo que se prueba: un curso de prueba que usa «Respiración», cargado como
    // el guion local (el dueño declarado sistema, con su ajuste). Queda en revisión, y en
    // revisión ya cuenta.
    const course = {
      slug: "en-uso-e2e",
      title: "Curso que usa una práctica",
      practice: "respiracion",
      level: "basico",
      modules: [{ title: "Uno", lessons: [{ title: "Una", video: { provider: "test", asset_id: "en-uso-e2e-1", playback_id: "p", duration_seconds: 60 } }] }],
    };
    const [loaded] = await ownerQuery<{ answer: string }>(
      `with declared as materialized (
         select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)),
       teacher as materialized (
         select private.system_add_teacher('Maestra de extremo a extremo', 'maestra-e2e', null) as id from declared)
       select private.system_load_course((select id from teacher), $1::jsonb) ->> 'answer' as answer from teacher`,
      [JSON.stringify(course)],
    );
    expect(loaded?.answer).toBe("loaded");

    await enterAdmin(page, ana, CATALOG);
    const practices = page.locator("#bloque-catalogo-practicas");
    const row = practices.getByRole("listitem").filter({ hasText: "Respiración" });
    await expect(row.getByText("En uso en 1 curso.")).toBeVisible();
    await expect(row.getByRole("button", { name: "Desactivar «Respiración»" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Renombrar «Respiración»" })).toBeVisible();

    // Llamada directo, la base contesta «en uso» y no la desactiva.
    const fields = actionFields(await (await page.request.get(CATALOG)).text(), 0);
    const id = (await practiceId("Respiración"))?.id ?? "";
    const answered = await postAction(page.context().request, CATALOG, { ...fields, do: `deactivate:${id}` });
    expect(answered.status()).toBe(200);
    expect(await answered.text()).toContain("Ya la usa un curso, así que no se puede desactivar mientras tanto.");
    expect(await practicesNow()).toContain("Respiración|respiracion|activa");
    expect(await a11yViolations(page)).toEqual([]);
  });

  test("prácticas y niveles: quien no tiene Contenido, o no tiene su código reciente, no cambia nada aunque llame a las acciones directo", async ({ page, browser }) => {
    test.setTimeout(300_000);
    // Los campos con que React nombra cada acción salen de la página de quien sí puede.
    await enterAdmin(page, ana, CATALOG);
    const html = await (await page.request.get(CATALOG)).text();
    const practicesFields = actionFields(html, 0);
    const levelsFields = actionFields(html, 2);
    expect(practicesFields).not.toEqual(levelsFields);
    const yoga = await practiceId("Yoga suave");
    if (!yoga) throw new Error("Falta la práctica del caso de arriba.");
    await ageCode(ana.id);
    const stale = await (await page.request.get(CATALOG)).text();
    const codeFields = actionFields(stale, 0);
    expect(codeFields).not.toEqual(practicesFields);

    const attempts: [string, Record<string, string>][] = [
      ["agregar", { ...practicesFields, do: "add", name: "Intrusa" }],
      ["agregar un nivel", { ...levelsFields, do: "add", name: "Intruso" }],
      ["renombrar", { ...practicesFields, do: `save:${yoga.id}`, name: "Otra" }],
      ["mover", { ...practicesFields, do: `down:${yoga.id}:${yoga.position}` }],
      ["desactivar", { ...practicesFields, do: `deactivate:${yoga.id}` }],
    ];
    const snapshot = await practicesNow();
    const audited = await auditRows();
    const untouched = async () => {
      expect(await practicesNow()).toEqual(snapshot);
      expect(await ownerQuery("select 1 from public.levels where name = 'Intruso'")).toEqual([]);
      expect(await auditRows()).toBe(audited);
    };

    // Con Contenido y el código vencido: la base pide el código, y nada cambia.
    for (const [what, fields] of attempts) {
      const answered = await postAction(page.context().request, CATALOG, fields);
      expect(answered.status(), what).toBe(200);
      expect(await answered.text(), what).toContain("Tu código ya no es reciente.");
    }
    await untouched();

    // Con configuración y sin Contenido: PA-88 dice qué le falta, y nada cambia. Es la misma
    // persona, sin Contenido (el caso de arriba le restableció el factor a la otra, que ya no
    // entra). Quitárselo es preparación, no lo que se prueba: lo hace el dueño, declarado
    // sistema.
    await ownerQuery(
      `with declared as materialized (select set_config('app.actor_kind', 'system', true) as kind)
       update public.admin_capabilities c set revoked_at = now(), revoked_by = $1::uuid from declared
       where c.profile_id = $2::uuid and c.capability = 'content' and c.revoked_at is null`,
      [ana.id, ana.id],
    );
    const prepared = await auditRows();
    await inContext(browser, {}, async (hers, herContext) => {
      await enterAdmin(hers, ana, "/admin");
      await expect(hers.getByRole("link", { name: "Prácticas y niveles" })).toHaveCount(0);
      await hers.goto(CATALOG);
      await expect(hers.getByRole("heading", { level: 1, name: "Esta sección pide la capacidad de Contenido" })).toBeVisible();
      await expect(hers.getByText("Yoga suave")).toHaveCount(0);
      const given = await lastCodeOf(ana.id);
      for (const [what, fields] of [...attempts, ["dar el código otra vez", { ...codeFields, code: "123456" }] as [string, Record<string, string>]]) {
        const answered = await postAction(herContext.request, CATALOG, fields);
        expect(answered.status(), what).toBe(303);
        expect(answered.headers().location, what).toBe(CATALOG);
      }
      // Tampoco se le tomó el código que mandó.
      expect(await lastCodeOf(ana.id)).toBe(given);
    });
    expect(await practicesNow()).toEqual(snapshot);
    expect(await auditRows()).toBe(prepared);

    // Una alumna: cada acción la manda a la sección, donde la guarda le contesta que no existe.
    const alumna = await person();
    await inContext(browser, {}, async (other, otherContext) => {
      await signIn(other, alumna);
      await expect(other).toHaveURL("/inicio");
      for (const [what, fields] of attempts) {
        const answered = await postAction(otherContext.request, CATALOG, fields);
        expect(answered.status(), what).toBe(303);
        expect(answered.headers().location, what).toBe(CATALOG);
      }
      expect((await otherContext.request.get(CATALOG)).status()).toBe(404);
    });
    expect(await practicesNow()).toEqual(snapshot);
    expect(await auditRows()).toBe(prepared);
  });
});
