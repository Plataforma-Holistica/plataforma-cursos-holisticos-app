import { expect, test, type APIResponse, type Page } from "@playwright/test";

import { clearCounters, ownerQuery, person, SESSION_COOKIE, type Person } from "./support/stack";

// Administración y las dos pantallas del segundo factor (PA-60, PA-12 y PA-19; RF-105),
// vistas por quien no es del equipo: sin sesión, con la sesión de una alumna, y con una
// cookie inventada. Nada de esto escribe en la auditoría: corre con las demás.
//
// El camino de quien sí es del equipo (invitar, configurar el factor, dar el código, entrar
// a administración) deja renglones en la auditoría, que no admite borrado. Vive aparte, en
// `tests/e2e/equipo/`, y no corre con estas.

test.beforeEach(clearCounters);

const NOT_FOUND = "No encontramos esa página";
const TEAM_PATHS = ["/admin", "/admin/equipo", "/admin/practicas", "/admin/revision", "/admin/alertas", "/admin/no-existe/tampoco", "/entrar/segundo-factor", "/entrar/segundo-factor/configurar"];
/** Las secciones de administración: todas las de la tabla del comodín. */
const SECTIONS = ["/admin/equipo", "/admin/practicas", "/admin/revision", "/admin/alertas"];

async function signIn(page: Page, who: Pick<Person, "email" | "password">, path = "/entrar"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

const auditRows = async () => Number((await ownerQuery<{ n: string }>("select count(*)::text as n from public.audit_log"))[0]?.n);

/** Lo que se ve de una respuesta desde fuera: su estado, su título, su texto y sus cabeceras. */
async function seen(response: APIResponse) {
  const body = await response.text();
  const headers = response.headers();
  return {
    status: response.status(),
    title: /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? null,
    heading: /<h1[^>]*>([^<]*)<\/h1>/.exec(body)?.[1] ?? null,
    // Las que podrían delatar que la ruta existe. Las demás (fecha, longitud) cambian solas.
    cacheControl: headers["cache-control"] ?? null,
    contentType: headers["content-type"] ?? null,
    location: headers.location ?? null,
    vary: headers.vary ?? null,
  };
}

test("sin sesión, administración y las pantallas del segundo factor mandan a entrar, guardando solo un destino que valga", async ({ page }) => {
  const expected: [string, string][] = [
    ["/admin", "/entrar?volver=%2Fadmin"],
    ["/admin/equipo?pagina=2", "/entrar?volver=%2Fadmin%2Fequipo%3Fpagina%3D2"],
    ["/admin/no-existe/tampoco", "/entrar?volver=%2Fadmin%2Fno-existe%2Ftampoco"],
    // Las del segundo factor no son destino: volver a ellas daría vueltas.
    ["/entrar/segundo-factor", "/entrar"],
    ["/entrar/segundo-factor?volver=%2Fadmin", "/entrar"],
    ["/entrar/segundo-factor/configurar", "/entrar"],
  ];
  for (const [path, to] of expected) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(307);
    expect(response.headers().location, path).toBe(to);
    expect(response.headers()["cache-control"], path).toMatch(/no-store/);
  }
  // Y en el navegador se llega a la pantalla de entrar.
  await page.goto("/admin");
  await expect(page).toHaveURL("/entrar?volver=%2Fadmin");
  await expect(page.getByRole("heading", { level: 1, name: "Inicia sesión" })).toBeVisible();
});

