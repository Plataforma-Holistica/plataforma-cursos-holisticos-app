import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

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
/** El código con que Mux Player dice que la dirección caducó (`NETWORK_TOKEN_EXPIRED`; el de `src/app/_video/errors.ts`). */
const TOKEN_EXPIRED = 2403210;

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

/**
 * Lo que manda Mux Player cuando la dirección caducó: un error fatal con su código, en el propio
 * elemento, que es donde lo escucha el reproductor. El elemento queda anotado, para ver que se
 * montó otro.
 */
async function expire(page: Page): Promise<void> {
  await page.evaluate((muxCode) => {
    const element = document.querySelector("mux-player");
    (window as unknown as { expired?: Element | null }).expired = element;
    element?.dispatchEvent(new CustomEvent("error", { detail: { fatal: true, muxCode } }));
  }, TOKEN_EXPIRED);
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
  // Si la dirección caduca a pantalla completa, se renueva sin salir de ella: otro Mux Player
  // dentro del mismo contenedor, ligado a él, que vuelve a pedir el video.
  const manifests = () => outside.filter((href) => href.startsWith(`https://stream.mux.com/Playback${SLUG.replaceAll("-", "")}.m3u8?`)).length;
  await expect.poll(manifests, { timeout: 60_000 }).toBeGreaterThan(0);
  const before = manifests();
  // Con el foco en el reproductor (en su controlador, que es lo que lo recibe), como quien usa el teclado.
  await page.evaluate(() => (document.querySelector("mux-player") as unknown as { mediaController: HTMLElement }).mediaController.focus());
  expect(await page.evaluate(() => document.activeElement === document.querySelector("mux-player"))).toBe(true);
  await expire(page);
  await expect.poll(() => page.evaluate(() => document.querySelector("mux-player") !== (window as unknown as { expired?: Element }).expired)).toBe(true);
  expect(await page.evaluate(() => document.fullscreenElement === document.querySelector("[data-player-frame]"))).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const controller = (document.querySelector("mux-player") as unknown as { mediaController?: Element & { fullscreenElement?: Element | null } }).mediaController;
        return controller?.fullscreenElement === document.querySelector("[data-player-frame]") && controller.hasAttribute("mediaisfullscreen");
      }),
    )
    .toBe(true);
  await expect.poll(manifests, { timeout: 60_000 }).toBeGreaterThan(before);
  await expect(mark).toHaveText(who.email);
  // El foco pasó al reproductor nuevo: los atajos del teclado siguen sirviendo.
  expect(await page.evaluate(() => document.activeElement === document.querySelector("mux-player"))).toBe(true);
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

  // Si la dirección caduca aquí, se renueva sin salir de la pantalla completa propia: sigue girada.
  await expire(page);
  await expect.poll(() => page.evaluate(() => document.querySelector("mux-player") !== (window as unknown as { expired?: Element }).expired)).toBe(true);
  await expect(frame).toHaveAttribute("data-filled", "");
  await expect(frame).toHaveAttribute("data-turned", "");
  await expect(page.getByRole("button", { name: "Girar" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.classList.contains("player-locked"))).toBe(true);
  await expect(page.locator("[data-player-frame] [data-watermark]")).toHaveText(who.email);

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
  // El deslinde (RF-809), al pie.
  await expect(page.getByRole("main").locator("> :last-child")).toHaveText("La Plataforma es educativa. No sustituye la atención médica ni psicológica profesional.");
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

/**
 * Lo que Mux Player avisa cuando el video empieza a avanzar: aquí nunca carga, así que se avisa a
 * mano, sobre el propio elemento. Desde entonces la lección late su reproducción (T-204).
 */
async function advance(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("mux-player")?.dispatchEvent(new Event("playing")));
}

