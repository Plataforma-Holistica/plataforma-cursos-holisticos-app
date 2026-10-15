import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// La página de una lección (PA-22, T-203), de extremo a extremo: a dónde va quien llega sin
// sesión, PA-33 al cargar para quien no tiene acceso, y para quien sí lo tiene, el reproductor
// con la marca de agua y la pantalla completa sobre su contenedor. La aplicación firma con una
// llave de prueba (`playwright.config.ts`), y el navegador corta toda petición que no sea a ella:
// nunca se sale a Mux.
//
// Va con el camino del equipo porque cargar y publicar un curso escriben en la auditoría, que no
// admite borrado: `pnpm test:e2e:equipo` rehace la base al terminar.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const SLUG = "leccion-e2e";
const OPEN_SLUG = "leccion-abierta-e2e";
const lessonUrl = (slug: string, id: string) => `/cursos/${slug}/lecciones/${id}`;

/** Un curso de una lección de Mux, cargado como el guion local y publicado y listado como sistema. Devuelve la lección. */
async function loadListedCourse(slug: string, open = false): Promise<string> {
  const course = {
    slug,
    title: `Curso ${slug}`,
    summary: "Un curso para probar la lección.",
    practice: "leccion-e2e",
    level: "basico",
    modules: [
      {
        title: "Uno",
        lessons: [
          { title: "Con Mux", video: { provider: "mux", asset_id: `Asset${slug.replaceAll("-", "")}`, playback_id: `Playback${slug.replaceAll("-", "")}`, duration_seconds: 356 } },
        ],
      },
    ],
  };
  const [loaded] = await ownerQuery<{ answer: string }>(
    `with declared as materialized (
       select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)),
     practice as materialized (
       select private.system_catalog_add('practices', 'Lección e2e'), private.system_catalog_add('levels', 'Básico') from declared),
     teacher as materialized (
       select private.system_add_teacher('Maestra de lección', $2, null) as id from practice)
     select private.system_load_course((select id from teacher), $1::jsonb) ->> 'answer' as answer from teacher`,
    [JSON.stringify(course), `maestra-${slug}`],
  );
  expect(loaded?.answer).toBe("loaded");
  // Publicar y listar a mano, como sistema: aprobar pide a alguien del equipo con su código.
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.course_registry
        set state = 'published', first_published_at = now(), is_open = $2, open_since = case when $2 then now() end
      where course_id = (select course_id from public.published_courses where slug = $1) and (select count(*) from declared) = 1`,
    [slug, open],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.published_courses set is_listed = true, is_open = $2
      where slug = $1 and (select count(*) from declared) = 1`,
    [slug, open],
  );
  const [lesson] = await ownerQuery<{ id: string }>(
    "select l.id::text as id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = $1",
    [slug],
  );
  return lesson?.id ?? "";
}

/** Una suscripción pagada por un mes, escrita por el dueño: nadie de la aplicación las escribe todavía (T-302). */
async function subscribe(who: Person): Promise<void> {
  await ownerQuery(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
    [who.id],
  );
}

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Corta toda petición que no sea a la aplicación, y anota a dónde iba; las de Mux se quedan sin contestar. */
async function holdOutside(context: BrowserContext): Promise<string[]> {
  const outside: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost") return route.continue();
    outside.push(url.href);
    if (url.hostname.endsWith(".mux.com")) return;
    return route.abort();
  });
  return outside;
}

let lesson = "";
let openLesson = "";

test.beforeAll(async () => {
  lesson = await loadListedCourse(SLUG);
  openLesson = await loadListedCourse(OPEN_SLUG, true);
});

test("sin sesión: la lección de un curso normal manda a entrar; la del abierto, a registrarse (flujo §6.3)", async ({ page }) => {
  await page.goto(lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(`/entrar?volver=${encodeURIComponent(lessonUrl(SLUG, lesson))}`);
  await page.goto(lessonUrl(OPEN_SLUG, openLesson));
  await expect(page).toHaveURL(`/registro?volver=${encodeURIComponent(lessonUrl(OPEN_SLUG, openLesson))}`);
});

test("sin acceso: PA-33 desde que carga, sin reproducir ni nada del video en lo servido; y una lección que no existe, PA-19", async ({ page }) => {
  const who = await person();
  await signIn(page, who, lessonUrl(SLUG, lesson));
  // Entrar vuelve a la lección.
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await expect(page.getByRole("heading", { level: 1, name: "Lección 1 · Con Mux" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Esta lección pide una suscripción" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reproducir la lección" })).toHaveCount(0);
  const served = await (await page.request.get(lessonUrl(SLUG, lesson))).text();
  expect(served).not.toContain(`Playback${SLUG.replaceAll("-", "")}`);
  expect(served).not.toMatch(/token=|eyJhbGciOiJSUzI1Ni/);
  expect(await a11yViolations(page)).toEqual([]);

  // El curso abierto sí se le abre a una cuenta verificada, sin suscripción.
  await page.goto(lessonUrl(OPEN_SLUG, openLesson));
  await expect(page.getByRole("button", { name: "Reproducir la lección" })).toBeVisible();

  const missing = await page.goto(lessonUrl(SLUG, "00000000-0000-4000-8000-000000000000"));
  expect(missing?.status()).toBe(404);
});

test("con acceso: el reproductor con la marca de agua, que entra con él a pantalla completa", async ({ page }) => {
  const who = await person();
  await subscribe(who);
  const outside = await holdOutside(page.context());
  await signIn(page, who, lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await page.getByRole("button", { name: "Reproducir la lección" }).click();
  // La marca: el correo de quien ve, dentro del contenedor que entra a pantalla completa.
  const mark = page.locator("[data-player-frame] [data-watermark]");
  await expect(mark).toHaveText(who.email);
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const controller = (document.querySelector("mux-player") as unknown as { mediaController?: { fullscreenElement?: Element | null } } | null)?.mediaController;
        return controller ? controller.fullscreenElement === document.querySelector("[data-player-frame]") : null;
      }),
    )
    .toBe(true);
  // Lo único que se le pide a alguien de fuera es el video a Mux, con su dirección firmada.
  await expect.poll(() => outside.some((href) => href.startsWith(`https://stream.mux.com/Playback${SLUG.replaceAll("-", "")}.m3u8?`) && href.includes("token=")), { timeout: 60_000 }).toBe(true);
  for (const host of new Set(outside.map((href) => new URL(href).hostname))) expect(["image.mux.com", "stream.mux.com"], host).toContain(host);
  expect(await a11yViolations(page)).toEqual([]);
  // Si la quitan, el video se pausa: el reproductor queda en pausa.
  await page.evaluate(() => document.querySelector("[data-watermark]")?.remove());
  await expect.poll(() => page.evaluate(() => (document.querySelector("mux-player") as unknown as { paused?: boolean } | null)?.paused)).toBe(true);
});

test("con acceso y sin JavaScript: la página se lee, y dice que para ver hace falta JavaScript", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, who, lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await expect(page.getByText("Para ver la lección hace falta JavaScript.")).toBeVisible();
  // Sin pestañas, todo el temario y «Sobre esta lección» se leen.
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await context.close();
});
