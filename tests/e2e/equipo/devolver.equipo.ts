import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { Client } from "pg";

import { localOwnerUrl } from "../../integration/helpers/local";
import { totpCode } from "../../integration/helpers/totp";
import { a11yViolations } from "../support/a11y";
import { clearCounters, lastMailTo, ownerQuery, person, testEmail, tokenHashIn, type Person } from "../support/stack";

// Devolver un curso enviado, de extremo a extremo (T-405, segunda solicitud; RF-607, RF-701, FL-35, FL-45), con JavaScript y sin él: Contenido lo ve en la cola con su anexo aceptado, un
// motivo vacío no se guarda, y su maestro lee por qué, puede corregir y puede borrar. El envío se fuerza aquí con las funciones de la base (enviar desde el portal lo prueba enviar.equipo.ts). Deja residuo:
// `pnpm test:e2e:equipo` rehace la base al terminar. Un código no se da dos veces, así que los casos van en serie.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 180_000 });

const PASSWORD = "una-clave-de-prueba-9";
const REVIEW = "/admin/revision";

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

/** Alguien nuevo del equipo, con todas las capacidades: se registra y configura su segundo factor. Queda sin sesión. */
async function joinTeam(browser: Browser, email: string): Promise<Member> {
  execFileSync(process.execPath, ["scripts/db-admins.mjs", email], { encoding: "utf8" });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
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
    await expect(page).toHaveURL("/entrar/segundo-factor/configurar");
    await page.getByRole("button", { name: "Empezar" }).click();
    const secret = (await page.locator("main code").innerText()).trim();
    const used: string[] = [];
    await page.getByLabel("Código").fill(await nextCode(secret, used));
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page).toHaveURL("/entrar");
    return { email, secret, used };
  } finally {
    await context.close();
  }
}

