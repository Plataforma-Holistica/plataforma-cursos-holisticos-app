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
  // En computadora el pedido de Mux no se atrapa: el navegador lleva a pantalla completa el
  // contenedor entero, con la marca. Sin video cargado, los controles de Mux no se ven: el
  // pedido sale de su controlador como lo mandaría su botón, dentro de un clic de verdad (el
  // navegador solo deja entrar a pantalla completa con un gesto de quien ve).
  await page.evaluate(() => {
    const controller = (document.querySelector("mux-player") as unknown as { mediaController: Element }).mediaController;
    const ask = () => controller.dispatchEvent(new CustomEvent("mediaenterfullscreenrequest", { bubbles: true, composed: true }));
    document.querySelector("h1")?.addEventListener("click", ask, { once: true });
  });
  await page.getByRole("heading", { level: 1 }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.querySelector("[data-player-frame]"))).toBe(true);
  await expect(page.locator("[data-player-frame]")).not.toHaveAttribute("data-filled");
  await page.evaluate(() => document.exitFullscreen());
  // Lo único que se le pide a alguien de fuera es el video a Mux, con su dirección firmada.
  await expect.poll(() => outside.some((href) => href.startsWith(`https://stream.mux.com/Playback${SLUG.replaceAll("-", "")}.m3u8?`) && href.includes("token=")), { timeout: 60_000 }).toBe(true);
  for (const host of new Set(outside.map((href) => new URL(href).hostname))) expect(["image.mux.com", "stream.mux.com"], host).toContain(host);
  expect(await a11yViolations(page)).toEqual([]);
  // Si la quitan, el video se pausa: el reproductor queda en pausa.
  await page.evaluate(() => document.querySelector("[data-watermark]")?.remove());
  await expect.poll(() => page.evaluate(() => (document.querySelector("mux-player") as unknown as { paused?: boolean } | null)?.paused)).toBe(true);
});

/**
 * Un iPhone, hasta donde Chromium lo deja simular: ningún elemento entra a pantalla completa
 * (Safari de iPhone solo lleva ahí el video, con la del sistema, que no pinta la marca), y el
 * video sí tiene la del sistema. Si alguien la pide, queda anotado.
 */
async function likeAnIPhone(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    for (const key of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]) Reflect.deleteProperty(Element.prototype, key);
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, "webkitFullscreenEnabled", { configurable: true, get: () => false });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitSupportsFullscreen", { configurable: true, get: () => true });
    Object.defineProperty(HTMLVideoElement.prototype, "webkitEnterFullscreen", {
      configurable: true,
      value() {
        (window as unknown as { systemFullscreen?: boolean }).systemFullscreen = true;
      },
    });
  });
}

/** Lo que ocupan en la ventana el contenedor, el escenario del video y la marca. */
async function boxes(page: Page) {
  const box = async (selector: string) => {
    const found = await page.locator(selector).boundingBox();
    if (found === null) throw new Error(`No se ve ${selector}`);
    return found;
  };
  return { frame: await box("[data-player-frame]"), stage: await box("[data-player-frame] .player-stage"), mark: await box("[data-player-frame] [data-watermark]") };
}

/**
 * Las celdas de la marca que quedarían bajo un botón de la pantalla completa propia. La celda es
 * al azar: se mide cada una con una muestra del mismo texto, puesta un momento en el escenario.
 * Agregarla no toca la marca, así que no pausa nada.
 */
async function cellsUnderButtons(page: Page, email: string): Promise<number[]> {
  return page.evaluate((text) => {
    const stage = document.querySelector("[data-player-frame] .player-stage");
    if (stage === null) throw new Error("No se ve el escenario");
    const buttons = [...document.querySelectorAll("[data-player-frame] .player-filled-bar button")].map((button) => button.getBoundingClientRect());
    if (buttons.length === 0) throw new Error("No se ven los botones");
    const under: number[] = [];
    for (const cell of [0, 1, 2, 3, 5, 6, 7, 8]) {
      const probe = document.createElement("p");
      probe.className = `watermark watermark-cell-${cell}`;
      probe.textContent = text;
      stage.append(probe);
      const mark = probe.getBoundingClientRect();
      probe.remove();
      if (buttons.some((button) => mark.left < button.right && button.left < mark.right && mark.top < button.bottom && button.top < mark.bottom)) under.push(cell);
    }
    return under;
  }, email);
}

