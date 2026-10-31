import { expect, test, type Browser, type Page } from "@playwright/test";

import { actionFields, postAction } from "../support/actions";
import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// PA-48, datos fiscales y bancarios (T-409; FL-31), de extremo a extremo: capturar, ver lo oculto en parte y cambiar, con JavaScript y sin él; que el
// documento nunca traiga el dato entero; la contraseña equivocada; el maestro suspendido en solo lectura; y que a una alumna la ruta le contesta lo mismo
// que una que no existe. Va con el camino del equipo porque escribe en una tabla que no se borra y en la auditoría: `pnpm test:e2e:equipo` rehace la base.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const PATH = "/portal/datos-fiscales";
const RFC = "GODE561231GR8";
const NAME = "Elena Gómez Díaz";
const CLABE = "012180001234567899";
const LAST4 = "7899";

async function makeTeacher(who: Person): Promise<void> {
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     insert into public.teachers (profile_id, status) select $1, 'active' from declared`,
    [who.id],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_id', $1::text, true) as done)
     insert into public.consents (profile_id, legal_document_id, origin)
     select $1::uuid, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from declared`,
    [who.id],
  );
}

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

async function noJs(browser: Browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  return { context, page: await context.newPage() };
}

const reads = async (who: Person): Promise<string | undefined> =>
  (
    await ownerQuery<{ count: string }>(
      `select count(*) from public.audit_log a join public.teachers t on t.id::text = a.new_value ->> 'teacher_id'
       where a.action = 'tax_profile.read' and t.profile_id = $1`,
      [who.id],
    )
  )[0]?.count;

async function capture(page: Page, password: string, clabe = CLABE): Promise<void> {
  await page.getByRole("textbox", { name: "RFC" }).fill(RFC);
  await page.getByRole("combobox", { name: /Régimen fiscal/ }).selectOption("626");
  await page.getByRole("textbox", { name: "Razón social" }).fill(NAME);
  await page.getByRole("textbox", { name: "CLABE" }).fill(clabe);
  await page.getByLabel("Tu contraseña").fill(password);
  await page.getByRole("button", { name: "Guardar" }).click();
}

