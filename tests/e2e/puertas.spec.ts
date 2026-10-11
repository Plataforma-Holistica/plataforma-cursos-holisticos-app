import { expect, test, type Browser, type Page } from "@playwright/test";

import { actionFields, postAction } from "./support/actions";
import {
  clearCounters,
  forgetNotedSessions,
  grantedDocTypes,
  ownerQuery,
  parameter,
  person,
  SESSION_COOKIE,
  sessionCount,
  type Person,
} from "./support/stack";

// Lo que una pantalla nunca mandaría, y lo que solo se ve desde fuera de ella: las acciones
// de servidor llamadas directo, el aviso entre dos pantallas, la hora del freno en otra
// zona, y qué cabecera se lee como la dirección de quien pide.

test.beforeEach(clearCounters);

const NOTICE_COOKIE = "plataforma-aviso";

async function signIn(page: Page, who: Pick<Person, "email" | "password">, path = "/entrar"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const counted = async () =>
  Number(
    (await ownerQuery<{ n: string }>(
      "select ((select count(*) from private.login_throttles) + (select count(*) from private.rate_limit_counters))::text as n",
    ))[0]?.n,
  );

test("la acción de entrar aguanta un formulario que su pantalla nunca mandaría", async ({ request }) => {
  const ana = await person();
  const hidden = actionFields(await (await request.get("/entrar")).text());
  const file = { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from(ana.email) };

  const attempts = [
    { ...hidden },
    { ...hidden, email: ana.email },
    { ...hidden, password: ana.password },
    { ...hidden, email: file, password: file },
    { ...hidden, email: "x".repeat(5_000), password: "y".repeat(5_000) },
  ];
  for (const fields of attempts) {
    const response = await postAction(request, "/entrar", fields);
    // Ni entra ni truena: contesta su pantalla, con el dato por corregir.
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("por corregir");
    expect(response.headers()["set-cookie"] ?? "").not.toContain(SESSION_COOKIE);
  }
  // Nada de eso llegó al servicio: ni un intento contado.
  expect(await counted()).toBe(0);
  expect(await sessionCount(ana.id)).toBe(0);
});

test("la respuesta de un intento fallido no trae la contraseña, ni con JavaScript ni sin él", async ({ page, request }) => {
  const ana = await person();
  const secret = `nunca-debe-volver-${Date.now()}`;

  // Lo que el servidor contesta al envío, se haya enviado con JavaScript o sin él.
  const answers: string[] = [];
  await page.route("**/entrar", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    answers.push(await response.text());
    return route.fulfill({ response });
  });
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(ana.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("El correo o la contraseña no coinciden.")).toBeVisible();
  expect(answers).toHaveLength(1);
  expect(answers[0]).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);

  const hidden = actionFields(await (await request.get("/entrar")).text());
  const plain = await postAction(request, "/entrar", { ...hidden, email: ana.email, password: secret });
  const body = await plain.text();
  expect(body).toContain("El correo o la contraseña no coinciden.");
  expect(body).not.toContain(secret);
});

test("la acción de completar la cuenta no hace nada para quien no trae sesión", async ({ page, request }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva);
  await expect(page).toHaveURL("/consentimientos");
  // Los campos de la acción, tomados de una sesión de verdad, enviados sin ninguna cookie.
  // Se piden al servidor: en la página ya viva, React quita los campos con que la nombra.
  const html = await (await page.request.get("/consentimientos")).text();
  const hidden = actionFields(html);
  const shown = [...html.matchAll(/name="shown" value="([^"]+)"/g)].map((match) => match[1] ?? "");
  expect(shown).toHaveLength(3);

  const fields: Record<string, string> = { ...hidden, name: "Intrusa", adult: "on", volver: "/inicio" };
  for (const value of shown) fields[`accept:${value.split("=")[0]}`] = "on";
  // `multipart` no repite nombres: basta un texto pintado para que el envío sea creíble.
  fields.shown = shown[0] ?? "";

  const response = await postAction(request, "/consentimientos", fields);
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe("/entrar?volver=%2Finicio");
  expect(await grantedDocTypes(nueva.id)).toEqual([]);
  const [profile] = await ownerQuery<{ display_name: string | null }>("select display_name from public.profiles where id = $1", [nueva.id]);
  expect(profile?.display_name).toBeNull();
});

test("si la sesión deja de valer mientras se llena el formulario, enviarlo la cierra y manda a entrar", async ({ page }) => {
  const nueva = await person("claimed");
  await signIn(page, nueva);
  await expect(page).toHaveURL("/consentimientos");
  expect(await forgetNotedSessions(nueva.id)).toBe(1);

  await page.getByLabel("Nombre").fill("Ana de Prueba");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Aceptar y seguir" }).click();

  await expect(page).toHaveURL("/entrar");
  expect((await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE)).toBeUndefined();
  expect(await sessionCount(nueva.id)).toBe(0);
  expect(await grantedDocTypes(nueva.id)).toEqual([]);
});

for (const [key, message] of [
  ["password_changed", "Tu contraseña se cambió y cerramos todas tus sesiones. Entra con la nueva."],
  ["account_ready", "Tu cuenta está lista. Entra con tu contraseña."],
] as const) {
  test(`el aviso ${key} se muestra al llegar a entrar, y un envío lo apaga`, async ({ page, context }) => {
    await context.addCookies([{ name: NOTICE_COOKIE, value: key, url: "http://localhost:3000", httpOnly: true, sameSite: "Lax" }]);
    await page.goto("/entrar");
    await expect(page.getByText(message)).toBeVisible();

    await page.getByLabel("Correo").fill("nadie@prueba.test");
    await page.getByLabel("Contraseña", { exact: true }).fill("equivocada-1");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "El correo o la contraseña no coinciden." })).toBeVisible();
    await expect(page.getByText(message)).toBeHidden();
    expect((await context.cookies()).find((cookie) => cookie.name === NOTICE_COOKIE)).toBeUndefined();
    await page.reload();
    await expect(page.getByText(message)).toBeHidden();
  });
}

