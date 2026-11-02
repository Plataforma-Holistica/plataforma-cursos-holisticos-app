import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page, type Route } from "@playwright/test";

import { a11yViolations } from "../support/a11y";
import { clearCounters, ownerQuery, person, type Person } from "../support/stack";

// Subir el video de una lección (T-403, segunda solicitud; RF-604, FL-33), en un navegador de verdad y contra el Storage local: lo que
// el criterio del 06 pide y la integración 92 no ve. Cortar la red y reanudar, recargar y elegir el mismo archivo, seguir mientras se
// cambia de lección, salir pregunta, y dos pestañas con el mismo archivo.
//
// Storage local es más rápido que cualquier espera: los trozos se detienen a mano (`hold`), para mirar la pantalla a media subida.
//
// Va con el camino del equipo porque un maestro con cuenta no se puede borrar: `pnpm test:e2e:equipo` rehace la base al terminar.

test.beforeEach(clearCounters);
test.describe.configure({ mode: "serial", timeout: 180_000 });

const MB = 1024 * 1024;
const VIDEOS = "**/storage/v1/upload/resumable/sign/**";

function atom(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
function mvhd(timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(100);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return atom("mvhd", body);
}
const ftyp = atom("ftyp", Buffer.from("isom", "latin1"), Buffer.alloc(4), Buffer.from("isommp42", "latin1"));
/** Tres trozos de 6 MB, con el índice al final. */
const videoOf = (seconds: number) => Buffer.concat([ftyp, atom("mdat", Buffer.alloc(13 * MB)), atom("moov", mvhd(1000, seconds * 1000))]);
const fileOf = (name: string, seconds: number) => ({ name, mimeType: "video/mp4", buffer: videoOf(seconds) });
/**
 * El mismo archivo en el disco, para reanudar: lo que se le pasa a Playwright como bytes nace con otra fecha cada vez, y la huella de
 * TUS la lleva, porque otro archivo con el mismo nombre y tamaño no debe seguir donde iba el primero.
 */
const onDisk = (name: string, seconds: number) => {
  const path = join(folder, name);
  writeFileSync(path, videoOf(seconds));
  return path;
};

async function makeTeacher(who: Person): Promise<void> {
  await ownerQuery(
    `with declared as materialized (select set_config('app.actor_kind', 'system', true) as done)
     insert into public.teachers (profile_id, status) select $1, 'active'::public.teacher_status from declared`,
    [who.id],
  );
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
  await expect(page).toHaveURL(path, { timeout: 15_000 });
}

/** Deja pasar `free` trozos, y detiene los demás hasta `open()`. Anota desde dónde empieza cada uno. */
async function hold(page: Page, free: number) {
  const waiting: Route[] = [];
  const offsets: number[] = [];
  let passed = 0;
  let closed = true;
  await page.route(VIDEOS, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.continue();
    offsets.push(Number(request.headers()["upload-offset"]));
    if (closed && passed >= free) {
      waiting.push(route);
      return undefined;
    }
    passed += 1;
    return route.continue();
  });
  return {
    offsets,
    held: () => waiting.length,
    open: async () => {
      closed = false;
      for (const route of waiting.splice(0)) await route.continue().catch(() => undefined);
    },
    /** Quita la intercepción, con lo que quedó detenido fallando como un corte. */
    stop: async () => {
      closed = false;
      for (const route of waiting.splice(0)) await route.abort("connectionreset").catch(() => undefined);
      await page.unroute(VIDEOS);
    },
  };
}

const rowsOf = (lessonTitle: string) =>
  ownerQuery<{ state: string; file_name: string; read_seconds: number | null; storage_path: string }>(
    `select v.state, v.file_name, v.read_seconds, v.storage_path from public.draft_videos v join public.draft_lessons l on l.id = v.lesson_id where l.title = $1`,
    [lessonTitle],
  );
const objectsAt = (path: string) => ownerQuery("select name from storage.objects where bucket_id = 'video-originals' and name = $1", [path]);

const block = (page: Page) => page.locator("section", { has: page.getByRole("heading", { level: 3, name: "Video de la lección" }) }).last();
const lessonLink = (page: Page, title: string) => page.getByRole("link", { name: new RegExp(`${title}$`) }).first();

const folder = mkdtempSync(join(tmpdir(), "videos-e2e-"));
test.afterAll(() => rmSync(folder, { recursive: true, force: true }));

let teacher: Person;
let editor = "";

test.beforeAll(async () => {
  teacher = await person();
  await makeTeacher(teacher);
});