test("una alumna recibe en administración y en las pantallas del segundo factor lo mismo que en una ruta que no existe", async ({ page }) => {
  const ana = await person();
  const audited = await auditRows();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");

  // El estado, el título y las cabeceras: nada de eso dice que la ruta sí existe. El título
  // de la página pedida no se asoma: es el de «no encontramos esa página».
  // (El título que va en el documento no se compara aquí: cómo llega el cuerpo de un «no
  // existe» depende de si lo dijo el enrutador o una página. Lo que se ve se compara abajo.)
  const outside = async (path: string) => ({ ...(await seen(await page.request.get(path))), heading: null });
  const missing = await outside("/no-existe");
  expect(missing).toMatchObject({ status: 404, location: null });
  expect(missing.title).toContain(NOT_FOUND);
  for (const path of TEAM_PATHS) expect(await outside(path), path).toEqual(missing);

  // Bajo administración, además, lo que aquí se mira del documento (estado, título,
  // encabezado y cabeceras) es igual exista o no la ruta: las dos contestan desde la misma
  // guarda. El documento entero se compara en el caso de abajo. (Que el prefijo es de
  // administración se sabe: a quien no trae sesión ya lo manda a entrar.)
  const existing = await seen(await page.request.get("/admin"));
  for (const path of [...SECTIONS, "/admin/no-existe/tampoco"]) {
    expect(await seen(await page.request.get(path)), path).toEqual(existing);
  }

  // Y lo que se ve en pantalla es lo mismo, palabra por palabra.
  const visible = async (path: string) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: NOT_FOUND })).toBeVisible();
    return { title: await page.title(), text: await page.locator("main").innerText() };
  };
  const missingScreen = await visible("/no-existe");
  const screens = new Map<string, Awaited<ReturnType<typeof visible>>>();
  for (const path of TEAM_PATHS) screens.set(path, await visible(path));
  for (const [path, screen] of screens) expect(screen.text, path).toBe(missingScreen.text);

  // La pestaña sí queda distinta, y es lo medido: cuando «no existe» lo dice una página, el
  // navegador se queda con el título por omisión del sitio, no con el de esa pantalla. Por
  // eso estas páginas no exportan título: se asomaría justo aquí. Lo exigible se cumple: la
  // pestaña dice lo mismo en una ruta de administración que existe y en una que no, y no
  // dice de qué es la página.
  const tabs = [...screens.values()].map((screen) => screen.title);
  expect(new Set(tabs).size, tabs.join(" | ")).toBe(1);
  expect(tabs[0]).toBe("La Plataforma");

  // Y lo mismo cuando quien pide es el navegador ya dentro de la aplicación, que pide la
  // página por partes: ni el estado ni el cuerpo distinguen una ruta de la otra.
  const partial = async (path: string) => {
    const first = await page.request.get(path, { headers: { RSC: "1" }, maxRedirects: 0 });
    const last = await page.request.get(path, { headers: { RSC: "1" } });
    const body = await last.text();
    return {
      // Una ruta que tiene página contesta primero con una redirección a su forma canónica.
      first: first.status(),
      status: last.status(),
      found: /Administración|Tus capacidades|Escribe tu código|Configura tu segundo factor|Empezar|Prácticas y niveles|Agregar práctica/.test(body),
    };
  };
  expect(await partial("/no-existe")).toMatchObject({ status: 404, found: false });
  // Medido: pedida por partes, una ruta que tiene página no contesta con el mismo estado que
  // una que no la tiene, aunque diga «no existe». Así que el estado no se compara contra
  // `/no-existe`, sino entre rutas de administración: exista o no la ruta, la respuesta es
  // la misma de principio a fin. Y ninguna trae nada de la pantalla pedida.
  const adminPartial = await partial("/admin");
  expect(adminPartial.found).toBe(false);
  for (const path of TEAM_PATHS.filter((each) => each.startsWith("/admin"))) expect(await partial(path), path).toEqual(adminPartial);
  for (const path of TEAM_PATHS) expect((await partial(path)).found, path).toBe(false);

  // La alumna sigue con su sesión, y nada quedó en la auditoría.
  await page.goto("/inicio");
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
  expect(await auditRows()).toBe(audited);
});

// Medido el 2026-10-13, al construir la primera sección (el equipo, PA-86). Con una página
// propia, a una alumna le llegaba el mismo «no existe» a la vista, pero el documento traía
// el árbol de rutas y los fragmentos de esa página: se distinguía del de una ruta que de
// verdad no existe, y hasta el comodín nombraba a su ruta hermana. Por eso las secciones las
// sirve el comodín, y aquí se compara el documento entero, no solo lo que se ve.
test("para una alumna, una sección de administración y una ruta que no existe son el mismo documento, de principio a fin", async ({ page }) => {
  const ana = await person();
  const audited = await auditRows();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");

  const MISSING = "/admin/zzznoexiste";
  /** El cuerpo sin la ruta que se pidió: es lo único que puede cambiar de una a otra. */
  const bare = (body: string, path: string) => body.replaceAll(path, "[ruta]").replaceAll(path.split("/").at(-1) ?? "", "[parte]");
  /** Next numera cada respuesta por partes con identificadores al azar: no dicen nada de la ruta. */
  const steady = (body: string) => body.replaceAll(/"[A-Za-z0-9_-]{22}"/g, '"[id]"');
  /** Las cabeceras que no cambian solas de una petición a otra. */
  const fixed = (response: APIResponse) =>
    Object.fromEntries(Object.entries(response.headers()).filter(([name]) => !["date", "etag", "content-length"].includes(name)));

  for (const SECTION of SECTIONS) {
    // El documento.
    const section = await page.request.get(SECTION);
    const missing = await page.request.get(MISSING);
    expect(section.status(), SECTION).toBe(404);
    expect(fixed(section), SECTION).toEqual(fixed(missing));
    const missingBody = await missing.text();
    expect(bare(await section.text(), SECTION), SECTION).toBe(bare(missingBody, MISSING));
    // Y el de la ruta que no existe no nombra a ninguna sección que sí: ni en su árbol de rutas.
    for (const name of SECTIONS.map((path) => path.split("/").at(-1) ?? "")) expect(missingBody).not.toContain(name);
    expect(missingBody).toContain(NOT_FOUND);

    // La página pedida por partes, como la pide el navegador ya dentro de la aplicación.
    const sectionPart = await page.request.get(SECTION, { headers: { RSC: "1" } });
    const missingPart = await page.request.get(MISSING, { headers: { RSC: "1" } });
    expect(sectionPart.status(), SECTION).toBe(missingPart.status());
    expect(fixed(sectionPart), SECTION).toEqual(fixed(missingPart));
    expect(steady(bare(await sectionPart.text(), SECTION)), SECTION).toBe(steady(bare(await missingPart.text(), MISSING)));
  }

  // Un envío con el nombre de una acción que no existe: con forma de nombre y sin ella.
  // La forma sale de una acción de verdad, la de entrar, que cualquiera puede ver.
  const real = /\$ACTION_ID_([0-9a-f]+)|&quot;id&quot;:&quot;([0-9a-f]+)&quot;/.exec(await (await page.request.get("/recuperar")).text());
  const known = real?.[1] ?? real?.[2] ?? "";
  expect(known.length).toBeGreaterThan(20);
  const invented = known.replaceAll(/[0-9a-f]/g, (digit) => (digit === "0" ? "1" : "0"));
  for (const name of [invented, "no-es-un-nombre"]) {
    const send = (path: string) =>
      page.request.post(path, {
        headers: { "Next-Action": name, Origin: "http://localhost:3000", "Content-Type": "text/plain;charset=UTF-8" },
        data: "[]",
        maxRedirects: 0,
      });
    for (const SECTION of SECTIONS) {
      const toSection = await send(SECTION);
      const toMissing = await send(MISSING);
      expect(toSection.status(), name).toBe(toMissing.status());
      expect(fixed(toSection), name).toEqual(fixed(toMissing));
      expect(bare(await toSection.text(), SECTION), name).toBe(bare(await toMissing.text(), MISSING));
    }
  }

  expect(await auditRows()).toBe(audited);
});

