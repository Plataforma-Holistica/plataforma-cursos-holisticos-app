import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// Bajar un recurso de lo publicado (RF-308; FL-14; T-404), en un navegador de verdad y contra el Storage local. Lo que solo se
// ve aquí: que un adjunto no deje al enrutador esperando (con JavaScript la dirección la abre el navegador; sin él, la acción
// redirige), que la página no se vaya, y que el nombre con que baja sea el que armó el servidor.
//
// Va con el camino del equipo porque cargar y publicar un curso escriben en la auditoría, que no admite borrado:
// `pnpm test:e2e:equipo` rehace la base al terminar.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const SLUG = "recursos-e2e";
const COURSE_URL = `/cursos/${SLUG}`;
const PDF = Buffer.from("%PDF-1.7\nun contenido cualquiera\n%%EOF\n", "latin1");

let lessonUrl = "";

/** Sube un objeto directo a la cubeta, como el servidor, y lo publica sobre el curso o una lección. */
async function publishResource(course: string, teacher: string, lesson: string | null, title: string): Promise<void> {
  const path = `${teacher}/${course}/${randomUUID()}`;
  const key = process.env.SUPABASE_SECRET_KEY ?? "";
  const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "")}/storage/v1/object/course-resources/${path}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/pdf" },
    body: new Uint8Array(PDF),
  });
  expect(response.ok).toBe(true);
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     insert into public.published_resources (course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
     select $1::uuid, $2::uuid, $3::uuid, $4, 'pdf', 'application/pdf', o.name, o.id, o.version, (o.metadata ->> 'size')::bigint, 1
       from storage.objects o, declared where o.bucket_id = 'course-resources' and o.name = $5`,
    [course, teacher, lesson, title, path],
  );
}

test.beforeAll(async () => {
  const course = {
    slug: SLUG,
    title: "Curso con recursos",
    practice: "recursos-e2e",
    level: "basico",
    modules: [{ title: "Uno", lessons: [{ title: "Con Mux", video: { provider: "mux", asset_id: "AssetRecursos", playback_id: "PlaybackRecursos", duration_seconds: 600 } }] }],
  };
  const [teacher] = await ownerQuery<{ id: string; answer: string }>(
    `with declared as materialized (
       select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)),
     practice as materialized (
       select private.system_catalog_add('practices', 'Recursos e2e'), private.system_catalog_add('levels', 'Básico') from declared),
     teacher as materialized (
       select private.system_add_teacher('Maestra de recursos', 'maestra-recursos', null) as id from practice)
     select (select id from teacher)::text as id, private.system_load_course((select id from teacher), $1::jsonb) ->> 'answer' as answer from teacher`,
    [JSON.stringify(course)],
  );
  expect(teacher?.answer).toBe("loaded");
  const [found] = await ownerQuery<{ course: string; lesson: string }>(
    "select c.course_id::text as course, l.id::text as lesson from public.published_courses c join public.published_lessons l on l.course_id = c.course_id where c.slug = $1",
    [SLUG],
  );
  const courseId = found?.course ?? "";
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.course_registry set state = 'published', first_published_at = now()
      where course_id = $1 and (select count(*) from declared) = 1`,
    [courseId],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.published_courses set is_listed = true where course_id = $1 and (select count(*) from declared) = 1`,
    [courseId],
  );
  await publishResource(courseId, teacher?.id ?? "", null, "Guía del curso");
  await publishResource(courseId, teacher?.id ?? "", found?.lesson ?? "", "Guía de la lección");
  lessonUrl = `${COURSE_URL}/lecciones/${found?.lesson ?? ""}`;
});

async function subscribe(who: Person): Promise<void> {
  await ownerQuery(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
    [who.id],
  );
}

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
}

const pressAndDownload = async (page: Page, name: string) => {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: `Descargar ${name}` }).first().click();
  return download;
};

test("el visitante ve la lista, sin descarga, y la invitación a entrar", async ({ page }) => {
  // Lo público se recuerda 30 segundos (`CATALOG_MEMORY_MS`): si otra prueba ya leyó el catálogo, este curso todavía no está
  // en lo listado. Lo que dice cada aserción no cambia: solo se espera a que el curso exista para la ficha.
  await expect(async () => {
    await page.goto(COURSE_URL);
    await expect(page.getByRole("heading", { name: "Recursos del curso" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000, intervals: [2_000] });
  await expect(page.getByText("Guía del curso")).toBeVisible();
  await expect(page.getByRole("button", { name: /Descargar/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Entra a tu cuenta para descargarlos." })).toBeVisible();
  // Lo de una lección no se lista en la ficha.
  await expect(page.getByText("Guía de la lección")).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);
});

test("con JavaScript: baja como adjunto, la página no se va, el enrutador sigue vivo y se puede bajar otra vez", async ({ page }) => {
  const ana = await person();
  await subscribe(ana);
  await signIn(page, ana, COURSE_URL);
  let left = 0;
  await page.exposeFunction("notePageHide", () => void left++);
  await page.evaluate(() => {
    window.addEventListener("pagehide", () => void (window as unknown as { notePageHide: () => void }).notePageHide());
  });

  const first = await pressAndDownload(page, "Guía del curso");
  expect(first.suggestedFilename()).toBe("Guía del curso.pdf");
  expect((await first.failure()) ?? null).toBeNull();
  await expect(page).toHaveURL(new RegExp(`${COURSE_URL}$`));
  await expect(page.getByText("Tu descarga empezó.")).toBeAttached();
  // El botón vuelve, y sirve otra vez.
  const again = await pressAndDownload(page, "Guía del curso");
  expect(again.suggestedFilename()).toBe("Guía del curso.pdf");
  expect(left).toBe(0);
  expect(await a11yViolations(page)).toEqual([]);

  // Una navegación del enrutador sigue funcionando: nada se quedó esperando.
  await page.getByRole("link", { name: "Explorar" }).first().click();
  await expect(page).toHaveURL(/\/explorar$/);
});

async function withoutJavaScript(browser: Browser, work: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: true });
  try {
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}

test("sin JavaScript: la acción redirige al adjunto, y la página se queda donde estaba", async ({ browser }) => {
  const ana = await person();
  await subscribe(ana);
  await withoutJavaScript(browser, async (page) => {
    await signIn(page, ana, COURSE_URL);
    const download = await pressAndDownload(page, "Guía del curso");
    expect(download.suggestedFilename()).toBe("Guía del curso.pdf");
    await expect(page).toHaveURL(new RegExp(`${COURSE_URL}$`));
    await expect(page.getByRole("button", { name: "Descargar Guía del curso" })).toBeVisible();
    // Se puede bajar otra vez.
    expect((await pressAndDownload(page, "Guía del curso")).suggestedFilename()).toBe("Guía del curso.pdf");
  });
});

test("sin acceso, PA-33 junto al recurso, con JavaScript y sin él", async ({ page, browser }) => {
  const ana = await person();
  await signIn(page, ana, COURSE_URL);
  await page.getByRole("button", { name: "Descargar Guía del curso" }).click();
  await expect(page.getByText("Este recurso pide una suscripción").last()).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  await withoutJavaScript(browser, async (other) => {
    await signIn(other, ana, COURSE_URL);
    await other.getByRole("button", { name: "Descargar Guía del curso" }).click();
    await expect(other.getByText("Este recurso pide una suscripción").last()).toBeVisible();
    await expect(other).toHaveURL(new RegExp(`${COURSE_URL}`));
  });
});

test("en la lección: los suyos, bajan sin irse de la página, y sin acceso no se muestran", async ({ page, browser }) => {
  const ana = await person();
  await subscribe(ana);
  await signIn(page, ana, lessonUrl);
  await expect(page.getByRole("heading", { name: "Recursos de esta lección" })).toBeVisible();
  // El reproductor, intacto después de bajar: `pagehide` es lo único que lo desmonta, y un adjunto no lo dispara.
  let left = 0;
  await page.exposeFunction("notePageHide", () => void left++);
  await page.evaluate(() => {
    window.addEventListener("pagehide", () => void (window as unknown as { notePageHide: () => void }).notePageHide());
  });
  const download = await pressAndDownload(page, "Guía de la lección");
  expect(download.suggestedFilename()).toBe("Guía de la lección.pdf");
  expect(left).toBe(0);
  await expect(page.getByRole("button", { name: "Reproducir la lección" })).toBeVisible();
  // Lo del curso va en la ficha.
  await expect(page.getByText("Guía del curso")).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);

  const sin = await person();
  await withoutJavaScript(browser, async (other) => {
    await signIn(other, sin, lessonUrl);
    await expect(other.getByRole("heading", { name: "Recursos de esta lección" })).toHaveCount(0);
    await expect(other.getByText("Guía de la lección")).toHaveCount(0);
  });
});

test("en la lección, en teléfono: su pestaña", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  try {
    const page = await context.newPage();
    const ana = await person();
    await subscribe(ana);
    await signIn(page, ana, lessonUrl);
    await page.getByRole("tab", { name: "Recursos" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("tabpanel", { name: "Recursos" }).getByRole("button", { name: "Descargar Guía de la lección" }).click();
    expect((await download).suggestedFilename()).toBe("Guía de la lección.pdf");
  } finally {
    await context.close();
  }
});