test("preparar: un curso con cuatro lecciones", async ({ page }) => {
  await signIn(page, teacher, "/portal/cursos");
  await page.getByRole("link", { name: "Crear mi primer curso" }).click();
  await page.getByRole("textbox", { name: "Título del curso" }).fill("Con videos");
  await page.getByRole("button", { name: "Crear curso" }).click();
  await expect(page).toHaveURL(/\/portal\/cursos\/[0-9a-f-]{36}$/);
  editor = new URL(page.url()).pathname;
  await page.getByRole("textbox", { name: "Título del módulo nuevo" }).fill("Inicio");
  await page.getByRole("button", { name: "Agregar módulo" }).click();
  await expect(page).toHaveURL(/\?modulo=/);
  for (const title of ["Corte", "Recarga", "Pestañas", "Cancelar"]) {
    await page.getByRole("textbox", { name: "Título de la lección nueva" }).first().fill(title);
    await page.getByRole("button", { name: "Agregar lección" }).first().click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }
});

test("sube mientras se cambia de lección y se guarda; se corta la red y se reanuda donde iba", async ({ page, context }) => {
  await signIn(page, teacher, editor);
  await lessonLink(page, "Corte").click();
  const video = block(page);
  await expect(video.getByText("Elige el video")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Lo que no se admite ni siquiera empieza.
  await video.getByLabel("Elige el video").setInputFiles({ name: "clase.mkv", mimeType: "video/x-matroska", buffer: Buffer.from("x") });
  await expect(video.getByText(/Ese tipo de archivo no se admite/)).toBeVisible();
  expect(await rowsOf("Corte")).toEqual([]);

  const gate = await hold(page, 1);
  await video.getByLabel("Elige el video").setInputFiles(fileOf("clase-corte.mp4", 125));
  await expect.poll(gate.held, { timeout: 15_000 }).toBe(1);
  await expect(video.getByText(/Subiendo: \d+ %/).first()).toBeVisible();
  await expect(page.getByText("Subiendo un video")).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Otra lección: no pregunta, la subida sigue, y ahí se puede guardar.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await lessonLink(page, "Recarga").click();
  await expect(page.getByRole("heading", { level: 2, name: "Recarga" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Descripción" }).fill("Escrita a media subida.");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByText(/Guardado/).first()).toBeVisible();

  // Salir del editor sí pregunta.
  await page.getByRole("link", { name: "Mis cursos" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("La subida se detiene.");
  await page.getByRole("button", { name: "Seguir editando" }).click();
  await lessonLink(page, "Corte").click();
  await expect(video.getByText(/Subiendo: \d+ %/).first()).toBeVisible();

  // Se va la red: se dice, y lo que subió no se pierde.
  await context.setOffline(true);
  await gate.stop();
  await expect(video.getByText(/La subida se interrumpió/)).toBeVisible({ timeout: 45_000 });
  expect(await a11yViolations(page)).toEqual([]);
  await context.setOffline(false);

  // Reanudar sigue donde iba, sin volver a mandar lo que Storage tiene.
  const after = await hold(page, 99);
  await video.getByRole("button", { name: "Reanudar" }).click();
  await expect(video.getByText("Listo: recibimos tu video.")).toBeVisible({ timeout: 30_000 });
  expect(after.offsets[0]).toBeGreaterThanOrEqual(6 * MB);
  await page.unroute(VIDEOS);

  await expect(video.getByText("clase-corte.mp4", { exact: true })).toBeVisible();
  await expect(video.getByText(/Recibido, 13 MB\. Falta procesarlo\./)).toBeVisible();
  await expect(page.getByText("Subiendo un video")).toHaveCount(0);
  const [row] = await rowsOf("Corte");
  expect(row).toMatchObject({ state: "uploaded", file_name: "clase-corte.mp4", read_seconds: 125 });
  expect(await objectsAt(row?.storage_path ?? "")).toHaveLength(1);
  expect(dialogs).toEqual([]);
  expect(await a11yViolations(page)).toEqual([]);

  // Ya recibido no se ofrece otro sin quitarlo, y sigue ahí al recargar.
  await page.reload();
  await expect(video.getByText(/Recibido, 13 MB/)).toBeVisible();
  await expect(video.getByLabel(/Elige/)).toHaveCount(0);
});

test("pausar y seguir, con el foco en el mismo botón", async ({ page }) => {
  await signIn(page, teacher, editor);
  await lessonLink(page, "Cancelar").click();
  const video = block(page);
  const gate = await hold(page, 1);
  await video.getByLabel("Elige el video").setInputFiles(fileOf("clase-pausa.mp4", 60));
  await expect.poll(gate.held, { timeout: 15_000 }).toBe(1);
  await video.getByRole("button", { name: "Pausar" }).click();
  await expect(video.getByRole("button", { name: "Reanudar" })).toBeFocused();
  await expect(video.getByText(/En pausa: \d+ %/)).toBeVisible();

  // Cancelar pregunta, y seguir no toca nada.
  await video.getByRole("button", { name: "Cancelar subida" }).click();
  await expect(video.getByText(/¿Cancelar la subida de «clase-pausa\.mp4»\?/)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await video.getByRole("button", { name: "Seguir con la subida" }).click();
  expect(await rowsOf("Cancelar")).toHaveLength(1);

  // Cancelar de verdad: la fila se va a la papelera, y vuelve a poder elegir.
  await video.getByRole("button", { name: "Cancelar subida" }).click();
  await video.getByRole("button", { name: "Cancelar subida" }).last().click();
  await expect(video.getByLabel("Elige el video")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => rowsOf("Cancelar")).toEqual([]);
  await page.unroute(VIDEOS);
  await expect(page.getByText("Subiendo un video")).toHaveCount(0);
});

test("recargar a media subida: pide el mismo archivo, otro no, y sigue donde iba", async ({ page }) => {
  await signIn(page, teacher, editor);
  await lessonLink(page, "Recarga").click();
  const video = block(page);
  const gate = await hold(page, 1);
  const same = onDisk("clase-recarga.mp4", 90);
  await video.getByLabel("Elige el video").setInputFiles(same);
  await expect.poll(gate.held, { timeout: 15_000 }).toBe(1);

  // Recargar lleva el aviso del navegador.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await gate.stop();
  await page.reload();
  expect(dialogs).toEqual(["beforeunload"]);

  await expect(video.getByText(/Quedó una subida a medias de «clase-recarga\.mp4»/)).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);

  // Otro archivo no se confunde con este.
  await video.getByLabel(/Elige el mismo archivo/).setInputFiles(fileOf("otra-cosa.mp4", 90));
  await expect(video.getByText(/Ese no es el archivo que estaba subiendo\. Elige «clase-recarga\.mp4»/)).toBeVisible({ timeout: 15_000 });

  // El mismo sigue donde iba.
  const after = await hold(page, 99);
  await video.getByLabel(/Elige el mismo archivo/).setInputFiles(same);
  await expect(video.getByText("Listo: recibimos tu video.")).toBeVisible({ timeout: 30_000 });
  expect(after.offsets[0]).toBeGreaterThanOrEqual(6 * MB);
  await page.unroute(VIDEOS);
  expect(await rowsOf("Recarga")).toMatchObject([{ state: "uploaded", read_seconds: 90 }]);
});

test("el mismo video en dos pestañas: una sube, la otra lo dice y no toca nada", async ({ page, context }) => {
  await signIn(page, teacher, editor);
  await lessonLink(page, "Pestañas").click();
  const video = block(page);
  const gate = await hold(page, 1);
  await video.getByLabel("Elige el video").setInputFiles(fileOf("clase-pestanas.mp4", 45));
  await expect.poll(gate.held, { timeout: 15_000 }).toBe(1);

  const other = await context.newPage();
  await other.goto(page.url());
  const there = block(other);
  await there.getByLabel(/Elige el mismo archivo/).setInputFiles(fileOf("clase-pestanas.mp4", 45));
  await expect(there.getByText(/Este video ya se está subiendo en otra pestaña/)).toBeVisible({ timeout: 15_000 });
  await other.close();

  await gate.open();
  await expect(video.getByText("Listo: recibimos tu video.")).toBeVisible({ timeout: 30_000 });
  await page.unroute(VIDEOS);
  expect(await rowsOf("Pestañas")).toMatchObject([{ state: "uploaded", read_seconds: 45 }]);

  // Quitar lo recibido pregunta, y vuelve a poder elegir.
  await video.getByRole("button", { name: "Quitar video" }).click();
  await expect(video.getByText(/¿Quitar «clase-pestanas\.mp4»\?/)).toBeVisible();
  await video.getByRole("button", { name: "Quitar video" }).last().click();
  await expect(video.getByLabel("Elige el video")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => rowsOf("Pestañas")).toEqual([]);
});

test("lo que no es un video se rechaza por su contenido, sin que quede nada", async ({ page }) => {
  await signIn(page, teacher, editor);
  await lessonLink(page, "Pestañas").click();
  const video = block(page);
  await video.getByLabel("Elige el video").setInputFiles({ name: "disfrazado.mp4", mimeType: "video/mp4", buffer: Buffer.from("MZ esto es un ejecutable, con un nombre que no le toca") });
  await expect(video.getByText(/no es un MP4 o un MOV/)).toBeVisible({ timeout: 15_000 });
  await expect(video.getByLabel("Elige el video")).toBeVisible();
  expect(await rowsOf("Pestañas")).toEqual([]);
});
