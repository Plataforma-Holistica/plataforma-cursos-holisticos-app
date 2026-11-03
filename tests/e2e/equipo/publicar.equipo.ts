import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { Client } from "pg";

import { localOwnerUrl } from "../../integration/helpers/local";
import { totpCode } from "../../integration/helpers/totp";
import { a11yViolations } from "../support/a11y";
import { clearCounters, lastMailTo, ownerQuery, person, testEmail, tokenHashIn, type Person } from "../support/stack";

// Publicar lo enviado, de extremo a extremo (T-405, cuarta solicitud; RF-606, RF-701, RF-310, FL-45), con JavaScript y sin él: Contenido lo aprueba en la cola, la base lo publica
// desde la fotografía, y el curso aparece en su ficha pública con su lección. El envío se fuerza con las funciones de la base, con un video del proveedor de prueba sin subtítulos:
// al aprobar, el servidor le pregunta al proveedor (el de prueba contesta que los tiene) y la base los anota. Deja residuo: `pnpm test:e2e:equipo` rehace la base al terminar. Un
// código no se da dos veces, así que los casos van en serie.

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

/** Un curso de una lección, ya enviado por su maestra con las funciones de la base, con su original en la cubeta. */
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
    const path = `${teacherId}/${course}/${video}`;
    const object = (
      await client.query<{ id: string }>(
        "insert into storage.objects (bucket_id, name, version, metadata) values ('video-originals', $1, 'v1', '{\"size\": 1000, \"mimetype\": \"video/mp4\"}') returning id",
        [path],
      )
    ).rows[0]!.id;
    // El proveedor de prueba contesta la reproducción igual que el asset.
    await client.query(
      `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                        provider, provider_asset_id, provider_playback_id, duration_seconds)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, $6::uuid, 'v1', 600, 'test', $7::text, $7::text, 600)`,
      [video, course, teacherId, lesson, path, object, `test-${video}`],
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
      "NavegadorPublicar",
    ]);
    expect(sent.answer).toBe("submitted");
    await client.query("commit");
    return course;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

const published = async (course: string) =>
  (
    await ownerQuery<{ state: string; slug: string | null; drafts: number }>(
      `select (select state::text from public.course_registry where course_id = $1) as state,
              (select slug from public.published_courses where course_id = $1) as slug,
              (select count(*)::int from public.course_drafts where course_id = $1) as drafts`,
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
    `${declared} insert into public.practices (slug, name, position, cover_tone) select $1, $2, 9850, 1 from declared returning id::text`,
    [`publicar-${tag}`, `Publicar ${tag}`],
  );
  const [l] = await ownerQuery<{ id: string }>(`${declared} insert into public.levels (slug, name, position) select $1, $2, 9850 from declared returning id::text`, [`publicar-${tag}`, `Publicar ${tag}`]);
  practice = p!.id;
  level = l!.id;
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  teacher = await person();
  const [t] = await ownerQuery<{ id: string }>(`${declared} insert into public.teachers (profile_id, status) select $1::uuid, 'active' from declared returning id::text`, [teacher.id]);
  teacherId = t!.id;
  // Como la deja aceptar la invitación: su ficha, sin listar.
  await ownerQuery(`${declared} insert into public.published_teachers (teacher_id, slug, display_name) select $1::uuid, $2, 'Maestra Publicar' from declared`, [teacherId, `maestra-${tag}`]);
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

test("FL-45: Contenido aprueba lo enviado, y el curso aparece en el catálogo con su lección", async ({ page, browser }) => {
  const title = "Curso para publicar";
  const course = await sentCourse(teacher, teacherId, title);
  await enterReview(page, member);

  const card = page.getByRole("article").filter({ hasText: title });
  // El video todavía no tiene subtítulos: la tarjeta lo dice, y aprobar le pregunta al proveedor.
  await expect(card.getByText(/^Esperan sus subtítulos: «Primera lección»/)).toBeVisible();
  await card.getByRole("button", { name: `Aprobar y publicar «${title}»` }).click();
  await expect(card.getByText("¿Aprobar y publicar este curso?")).toBeVisible();
  await expect(card.getByText(/Es el primer curso de Maestra Publicar/)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await card.getByRole("button", { name: "Sí, aprobar y publicar" }).click();
  await expect(page.getByText("Publicado. Ya aparece en el catálogo.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("article").filter({ hasText: title })).toHaveCount(0);

  const after = await published(course);
  expect(after).toMatchObject({ state: "published", drafts: 0 });
  expect(after.slug).toMatch(/^curso-para-publicar(-\d+)?$/);

  // Lo ve cualquiera en su ficha, con su lección y su maestra.
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    // Lo público se recuerda 30 s: se recarga hasta verlo.
    await expect(async () => {
      await visitor.goto(`/cursos/${after.slug}`);
      await expect(visitor.getByRole("heading", { level: 1, name: title })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(visitor.getByText("Primera lección").first()).toBeVisible();
    await expect(visitor.getByText("Maestra Publicar").first()).toBeVisible();
    expect(await a11yViolations(visitor)).toEqual([]);
  } finally {
    await context.close();
  }

  // Su maestra lo ve publicado en Mis cursos, aunque el borrador ya se borró.
  const hers = await browser.newContext();
  try {
    const portal = await hers.newPage();
    await portal.goto(`/entrar?volver=${encodeURIComponent("/portal/cursos")}`);
    await portal.getByLabel("Correo").fill(teacher.email);
    await portal.getByLabel("Contraseña", { exact: true }).fill(teacher.password);
    await portal.getByRole("button", { name: "Entrar" }).click();
    await expect(portal).toHaveURL("/portal/cursos", { timeout: 15_000 });
    const row = portal.getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("Publicado")).toBeVisible();
    expect(await a11yViolations(portal)).toEqual([]);
  } finally {
    await hers.close();
  }
});

test("sin JavaScript: aprobar en dos pasos, y recargar no aprueba otra vez", async ({ browser }) => {
  const title = "Curso publicado sin JavaScript";
  const course = await sentCourse(teacher, teacherId, title);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await enterReview(page, member);
    await page.getByRole("article").filter({ hasText: title }).getByRole("button", { name: `Aprobar y publicar «${title}»` }).click();
    await page.getByRole("article").filter({ hasText: title }).getByRole("button", { name: "Sí, aprobar y publicar" }).click();
    await expect(page.getByText("Publicado. Ya aparece en el catálogo.")).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole("article").filter({ hasText: title })).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect(await published(course)).toMatchObject({ state: "published", drafts: 0 });
  const [review] = await ownerQuery<{ result: string }>("select result::text from public.course_reviews where course_id = $1", [course]);
  expect(review?.result).toBe("approved");
});
