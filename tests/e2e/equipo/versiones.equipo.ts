import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { Client } from "pg";

import { localOwnerUrl } from "../../integration/helpers/local";
import { totpCode } from "../../integration/helpers/totp";
import { a11yViolations } from "../support/a11y";
import { clearCounters, lastMailTo, ownerQuery, person, testEmail, tokenHashIn, type Person } from "../support/stack";

// Las versiones de un curso publicado, de extremo a extremo (T-405, sexta solicitud; RF-608, FL-36, FL-45), con JavaScript y sin él: la maestra ve su curso
// publicado en solo lectura, pulsa «Editar», cambia el título y envía la versión; Contenido la ve como versión, con lo que cambió, y la aprueba; la ficha pública
// dice lo nuevo con el mismo slug. Y descartar, sin JavaScript. El primer envío y el de la versión se fuerzan con las funciones de la base (PA-44 lo prueba
// `enviar.equipo.ts`), con un video del proveedor de prueba. Deja residuo: `pnpm test:e2e:equipo` rehace la base al terminar. Un código no se da dos veces, así que
// los casos van en serie.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 240_000 });

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

/** Con las funciones de la base, como la maestra: `work` recibe con qué llamarlas. */
async function asTeacher<T>(work: (call: (text: string, params: unknown[]) => Promise<Record<string, string> & { annex?: { id: string } }>, client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
  const call = async (text: string, params: unknown[]) => (await client.query<{ r: Record<string, string> & { annex?: { id: string } } }>(`select ${text} as r`, params)).rows[0]!.r;
  try {
    await client.query("begin");
    await client.query("select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true), set_config('role', 'app_service', true)", [teacher.id, randomUUID()]);
    const result = await work(call, client);
    await client.query("commit");
    return result;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

/** Envía lo que hay en el borrador, como la maestra. */
async function submit(course: string): Promise<void> {
  await asTeacher(async (call) => {
    const seen = await call("private.course_submit_preview($1)", [course]);
    expect(seen.answer).toBe("ready");
    const sent = await call("private.course_submit($1, $2, $3, $4::integer, $5::integer, $6::inet, $7)", [
      course,
      seen.annex!.id,
      seen.content_sha256,
      seen.term_years,
      seen.submission_no,
      "203.0.113.7",
      "NavegadorVersiones",
    ]);
    expect(sent.answer).toBe("submitted");
  });
}

/** Un curso de una lección, ya enviado por su maestra, con su original en la cubeta y un video del proveedor de prueba. */
async function sentCourse(title: string): Promise<string> {
  const course = await asTeacher(async (call, client) => {
    const created = (await call("private.draft_create($1, $2)", [randomUUID(), title])).course!;
    await call("private.draft_save_course($1, 1, $2, $3, $4, $5)", [created, title, "Un resumen del curso.", practice, level]);
    const moduleId = (await call("private.draft_add_module($1, 1, $2)", [created, "Inicio"])).module!;
    const lesson = (await call("private.draft_add_lesson($1, $2, 1, $3)", [created, moduleId, "Primera lección"])).lesson!;
    await client.query("select set_config('role', 'none', true), set_config('app.actor_id', '', true), set_config('app.actor_session', '', true)");
    const video = randomUUID();
    const path = `${teacherId}/${created}/${video}`;
    const object = (
      await client.query<{ id: string }>(
        "insert into storage.objects (bucket_id, name, version, metadata) values ('video-originals', $1, 'v1', '{\"size\": 1000, \"mimetype\": \"video/mp4\"}') returning id",
        [path],
      )
    ).rows[0]!.id;
    await client.query(
      `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                        provider, provider_asset_id, provider_playback_id, duration_seconds)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, $6::uuid, 'v1', 600, 'test', $7::text, $7::text, 600)`,
      [video, created, teacherId, lesson, path, object, `test-${video}`],
    );
    return created;
  });
  await submit(course);
  return course;
}

/** Contenido aprueba en la cola, con JavaScript. */
async function approve(page: Page, title: string): Promise<void> {
  const card = page.getByRole("article").filter({ hasText: title });
  await card.getByRole("button", { name: `Aprobar y publicar «${title}»` }).click();
  await card.getByRole("button", { name: "Sí, aprobar y publicar" }).click();
  await expect(page.getByText("Publicado. Ya aparece en el catálogo.")).toBeVisible({ timeout: 20_000 });
}

const registry = async (course: string) =>
  (
    await ownerQuery<{ state: string; pending: string | null; slug: string | null; title: string | null }>(
      `select (select state::text from public.course_registry where course_id = $1) as state,
              (select pending_version_state::text from public.course_registry where course_id = $1) as pending,
              (select slug from public.published_courses where course_id = $1) as slug,
              (select title from public.published_courses where course_id = $1) as title`,
      [course],
    )
  )[0]!;

let practice = "";
let level = "";
let member: Member;
let teacher: Person;
let teacherId = "";

test.beforeAll(async ({ browser }) => {
  const tag = randomUUID().slice(0, 8);
  const declared = "with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)";
  const [p] = await ownerQuery<{ id: string }>(
    `${declared} insert into public.practices (slug, name, position, cover_tone) select $1, $2, 9860, 1 from declared returning id::text`,
    [`versiones-${tag}`, `Versiones ${tag}`],
  );
  const [l] = await ownerQuery<{ id: string }>(`${declared} insert into public.levels (slug, name, position) select $1, $2, 9860 from declared returning id::text`, [`versiones-${tag}`, `Versiones ${tag}`]);
  practice = p!.id;
  level = l!.id;
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  teacher = await person();
  const [t] = await ownerQuery<{ id: string }>(`${declared} insert into public.teachers (profile_id, status) select $1::uuid, 'active' from declared returning id::text`, [teacher.id]);
  teacherId = t!.id;
  await ownerQuery(`${declared} insert into public.published_teachers (teacher_id, slug, display_name) select $1::uuid, $2, 'Maestra Versiones' from declared`, [teacherId, `maestra-${tag}`]);
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

test("FL-36: «Editar» un curso publicado, enviar la versión, Contenido la ve como versión y la aprueba, y la ficha dice lo nuevo", async ({ page, browser }) => {
  const title = "Curso con versiones";
  const course = await sentCourse(title);
  await enterReview(page, member);
  await approve(page, title);
  const first = await registry(course);
  expect(first).toMatchObject({ state: "published", pending: null, title });

  // La maestra ve su curso publicado, en solo lectura, y pulsa «Editar».
  const hers = await browser.newContext();
  try {
    const portal = await hers.newPage();
    await signIn(portal, teacher, "/portal/cursos");
    const row = portal.getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("Publicado")).toBeVisible();
    await expect(row.getByRole("link", { name: `Ver la ficha de ${title}` })).toBeVisible();
    await row.getByRole("link", { name: `Editar ${title}` }).click();
    await expect(portal).toHaveURL(`/portal/cursos/${course}`);
    await expect(portal.getByText(/Tus alumnos ven esta versión/)).toBeVisible();
    await expect(portal.getByText("Primera lección, 10 min 0 s")).toBeVisible();
    await expect(portal.getByRole("textbox", { name: "Título del curso" })).toHaveCount(0);
    expect(await a11yViolations(portal)).toEqual([]);
    await portal.getByRole("button", { name: "Editar" }).click();

    // El editor de la versión: el aviso, «Enviar a revisión» y «Descartar cambios».
    await expect(portal.getByText("Tus alumnos siguen viendo la versión publicada hasta que se apruebe la nueva.")).toBeVisible({ timeout: 15_000 });
    await expect(portal.getByText("Con cambios pendientes").first()).toBeVisible();
    await expect(portal.getByRole("link", { name: "Descartar cambios" })).toBeVisible();
    await expect(portal.getByRole("link", { name: "Enviar a revisión" })).toBeVisible();
    expect(await registry(course)).toMatchObject({ state: "changes_pending", pending: "draft" });
    await portal.getByRole("textbox", { name: "Título del curso" }).fill("Curso con versiones, segunda");
    await portal.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(portal.getByText("Guardado.")).toBeVisible();
    expect(await a11yViolations(portal)).toEqual([]);
    // Lo que ven los alumnos no cambió.
    expect((await registry(course)).title).toBe(title);
  } finally {
    await hers.close();
  }

  // Enviada, Contenido la ve como versión, con lo que cambió, y la aprueba.
  await submit(course);
  await page.reload();
  const card = page.getByRole("article").filter({ hasText: "Curso con versiones, segunda" });
  await expect(card.getByText("Versión 2 de un curso ya publicado. Los alumnos siguen viendo la anterior hasta que se apruebe.")).toBeVisible();
  await expect(card.getByText("Datos del curso: el título.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await approve(page, "Curso con versiones, segunda");
  const after = await registry(course);
  expect(after).toMatchObject({ state: "published", pending: null, slug: first.slug, title: "Curso con versiones, segunda" });

  // La ficha pública, con el mismo slug, dice el título nuevo.
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    await expect(async () => {
      await visitor.goto(`/cursos/${first.slug}`);
      await expect(visitor.getByRole("heading", { level: 1, name: "Curso con versiones, segunda" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
  } finally {
    await context.close();
  }
});

test("sin JavaScript: «Editar» abre la versión, y descartarla deja el curso como estaba", async ({ browser }) => {
  const title = "Curso para descartar";
  const course = await sentCourse(title);
  const review = await browser.newContext();
  try {
    const page = await review.newPage();
    await enterReview(page, member);
    await approve(page, title);
  } finally {
    await review.close();
  }

  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await signIn(page, teacher, `/portal/cursos/${course}`);
    await page.getByRole("button", { name: "Editar" }).click();
    await expect(page.getByText("Tus alumnos siguen viendo la versión publicada hasta que se apruebe la nueva.")).toBeVisible();
    await page.getByRole("link", { name: "Descartar cambios" }).click();
    await expect(page).toHaveURL(`/portal/cursos/${course}/descartar`);
    await expect(page.getByRole("heading", { level: 1, name: "Descartar los cambios" })).toBeVisible();
    await page.getByRole("button", { name: "Descartar cambios" }).click();
    // Sin JavaScript, el navegador conserva el ancla del formulario al seguir la redirección: es Mis cursos.
    await expect(page).toHaveURL(/\/portal\/cursos(#bloque-version-descartar)?$/);
    await expect(page.getByText("Descartaste los cambios. Tus alumnos siguen viendo el curso publicado.")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: title }).getByText("Publicado")).toBeVisible();
  } finally {
    await context.close();
  }
  expect(await registry(course)).toMatchObject({ state: "published", pending: null, title });
  const [drafts] = await ownerQuery<{ n: number }>("select count(*)::int as n from public.course_drafts where course_id = $1", [course]);
  expect(drafts?.n).toBe(0);
});