async function enterReview(page: Page, who: Member): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(REVIEW)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(`/entrar/segundo-factor?volver=${encodeURIComponent(REVIEW)}`);
  await page.getByLabel("Código").fill(await nextCode(who.secret, who.used));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page).toHaveURL(REVIEW);
}

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** Un curso de una lección, ya enviado por su maestra con las funciones de la base. */
async function sentCourse(teacher: Person, teacherId: string, title: string): Promise<string> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  const asTeacher = () =>
    client.query("select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true), set_config('role', 'app_service', true)", [teacher.id, randomUUID()]);
  const call = async (text: string, params: unknown[]) => (await client.query<{ r: Record<string, string> & { annex?: { id: string } } }>(`select ${text} as r`, params)).rows[0]!.r;
  try {
    await client.query("begin");
    await asTeacher();
    const course = (await call("private.draft_create($1, $2)", [randomUUID(), title])).course!;
    await call("private.draft_save_course($1, 1, $2, $3, $4, $5)", [course, title, "Un resumen del curso.", practice, level]);
    const moduleId = (await call("private.draft_add_module($1, 1, $2)", [course, "Inicio"])).module!;
    const lesson = (await call("private.draft_add_lesson($1, $2, 1, $3)", [course, moduleId, "Primera lección"])).lesson!;
    await client.query("select set_config('role', 'none', true), set_config('app.actor_id', '', true), set_config('app.actor_session', '', true)");
    const video = randomUUID();
    await client.query(
      `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                        provider, provider_asset_id, provider_playback_id, duration_seconds)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, gen_random_uuid(), 'v1', 600, 'test', $6::text, $7::text, 600)`,
      [video, course, teacherId, lesson, `rutasalida/${video}`, `AssetSalida${video}`, `PlaySalida${video}`],
    );
    await asTeacher();
    const seen = await call("private.course_submit_preview($1)", [course]);
    expect(seen.answer).toBe("ready");
    const sent = await call("private.course_submit($1, $2, $3, $4::integer, $5::integer, $6::inet, $7)", [
      course,
      seen.annex!.id,
      seen.content_sha256,
      seen.term_years,
      seen.submission_no,
      "203.0.113.7",
      "NavegadorSalida",
    ]);
    expect(sent.answer).toBe("submitted");
    await client.query("commit");
    return course;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

let practice = "";
let level = "";
let member: Member;
let teacher: Person;
let teacherId = "";

test.beforeAll(async ({ browser }) => {
  const tag = randomUUID().slice(0, 8);
  const declared = "with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)";
  const [p] = await ownerQuery<{ id: string }>(
    `${declared} insert into public.practices (slug, name, position, cover_tone) select $1, $2, 9700, 1 from declared returning id::text`,
    [`devolver-${tag}`, `Devolver ${tag}`],
  );
  const [l] = await ownerQuery<{ id: string }>(`${declared} insert into public.levels (slug, name, position) select $1, $2, 9700 from declared returning id::text`, [`devolver-${tag}`, `Devolver ${tag}`]);
  practice = p!.id;
  level = l!.id;
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  teacher = await person();
  const [t] = await ownerQuery<{ id: string }>(`${declared} insert into public.teachers (profile_id, status) select $1::uuid, 'active' from declared returning id::text`, [teacher.id]);
  teacherId = t!.id;
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_id', $1::text, true) as done)
     insert into public.consents (profile_id, legal_document_id, origin)
     select $1::uuid, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from declared`,
    [teacher.id],
  );
  member = await joinTeam(browser, testEmail());
});

test.afterAll(async () => {
  await ownerQuery("revoke app_service from postgres");
});

test("FL-45 y FL-35: Contenido lo devuelve con motivo y qué corregir, y su maestra lo lee, lo corrige o lo borra", async ({ page, browser }) => {
  const title = "Curso para devolver";
  const course = await sentCourse(teacher, teacherId, title);
  await enterReview(page, member);

  const card = page.getByRole("article").filter({ hasText: title });
  await expect(card.getByText(/^Enviado el .* Envío número 1\.$/)).toBeVisible();
  await expect(card.getByText("Un resumen del curso.")).toBeVisible();
  await expect(card.getByText("Anexo aceptado")).toBeVisible();
  await expect(card.getByText(/^Acepto el anexo de licencia, .*«Curso para devolver»/)).toBeVisible();
  // Desde la cuarta solicitud también se aprueba (lo prueba publicar.equipo.ts), y dice qué espera sus subtítulos: el video de prueba de aquí todavía no los tiene.
  await expect(card.getByRole("button", { name: /Aprobar y publicar/ })).toBeVisible();
  await expect(card.getByText(/^Sin subtítulos confirmados: «Primera lección»/)).toBeVisible();
  // Nada de la fotografía que no sea para la pantalla, ni del origen de la aceptación, en todo el documento.
  const served = await page.content();
  for (const secret of ["PlaySalida", "AssetSalida", "rutasalida", "203.0.113.7", "NavegadorSalida"]) expect(served).not.toContain(secret);
  expect(await a11yViolations(page)).toEqual([]);

  await card.getByRole("button", { name: /Devolver al/ }).click();
  await expect(card.getByLabel(/Motivo/)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Sin motivo no se guarda, y lo escrito se queda.
  await card.getByLabel(/Qué corregir/).fill("Vuelve a subir la lección 1.");
  await card.getByRole("button", { name: "Sí, devolverlo" }).click();
  await expect(card.getByText("Escribe el motivo.")).toBeVisible();
  await expect(card.getByLabel(/Qué corregir/)).toHaveValue("Vuelve a subir la lección 1.");
  const [pending] = await ownerQuery<{ state: string }>("select state::text from public.course_registry where course_id = $1", [course]);
  expect(pending?.state).toBe("in_review");

  await card.getByLabel(/Motivo/).fill("El audio se corta en el minuto 3.");
  await card.getByRole("button", { name: "Sí, devolverlo" }).click();
  await expect(page.getByText(/Ya no está en la cola/)).toBeVisible();
  await expect(page.getByRole("article").filter({ hasText: title })).toHaveCount(0);

  // Su maestra lo lee.
  const context = await browser.newContext();
  try {
    const hers = await context.newPage();
    await signIn(hers, teacher, "/portal/cursos");
    const row = hers.getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("Rechazado")).toBeVisible();
    await expect(row.getByText("El audio se corta en el minuto 3.")).toBeVisible();
    expect(await a11yViolations(hers)).toEqual([]);

    await row.getByRole("link", { name: `Corregir ${title}` }).click();
    await expect(hers).toHaveURL(`/portal/cursos/${course}`);
    await expect(hers.getByText(/Tu curso fue devuelto el/)).toBeVisible();
    await expect(hers.getByText("El audio se corta en el minuto 3.")).toBeVisible();
    await expect(hers.getByText("Vuelve a subir la lección 1.")).toBeVisible();
    // Se abre otra vez: el editor ofrece guardar.
    await expect(hers.getByRole("button", { name: "Guardar" }).first()).toBeVisible();
    expect(await a11yViolations(hers)).toEqual([]);

    // Borrarlo dice que la prueba se queda, y se queda.
    await hers.goto(`/portal/cursos/${course}/borrar`);
    await expect(hers.getByText(/se conservan como prueba/)).toBeVisible();
    await hers.getByRole("button", { name: "Borrar curso" }).click();
    await expect(hers).toHaveURL("/portal/cursos", { timeout: 20_000 });
    await expect(hers.getByText("Borraste el curso.")).toBeVisible();
  } finally {
    await context.close();
  }
  const [kept] = await ownerQuery<{ reviews: number; licenses: number; registry: number }>(
    `select (select count(*)::int from public.course_reviews where course_id = $1) as reviews, (select count(*)::int from public.licenses where course_id = $1) as licenses,
            (select count(*)::int from public.course_registry where course_id = $1) as registry`,
    [course],
  );
  expect(kept).toEqual({ reviews: 1, licenses: 1, registry: 0 });
});

test("sin JavaScript: abrir, un envío sin motivo, y devolver, sin perder lo escrito", async ({ browser }) => {
  const title = "Curso sin JavaScript";
  const course = await sentCourse(teacher, teacherId, title);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await enterReview(page, member);
    const card = page.getByRole("article").filter({ hasText: title });
    await card.getByRole("button", { name: /Devolver al/ }).click();
    const opened = page.getByRole("article").filter({ hasText: title });
    await opened.getByLabel(/Qué corregir/).fill("Vuelve a grabar la lección 1.");
    await opened.getByRole("button", { name: "Sí, devolverlo" }).click();
    await expect(page.getByText("Escribe el motivo.")).toBeVisible();
    const again = page.getByRole("article").filter({ hasText: title });
    await expect(again.getByLabel(/Qué corregir/)).toHaveValue("Vuelve a grabar la lección 1.");
    await again.getByLabel(/Motivo/).fill("No se oye.");
    await again.getByRole("button", { name: "Sí, devolverlo" }).click();
    await expect(page.getByText(/Ya no está en la cola/)).toBeVisible();
    // Recargar no devuelve otra vez.
    await page.reload();
    await expect(page.getByRole("article").filter({ hasText: title })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const [row] = await ownerQuery<{ result: string; reason: string }>("select result::text, reason from public.course_reviews where course_id = $1", [course]);
  expect(row).toEqual({ result: "rejected", reason: "No se oye." });
});
