import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { totpCode } from "../../integration/helpers/totp";
import { lastMailTo, ownerQuery, person, tokenHashIn, type Person } from "../support/stack";

// El recorrido de capturas de la pasada visual (T-614): las mismas pantallas, en computadora (1 440 × 900)
// y en teléfono (390 × 844), para que cada parte traiga sus capturas antes y después con el mismo
// recorrido. Lo escribió la sesión de la vitrina el 2026-11-03, y entra aquí con la primera parte.
//
// No es una prueba: no revisa nada de lo que muestra, y cada captura es independiente (si una pantalla
// falla, se anota y se sigue). Por eso se salta salvo que se le pida, con `VITRINA_OUT` (la carpeta de las
// capturas), y no alarga la corrida de siempre de `pnpm test:e2e:equipo`. Se corre solo, contra la base
// local con sus cursos y su alumna:
//
//   pnpm db:reset && pnpm db:courses && pnpm db:student      (imprime la contraseña de la alumna)
//   VITRINA_OUT=<carpeta> VITRINA_ALUMNA_PASS=<contraseña> pnpm test:e2e:equipo tests/e2e/equipo/vitrina.equipo.ts
//
// Como todo el camino del equipo, rehace la base al terminar. `/admin/revision` sale vacía si `db:student`
// ya publicó los cursos.

const OUT = process.env.VITRINA_OUT ?? "";
const STUDENT_EMAIL = process.env.VITRINA_ALUMNA ?? "alumna@prueba.test";
const STUDENT_PASSWORD = process.env.VITRINA_ALUMNA_PASS ?? "";
const PASSWORD = "Vitrina-2026-pruebas";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const failures: string[] = [];