test("quien entra pidiendo administración sin ser del equipo llega a «no encontramos esa página», no a una pantalla de códigos", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana, "/entrar?volver=%2Fadmin");
  await expect(page).toHaveURL("/admin");
  await expect(page.getByRole("heading", { level: 1, name: NOT_FOUND })).toBeVisible();
  await expect(page.getByLabel("Código")).toHaveCount(0);
});

test("con una cookie inventada, una ruta de administración que existe y una que no existe contestan lo mismo", async ({ browser }) => {
  // Una cookie con la forma de las de la aplicación y un token firmado con una clave que
  // nadie conoce: no se puede saber si vale, y «no se supo» no es «sin sesión». Lo que
  // importa es que no sirva para saber qué rutas de administración existen.
  const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const token = [
    b64({ alg: "ES256", kid: "inventada", typ: "JWT" }),
    b64({ sub: "11111111-1111-4111-8111-111111111111", exp: Math.floor(Date.now() / 1000) + 600 }),
    b64("firma"),
  ].join(".");
  const forged = `v1.${token}.${b64("renovacion-inventada")}`;

  /** Lo visto, sin la ruta pedida: si manda a entrar guardando el destino, el destino es el de cada quien. */
  const seenAt = async (context: Awaited<ReturnType<typeof browser.newContext>>, path: string) => {
    const result = await seen(await context.request.get(path, { maxRedirects: 0 }));
    return { ...result, location: result.location?.replace(encodeURIComponent(path), "[ruta]") ?? null };
  };

  const context = await browser.newContext();
  const forge = () => context.addCookies([{ name: SESSION_COOKIE, value: forged, url: "http://localhost:3000" }]);
  try {
    // Primero, unas peticiones que no se miden. Con una clave que no conoce, el servidor
    // vuelve a pedir las claves si hace más de un minuto que las pidió, y entonces sí sabe
    // que el token es inventado: borra la cookie y manda a entrar. Dentro de ese minuto no
    // pregunta otra vez: «no se supo». El paso previo y las páginas llevan cada uno su
    // memoria de claves, así que hace falta una petición por cada uno para dejarlas recién
    // pedidas. Lo que sigue mide siempre ese estado, corra este caso solo o con los demás.
    let response = await context.request.get("/admin", { maxRedirects: 0 });
    for (let warming = 0; warming < 4 && response.status() !== 200; warming += 1) {
      await forge();
      response = await context.request.get("/admin", { maxRedirects: 0 });
    }
    // «No se supo» no es «sin sesión» ni «no es del equipo»: ni manda a entrar, ni dice «no
    // existe». Pinta su aviso, con 200, y no pinta administración.
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain("Algo falló de nuestro lado");
    expect(body).not.toContain("Tus capacidades");

    await forge();
    const existing = await seenAt(context, "/admin");
    for (const path of ["/admin/no-existe", "/admin/no-existe/tampoco", ...SECTIONS]) {
      // La cookie se vuelve a poner: si una respuesta la borrara, la siguiente no mediría lo mismo.
      await forge();
      expect(await seenAt(context, path), path).toEqual(existing);
      await forge();
      expect(await (await context.request.get(path, { maxRedirects: 0 })).text(), path).toContain("Algo falló de nuestro lado");
    }
  } finally {
    await context.close();
  }
});

test("administración y las pantallas del segundo factor no se guardan en caché, tampoco cuando contestan que no existen", async ({ page }) => {
  const ana = await person();
  await signIn(page, ana);
  await expect(page).toHaveURL("/inicio");
  for (const path of TEAM_PATHS) {
    expect((await page.request.get(path)).headers()["cache-control"], path).toMatch(/no-store/);
  }
});