/** Un latido ahora, sin esperar `LATIDO_SEGUNDOS`: la pantalla late al volver a la pestaña. */
async function beatNow(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

/** Entra con su propio navegador (otra sesión de Auth de la misma cuenta) y le da reproducir. */
async function watchFrom(context: BrowserContext, who: Person): Promise<Page> {
  const page = await context.newPage();
  await holdOutside(context);
  await signIn(page, who, lessonUrl(SLUG, lesson));
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await page.getByRole("button", { name: "Reproducir la lección" }).click();
  return page;
}

test("una reproducción a la vez: otro dispositivo ve PA-34, cierra la otra, y la otra se detiene y puede tomar el lugar de vuelta (T-204)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const computer = await browser.newContext();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const first = await watchFrom(computer, who);
  await expect(first.locator("mux-player")).toHaveCount(1);
  await advance(first);

  // El teléfono encuentra el lugar ocupado: PA-34 en el lugar del reproductor, con la lista.
  const second = await watchFrom(phone, who);
  await expect(second.getByRole("heading", { level: 2, name: "Tu cuenta ya está reproduciendo en otro lugar" })).toBeVisible();
  const rows = second.getByRole("list", { name: "Dónde se está reproduciendo" }).getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Con Mux · Curso leccion-e2e · desde las");
  await expect(second.locator("mux-player")).toHaveCount(0);
  expect(await a11yViolations(second)).toEqual([]);

  // Cerrar esa reproducción: aquí arranca, en el mismo pedido.
  await rows.first().getByRole("button", { name: /^Cerrar esa reproducción/ }).click();
  await expect(second.locator("mux-player")).toHaveCount(1);
  await expect(second.locator("[data-player-frame] [data-watermark]")).toHaveText(who.email);

  // En la computadora, su siguiente latido lo dice, y el video se va.
  await beatNow(first);
  await expect(first.getByText("Esta reproducción se cerró desde otro dispositivo.").first()).toBeVisible();
  await expect(first.locator("mux-player")).toHaveCount(0);
  expect(await a11yViolations(first)).toEqual([]);

  // «Reproducir aquí» toma el lugar de vuelta, y ahora es el teléfono el que se detiene.
  await advance(second);
  await first.getByRole("button", { name: "Reproducir aquí" }).click();
  await expect(first.locator("mux-player")).toHaveCount(1);
  await beatNow(second);
  await expect(second.getByText("Esta reproducción se cerró desde otro dispositivo.").first()).toBeVisible();

  // En la base, una sola viva para la cuenta.
  const [live] = await ownerQuery<{ n: number }>(
    "select count(*)::int as n from public.playback_sessions where profile_id = $1 and revoked_at is null",
    [who.id],
  );
  expect(live?.n).toBe(1);
  await computer.close();
  await phone.close();
});

test("la misma lección en otra pestaña del mismo navegador: la nueva reproduce y la vieja lo dice (T-204)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const first = await watchFrom(context, who);
  await expect(first.locator("mux-player")).toHaveCount(1);
  await advance(first);
  // Otra pestaña, con la misma sesión: nunca dice ocupado.
  const second = await context.newPage();
  await second.goto(lessonUrl(SLUG, lesson));
  await second.getByRole("button", { name: "Reproducir la lección" }).click();
  await expect(second.locator("mux-player")).toHaveCount(1);
  await beatNow(first);
  await expect(first.getByText("Esta lección se abrió en otra pestaña o ventana.").first()).toBeVisible();
  await expect(first.locator("mux-player")).toHaveCount(0);
  // Y renovar la dirección en la nueva no la saca: sigue reproduciendo, y su latido sigue bien.
  await advance(second);
  await expire(second);
  await expect.poll(() => second.evaluate(() => document.querySelector("mux-player") !== (window as unknown as { expired?: Element }).expired)).toBe(true);
  // El latido de la nueva tiene que llegar a la base antes de afirmar que no pasó nada: si latiera
  // con la reproducción reemplazada, el aviso de la pestaña llegaría después.
  const [{ at } = { at: "" }] = await ownerQuery<{ at: string }>("select now()::text as at");
  await advance(second);
  await beatNow(second);
  await expect
    .poll(async () => {
      const [row] = await ownerQuery<{ beat: boolean }>(
        `select bool_or(last_heartbeat_at > $2::timestamptz) as beat from public.playback_sessions
          where profile_id = $1 and revoked_at is null`,
        [who.id, at],
      );
      return row?.beat ?? false;
    })
    .toBe(true);
  await expect(second.locator("mux-player")).toHaveCount(1);
  await expect(second.getByText("Esta lección se abrió en otra pestaña o ventana.")).toHaveCount(0);
  await context.close();
});

