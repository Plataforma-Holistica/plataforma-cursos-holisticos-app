import { execFileSync } from "node:child_process";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { totpCode } from "../../integration/helpers/totp";
import { a11yViolations } from "../support/a11y";
import { clearCounters, lastMailTo, ownerQuery, testEmail, tokenHashIn, userIdOf } from "../support/stack";

// Administrar a los maestros, de extremo a extremo (T-401; RF-104, RF-702; PA-65, PA-66, PA-40 y PA-68; FL-30, FL-46,
// FL-64): alguien con Contenido invita, la persona se registra y acepta, se le marca fundador, se le suspende y se le
// levanta; y una suspensión por fraude la propone una persona y la confirma otra. Deja residuo, como todo lo del equipo.

test.beforeEach(clearCounters);
// Un código no se da dos veces: entre configurar y entrar hay que esperar al siguiente.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const PASSWORD = "una-clave-de-prueba-9";
const LIST = "/admin/maestros";

interface Member {
  email: string;
  secret: string;
  used: string[];
}

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

async function inContext<T>(browser: Browser, work: (page: Page) => Promise<T>, javaScriptEnabled = true): Promise<T> {
  const context = await browser.newContext({ javaScriptEnabled });
  try {
    return await work(await context.newPage());
  } finally {
    await context.close();
  }
}

/** Registra ese correo desde el enlace de su buzón, en ese navegador, y la deja dentro. */
async function register(page: Page, email: string): Promise<void> {
  await page.goto("/registro");
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Crear mi cuenta" }).click();
  await expect(page).toHaveURL("/verificar", { timeout: 20_000 });
  await page.goto(`/verificar/${tokenHashIn(await lastMailTo(email), "verificar")}`);
  await page.getByLabel("Nombre").fill("Persona de Prueba");
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Tengo 18 años cumplidos o más.").check();
  await page.getByRole("checkbox", { name: /^Acepto los Términos.*y el Aviso de privacidad/ }).check();
  await page.getByLabel("Doy mi permiso para que La Plataforma guarde mi historial de cursos con esos fines.").check();
  await page.getByRole("button", { name: "Confirmar mi correo" }).click();
}

/** Alguien nuevo del equipo, con todas las capacidades: se registra y configura su segundo factor. Queda sin sesión. */
async function joinTeam(browser: Browser, email: string): Promise<Member> {
  execFileSync(process.execPath, ["scripts/db-admins.mjs", email], { encoding: "utf8" });
  return inContext(browser, async (page) => {
    await register(page, email);
    await expect(page).toHaveURL("/entrar/segundo-factor/configurar");
    await page.getByRole("button", { name: "Empezar" }).click();
    const secret = (await page.locator("main code").innerText()).trim();
    const used: string[] = [];
    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");
    return { email, secret, used };
  });
}

