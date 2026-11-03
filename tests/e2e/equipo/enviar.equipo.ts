import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// Enviar a revisión desde el portal, de extremo a extremo (T-405, tercera solicitud; RF-606, FL-34; PA-43, PA-44, PA-42 y PA-50), con JavaScript y sin él: el editor ofrece enviar,
// PA-44 dice qué está completo y muestra el anexo con la frase que nombra el curso, sin la casilla no se envía, enviado vuelve a Mis cursos con la fecha, y «Lo que aceptaste» lo
// lista con su texto. Va con el camino del equipo porque un maestro con cuenta no se puede borrar y enviar deja un libro: `pnpm test:e2e:equipo` rehace la base al terminar.
//
// El video de cada curso es del proveedor de prueba, que en la integración continua no le pregunta nada a Mux.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

let practice = "";
let level = "";

const declared = "with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)";

async function makeTeacher(who: Person): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(`${declared} insert into public.teachers (profile_id, status) select $1::uuid, 'active' from declared returning id::text`, [who.id]);
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_id', $1::text, true) as done)
     insert into public.consents (profile_id, legal_document_id, origin)
     select $1::uuid, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from declared`,
    [who.id],
  );
  return row!.id;
}

/** Un curso de una lección, listo para enviar: los datos, un módulo y una lección con su video vigente. */
async function readyCourse(teacherId: string, title: string): Promise<string> {
  const course = randomUUID();
  const moduleId = randomUUID();
  const lesson = randomUUID();
  const video = randomUUID();
  await ownerQuery(`${declared} insert into public.course_registry (course_id, teacher_id, state) select $1::uuid, $2::uuid, 'draft' from declared`, [course, teacherId]);
  await ownerQuery(
    `insert into public.course_drafts (course_id, teacher_id, title, summary, practice_id, level_id, create_token) values ($1::uuid, $2::uuid, $3, 'Un resumen.', $4::uuid, $5::uuid, gen_random_uuid())`,
    [course, teacherId, title, practice, level],
  );
  await ownerQuery("insert into public.draft_modules (id, course_id, teacher_id, title, position) values ($1::uuid, $2::uuid, $3::uuid, 'Inicio', 1)", [moduleId, course, teacherId]);
  await ownerQuery(
    "insert into public.draft_lessons (id, course_id, teacher_id, module_id, title, position) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Primera lección', 1)",
    [lesson, course, teacherId, moduleId],
  );
  await ownerQuery(
    `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                      provider, provider_asset_id, provider_playback_id, duration_seconds)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, gen_random_uuid(), 'v1', 1200, 'test', $6::text, $7::text, 1200)`,
    [video, course, teacherId, lesson, `enviar/${video}`, `test-${video}`, `test-${video}`],
  );
  return course;
}

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

const reviews = async (course: string) =>
  (await ownerQuery<{ n: number }>("select count(*)::int as n from public.course_reviews where course_id = $1", [course]))[0]?.n ?? -1;

test.beforeAll(async () => {
  const tag = randomUUID().slice(0, 8);
  const [p] = await ownerQuery<{ id: string }>(`${declared} insert into public.practices (slug, name, position, cover_tone) select $1, $2, 9800, 1 from declared returning id::text`, [
    `enviar-${tag}`,
    `Enviar ${tag}`,
  ]);
  const [l] = await ownerQuery<{ id: string }>(`${declared} insert into public.levels (slug, name, position) select $1, $2, 9800 from declared returning id::text`, [`enviar-${tag}`, `Enviar ${tag}`]);
  practice = p!.id;
  level = l!.id;
});

async function walk(page: Page, course: string, title: string, javaScript: boolean): Promise<void> {
  // El editor ofrece enviar.
  await page.goto(`/portal/cursos/${course}`);
  await page.getByRole("link", { name: "Enviar a revisión" }).click();
  await expect(page).toHaveURL(`/portal/cursos/${course}/enviar`);
  await expect(page.getByRole("heading", { level: 2, name: "1. Tu curso está completo" })).toBeVisible();
  await expect(page.getByText("1 de 1 videos listos")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "3. Anexo de licencia de este curso" })).toBeVisible();
  const statement = page.getByLabel(new RegExp(`^Acepto el anexo de licencia, versión \\d+, para el curso «${title}», versión 1, por \\d+ años\\.`));
  await expect(statement).toBeVisible();
  if (javaScript) expect(await a11yViolations(page)).toEqual([]);

  // Sin la casilla no se envía, y nada se escribe.
  await page.getByRole("button", { name: "Enviar a revisión" }).click();
  await expect(page.getByText(/Marca la casilla para aceptar el anexo/).first()).toBeVisible();
  expect(await reviews(course)).toBe(0);

  await page.getByLabel(/^Acepto el anexo de licencia/).check();
  await page.getByRole("button", { name: "Enviar a revisión" }).click();
  // Sin JavaScript el navegador se lleva el ancla del bloque: en Mis cursos no existe, así que no desplaza nada.
  await expect(page).toHaveURL(/\/portal\/cursos(#bloque-enviar)?$/, { timeout: 20_000 });
  // El aviso lleva antes «Listo:», para quien no ve su color.
  await expect(page.getByText(/Enviado a revisión\. Mientras lo revisamos no se puede editar\./)).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row.getByText("En revisión")).toBeVisible();
  await expect(row.getByText(/^Enviado el /)).toBeVisible();
  expect(await reviews(course)).toBe(1);

  // Lo que aceptó, con su texto.
  await page.goto("/portal/cuenta");
  const accepted = page.getByRole("listitem").filter({ hasText: title });
  await expect(accepted.getByText(/^Versión \d+, aceptada el /)).toBeVisible();
  await accepted.getByRole("link", { name: new RegExp(`Leer el anexo de «${title}»`) }).click();
  await expect(page).toHaveURL(/\/portal\/anexo\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (javaScript) expect(await a11yViolations(page)).toEqual([]);
}

test("FL-34: el editor ofrece enviar, PA-44 pide la casilla, y enviado lo dice Mis cursos y «Lo que aceptaste»", async ({ page }) => {
  const teacher = await person();
  const teacherId = await makeTeacher(teacher);
  const title = "Curso para enviar";
  const course = await readyCourse(teacherId, title);
  await signIn(page, teacher, "/portal/cursos");
  await walk(page, course, title, true);
});

test("sin JavaScript: el mismo camino", async ({ browser }: { browser: Browser }) => {
  const teacher = await person();
  const teacherId = await makeTeacher(teacher);
  const title = "Curso sin JavaScript";
  const course = await readyCourse(teacherId, title);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await signIn(page, teacher, "/portal/cursos");
    await walk(page, course, title, false);
  } finally {
    await context.close();
  }
});
