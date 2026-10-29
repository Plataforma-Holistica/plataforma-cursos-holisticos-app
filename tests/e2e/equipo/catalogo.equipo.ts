import { expect, test, type Page } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// El catálogo del alumno (T-210), de extremo a extremo: FL-10 (el inicio de quien no ha empezado
// nada, y de ahí a la ficha de un curso), las fichas públicas para el visitante, con JavaScript y
// sin él, FL-11 (explorar y buscar, con JavaScript y sin él), y que solo aparece lo publicado.
// Desde la tercera solicitud, FL-11 paso 6: guardar en Mi lista y quitar, con JavaScript y sin él.
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

/**
 * Un curso de dos lecciones, cargado como el guion local; si `listed`, publicado y listado como sistema con su maestra.
 * La primera es de Mux, como en `leccion.equipo.ts`: de una de prueba la ficha no sabe si hay acceso (`no_video`) y
 * ofrece «Empezar» a cualquiera, y lo que se prueba es el botón de quien no tiene suscripción.
 */
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
          { title: "Primera", video: { provider: "mux", asset_id: `Asset${slug.replaceAll("-", "")}`, playback_id: `Playback${slug.replaceAll("-", "")}`, duration_seconds: 300 } },
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
  // «Para empezar» lleva los del nivel más bajo que tenga cursos listados. Otras pruebas del grupo
  // aprueban cursos con niveles creados antes que los de aquí: cuál es se le pregunta a la base.
  const [first] = await ownerQuery<{ title: string; teacher: string }>(
    `select c.title, c.teacher_name as teacher
       from public.published_courses c
       join public.course_registry r on r.course_id = c.course_id and r.state in ('published', 'changes_pending')
       join public.levels l on l.id = c.level_id and l.is_active
      where c.is_listed
      order by l.position, c.published_at desc, c.slug
      limit 1`,
  );
  if (first === undefined) throw new Error("No hay cursos listados con nivel.");
  // Lo público se recuerda 30 segundos (`CATALOG_MEMORY_MS`): si otra prueba ya leyó el inicio
  // antes de que se cargaran estos cursos, aparecen al vencer esa memoria.
  const newest = page.getByRole("list", { name: "Nuevos" });
  await expect(async () => {
    await page.reload();
    await expect(newest.getByRole("link", { name: `Curso ${BEGINNER}, con Maestra ${BEGINNER}` })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000, intervals: [2_000] });
  await expect(starters.getByRole("link", { name: `${first.title}, con ${first.teacher}` })).toBeVisible();
  // El avanzado se creó después que el inicial: nunca es el más bajo.
  await expect(starters.getByRole("link", { name: new RegExp(ADVANCED) })).toHaveCount(0);
  await expect(newest.getByRole("link", { name: new RegExp(`^Curso ${ADVANCED}`) })).toBeVisible();
  await expect(page.getByRole("list", { name: "Meditación e2e" }).getByRole("link", { name: new RegExp(`^Curso ${ADVANCED}`) })).toBeVisible();
  await expect(page.getByRole("list", { name: "Por maestro" }).getByRole("link", { name: `Maestra ${BEGINNER}, maestro de Respiración e2e` })).toBeVisible();
  // Solo aparece lo publicado.
  await expect(page.getByText(HIDDEN)).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);

  // Sin suscripción, la ficha ofrece suscribirse y lleva a la lección, donde PA-33 dice por qué.
  await newest.getByRole("link", { name: `Curso ${BEGINNER}, con Maestra ${BEGINNER}` }).click();
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
    // El deslinde (RF-809), al pie de la ficha.
    await expect(page.getByRole("main").locator("> p").last()).toHaveText("La Plataforma es educativa. No sustituye la atención médica ni psicológica profesional.");
    await page.getByRole("link", { name: `Ver la ficha de Maestra ${ADVANCED}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Maestra ${ADVANCED}`);
    await expect(page.getByRole("region", { name: `Cursos de Maestra ${ADVANCED}` }).getByRole("link")).toHaveCount(1);
    expect((await page.goto(`/cursos/${HIDDEN}`))?.status()).toBe(404);
    expect((await page.goto(`/maestros/maestra-${HIDDEN}`))?.status()).toBe(404);
    await context.close();
  }
});

