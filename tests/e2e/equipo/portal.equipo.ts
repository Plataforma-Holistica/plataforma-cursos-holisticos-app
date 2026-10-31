import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { actionFields, postAction } from "../support/actions";
import { a11yViolations } from "../support/a11y";
import { clearCounters, lastMailTo, ownerQuery, person, SESSION_COOKIE, tokenHashIn, type Person } from "../support/stack";

// El portal del maestro (T-402, segunda solicitud), de extremo a extremo: FL-32 (crear un curso, sus
// datos, módulos y lecciones, ordenar, mover, borrar, salir y volver) con JavaScript y sin él, los
// reenvíos sin JavaScript (un «Nuevo curso» doble crea uno solo, un «Subir» reenviado no mueve dos veces,
// un «Borrar» reenviado no falla), el maestro suspendido en solo lectura, y que a una alumna toda ruta
// del portal le contesta lo mismo que una que no existe. Arrastrar llega con la tercera solicitud.
//
// Va con el camino del equipo porque crear y borrar un curso escriben en la auditoría del registro, y
// porque un maestro con cuenta no se puede borrar: `pnpm test:e2e:equipo` rehace la base al terminar.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 120_000 });

const PRACTICE = "Respiración portal e2e";
const LEVEL = "Inicial portal e2e";

/** Hace maestra a esa persona, como el dueño de la base declarado sistema. */
async function makeTeacher(who: Person, status: "active" | "suspended" = "active", noticeAccepted = true): Promise<void> {
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
     select $1, $2::public.teacher_status, case when $3 then now() end, case when $3 then 'prueba' end from declared`,
    [who.id, status, status === "suspended"],
  );
  // Con el aviso del maestro aceptado: sin él, el portal lo manda a aceptarlo (decisión de Sergio del 2026-10-30, T-401).
  if (!noticeAccepted) return;
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_id', $1::text, true) as done)
     insert into public.consents (profile_id, legal_document_id, origin)
     select $1::uuid, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from declared`,
    [who.id],
  );
}

async function signIn(page: Page, who: Person, path: string): Promise<void> {
  await page.goto(`/entrar?volver=${encodeURIComponent(path)}`);
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  // Entrar es lo primero que pide la aplicación recién arrancada: puede tardar más que la espera por omisión.
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

async function noJs(browser: Browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  return { context, page: await context.newPage() };
}

const coursesOf = async (who: Person) =>
  (
    await ownerQuery<{ count: string }>(
      "select count(*) from public.course_registry r join public.teachers t on t.id = r.teacher_id where t.profile_id = $1",
      [who.id],
    )
  )[0]?.count;

/** Abre «Ordenar» de una lección, si está plegado. */
async function openReorder(page: Page, lesson: string): Promise<void> {
  const details = page.locator("details", { has: page.getByText(`Ordenar ${lesson}`, { exact: true }) });
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
}

/** Las lecciones de un módulo, en orden, como las pinta el editor. */
const lessonsIn = (page: Page, module: string) =>
  page.locator("li", { has: page.getByRole("link", { name: new RegExp(`^Módulo \\d+: ${module}$`) }) }).locator("ol > li > span > a");

/**
 * Los campos ocultos del formulario con acción de servidor que trae `needle`: el menú del portal tiene
 * su propio formulario («Cerrar sesión») antes que los de la pantalla.
 */
function fieldsOf(html: string, needle: string): Record<string, string> {
  const forms = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)].map((match) => match[0]).filter((form) => form.includes("$ACTION"));
  const position = forms.findIndex((form) => form.includes(needle));
  if (position < 0) throw new Error(`Ningún formulario trae ${needle}.`);
  return actionFields(html, position);
}