// Los tramos vistos (T-205). Aquí el video nunca carga: el elemento dice que avanza y en qué
// segundo va, y manda `timeupdate` cada cuarto de segundo con el reloj de verdad, porque la base
// revisa cada tramo contra el tiempo vivo de su reproducción.

/** El video avanza de `from` a `to` a velocidad normal, en tiempo real. */
async function playVideo(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    async ({ from, to }) => {
      const element = document.querySelector("mux-player") as (Element & { fakeAt?: number }) | null;
      if (element === null) throw new Error("sin reproductor");
      if (Object.getOwnPropertyDescriptor(element, "paused") === undefined) {
        Object.defineProperty(element, "paused", { configurable: true, get: () => false });
        Object.defineProperty(element, "currentTime", { configurable: true, get: () => element.fakeAt ?? 0, set: () => undefined });
        Object.defineProperty(element, "playbackRate", { configurable: true, get: () => 1, set: () => undefined });
        Object.defineProperty(element, "duration", { configurable: true, get: () => 356 });
      }
      for (let at = from; at <= to; at += 0.25) {
        element.fakeAt = at;
        element.dispatchEvent(new Event("timeupdate"));
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    { from, to },
  );
}

/** La pausa, como la avisa Mux Player: el tramo se cierra y lo pendiente sale sin presencia. */
async function pauseVideo(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("mux-player")?.dispatchEvent(new Event("pause")));
}

type Watched = {
  session: string;
  seq: number;
  from: number;
  to: number;
  visible: boolean;
};

/** Lo que el libro tiene de esa cuenta. */
async function watched(who: Person): Promise<Watched[]> {
  return ownerQuery<Watched>(
    `select playback_session_id::text as session, seq, from_second as "from", to_second as "to", was_visible as visible
       from public.watch_events where profile_id = $1 order by received_at, seq`,
    [who.id],
  );
}

/** Cuántas colas guarda el navegador en esa página. */
const queues = (page: Page) => page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith("plataforma-latidos:")).length);

/** Una acción de servidor: un envío con su cabecera. */
const isAction = (route: Route) => route.request().method() === "POST" && route.request().headers()["next-action"] !== undefined;

test("los tramos vistos llegan al libro una sola vez, aunque una respuesta se pierda (T-205)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await advance(page);
  await playVideo(page, 0, 3);
  // La respuesta del primer vaciado se pierde después de que el servidor lo atendió: el navegador
  // lo reintenta, y la base lo contesta repetido.
  let dropped = false;
  await page.route("**/*", async (route) => {
    if (!dropped && isAction(route)) {
      dropped = true;
      await route.fetch();
      return route.abort();
    }
    return route.fallback();
  });
  await pauseVideo(page);
  await expect.poll(() => watched(who)).toEqual([expect.objectContaining({ seq: 0, from: 0, to: 3, visible: true })]);
  expect(dropped).toBe(true);
  // El reintento sale a los 5 s; con su respuesta, la cola queda vacía. En el libro, uno solo.
  await expect.poll(() => queues(page), { timeout: 15_000 }).toBe(0);
  expect(await watched(who)).toHaveLength(1);
  await context.close();
});