test("FL-11: explorar pide sesión, filtra y busca sin acentos, y regresar de una ficha no pierde lo pedido", async ({ page }) => {
  const who = await person();
  // Sin sesión, a entrar; y al entrar, de vuelta a lo que se pidió, con su filtro.
  await signIn(page, who, `/explorar?practica=${slugOf("Meditación e2e")}`);
  await expect(page).toHaveURL(new RegExp(`/explorar\\?practica=${slugOf("Meditación e2e")}$`));
  const results = page.getByRole("region", { name: "Resultados" });
  await expect(async () => {
    await page.reload();
    await expect(results.getByRole("link", { name: new RegExp(`^Curso ${ADVANCED}`) })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000, intervals: [2_000] });
  await expect(page.getByRole("link", { name: "Quitar filtro: Meditación e2e" })).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(BEGINNER) })).toHaveCount(0);
  await expect(page.getByText(HIDDEN)).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);

  // Sin filtros, y buscando con acento y mayúsculas el principio de unas palabras: busca solo.
  await page.getByRole("link", { name: "Limpiar filtros" }).first().click();
  await expect(page).toHaveURL(/\/explorar$/);
  await page.getByRole("searchbox", { name: "Buscar por curso o maestro" }).fill("CATÁLOGO-INIC");
  await expect(page).toHaveURL(/\/explorar\?q=CAT%C3%81LOGO-INIC$/);
  await expect(results.getByRole("link", { name: new RegExp(`^Curso ${BEGINNER}`) })).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(ADVANCED) })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Maestros" }).getByRole("link", { name: new RegExp(`^Maestra ${BEGINNER}`) })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // A la ficha y de regreso: la búsqueda sigue ahí.
  await results.getByRole("link", { name: new RegExp(`^Curso ${BEGINNER}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/cursos/${BEGINNER}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/explorar\?q=CAT%C3%81LOGO-INIC$/);
  await expect(page.getByRole("searchbox")).toHaveValue("CATÁLOGO-INIC");
  await expect(results.getByRole("link", { name: new RegExp(`^Curso ${BEGINNER}`) })).toBeVisible();

  // Sin resultados: lo dice y muestra una selección.
  await page.getByRole("searchbox").fill("zzzz-ninguno");
  await expect(page.getByText("No encontramos cursos con esos filtros.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Nuevos" })).toBeVisible();
});

test("FL-11 sin JavaScript: «Buscar» envía, y la dirección lleva lo pedido", async ({ browser }) => {
  const who = await person();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, who, "/explorar");
  await expect(page).toHaveURL(/\/explorar$/);
  await page.getByRole("searchbox", { name: "Buscar por curso o maestro" }).fill("maestra catalogo-avan");
  await page.getByRole("combobox", { name: "Nivel" }).selectOption(slugOf("Avanzado e2e"));
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page).toHaveURL(/\/explorar\?q=maestra\+catalogo-avan/);
  await expect(page.getByRole("region", { name: "Resultados" }).getByRole("link", { name: new RegExp(`^Curso ${ADVANCED}`) })).toBeVisible();
  await expect(page.getByRole("link", { name: "Quitar filtro: Avanzado e2e" })).toBeVisible();
  await context.close();
});

const MEDITATION = slugOf("Meditación e2e");
const saveButton = (page: Page, slug: string) => page.getByRole("button", { name: `Guardar en mi lista: Curso ${slug}` });
const removeButton = (page: Page, slug: string) => page.getByRole("button", { name: `Quitar de mi lista: Curso ${slug}` });

/** La ficha de un curso, ya con lo listado de ahora: lo público se recuerda 30 segundos. */
async function openCourse(page: Page, slug: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/cursos/${slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Curso ${slug}`, { timeout: 1_000 });
  }).toPass({ timeout: 45_000, intervals: [2_000] });
}