/**
 * Arrastrar con el ratón: los eventos de arrastrar y soltar, con su `DataTransfer`, a la aplicación de verdad.
 * El arrastre nativo de Playwright no es confiable en esta máquina (medido el 2026-10-29: a veces no llega ni un
 * `dragstart`); que el arrastre arranca desde el asa lo midió una sonda ese día. Esto recorre los manejadores, el
 * formulario oculto de la estructura y la base.
 */
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await from.dispatchEvent("dragstart", { dataTransfer });
  await to.dispatchEvent("dragenter", { dataTransfer });
  await to.dispatchEvent("dragover", { dataTransfer });
  await to.dispatchEvent("drop", { dataTransfer });
  await from.dispatchEvent("dragend", { dataTransfer });
}

let created: { teacher: Person; course: string } | null = null;

test.beforeAll(async () => {
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     select private.system_catalog_add('practices', $1), private.system_catalog_add('levels', $2) from declared`,
    [PRACTICE, LEVEL],
  );
});

test("FL-32 con JavaScript: crea un curso, lo llena, ordena, mueve, borra, sale y vuelve", async ({ page }) => {
  const ana = await person();
  await makeTeacher(ana);
  await signIn(page, ana, "/portal/cursos");

  await expect(page.getByText("Todavía no tienes cursos.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("link", { name: "Crear mi primer curso" }).click();
  await page.getByRole("textbox", { name: "Título del curso" }).fill("Respirar en calma");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  const course = page.url().split("/").at(-1) ?? "";
  created = { teacher: ana, course };
  expect(await a11yViolations(page)).toEqual([]);

  // Los datos.
  await page.getByRole("textbox", { name: /Resumen/ }).fill("Para empezar.\nDespacio.");
  await page.getByRole("combobox", { name: /Práctica/ }).selectOption({ label: PRACTICE });
  await page.getByRole("combobox", { name: /Nivel/ }).selectOption({ label: LEVEL });
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText("Guardado.")).toBeVisible();

  // Dos módulos y tres lecciones; lo agregado se abre en el editor.
  for (const title of ["Inicio", "Cierre"]) {
    await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill(title);
    await page.getByRole("button", { name: "Agregar módulo" }).click();
    await expect(page).toHaveURL(/\?modulo=/);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }
  const addLesson = async (module: string, title: string) => {
    const item = page.locator("li", { has: page.getByRole("link", { name: new RegExp(`^Módulo \\d+: ${module}$`) }) });
    await item.getByRole("textbox", { name: "Título de la lección nueva" }).fill(title);
    await item.getByRole("button", { name: "Agregar lección" }).click();
    await expect(page).toHaveURL(/\?leccion=/);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  };
  await addLesson("Inicio", "Una");
  await addLesson("Inicio", "Dos");
  await addLesson("Inicio", "Tres");
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Una", "Dos", "Tres"]);

  // Subir, mover a otro módulo y bajar un módulo. Los controles de cada lección van plegados en «Ordenar».
  await openReorder(page, "Dos");
  await page.getByRole("button", { name: "Subir Dos" }).click();
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Dos", "Una", "Tres"]);
  await openReorder(page, "Tres");
  await page.getByRole("combobox", { name: "Mover Tres a otro módulo" }).selectOption({ label: "Cierre" });
  await page.locator("form", { has: page.getByRole("combobox", { name: "Mover Tres a otro módulo" }) }).getByRole("button", { name: "Mover" }).click();
  await expect(lessonsIn(page, "Cierre")).toHaveText(["Tres"]);
  await page.getByRole("button", { name: "Bajar Inicio" }).click();
  await expect(page.getByRole("link", { name: /^Módulo 1: / })).toHaveAccessibleName("Módulo 1: Cierre");

  // La lección: su descripción, y borrarla con confirmación.
  await page.getByRole("link", { name: "Una", exact: true }).click();
  await page.getByRole("textbox", { name: /Descripción/ }).fill("Qué se hace.");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText("Guardado.")).toBeVisible();
  await page.getByRole("button", { name: "Borrar lección" }).click();
  await expect(page.getByText("Se borra la lección. No se puede deshacer.")).toBeVisible();
  await page.getByRole("button", { name: "Borrar lección" }).click();
  // Borrada, deja los datos del curso, con su ancla: sin JavaScript el navegador no hereda la del bloque que envió.
  await expect(page).toHaveURL(new RegExp(`/portal/cursos/${course}#bloque-editor-datos$`));
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Dos"]);

  // Salir y volver: todo quedó guardado.
  await page.getByRole("link", { name: "Mis cursos" }).first().click();
  await expect(page).toHaveURL("/portal/cursos");
  await expect(page.getByText("Faltan 2 cosas para enviarlo")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("link", { name: "Editar Respirar en calma" }).click();
  await expect(page.getByRole("textbox", { name: /Resumen/ })).toHaveValue("Para empezar.\nDespacio.");
  await expect(lessonsIn(page, "Cierre")).toHaveText(["Tres"]);
});

test("FL-32 sin JavaScript: crear, un «Nuevo curso» reenviado crea uno solo, y un «Subir» reenviado no mueve dos veces", async ({ browser }) => {
  const beto = await person();
  await makeTeacher(beto);
  const { context, page } = await noJs(browser);
  await signIn(page, beto, "/portal/cursos");
  await page.getByRole("link", { name: "Crear mi primer curso" }).click();

  // El mismo formulario dos veces, con el mismo testigo: el segundo devuelve el curso del primero.
  const html = await (await page.request.get("/portal/cursos/nuevo")).text();
  const fields = { ...fieldsOf(html, 'name="token"'), title: "Sin prisa" };
  const first = await postAction(page.request, "/portal/cursos/nuevo", fields);
  const second = await postAction(page.request, "/portal/cursos/nuevo", fields);
  expect(first.status()).toBe(303);
  expect(second.headers().location).toBe(first.headers().location);
  expect(await coursesOf(beto)).toBe("1");

  await page.goto(first.headers().location ?? "/portal/cursos");
  await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill("Inicio");
  await page.getByRole("button", { name: "Agregar módulo" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Inicio" })).toBeVisible();
  for (const title of ["Una", "Dos"]) {
    await page.getByRole("textbox", { name: "Título de la lección nueva" }).fill(title);
    await page.getByRole("button", { name: "Agregar lección" }).click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }

  // «Subir Dos», enviado dos veces con lo mismo: la segunda dice que cambió.
  const editor = page.url();
  const page2 = await (await page.request.get(editor)).text();
  const subir = /value="(lesson-up:[^"]+)"/.exec(page2)?.[1] ?? "";
  expect(subir).not.toBe("");
  await openReorder(page, "Dos");
  await page.getByRole("button", { name: "Subir Dos" }).click();
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Dos", "Una"]);
  const again = await postAction(page.request, editor, { ...fieldsOf(page2, subir), do: subir });
  expect(again.status()).toBe(200);
  expect(await again.text()).toContain("Esto cambió mientras lo veías");
  await page.reload();
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Dos", "Una"]);
  await context.close();
});

test("borrar un curso nunca enviado, con confirmación, y reenviado no falla", async ({ page }) => {
  const caro = await person();
  await makeTeacher(caro);
  await signIn(page, caro, "/portal/cursos/nuevo");
  await page.getByRole("textbox", { name: "Título del curso" }).fill("Para borrar");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  const course = page.url().split("/").at(-1) ?? "";

  await page.goto("/portal/cursos");
  await page.getByRole("link", { name: "Borrar Para borrar" }).click();
  await expect(page.getByText("Se borra «Para borrar» con sus módulos y sus lecciones. No se puede deshacer.")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  const html = await (await page.request.get(`/portal/cursos/${course}/borrar`)).text();
  const confirm = /value="(delete:[^"]+)"/.exec(html)?.[1] ?? "";
  const fields = { ...fieldsOf(html, confirm), do: confirm };
  await page.getByRole("button", { name: "Borrar curso" }).click();
  await expect(page).toHaveURL("/portal/cursos");
  await expect(page.getByText("Borraste el curso.")).toBeVisible();
  expect(await coursesOf(caro)).toBe("0");

  const again = await postAction(page.request, `/portal/cursos/${course}/borrar`, fields);
  expect(again.status()).toBe(303);
  expect(again.headers().location).toBe("/portal/cursos");
});

