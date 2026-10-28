import { expect, test, type Page } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// El catálogo del alumno (T-210), de extremo a extremo: FL-10 (el inicio de quien no ha empezado
// nada, y de ahí a la ficha de un curso), las fichas públicas para el visitante, con JavaScript y
// sin él, y que solo aparece lo publicado.
//
// Va con el camino del equipo porque cargar y publicar un curso escriben en la auditoría, que no
// admite borrado: `pnpm test:e2e:equipo` rehace la base al terminar.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const BEGINNER = "catalogo-inicial-e2e";
const ADVANCED = "catalogo-avanzado-e2e";
const HIDDEN = "catalogo-oculto-e2e";

/** El slug que la base le da a un nombre de la lista: sin acentos, en minúsculas, con guiones. */
const slugOf = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

/** Un curso de dos lecciones de prueba, cargado como el guion local; si `listed`, publicado y listado como sistema con su maestra. */
async function loadCourse(slug: string, practice: string, level: string, listed: boolean): Promise<void> {
  const course = {
    slug,
    title: `Curso ${slug}`,
    summary: "Un curso para probar el catálogo.",
    practice: slugOf(practice),
    level: slugOf(level),
    modules: [
      {
        title: "Uno",
        lessons: [
          { title: "Primera", video: { provider: "test", asset_id: `${slug}-1`, playback_id: `prueba:${slug}-1`, duration_seconds: 300 } },
          { title: "Segunda", video: { provider: "test", asset_id: `${slug}-2`, playback_id: `prueba:${slug}-2`, duration_seconds: 300 } },
        ],
      },
    ],
  };
  const [loaded] = await ownerQuery<{ answer: string }>(
    `with declared as materialized (
       select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)),
     catalog as materialized (
       select private.system_catalog_add('practices', $3), private.system_catalog_add('levels', $4) from declared),
     teacher as materialized (
       select private.system_add_teacher($5, $2, 'Una maestra para probar el catálogo.') as id from catalog)
     select private.system_load_course((select id from teacher), $1::jsonb) ->> 'answer' as answer from teacher`,
    [JSON.stringify(course), `maestra-${slug}`, practice, level, `Maestra ${slug}`],
  );
  expect(loaded?.answer).toBe("loaded");
  if (!listed) return;
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.course_registry set state = 'published', first_published_at = now()
      where course_id = (select course_id from public.published_courses where slug = $1) and (select count(*) from declared) = 1`,
    [slug],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.published_courses set is_listed = true where slug = $1 and (select count(*) from declared) = 1`,
    [slug],
  );
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.published_teachers set is_listed = true
      where teacher_id = (select teacher_id from public.published_courses where slug = $1) and (select count(*) from declared) = 1`,
    [slug],
  );
}

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

test.beforeAll(async () => {
  // El primer nivel que se crea queda primero en el orden: «Para empezar» toma el más bajo con cursos.
  await loadCourse(BEGINNER, "Respiración e2e", "Inicial e2e", true);
  await loadCourse(ADVANCED, "Meditación e2e", "Avanzado e2e", true);
  await loadCourse(HIDDEN, "Meditación e2e", "Avanzado e2e", false);
});

test("FL-10: quien no ha empezado nada ve «Para empezar», «Nuevos», sus prácticas y sus maestras, y de ahí llega a la ficha", async ({ page }) => {
  const who = await person();
  await signIn(page, who, "/entrar?volver=%2Finicio");
  await expect(page).toHaveURL(/\/inicio$/);

  await expect(page.getByRole("heading", { level: 2, name: "Continuar viendo" })).toHaveCount(0);
  const starters = page.getByRole("list", { name: "Para empezar" });
  // Lo público se recuerda 30 segundos (`CATALOG_MEMORY_MS`): si otra prueba ya leyó el inicio
  // antes de que se cargaran estos cursos, aparecen al vencer esa memoria.
  await expect(async () => {
    await page.reload();
    await expect(starters.getByRole("link", { name: `Curso ${BEGINNER}, con Maestra ${BEGINNER}` })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000, intervals: [2_000] });
  await expect(starters.getByRole("link", { name: new RegExp(ADVANCED) })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Nuevos" }).getByRole("link", { name: new RegExp(`^Curso ${ADVANCED}`) })).toBeVisible();
  await expect(page.getByRole("list", { name: "Meditación e2e" }).getByRole("link", { name: new RegExp(`^Curso ${ADVANCED}`) })).toBeVisible();
  await expect(page.getByRole("list", { name: "Por maestro" }).getByRole("link", { name: `Maestra ${BEGINNER}, maestro de Respiración e2e` })).toBeVisible();
  // Solo aparece lo publicado.
  await expect(page.getByText(HIDDEN)).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);

  // Sin suscripción, la ficha ofrece suscribirse y lleva a la lección, donde PA-33 dice por qué.
  await starters.getByRole("link", { name: `Curso ${BEGINNER}, con Maestra ${BEGINNER}` }).click();
  await expect(page).toHaveURL(new RegExp(`/cursos/${BEGINNER}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Curso ${BEGINNER}`);
  await expect(page.getByRole("link", { name: "Suscribirme para verlo" })).toHaveAttribute("href", new RegExp(`^/cursos/${BEGINNER}/lecciones/`));
  await expect(page.getByRole("region", { name: "Temario" }).getByRole("link")).toHaveCount(2);
  expect(await a11yViolations(page)).toEqual([]);

  // Con suscripción, «Empezar».
  await subscribe(who);
  await page.reload();
  await expect(page.getByRole("link", { name: "Empezar" })).toHaveAttribute("href", new RegExp(`^/cursos/${BEGINNER}/lecciones/`));
});

test("el visitante ve la ficha completa y su botón lleva a registrarse; un curso sin listar no existe", async ({ browser }) => {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    await page.goto(`/cursos/${ADVANCED}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Curso ${ADVANCED}`);
    await expect(page.getByRole("link", { name: "Suscribirme para verlo" })).toHaveAttribute("href", new RegExp(`^/registro\\?volver=`));
    await expect(page.getByRole("navigation", { name: "Principal" })).toHaveCount(0);
    await page.getByRole("link", { name: `Ver la ficha de Maestra ${ADVANCED}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Maestra ${ADVANCED}`);
    await expect(page.getByRole("region", { name: `Cursos de Maestra ${ADVANCED}` }).getByRole("link")).toHaveCount(1);
    expect((await page.goto(`/cursos/${HIDDEN}`))?.status()).toBe(404);
    expect((await page.goto(`/maestros/maestra-${HIDDEN}`))?.status()).toBe(404);
    await context.close();
  }
});