test.skip(OUT === "", "El recorrido de capturas corre solo con VITRINA_OUT");
test.describe.configure({ mode: "serial", timeout: 600_000 });
if (OUT !== "") mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string, path: string | null, size = DESKTOP): Promise<void> {
  try {
    await page.setViewportSize(size);
    if (path !== null) await page.goto(path, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message.split("\n")[0]}`);
  }
}

async function both(page: Page, name: string, path: string): Promise<void> {
  await shot(page, `${name}-escritorio`, path, DESKTOP);
  await shot(page, `${name}-telefono`, path, PHONE);
}

async function signIn(page: Page, email: string, password: string, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(path, { timeout: 20_000 });
}

test.afterAll(() => {
  if (OUT !== "") console.log(`\nCAPTURAS FALLIDAS (${failures.length}):\n${failures.join("\n")}`);
});

test("público y cuenta", async ({ page }) => {
  await both(page, "01-portada", "/");
  await both(page, "02-entrar", "/entrar");
  await both(page, "03-registro", "/registro");
  await both(page, "04-recuperar", "/recuperar");
  await both(page, "05-legal-terminos", "/legal/terminos");
  await both(page, "06-ficha-curso-visitante", "/cursos/prueba-naturaleza");
  await both(page, "07-ficha-maestra-visitante", "/maestros/maestra-de-prueba-bosque");
  await both(page, "08-explorar-visitante", "/explorar");
  await both(page, "09-no-existe", "/no-existe");
});

test("alumna", async ({ page }) => {
  test.skip(STUDENT_PASSWORD === "", "Falta VITRINA_ALUMNA_PASS");
  await signIn(page, STUDENT_EMAIL, STUDENT_PASSWORD, "/inicio");
  await both(page, "10-inicio-alumna", "/inicio");
  await both(page, "11-explorar", "/explorar");
  await both(page, "12-buscar", "/explorar?q=respira");
  await both(page, "13-ficha-curso", "/cursos/prueba-naturaleza");
  await both(page, "14-ficha-maestra", "/maestros/maestra-de-prueba-bosque");
  try {
    await page.setViewportSize(DESKTOP);
    await page.goto("/cursos/prueba-naturaleza", { waitUntil: "networkidle" });
    const lesson = page.locator('a[href*="/lecciones/"]').first();
    const href = await lesson.getAttribute("href");
    if (href) {
      await both(page, "15-leccion", href);
    }
  } catch (error) {
    failures.push(`15-leccion: ${(error as Error).message.split("\n")[0]}`);
  }
  await both(page, "16-cuenta", "/cuenta");
});

async function makeTeacher(who: Person): Promise<void> {
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     insert into public.teachers (profile_id, status) select $1, 'active'::public.teacher_status from declared`,
    [who.id],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_id', $1::text, true) as done)
     insert into public.consents (profile_id, legal_document_id, origin)
     select $1::uuid, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from declared`,
    [who.id],
  );
}

test("maestra", async ({ page }) => {
  const ana = await person();
  await makeTeacher(ana);
  await signIn(page, ana.email, ana.password, "/portal/cursos");
  await shot(page, "20-portal-sin-cursos", "/portal/cursos");
  await shot(page, "21-portal-inicio", "/portal");
  try {
    await page.goto("/portal/cursos");
    await page.getByRole("link", { name: "Crear mi primer curso" }).click();
    await shot(page, "22-portal-curso-nuevo", null);
    await page.getByRole("textbox", { name: "Título del curso" }).fill("Respirar en calma");
    await page.getByRole("button", { name: "Crear curso" }).click();
    await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
    const course = page.url();
    await page.getByRole("textbox", { name: /Resumen/ }).fill("Siete prácticas cortas para volver a la respiración en un día agitado.");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByText("Guardado.")).toBeVisible();
    for (const title of ["Primeros pasos", "La práctica diaria"]) {
      await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill(title);
      await page.getByRole("button", { name: "Agregar módulo" }).click();
      await expect(page).toHaveURL(/\?modulo=/);
    }
    for (const title of ["Notar la respiración", "Exhalar más largo"]) {
      const item = page.locator("li", { has: page.getByRole("link", { name: /^Módulo \d+: Primeros pasos$/ }) });
      await item.getByRole("textbox", { name: "Título de la lección nueva" }).fill(title);
      await item.getByRole("button", { name: "Agregar lección" }).click();
      await expect(page).toHaveURL(/\?leccion=/);
    }
    await shot(page, "23-editor-leccion", null);
    await shot(page, "24-editor-curso", course);
    await shot(page, "25-portal-mis-cursos", "/portal/cursos");
  } catch (error) {
    failures.push(`editor: ${(error as Error).message.split("\n")[0]}`);
  }
  await shot(page, "26-portal-datos-fiscales", "/portal/datos-fiscales");
  await shot(page, "27-portal-cuenta", "/portal/cuenta");
  await shot(page, "28-portal-telefono", "/portal/cursos", PHONE);
});

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

async function joinTeam(browser: Browser, email: string): Promise<{ secret: string; used: string[] }> {
  execFileSync(process.execPath, ["scripts/db-admins.mjs", email], { encoding: "utf8" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/registro");
    await page.getByLabel("Correo").fill(email);
    await page.getByRole("button", { name: "Crear mi cuenta" }).click();
    await expect(page).toHaveURL("/verificar", { timeout: 20_000 });
    await page.goto(`/verificar/${tokenHashIn(await lastMailTo(email), "verificar")}`);
    await page.getByLabel("Nombre").fill("Equipo de Prueba");
    await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Tengo 18 años cumplidos o más.").check();
    await page.getByRole("checkbox", { name: /^Acepto los Términos.*y el Aviso de privacidad/ }).check();
    await page.getByLabel("Doy mi permiso para que la Escuela de Misterios guarde mi historial de cursos con esos fines.").check();
    await page.getByRole("button", { name: "Confirmar mi correo" }).click();
    await expect(page).toHaveURL("/entrar/segundo-factor/configurar");
    await page.getByRole("button", { name: "Empezar" }).click();
    await page.waitForTimeout(500);
    await page.setViewportSize(DESKTOP);
    await page.screenshot({ path: join(OUT, "30-segundo-factor-configurar.png"), fullPage: true });
    const secret = (await page.locator("main code").innerText()).trim();
    const used: string[] = [];
    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");
    return { secret, used };
  } finally {
    await context.close();
  }
}

test("administración", async ({ browser, page }) => {
  const email = "equipo-vitrina@prueba.test";
  const member = await joinTeam(browser, email);
  await page.goto("/entrar?volver=%2Fadmin");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/segundo-factor/);
  await shot(page, "31-segundo-factor", null);
  await page.getByLabel("Código").fill(await nextCode(member.secret, member.used));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL("/admin");
  await shot(page, "32-admin-inicio", "/admin");
  await shot(page, "33-admin-revision", "/admin/revision");
  await shot(page, "34-admin-maestros", "/admin/maestros");
  await shot(page, "35-admin-equipo", "/admin/equipo");
  await shot(page, "36-admin-periodos", "/admin/periodos");
  await shot(page, "37-admin-alertas", "/admin/alertas");
  await shot(page, "38-admin-practicas", "/admin/practicas");
  await shot(page, "39-admin-textos-legales", "/admin/textos-legales");
});