test("FL-11 paso 6: guardar en la ficha, verlo en «Mi lista», quitar desde el carrusel y guardar desde explorar con los filtros puestos", async ({ page }) => {
  const who = await person();
  await signIn(page, who, "/entrar?volver=%2Finicio");
  await expect(page).toHaveURL(/\/inicio$/);
  await expect(page.getByRole("heading", { level: 2, name: "Mi lista" })).toHaveCount(0);

  // En la ficha: guardar, y el botón dice ya quitar, sin soltar el foco.
  await openCourse(page, BEGINNER);
  await saveButton(page, BEGINNER).click();
  await expect(removeButton(page, BEGINNER)).toBeFocused();
  await expect(page.getByText("Guardado en tu lista.")).toBeAttached();
  expect(await a11yViolations(page)).toEqual([]);
  await openCourse(page, ADVANCED);
  await saveButton(page, ADVANCED).click();
  await expect(removeButton(page, ADVANCED)).toBeVisible();

  // En el inicio, después de «Para empezar» y antes de «Nuevos», lo último guardado primero.
  await page.goto("/inicio");
  const row = page.getByRole("list", { name: "Mi lista" });
  await expect(row.getByRole("link")).toHaveText([new RegExp(`^Curso ${ADVANCED}`), new RegExp(`^Curso ${BEGINNER}`)]);
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings.indexOf("Mi lista")).toBe(headings.indexOf("Para empezar") + 1);
  expect(headings.indexOf("Nuevos")).toBe(headings.indexOf("Mi lista") + 1);
  expect(await a11yViolations(page)).toEqual([]);

  // Quitar desde el carrusel: la tarjeta se va al momento y el foco pasa a la siguiente.
  await removeButton(page, ADVANCED).click();
  await expect(row.getByRole("link")).toHaveCount(1);
  await expect(removeButton(page, BEGINNER)).toBeFocused();
  await expect(page.getByText("Quitado de tu lista.")).toBeAttached();

  // En explorar, con un filtro: guardar no lo pierde.
  await page.goto(`/explorar?practica=${MEDITATION}`);
  const results = page.getByRole("region", { name: "Resultados" });
  await results.getByRole("button", { name: `Guardar en mi lista: Curso ${ADVANCED}` }).click();
  await expect(results.getByRole("button", { name: `Quitar de mi lista: Curso ${ADVANCED}` })).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`/explorar\\?practica=${MEDITATION}$`));
  expect(await a11yViolations(page)).toEqual([]);
  await page.goto("/inicio");
  await expect(row.getByRole("link")).toHaveText([new RegExp(`^Curso ${ADVANCED}`), new RegExp(`^Curso ${BEGINNER}`)]);

  // Lo de otra persona no se ve: su inicio no tiene «Mi lista».
  const other = await person();
  const otherContext = await page.context().browser()?.newContext();
  if (otherContext === undefined) throw new Error("Sin navegador.");
  const otherPage = await otherContext.newPage();
  await signIn(otherPage, other, "/entrar?volver=%2Finicio");
  await expect(otherPage).toHaveURL(/\/inicio$/);
  await expect(otherPage.getByRole("heading", { level: 2, name: "Nuevos" })).toBeVisible();
  await expect(otherPage.getByRole("heading", { level: 2, name: "Mi lista" })).toHaveCount(0);
  await otherContext.close();
});

test("FL-11 paso 6 sin JavaScript: cada botón vuelve a su pantalla, en su lugar", async ({ browser }) => {
  const who = await person();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, who, "/entrar?volver=%2Finicio");
  await expect(page).toHaveURL(/\/inicio$/);

  await openCourse(page, BEGINNER);
  await saveButton(page, BEGINNER).click();
  await expect(page).toHaveURL(new RegExp(`/cursos/${BEGINNER}#bloque-ficha-lista$`));
  await expect(removeButton(page, BEGINNER)).toBeVisible();

  await page.goto(`/explorar?practica=${MEDITATION}`);
  await saveButton(page, ADVANCED).click();
  await expect(page).toHaveURL(new RegExp(`/explorar\\?practica=${MEDITATION}#bloque-explorar-${ADVANCED}$`));
  await expect(page.getByRole("link", { name: "Quitar filtro: Meditación e2e" })).toBeVisible();
  await expect(removeButton(page, ADVANCED)).toBeVisible();

  await page.goto("/inicio");
  const row = page.getByRole("list", { name: "Mi lista" });
  await expect(row.getByRole("link")).toHaveCount(2);
  await removeButton(page, ADVANCED).click();
  await expect(page).toHaveURL(/\/inicio#bloque-mi-lista$/);
  await expect(row.getByRole("link")).toHaveText([new RegExp(`^Curso ${BEGINNER}`)]);
  await removeButton(page, BEGINNER).click();
  await expect(page.getByRole("heading", { level: 2, name: "Mi lista" })).toHaveCount(0);
  await context.close();
});