test("FL-31 con JavaScript: captura, ve lo oculto en parte, y cambia", async ({ page }) => {
  const ana = await person();
  await makeTeacher(ana);
  await signIn(page, ana, "/portal");

  // El aviso de datos pendientes lleva a la pantalla. Recién entrando, el enrutador todavía puede estar terminando la acción de entrar y soltar el clic.
  await expect(async () => {
    await page.getByRole("link", { name: "Capturar mis datos fiscales" }).click({ timeout: 2_000 });
    await expect(page).toHaveURL(PATH, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  expect(await a11yViolations(page)).toEqual([]);
  await expect(page.getByText("Solo tú y el equipo de finanzas ven estos datos")).toBeVisible();

  // Un error de forma se dice en su campo, y lo escrito no se pierde.
  await capture(page, ana.password, "123");
  await expect(page.getByText("La CLABE tiene 18 dígitos").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "RFC" })).toHaveValue(RFC);
  await expect(page.getByRole("combobox", { name: /Régimen fiscal/ })).toHaveValue("626");
  await expect(page.getByRole("textbox", { name: "CLABE" })).toHaveValue("123");
  await expect(page.getByLabel("Tu contraseña")).toHaveValue("");

  // La contraseña equivocada no guarda.
  await capture(page, "no-es-la-suya");
  await expect(page.getByText("Esa no es tu contraseña").first()).toBeVisible();

  await capture(page, ana.password);
  await expect(page.getByText("Tus datos quedaron guardados.")).toBeVisible();
  expect(await reads(ana)).toBe("0");
  // Ni el documento ni la dirección traen lo escrito.
  const saved = await page.content();
  for (const plain of [RFC, NAME, CLABE]) expect(saved).not.toContain(plain);
  expect(await a11yViolations(page)).toEqual([]);

  // Antes de mostrar nada, la contraseña.
  await expect(page.getByText(`•••• ${LAST4}`)).toHaveCount(0);
  await page.getByLabel("Tu contraseña").fill("no-es-la-suya");
  await page.getByRole("button", { name: "Ver mis datos" }).click();
  await expect(page.getByText("Esa no es tu contraseña").first()).toBeVisible();
  expect(await reads(ana)).toBe("0");

  await page.getByLabel("Tu contraseña").fill(ana.password);
  // Lo que viaja en la respuesta de la acción, que `page.content()` no ve. Se pasa por aquí: el navegador no guarda el cuerpo de una respuesta en flujo.
  const answers: string[] = [];
  await page.route(`**${PATH}`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    answers.push(await response.text());
    return route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Ver mis datos" }).click();
  await expect(page.getByText(`•••• ${LAST4}`)).toBeVisible();
  await page.unroute(`**${PATH}`);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toContain(`•••• ${LAST4}`);
  for (const plain of [RFC, NAME, CLABE, ana.password]) expect(answers[0]).not.toContain(plain);
  await expect(page.getByRole("heading", { name: "Tus datos guardados" })).toBeFocused();
  await expect(page.getByText("•••• 1GR8")).toBeVisible();
  await expect(page.getByText("•••• Díaz")).toBeVisible();
  await expect(page.getByText(/Régimen Simplificado de Confianza/)).toBeVisible();
  expect(await reads(ana)).toBe("1");
  const shown = await page.content();
  for (const plain of [RFC, NAME, CLABE]) expect(shown).not.toContain(plain);
  expect(await a11yViolations(page)).toEqual([]);

  // Cambiar vuelve a pedir el dato completo, y dice a qué pagos aplica.
  await page.getByRole("link", { name: "Cambiar" }).click();
  await expect(page).toHaveURL(`${PATH}?cambiar=1`);
  await expect(page.getByText("Aplica a los pagos que todavía no se hacen.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "RFC" })).toHaveValue("");
  // El aviso de lo guardado antes dura 60 segundos en su cookie, y mientras se captura de nuevo no se dice.
  await expect(page.getByText("Tus datos quedaron guardados.")).toHaveCount(0);
  await capture(page, ana.password);
  await expect(page).toHaveURL(PATH);
  await expect(page.getByText("Tus datos quedaron guardados.")).toBeVisible();
  const rows = await ownerQuery<{ version: number }>(
    `select x.version from private.teacher_tax_profiles x join public.teachers t on t.id = x.teacher_id where t.profile_id = $1 order by x.version`,
    [ana.id],
  );
  expect(rows.map((row) => row.version)).toEqual([1, 2]);

  // El menú la lleva, y el aviso de pendientes ya no está.
  await page.goto("/portal");
  await expect(page.getByRole("link", { name: "Capturar mis datos fiscales" })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("link", { name: "Datos fiscales" }).first().click();
  await expect(page).toHaveURL(PATH);
});

test("FL-31 sin JavaScript: captura y ve, y el documento nunca trae el dato entero", async ({ browser }) => {
  const { context, page } = await noJs(browser);
  try {
    const ana = await person();
    await makeTeacher(ana);
    await signIn(page, ana, PATH);

    await capture(page, ana.password);
    await expect(page.getByText("Tus datos quedaron guardados.")).toBeVisible();
    for (const plain of [RFC, NAME, CLABE]) expect(await page.content()).not.toContain(plain);

    await page.getByLabel("Tu contraseña").fill(ana.password);
    await page.getByRole("button", { name: "Ver mis datos" }).click();
    await expect(page.getByText(`•••• ${LAST4}`)).toBeVisible();
    const shown = await page.content();
    for (const plain of [RFC, NAME, CLABE, ana.password]) expect(shown).not.toContain(plain);
    // Con lo oculto a la vista no hay formulario de esta pantalla: sin JavaScript, el estado viajaría en él. Queda el de «Cerrar sesión» del menú.
    await expect(page.locator("main form")).toHaveCount(0);

    await page.getByRole("link", { name: "Ocultar" }).click();
    await expect(page.getByText(`•••• ${LAST4}`)).toHaveCount(0);

    // Al cambiar, un error se dice en la misma pantalla: el envío vuelve a la dirección con `cambiar`.
    await page.getByRole("link", { name: "Cambiar" }).click();
    await capture(page, ana.password, "123");
    await expect(page).toHaveURL(`${PATH}?cambiar=1`);
    await expect(page.getByText("La CLABE tiene 18 dígitos").first()).toBeVisible();
    for (const plain of [RFC, NAME, ana.password]) expect(await page.content()).not.toContain(plain);
    await capture(page, "no-es-la-suya");
    await expect(page.getByText("Esa no es tu contraseña").first()).toBeVisible();
    for (const plain of [RFC, NAME, CLABE, "no-es-la-suya"]) expect(await page.content()).not.toContain(plain);
  } finally {
    await context.close();
  }
});

test("dos ventanas en la primera captura: la segunda no pisa, y dice qué pasó", async ({ page, context }) => {
  const ana = await person();
  await makeTeacher(ana);
  await signIn(page, ana, PATH);
  const other = await context.newPage();
  await other.goto(PATH);

  await capture(page, ana.password);
  await expect(page.getByText("Tus datos quedaron guardados.")).toBeVisible();

  await capture(other, ana.password);
  await expect(other).toHaveURL(`${PATH}?cambiar=1`);
  await expect(other.getByText("Tus datos cambiaron en otra ventana.")).toBeVisible();
  const rows = await ownerQuery<{ version: number }>(
    `select x.version from private.teacher_tax_profiles x join public.teachers t on t.id = x.teacher_id where t.profile_id = $1`,
    [ana.id],
  );
  expect(rows.map((row) => row.version)).toEqual([1]);
});

test("reenviar el formulario de ver con la contraseña equivocada no deja lectura", async ({ browser }) => {
  const { context, page } = await noJs(browser);
  try {
    const ana = await person();
    await makeTeacher(ana);
    await signIn(page, ana, PATH);
    await capture(page, ana.password);
    await expect(page.getByText("Tus datos quedaron guardados.")).toBeVisible();

    const html = await page.content();
    const position = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].findIndex((match) => match[0].includes('name="password"'));
    const response = await postAction(context.request, PATH, { ...actionFields(html, position), password: "no-es-la-suya" });
    expect(response.status()).toBeLessThan(500);
    expect(await reads(ana)).toBe("0");
  } finally {
    await context.close();
  }
});

test("un maestro suspendido ve lo suyo y no lo cambia", async ({ page }) => {
  const ana = await person();
  await makeTeacher(ana);
  await signIn(page, ana, PATH);
  await capture(page, ana.password);
  await expect(page.getByText("Tus datos quedaron guardados.")).toBeVisible();
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where profile_id = $1 and exists (select 1 from declared)`,
    [ana.id],
  );

  await page.goto(PATH);
  await expect(page.getByRole("link", { name: "Cambiar" })).toHaveCount(0);
  await page.getByLabel("Tu contraseña").fill(ana.password);
  await page.getByRole("button", { name: "Ver mis datos" }).click();
  await expect(page.getByText(`•••• ${LAST4}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Cambiar" })).toHaveCount(0);

  // Pedir la captura en la dirección no la pinta.
  await page.goto(`${PATH}?cambiar=1`);
  await expect(page.getByRole("textbox", { name: "RFC" })).toHaveCount(0);
});

test("a una alumna la ruta le contesta lo mismo que una que no existe", async ({ page }) => {
  const alumna = await person();
  await signIn(page, alumna, "/inicio");
  const here = await page.goto(PATH);
  expect(here?.status()).toBe(404);
  const other = await page.goto("/portal/no-existe");
  expect(other?.status()).toBe(404);
  await expect(page.getByRole("textbox", { name: "RFC" })).toHaveCount(0);
});