test("el maestro suspendido ve sus cursos y el editor en solo lectura", async ({ page }) => {
  const dani = await person();
  await makeTeacher(dani);
  await signIn(page, dani, "/portal/cursos/nuevo");
  await page.getByRole("textbox", { name: "Título del curso" }).fill("Mío");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  const course = page.url().split("/").at(-1) ?? "";
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba'
      where profile_id = $1 and (select count(*) from declared) = 1`,
    [dani.id],
  );

  await page.goto("/portal/cursos");
  await expect(page.getByText("Tu cuenta está en solo lectura. Sigues viendo tus números y tus pagos.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Nuevo curso" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Borrar Mío" })).toHaveCount(0);
  await page.getByRole("link", { name: "Ver Mío" }).click();
  await expect(page).toHaveURL(`/portal/cursos/${course}`);
  await expect(page.getByRole("button", { name: "Guardar" })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);
  await page.goto("/portal/cursos/nuevo");
  await expect(page).toHaveURL("/portal/cursos");
});

test("a una alumna, el curso de otro y una ruta que no existe son el mismo documento, también con una cookie inventada", async ({ page, browser }) => {
  expect(created).not.toBeNull();
  const eva = await person();
  await signIn(page, eva, "/inicio");
  const path = `/portal/cursos/${created?.course ?? ""}`;
  const missing = "/portal/zzznoexiste/zzzotro1";
  /** El cuerpo sin la ruta que se pidió: es lo único que puede cambiar de una a otra. */
  const bare = (body: string, asked: string) =>
    asked
      .split("/")
      .slice(2)
      .reduce((done, segment) => done.replaceAll(segment, "[parte]"), body.replaceAll(asked, "[ruta]"));
  const course = await page.request.get(path);
  const nothing = await page.request.get(missing);
  expect(course.status()).toBe(404);
  expect(nothing.status()).toBe(404);
  expect(bare(await course.text(), path)).toBe(bare(await nothing.text(), missing));

  // Una cookie con la forma de las de la aplicación y un token firmado con una clave que nadie conoce:
  // «no se supo» se provoca a voluntad, y no debe servir para saber qué rutas del portal existen (como
  // en tests/e2e/administracion.spec.ts).
  const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const token = [
    b64({ alg: "ES256", kid: "inventada", typ: "JWT" }),
    b64({ sub: "11111111-1111-4111-8111-111111111111", exp: Math.floor(Date.now() / 1000) + 600 }),
    b64("firma"),
  ].join(".");
  const context = await browser.newContext();
  const forge = () => context.addCookies([{ name: SESSION_COOKIE, value: `v1.${token}.${b64("renovacion-inventada")}`, url: "http://localhost:3000" }]);
  try {
    let response = await context.request.get("/portal/cursos", { maxRedirects: 0 });
    for (let warming = 0; warming < 4 && response.status() !== 200; warming += 1) {
      await forge();
      response = await context.request.get("/portal/cursos", { maxRedirects: 0 });
    }
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("Algo falló de nuestro lado");
    for (const asked of [path, missing, "/portal/cursos/nuevo"]) {
      await forge();
      const each = await context.request.get(asked, { maxRedirects: 0 });
      expect(each.status(), asked).toBe(200);
      expect(await each.text(), asked).toContain("Algo falló de nuestro lado");
    }
  } finally {
    await context.close();
  }
});

test("arrastrar: con el teclado y con el ratón; y salir con cambios sin guardar pregunta", async ({ page }) => {
  const gus = await person();
  await makeTeacher(gus);
  await signIn(page, gus, "/portal/cursos/nuevo");
  await page.getByRole("textbox", { name: "Título del curso" }).fill("Para ordenar");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  for (const title of ["Inicio", "Cierre"]) {
    await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill(title);
    await page.getByRole("button", { name: "Agregar módulo" }).click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }
  const inicio = page.locator("li", { has: page.getByRole("link", { name: /^Módulo [0-9]+: Inicio$/ }) });
  for (const title of ["Una", "Dos", "Tres"]) {
    await inicio.getByRole("textbox", { name: "Título de la lección nueva" }).fill(title);
    await inicio.getByRole("button", { name: "Agregar lección" }).click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Una", "Dos", "Tres"]);

  // Con el teclado: Espacio toma, las flechas mueven, Espacio suelta.
  await page.getByRole("button", { name: "Arrastrar Una" }).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(lessonsIn(page, "Inicio")).toHaveText(["Dos", "Tres", "Una"]);
  expect(await a11yViolations(page)).toEqual([]);

  // Con el ratón: una lección sobre otro módulo va al final de ese módulo; un módulo sobre otro toma su lugar.
  await drag(page, page.getByRole("button", { name: "Arrastrar Tres" }), page.getByRole("link", { name: /^Módulo [0-9]+: Cierre$/ }));
  await expect(lessonsIn(page, "Cierre")).toHaveText(["Tres"]);
  await drag(page, page.getByRole("button", { name: "Arrastrar Cierre" }), page.getByRole("link", { name: /^Módulo [0-9]+: Inicio$/ }));
  await expect(page.getByRole("link", { name: /^Módulo 1: / })).toHaveAccessibleName("Módulo 1: Cierre");

  // Salir con algo escrito pregunta; sin nada, no.
  await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill("A medias");
  await expect(page.getByText("Cambios sin guardar")).toBeVisible();
  await page.getByRole("link", { name: "Mis cursos" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Salir sin guardar" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Seguir editando" }).click();
  await expect(page.getByRole("textbox", { name: "Título del módulo nuevo" })).toHaveValue("A medias");
  await page.getByRole("link", { name: "Mis cursos" }).first().click();
  await page.getByRole("dialog", { name: "Salir sin guardar" }).getByRole("button", { name: "Salir sin guardar" }).click();
  await expect(page).toHaveURL("/portal/cursos");
});

// La corrida del equipo es solo de escritorio: este caso pone el ancho de un teléfono (el del Pixel 7 de la
// corrida normal).
test("los recursos: se sube de verdad a la cubeta, se rechaza lo disfrazado, y quitar lo borra", async ({ page }) => {
  const rut = await person();
  await makeTeacher(rut);
  await signIn(page, rut, "/portal/cursos/nuevo");
  await page.getByRole("textbox", { name: "Título del curso" }).fill("Con recursos");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill("Inicio");
  await page.getByRole("button", { name: "Agregar módulo" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Inicio" })).toBeVisible();
  await page.getByRole("textbox", { name: "Título de la lección nueva" }).fill("Una");
  await page.getByRole("button", { name: "Agregar lección" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Una" })).toBeVisible();

  const block = page.getByRole("region", { name: "Recursos de esta lección" });
  await expect(block.getByText("Todavía no hay recursos aquí.")).toBeVisible();

  // Un PDF de verdad: sube directo a la cubeta, y el título por omisión sale del nombre.
  await block.getByLabel("Archivo").setInputFiles({ name: "Guía de respiración.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nun pdf\n%%EOF\n") });
  await expect(block.getByRole("textbox", { name: "Título del recurso" })).toHaveValue("Guía de respiración");
  await block.getByRole("button", { name: "Adjuntar recurso" }).click();
  await expect(block.getByText("Listo: el recurso quedó adjunto.")).toBeVisible({ timeout: 15_000 });
  await expect(block.getByText("Guía de respiración", { exact: true })).toBeVisible();
  await expect(block.getByText("PDF, 1 KB", { exact: true })).toBeVisible();
  const objects = () => ownerQuery<{ name: string }>("select name from storage.objects where bucket_id = 'course-resources' and name like $1", [`%${page.url().split("/cursos/")[1]?.split("?")[0]}%`]);
  expect(await objects()).toHaveLength(1);
  expect(await a11yViolations(page)).toEqual([]);

  // Un ejecutable con nombre de PDF: se rechaza por su contenido, y no se queda ni la fila ni el objeto.
  await block.getByLabel("Archivo").setInputFiles({ name: "disfrazado.pdf", mimeType: "application/pdf", buffer: Buffer.from("MZ esto es un ejecutable") });
  await block.getByRole("button", { name: "Adjuntar recurso" }).click();
  await expect(block.getByText(/no es lo que dice su nombre/)).toBeVisible({ timeout: 15_000 });
  await expect(block.getByText("disfrazado", { exact: true })).toHaveCount(0);
  await expect.poll(objects).toHaveLength(1);

  // Un tipo que no se admite ni siquiera empieza.
  await block.getByLabel("Archivo").setInputFiles({ name: "programa.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await expect(block.getByText(/Ese tipo de archivo no se admite/)).toBeVisible();

  // Quitar pregunta, y se lleva el objeto.
  await block.getByRole("button", { name: "Quitar Guía de respiración" }).click();
  await block.getByRole("button", { name: "Quitar", exact: true }).click();
  await expect(block.getByText("Listo: se quitó.")).toBeVisible({ timeout: 15_000 });
  await expect(block.getByText("Todavía no hay recursos aquí.")).toBeVisible();
  await expect.poll(objects).toHaveLength(0);
});

test("en el teléfono, lo elegido va primero y se vuelve a la estructura", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const fer = await person();
  await makeTeacher(fer);
  await signIn(page, fer, "/portal/cursos/nuevo");
  await page.getByRole("textbox", { name: "Título del curso" }).fill("En el teléfono");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill("Inicio");
  await page.getByRole("button", { name: "Agregar módulo" }).click();
  await expect(page).toHaveURL(/\?modulo=/);
  await page.getByRole("textbox", { name: "Título de la lección nueva" }).fill("Una");
  await page.getByRole("button", { name: "Agregar lección" }).click();
  await expect(page).toHaveURL(/\?leccion=/);
  await expect(page.getByRole("heading", { level: 2, name: "Una" })).toBeInViewport();
  await page.getByRole("link", { name: "Volver a la estructura" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Estructura del curso" })).toBeInViewport();
  expect(await a11yViolations(page)).toEqual([]);
});

// La invitación del maestro (T-401, PA-40, FL-30): sin correo propio ni enlace con token. Quien invita le avisa por
// fuera; la persona prueba su buzón recuperando su contraseña en ese navegador, entra, y acepta el contrato y el aviso.

const NEW_PASSWORD = "Una-contraseña-nueva-del-maestro-9";

/** Un maestro cargado por el sistema, con su invitación al correo de esa persona, como el dueño de la base. */
async function inviteTeacher(who: Person): Promise<void> {
  const slug = `invitada-${who.id.slice(0, 8)}`;
  const [row] = await ownerQuery<{ id: string }>(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     select private.system_add_teacher('Maestra Invitada', $1, null)::text as id from declared`,
    [slug],
  );
  const [answered] = await ownerQuery<{ answer: string }>(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     select private.system_invite_teacher($1::uuid, $2) as answer from declared`,
    [row?.id, who.email],
  );
  expect(answered?.answer).toBe("invited_existing");
}

async function enter(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/** Recupera la contraseña en este navegador: deja el resguardo del buzón. */
async function recoverHere(page: Page, email: string): Promise<void> {
  await page.goto("/recuperar");
  await page.getByLabel("Correo").fill(email);
  await page.getByRole("button", { name: "Mandarme el enlace" }).click();
  await expect(page.getByText(/Si ese correo tiene cuenta, te mandamos un enlace\./)).toBeVisible();
  await page.goto(`/recuperar/${tokenHashIn(await lastMailTo(email), "recuperar")}`);
  await page.getByLabel("Contraseña nueva").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Guardar contraseña" }).click();
  await expect(page).toHaveURL("/entrar");
}

const consentsOf = async (who: Person) =>
  (
    await ownerQuery<{ type: string }>(
      `select d.doc_type::text as type from public.consents c join public.legal_documents d on d.id = c.legal_document_id
       where c.profile_id = $1 and d.doc_type in ('teacher_agreement', 'teacher_privacy_notice') order by 1`,
      [who.id],
    )
  ).map((row) => row.type);

test("invitada con cuenta: se le pide probar su buzón, recupera su contraseña, acepta los dos textos y llega al portal", async ({ page }) => {
  const ana = await person();
  await inviteTeacher(ana);

  await enter(page, ana.email, ana.password);
  await expect(page).toHaveURL("/portal/invitacion");
  await expect(page.getByRole("heading", { level: 1, name: "Confirma tu correo para seguir" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Aceptar y entrar" })).toHaveCount(0);
  expect(await a11yViolations(page)).toEqual([]);
  // A una invitada, toda ruta del portal la lleva a su invitación. Y no queda encerrada.
  await page.goto("/portal/cursos");
  await expect(page).toHaveURL("/portal/invitacion");
  await page.getByRole("link", { name: "Ir a mi inicio" }).click();
  await expect(page).toHaveURL("/inicio");

  await recoverHere(page, ana.email);
  await enter(page, ana.email, NEW_PASSWORD);
  await expect(page).toHaveURL("/portal/invitacion");
  await expect(page.getByRole("heading", { level: 1, name: "Maestra Invitada, te invitamos a dar clases" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Sin marcar no acepta, y lo dice junto a cada casilla.
  await page.getByRole("button", { name: "Aceptar y entrar" }).click();
  await expect(page.getByRole("link", { name: "Falta aceptar el contrato." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Falta aceptar el aviso de privacidad." })).toBeVisible();
  expect(await consentsOf(ana)).toEqual([]);

  await page.getByLabel("He leído y acepto el contrato.").check();
  await page.getByLabel("He leído y acepto el aviso de privacidad.").check();
  await page.getByRole("button", { name: "Aceptar y entrar" }).click();
  await expect(page).toHaveURL("/portal");
  await expect(page.getByText(/Ya eres /)).toBeVisible();
  expect(await consentsOf(ana)).toEqual(["teacher_agreement", "teacher_privacy_notice"]);
  expect(await a11yViolations(page)).toEqual([]);

  // Sirvió una vez: ya no hay invitación que ver.
  await page.goto("/portal/invitacion");
  await expect(page).toHaveURL("/portal");
  await page.getByRole("link", { name: "Ir a mis cursos" }).click();
  await expect(page).toHaveURL("/portal/cursos");
});

test("sin JavaScript también se acepta", async ({ browser }) => {
  const beto = await person();
  await inviteTeacher(beto);
  const { context, page } = await noJs(browser);
  try {
    await recoverHere(page, beto.email);
    await enter(page, beto.email, NEW_PASSWORD);
    await expect(page).toHaveURL("/portal/invitacion");
    await page.getByRole("button", { name: "Aceptar y entrar" }).click();
    await expect(page.getByRole("link", { name: "Falta aceptar el contrato." })).toBeVisible();
    await page.getByLabel("He leído y acepto el contrato.").check();
    await page.getByLabel("He leído y acepto el aviso de privacidad.").check();
    await page.getByRole("button", { name: "Aceptar y entrar" }).click();
    await expect(page).toHaveURL("/portal");
    expect(await consentsOf(beto)).toEqual(["teacher_agreement", "teacher_privacy_notice"]);
  } finally {
    await context.close();
  }
});

for (const withJs of [true, false]) {
  test(`si la invitación se va con la pantalla abierta, lo dice su inicio y no anota nada (${withJs ? "con" : "sin"} JavaScript)`, async ({ browser }) => {
    const gala = await person();
    await inviteTeacher(gala);
    const { context, page } = withJs ? await (async () => { const context = await browser.newContext(); return { context, page: await context.newPage() }; })() : await noJs(browser);
    try {
      await recoverHere(page, gala.email);
      await enter(page, gala.email, NEW_PASSWORD);
      await expect(page).toHaveURL("/portal/invitacion");
      await page.getByLabel("He leído y acepto el contrato.").check();
      await page.getByLabel("He leído y acepto el aviso de privacidad.").check();
      await ownerQuery(
        `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
         update private.teacher_invitations set revoked_at = now() from declared where email = lower($1)`,
        [gala.email],
      );
      await page.getByRole("button", { name: "Aceptar y entrar" }).click();
      await expect(page).toHaveURL("/inicio");
      await expect(page.getByText(/Esa invitación ya no sirve/)).toBeVisible();
      expect(await consentsOf(gala)).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("la prueba del buzón hecha en otro navegador no sirve", async ({ page, browser }) => {
  const caro = await person();
  await inviteTeacher(caro);
  const other = await browser.newContext();
  try {
    await recoverHere(await other.newPage(), caro.email);
  } finally {
    await other.close();
  }
  await enter(page, caro.email, NEW_PASSWORD);
  await expect(page).toHaveURL("/portal/invitacion");
  await expect(page.getByRole("heading", { level: 1, name: "Confirma tu correo para seguir" })).toBeVisible();
});

test("a una alumna, la invitación le contesta lo mismo que una ruta que no existe", async ({ page }) => {
  const dani = await person();
  await signIn(page, dani, "/inicio");
  const invitation = await page.goto("/portal/invitacion");
  const missing = await page.goto("/portal/esto-no-existe");
  expect(invitation?.status()).toBe(404);
  expect(missing?.status()).toBe(404);
  expect((await page.goto("/portal/aviso"))?.status()).toBe(404);
  expect((await page.goto("/portal"))?.status()).toBe(404);
});

test("un maestro al que le falta el aviso va al aviso desde cualquier ruta, lo acepta y vuelve a donde iba", async ({ page }) => {
  const eli = await person();
  await makeTeacher(eli, "active", false);
  await enter(page, eli.email, eli.password);
  await expect(page).toHaveURL("/portal/aviso");
  await page.goto("/portal/cursos");
  await expect(page).toHaveURL("/portal/aviso?volver=%2Fportal%2Fcursos");
  await expect(page.getByRole("heading", { level: 1, name: "Actualizamos el aviso de privacidad" })).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Aceptar" }).click();
  await expect(page.getByRole("link", { name: "Falta aceptar el aviso de privacidad." })).toBeVisible();
  await page.getByLabel("He leído y acepto el aviso de privacidad.").check();
  await page.getByRole("button", { name: "Aceptar" }).click();
  await expect(page).toHaveURL("/portal/cursos");
  expect(await consentsOf(eli)).toEqual(["teacher_privacy_notice"]);
});

test("un maestro suspendido ve en su portal el texto escrito para él, nunca el motivo interno, y no se le pide el aviso", async ({ page }) => {
  const fer = await person();
  await makeTeacher(fer, "suspended", false);
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     update public.teachers set suspension_reason = 'Motivo interno de la prueba', suspension_notice = 'Tu cuenta está en pausa mientras revisamos un caso.'
     from declared where profile_id = $1`,
    [fer.id],
  );
  await enter(page, fer.email, fer.password);
  await expect(page).toHaveURL("/portal");
  await expect(page.getByText("Tu cuenta está en pausa mientras revisamos un caso.")).toBeVisible();
  await expect(page.getByText("Motivo interno de la prueba")).toHaveCount(0);
  expect(await page.content()).not.toContain("Motivo interno de la prueba");
  expect(await a11yViolations(page)).toEqual([]);
});