test("en un iPhone: la pantalla completa es dentro de la página, con la marca sobre el video, y «Girar»", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await likeAnIPhone(context);
  const page = await context.newPage();
  await holdOutside(context);
  await signIn(page, who, lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await page.getByRole("button", { name: "Reproducir la lección" }).click();
  await expect(page.locator("[data-player-frame] [data-watermark]")).toHaveText(who.email);

  // Lo que pide el botón de pantalla completa de Mux (o la tecla F), desde dentro de sus controles.
  await page.evaluate(() =>
    (document.querySelector("mux-player") as unknown as { mediaController: Element }).mediaController.dispatchEvent(
      new CustomEvent("mediaenterfullscreenrequest", { bubbles: true, composed: true }),
    ),
  );
  const frame = page.locator("[data-player-frame]");
  await expect(frame).toHaveAttribute("data-filled", "");
  expect(await page.evaluate(() => (window as unknown as { systemFullscreen?: boolean }).systemFullscreen)).toBeUndefined();
  // Toda la ventana; el video al centro, a lo ancho, y la marca encima del video, no en lo negro.
  let { frame: frameBox, stage, mark } = await boxes(page);
  expect(frameBox).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(stage.width).toBeCloseTo(390, 0);
  expect(stage.height).toBeCloseTo((390 * 9) / 16, 0);
  expect(mark.y).toBeGreaterThanOrEqual(stage.y);
  expect(mark.y + mark.height).toBeLessThanOrEqual(stage.y + stage.height);
  // La página de atrás no se desplaza.
  expect(await page.evaluate(() => document.documentElement.classList.contains("player-locked"))).toBe(true);
  await expect(page.getByRole("button", { name: "Salir de pantalla completa" })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Gira tu teléfono para verlo más grande" })).toBeVisible();
  expect(await cellsUnderButtons(page, who.email)).toEqual([]);
  expect(await a11yViolations(page)).toEqual([]);

  // Girar: el contenedor rota y el video ocupa el largo de la pantalla.
  await page.getByRole("button", { name: "Girar" }).click();
  await expect(page.getByRole("button", { name: "Girar" })).toHaveAttribute("aria-pressed", "true");
  ({ frame: frameBox, stage, mark } = await boxes(page));
  expect(frameBox.width).toBeCloseTo(390, 0);
  expect(frameBox.height).toBeCloseTo(844, 0);
  expect(stage.height).toBeGreaterThan(stage.width);
  expect(mark.x).toBeGreaterThanOrEqual(stage.x);
  expect(mark.x + mark.width).toBeLessThanOrEqual(stage.x + stage.width);
  expect(await cellsUnderButtons(page, who.email)).toEqual([]);

  // En horizontal ya no gira, y el video llena el alto: «Salir» queda encima del video, sin tapar
  // ninguna celda de la marca, y un toque junto a él llega al video, no a la franja de los botones.
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(frame).not.toHaveAttribute("data-turned");
  await expect(page.getByRole("button", { name: "Girar" })).toHaveCount(0);
  ({ frame: frameBox, stage } = await boxes(page));
  expect(frameBox).toEqual({ x: 0, y: 0, width: 844, height: 390 });
  expect(stage.height).toBeCloseTo(390, 0);
  expect(await cellsUnderButtons(page, who.email)).toEqual([]);
  const exit = await page.getByRole("button", { name: "Salir de pantalla completa" }).boundingBox();
  if (exit === null) throw new Error("No se ve «Salir de pantalla completa»");
  expect(exit.x + exit.width).toBeGreaterThan(stage.x);
  const beside = { x: exit.x + exit.width + 40, y: exit.y + exit.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("mux-player") !== null, beside)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "Salir de pantalla completa" }).click();
  await expect(frame).not.toHaveAttribute("data-filled");
  expect(await page.evaluate(() => document.documentElement.classList.contains("player-locked"))).toBe(false);

  // Si iOS entra solo a la del sistema (un pellizco), se sale de ella y pasa a la propia.
  await page.evaluate(() => {
    const video = (document.querySelector("mux-player") as unknown as { media: { nativeEl: HTMLVideoElement } }).media.nativeEl;
    video.dispatchEvent(new Event("webkitbeginfullscreen"));
  });
  await expect(frame).toHaveAttribute("data-filled", "");
  await context.close();
});

test("con acceso y sin JavaScript: la página se lee, y dice que para ver hace falta JavaScript", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, who, lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await expect(page.getByText("Para ver la lección hace falta JavaScript.")).toBeVisible();
  // El temario y «Sobre esta lección» se leen, sin pestañas.
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Lección 1, Con Mux, 6 min, reproduciendo" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Sobre esta lección" })).toBeVisible();
  await expect(page.getByText("Un curso para probar la lección.").first()).toBeVisible();
  await context.close();
});

test("en un teléfono: el reproductor arriba, las pestañas Temario y Sobre esta lección, y las reglas de accesibilidad", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await holdOutside(context);
  await signIn(page, who, lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  const tabs = page.getByRole("tablist", { name: "Partes de la lección" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveText(["Temario", "Sobre esta lección"]);
  // La columna de escritorio no se ve, y el temario de la pestaña sí.
  await expect(page.getByRole("link", { name: "Lección 1, Con Mux, 6 min, reproduciendo" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Lección 1, Con Mux, 6 min, reproduciendo" })).toBeVisible();
  await page.getByRole("tab", { name: "Sobre esta lección" }).click();
  await expect(page.getByRole("tabpanel", { name: "Sobre esta lección" })).toContainText("Un curso para probar la lección.");
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Reproducir la lección" }).click();
  await expect(page.locator("[data-player-frame] [data-watermark]")).toHaveText(who.email);
  expect(await a11yViolations(page)).toEqual([]);
  await context.close();
});