/** Entra con su contraseña, da su código y llega a esa pantalla de administración. */
async function enterAdmin(page: Page, who: Member, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(`/entrar/segundo-factor?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Código").fill(await nextCode(who.secret, who.used));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(path);
}

/** El maestro de ese correo, a partir de su invitación. */
async function teacherOf(email: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>("select teacher_id::text as id from private.teacher_invitations where email = lower($1) order by created_at desc limit 1", [email]);
  if (row === undefined) throw new Error(`Sin invitación para ${email}.`);
  return row.id;
}

async function invite(page: Page, name: string, email: string): Promise<void> {
  await page.getByLabel("Nombre").fill(name);
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Invitar", exact: true }).click();
  await expect(page.getByText(/^Invitación lista\.|Invitación lista\./)).toBeVisible();
}

let primera: Member;
let segunda: Member;

test.beforeAll(async ({ browser }) => {
  primera = await joinTeam(browser, testEmail());
  segunda = await joinTeam(browser, testEmail());
});

test("FL-46 y FL-30: invita, la persona se registra y acepta, se le marca fundador, se le suspende y se le levanta", async ({ page, browser }) => {
  const maestra = testEmail();
  await enterAdmin(page, primera, LIST);
  expect(await a11yViolations(page)).toEqual([]);

  // Sin nombre ni correo lo dice en sus campos.
  await page.getByRole("button", { name: "Invitar", exact: true }).click();
  await expect(page.getByRole("link", { name: /Escribe su nombre/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Escribe un correo válido/ })).toBeVisible();

  await invite(page, "Nora Maestra", maestra);
  const row = page.getByRole("row", { name: /Nora Maestra/ });
  await expect(row.getByText(/Pendiente, caduca el/)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // El mismo correo otra vez: lo dice y no manda nada.
  await page.getByLabel("Nombre").fill("Nora Otra Vez");
  await page.getByLabel("Correo").fill(maestra);
  await page.getByRole("button", { name: "Invitar", exact: true }).click();
  await expect(page.getByText(/ya tiene una invitación/)).toBeVisible();

  // Revocar y reenviar.
  await row.getByRole("button", { name: "Revocar" }).click();
  await expect(page.getByText("Invitación revocada.")).toBeVisible();
  await expect(row.getByText("Revocada")).toBeVisible();
  await expect(row.getByRole("button", { name: "Revocar" })).toHaveCount(0);
  await row.getByRole("button", { name: "Reenviar" }).click();
  await expect(page.getByText(/Invitación renovada/)).toBeVisible();

  // La persona se registra con ese correo y acepta.
  await inContext(browser, async (other) => {
    await register(other, maestra);
    await expect(other).toHaveURL("/portal/invitacion");
    await expect(other.getByRole("heading", { level: 1, name: "Nora Maestra, te invitamos a dar clases" })).toBeVisible();
    await other.getByLabel("He leído y acepto el contrato.").check();
    await other.getByLabel("He leído y acepto el aviso de privacidad.").check();
    await other.getByRole("button", { name: "Aceptar y entrar" }).click();
    await expect(other).toHaveURL("/portal");
  });

  // La ficha.
  await page.goto(LIST);
  await expect(row.getByText("Activo")).toBeVisible();
  await row.getByRole("link", { name: "Nora Maestra" }).click();
  const teacher = await teacherOf(maestra);
  await expect(page).toHaveURL(`${LIST}/${teacher}`);
  expect(await a11yViolations(page)).toEqual([]);

  // Fundador: sin fecha atrás.
  await page.getByLabel("Fundador desde").fill("2020-01-01");
  await page.getByRole("button", { name: "Guardar la fecha" }).click();
  await expect(page.getByText(/no puede ser anterior al mes en curso/)).toBeVisible();
  const year = new Date().getUTCFullYear() + 2;
  await page.getByLabel("Fundador desde").fill(`${year}-01-01`);
  await page.getByRole("button", { name: "Guardar la fecha" }).click();
  await expect(page.getByText("Guardado.")).toBeVisible();
  await page.getByRole("button", { name: "Quitar la marca" }).click();
  await expect(page.getByText("No es fundador.")).toBeVisible();

  // Suspender pide lo que lee y el motivo, y pregunta antes.
  await page.getByRole("button", { name: "Suspender", exact: true }).click();
  await expect(page.getByRole("link", { name: /Escribe el motivo/ })).toBeVisible();
  await page.getByLabel("Motivo interno").fill("Motivo interno de la prueba");
  await page.getByLabel(/^Lo que lee/).fill("Tu cuenta está en pausa.");
  await page.getByRole("button", { name: "Suspender", exact: true }).click();
  await expect(page.getByText(/¿Dejar en solo lectura/)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Sí, suspender" }).click();
  await expect(page.getByText(/ya está en solo lectura/)).toBeVisible();
  await expect(page.getByText("Motivo interno: Motivo interno de la prueba")).toBeVisible();

  // La maestra ve solo su texto.
  await inContext(browser, async (other) => {
    await other.goto("/entrar");
    await other.getByLabel("Correo").fill(maestra);
    await other.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
    await other.getByRole("button", { name: "Entrar" }).click();
    await expect(other).toHaveURL("/portal");
    await expect(other.getByText("Tu cuenta está en pausa.")).toBeVisible();
    expect(await other.content()).not.toContain("Motivo interno de la prueba");
  });

  await page.getByRole("button", { name: "Levantar la suspensión" }).click();
  await expect(page.getByText("Suspensión levantada.")).toBeVisible();
});

test("sin JavaScript también se invita, se revoca, se suspende y se levanta", async ({ browser }) => {
  const maestra = testEmail();
  await inContext(
    browser,
    async (page) => {
      await enterAdmin(page, segunda, LIST);
      await invite(page, "Elsa Sinjs", maestra);
      const row = page.getByRole("row", { name: /Elsa Sinjs/ });
      await row.getByRole("button", { name: "Revocar" }).click();
      await expect(page.getByText("Invitación revocada.")).toBeVisible();
      await row.getByRole("link", { name: "Elsa Sinjs" }).click();
      await expect(page).toHaveURL(`${LIST}/${await teacherOf(maestra)}`);
      await page.getByLabel("Fundador desde").fill(`${new Date().getUTCFullYear() + 2}-01-01`);
      await page.getByRole("button", { name: "Guardar la fecha" }).click();
      await expect(page.getByText("Guardado.")).toBeVisible();
    },
    false,
  );

  // Un maestro activo: suspender en dos pasos, sin JavaScript, con «Seguir revisando» en medio.
  const activa = testEmail();
  const teacher = await inContext(browser, async (page) => {
    await enterAdmin(page, primera, LIST);
    await invite(page, "Luz Sinjs", activa);
    return teacherOf(activa);
  });
  await inContext(browser, async (other) => {
    await register(other, activa);
    await other.getByLabel("He leído y acepto el contrato.").check();
    await other.getByLabel("He leído y acepto el aviso de privacidad.").check();
    await other.getByRole("button", { name: "Aceptar y entrar" }).click();
    await expect(other).toHaveURL("/portal");
  });
  await inContext(
    browser,
    async (page) => {
      await enterAdmin(page, segunda, `${LIST}/${teacher}`);
      await page.getByLabel("Motivo interno").fill("Motivo sin JavaScript");
      await page.getByLabel(/^Lo que lee/).fill("Aviso sin JavaScript");
      await page.getByRole("button", { name: "Suspender", exact: true }).click();
      await page.getByRole("button", { name: "Seguir revisando" }).click();
      await expect(page.getByLabel("Motivo interno")).toHaveValue("Motivo sin JavaScript");
      await page.getByRole("button", { name: "Suspender", exact: true }).click();
      await page.getByRole("button", { name: "Sí, suspender" }).click();
      await expect(page.getByText("Motivo interno: Motivo sin JavaScript")).toBeVisible();
      await page.getByRole("button", { name: "Levantar la suspensión" }).click();
      await expect(page.getByText("Suspensión levantada.")).toBeVisible();
    },
    false,
  );
});

test("FL-64: una persona marca el fraude y propone; quien propuso no confirma; otra persona confirma", async ({ browser }) => {
  const maestra = testEmail();
  const teacher = await inContext(browser, async (page) => {
    await enterAdmin(page, primera, LIST);
    await invite(page, "Rita Fraude", maestra);
    return teacherOf(maestra);
  });
  await inContext(browser, async (other) => {
    await register(other, maestra);
    await expect(other).toHaveURL("/portal/invitacion");
    await other.getByLabel("He leído y acepto el contrato.").check();
    await other.getByLabel("He leído y acepto el aviso de privacidad.").check();
    await other.getByRole("button", { name: "Aceptar y entrar" }).click();
    await expect(other).toHaveURL("/portal");
  });

  // Una alerta de salto de puntos de esa maestra, como la dejaría la consolidación.
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done),
          opened as materialized (select private.open_period(private.period_of(clock_timestamp())) from declared)
     insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value)
     select private.period_of(clock_timestamp()), 'teacher_points_jump', $1::uuid, 500, 300 from opened`,
    [teacher],
  );

  await inContext(browser, async (page) => {
    await enterAdmin(page, segunda, "/admin/alertas");
    const alert = page.getByRole("article", { name: /Subida de puntos/ }).filter({ hasText: "Rita Fraude" });
    await alert.getByLabel("Nota de la revisión").fill("Revisada.");
    await alert.getByRole("button", { name: "Marcar como revisada" }).click();
    await alert.getByRole("button", { name: "Decidir que es fraude" }).click();
    await alert.getByLabel("Evidencia").fill("Puntos imposibles.");
    await alert.getByRole("button", { name: "Sí, es fraude" }).click();
    await alert.getByRole("button", { name: "Proponer la suspensión" }).click();
    await alert.getByLabel("Por qué").fill("Puntos inflados.");
    await alert.getByRole("button", { name: "Sí, proponerla" }).click();
    await expect(page.getByText(/Propuesta hecha/)).toBeVisible();
    await expect(alert.getByText("Tú propusiste la suspensión.", { exact: false })).toBeVisible();

    // Quien propuso no confirma, y la pantalla lo dice.
    await page.goto(`${LIST}/${teacher}`);
    await expect(page.getByText("Tú la propusiste", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar la suspensión" })).toHaveCount(0);
  });

  await inContext(browser, async (page) => {
    await enterAdmin(page, primera, LIST);
    await expect(page.getByRole("heading", { name: "Suspensiones por confirmar" })).toBeVisible();
    await page.getByRole("link", { name: "Abrir la ficha" }).click();
    await expect(page).toHaveURL(`${LIST}/${teacher}`);
    await page.getByLabel(/^Lo que lee/).first().fill("Revisamos un caso de tu cuenta.");
    await page.getByRole("button", { name: "Confirmar la suspensión" }).click();
    await expect(page.getByText("¿Confirmar la suspensión por fraude?")).toBeVisible();
    await page.getByRole("button", { name: "Sí, confirmar" }).click();
    await expect(page.getByText(/Suspensión confirmada/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "En solo lectura, por fraude" })).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
  });
  expect(await userIdOf(maestra)).not.toBe("");
});