test("sin red: «Sin conexión. Reintentando…» a los dos envíos fallidos, y al volver, los tramos llegan (T-205)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await advance(page);
  await playVideo(page, 0, 3);
  await context.setOffline(true);
  await pauseVideo(page);
  // Un envío perdido no la muestra: el primero falla en el acto, y el reintento sale a los 5 s.
  await page.waitForTimeout(2_000);
  await expect(page.getByText("Sin conexión. Reintentando…")).toHaveCount(0);
  const note = page.getByText("Sin conexión. Reintentando…");
  await expect(note).toBeVisible({ timeout: 15_000 });
  expect(await watched(who)).toEqual([]);
  expect(await a11yViolations(page)).toEqual([]);
  await context.setOffline(false);
  await expect(page.getByText("Sin conexión. Reintentando…")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(() => watched(who)).toEqual([expect.objectContaining({ seq: 0, from: 0, to: 3, visible: true })]);
  await context.close();
});

test("con la pestaña oculta, lo visto llega como no visible (T-205, RF-403)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await advance(page);
  // El navegador de prueba siempre está a la vista: se le dice que no, y se avisa.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await playVideo(page, 0, 3);
  await pauseVideo(page);
  await expect.poll(() => watched(who)).toEqual([expect.objectContaining({ seq: 0, from: 0, to: 3, visible: false })]);
  await context.close();
});

test("al irse la página con un tramo sin mandar, sale la próxima vez que se abre una lección (T-205)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await advance(page);
  await playVideo(page, 0, 3);
  // Nada sale de esta página: el tramo solo se guarda al irse.
  await page.route("**/*", (route) => (isAction(route) ? route.abort() : route.fallback()));
  await page.goto("about:blank");
  expect(await watched(who)).toEqual([]);
  const again = await context.newPage();
  await again.goto(lessonUrl(SLUG, lesson));
  await expect.poll(() => watched(who)).toEqual([expect.objectContaining({ seq: 0, from: 0, to: 3, visible: true })]);
  await expect.poll(() => queues(again)).toBe(0);
  await context.close();
});

test("al navegar dentro de la aplicación, el tramo abierto se cierra y sale (T-205)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await advance(page);
  await playVideo(page, 0, 3);
  await page.getByRole("link", { name: "Volver al inicio" }).click();
  await expect(page).toHaveURL("/inicio");
  await expect.poll(() => watched(who)).toEqual([expect.objectContaining({ seq: 0, from: 0, to: 3, visible: true })]);
  await context.close();
});

test("al renovar la dirección, lo visto con la reproducción vieja llega a la vieja (T-205)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await advance(page);
  await playVideo(page, 0, 3);
  await expire(page);
  await expect.poll(() => page.evaluate(() => document.querySelector("mux-player") !== (window as unknown as { expired?: Element }).expired)).toBe(true);
  await expect.poll(() => watched(who)).toEqual([expect.objectContaining({ seq: 0, from: 0, to: 3 })]);
  const [{ session } = { session: "" }] = await watched(who);
  const [old] = await ownerQuery<{ reason: string | null }>("select revoke_reason as reason from public.playback_sessions where id = $1", [session]);
  expect(old?.reason).toBe("replaced");
  await context.close();
});

// El progreso (T-206, RF-307): lo visto queda guardado al momento, la lección siguiente vez
// arranca donde se quedó, el inicio la pone en «continuar viendo», y la lección se marca
// terminada sin recargar al llegar a UMBRAL_COMPLETO_PCT.

/** El segundo en que arranca el reproductor, como Mux Player lo recibe. */
const startOf = (page: Page) => page.evaluate(() => document.querySelector("mux-player")?.getAttribute("start-time") ?? null);

/** Lo que la base guarda de esa cuenta en la lección. */
async function progressOf(who: Person): Promise<{ position: number; covered: number; completed: boolean } | null> {
  const [row] = await ownerQuery<{ position: number; covered: number; completed: boolean }>(
    "select last_position_seconds as position, covered_seconds as covered, completed_at is not null as completed from public.lesson_progress where profile_id = $1 and lesson_id = $2",
    [who.id, lesson],
  );
  return row ?? null;
}