test("un aviso que no es de la lista, o que no es de esta pantalla, no dice nada", async ({ page, context }) => {
  for (const value of ["choose_password", "otra_cosa", "Tu contraseña se cambió", "<b>hola</b>"]) {
    await context.clearCookies();
    await context.addCookies([{ name: NOTICE_COOKIE, value: encodeURIComponent(value), url: "http://localhost:3000" }]);
    await page.goto("/entrar");
    await expect(page.getByRole("heading", { level: 1, name: "Inicia sesión" })).toBeVisible();
    await expect(page.getByText(/Tu contraseña se cambió|Tu cuenta está lista|elegir su contraseña|hola/)).toHaveCount(0);
  }
  // Y nada de lo que venga en la dirección se convierte en aviso.
  await context.clearCookies();
  await page.goto("/entrar?aviso=password_changed&notice=password_changed");
  await expect(page.getByText(/Tu contraseña se cambió/)).toHaveCount(0);
});

async function throttle(page: Page, who: Person): Promise<Date> {
  const attempts = await parameter("INTENTOS_ANTES_DE_FRENO");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await signIn(page, { email: who.email, password: `equivocada-${attempt}` });
    await expect(page.getByText("El correo o la contraseña no coinciden.")).toBeVisible();
  }
  await signIn(page, who);
  const [row] = await ownerQuery<{ locked_until: Date }>(
    "select locked_until from private.login_throttles where locked_until is not null order by locked_until desc limit 1",
  );
  if (!row?.locked_until) throw new Error("El freno no dejó una espera.");
  return row.locked_until;
}

const clock = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat("es-MX", { hour: "numeric", minute: "2-digit", timeZone }).format(date);

// La hora la escribe aquí Node y allá el navegador, y no siempre ponen el mismo espacio
// entre la hora y «a. m.»: se comparan con los espacios emparejados.
const spaced = (text: string) => text.replace(/\s+/g, " ").trim();

async function inContext<T>(browser: Browser, options: Parameters<Browser["newContext"]>[0], work: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await work(await context.newPage());
  } finally {
    await context.close();
  }
}

test("la hora del freno se dice en la zona de quien lee", async ({ browser }) => {
  const ana = await person();
  await inContext(browser, { timezoneId: "Asia/Tokyo", locale: "es-MX" }, async (page) => {
    const until = await throttle(page, ana);
    // Tokio y el centro de México no dan nunca la misma hora: si la pantalla dijera la del
    // servidor, este caso lo notaría.
    expect(clock(until, "Asia/Tokyo")).not.toBe(clock(until, "America/Mexico_City"));
    const alert = page.getByRole("alert").filter({ hasText: "Demasiados intentos." });
    await expect(alert).toBeVisible();
    // Espera a que el navegador haya vuelto a escribir la hora en su zona.
    await expect
      .poll(async () => spaced((await alert.textContent()) ?? ""))
      .toContain(spaced(`Demasiados intentos. Podrás probar de nuevo a las ${clock(until, "Asia/Tokyo")}.`));
    await expect(alert).not.toContainText("hora del centro de México");
    await expect(page.getByRole("button", { name: "Entrar" })).toBeDisabled();
  });
});

test("sin JavaScript, la hora del freno va en la del centro de México, lo dice, y el botón llega deshabilitado", async ({ browser }) => {
  const ana = await person();
  await inContext(browser, { javaScriptEnabled: false, timezoneId: "Asia/Tokyo", locale: "es-MX" }, async (page) => {
    const until = await throttle(page, ana);
    const message = page.getByText("hora del centro de México");
    await expect(message).toBeVisible();
    expect(spaced((await message.textContent()) ?? "")).toContain(
      spaced(`Demasiados intentos. Podrás probar de nuevo a las ${clock(until, "America/Mexico_City")}, hora del centro de México.`),
    );
    const button = page.getByRole("button", { name: "Entrar" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription("Podrás intentarlo de nuevo cuando pase la espera.");
  });
});

test("sin JavaScript, un formulario vacío vuelve con sus errores y el destino guardado se respeta", async ({ browser }) => {
  const ana = await person();
  await inContext(browser, { javaScriptEnabled: false }, async (page) => {
    await page.goto("/entrar?volver=%2Finicio%3Fpestana%3D2");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("Hay 2 datos por corregir")).toBeVisible();
    await expect(page.getByRole("link", { name: "Escribe tu correo." })).toBeVisible();

    await page.getByLabel("Correo").fill(ana.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(ana.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL("/inicio?pestana=2");
  });
});

test("la dirección de quien pide se lee de la cabecera que pone el alojamiento, y de ninguna otra", async ({ request }) => {
  const ask = async (headers: Record<string, string>) =>
    (await (await request.get("/api/origin-drill?probe=203.0.113.9", { headers })).json()) as Record<string, boolean>;

  // En local no hay alojamiento delante: la cabecera llega tal como la manda quien pide, y
  // por eso aquí no se le cree (`trusted`).
  expect(await ask({ "x-real-ip": "203.0.113.9" })).toEqual({ present: true, readable: true, matchesProbe: true, trusted: false });
  expect(await ask({ "x-real-ip": "198.51.100.20" })).toEqual({ present: true, readable: true, matchesProbe: false, trusted: false });
  // La que escribe quien pide no se lee nunca.
  expect(await ask({ "x-forwarded-for": "203.0.113.9" })).toMatchObject({ present: false, matchesProbe: false });
  expect((await request.get("/api/origin-drill")).status()).toBe(400);
});