test("lo visto queda guardado; al volver arranca donde se quedó, y el inicio lo ofrece en «continuar viendo» (T-206)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  expect(await startOf(page)).toBe("0");
  await advance(page);
  await playVideo(page, 0, 20);
  await pauseVideo(page);
  await expect.poll(() => progressOf(who)).toEqual({ position: 20, covered: 20, completed: false });
  // El inicio: el curso, con la lección sugerida y su avance.
  await page.getByRole("link", { name: "Volver al inicio" }).click();
  await expect(page).toHaveURL("/inicio");
  // Desde T-210, una tarjeta del carrusel: su nombre dice la lección sugerida y lo que dice su barra, que solo se ve.
  const offered = page
    .getByRole("list", { name: "Continuar viendo" })
    .getByRole("link", { name: `Curso ${SLUG}, con Maestra de lección: lección 1 de 1, 0 de 1 terminada`, exact: true });
  await expect(offered).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await offered.click();
  await expect(page).toHaveURL(lessonUrl(SLUG, lesson));
  await page.getByRole("button", { name: "Reproducir la lección" }).click();
  await expect(page.locator("mux-player")).toHaveCount(1);
  await expect.poll(() => startOf(page)).toBe("20");
  await context.close();
});

test("al llegar a UMBRAL_COMPLETO_PCT, la lección queda terminada sin recargar (T-206, RF-307)", async ({ browser }) => {
  const who = await person();
  await subscribe(who);
  // Ya vio casi toda la lección (315 de 356 s; el 90 % son 321), como lo dejaría la base.
  await ownerQuery(
    `insert into public.lesson_progress (profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, covered,
                                         first_watched_at, last_watched_at, last_playback_session_id, last_seq)
     select $1, l.id, l.course_id, l.video_asset_id, 315, '{[0,315)}', now() - interval '1 day', now() - interval '1 day', gen_random_uuid(), 0
     from public.published_lessons l where l.id = $2`,
    [who.id, lesson],
  );
  const context = await browser.newContext();
  const page = await watchFrom(context, who);
  await expect(page.locator("mux-player")).toHaveCount(1);
  await expect(page.getByRole("progressbar", { name: "Avance del curso" }).first()).toHaveAttribute("aria-valuetext", "0 de 1 lección");
  await expect.poll(() => startOf(page)).toBe("315");
  await advance(page);
  await playVideo(page, 315, 322.5);
  await pauseVideo(page);
  await expect.poll(() => progressOf(who)).toMatchObject({ completed: true });
  // Sin recargar: la fila y la barra lo dicen, y se anuncia una vez.
  await expect(page.getByRole("link", { name: "Lección 1, Con Mux, 6 min, terminada, reproduciendo" }).first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Avance del curso" }).first()).toHaveAttribute("aria-valuetext", "1 de 1 lección");
  await expect(page.getByText("Esta lección ya cuenta como terminada.")).toHaveCount(1);
  // Recargar: la página la pinta terminada, y no lo vuelve a anunciar.
  await page.reload();
  await expect(page.getByRole("link", { name: "Lección 1, Con Mux, 6 min, terminada, reproduciendo" }).first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Avance del curso" }).first()).toHaveAttribute("aria-valuetext", "1 de 1 lección");
  await expect(page.getByText("Esta lección ya cuenta como terminada.")).toHaveCount(0);
  // Terminada, el curso sale de «continuar viendo» (FL-13 A3).
  await page.getByRole("link", { name: "Volver al inicio" }).click();
  await expect(page).toHaveURL("/inicio");
  await expect(page.getByRole("heading", { name: "Continuar viendo" })).toHaveCount(0);
  await context.close();
});
