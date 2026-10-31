// Carga en la base LOCAL los cursos de prueba (T-107; decisión de Sergio del 2026-10-14):
// sus prácticas y niveles, dos maestros ficticios y dos cursos, con videos del proveedor de
// prueba. Los cursos quedan por aprobar, sin listar: los aprueba alguien con Contenido.
//
// No es una semilla, y a propósito: `supabase/seeds/` viaja con cualquier siembra, también a
// una base remota. Este guion solo corre contra la base local (`pnpm db:courses`), como el de
// los borradores legales. Escribe como el dueño de la base declarado sistema, con el ajuste
// que la base exige para un video de prueba. Deja renglones en la auditoría: después,
// `pnpm db:reset` antes de `pnpm test:db`.
//
// Los datos viven en `supabase/local/test-courses.json`. El guion no ejecuta SQL que venga
// de un archivo: llama a funciones fijas con los datos como parámetros. Correrlo dos veces no
// duplica nada.
//
// Desde T-404 cada curso lleva además dos recursos publicados, uno del curso y otro de su primera
// lección, con un PDF mínimo que sube a la cubeta local. Lo publicado lo escribe el sistema: el
// camino del maestro llega con T-405.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DATA_FILE = join("supabase", "local", "test-courses.json");
// Los videos que ya subió `pnpm media:upload-test` (T-108): fuera de git. Una lección cuyo
// archivo esté aquí se carga con video de Mux; las demás, con el proveedor de prueba.
const VIDEOS_FILE = join("supabase", "local", "test-videos.json");
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function fail(message) {
  console.error(`db:courses: ${message}`);
  process.exit(1);
}

const TEST_PDF = Buffer.from("%PDF-1.7\nUn recurso de prueba.\n%%EOF\n", "latin1");

// Lo que ya está en el entorno gana sobre el archivo: así la integración continua pasa
// sus propios valores.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

if (process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en Vercel: los cursos de prueba solo existen en una base local.");
}

const raw = process.env.DATABASE_URL_DIRECT;
if (!raw) fail("falta DATABASE_URL_DIRECT. Mira .env.example.");
let url;
try {
  url = new URL(raw);
} catch {
  fail("DATABASE_URL_DIRECT no es una URL.");
}
if (!LOCAL_HOSTS.has(url.hostname)) {
  fail("DATABASE_URL_DIRECT no apunta a la base local. Este guion solo corre contra 127.0.0.1 o localhost.");
}
// `pg` deja que los parámetros de la cadena manden sobre lo demás: con `?host=` este guion
// pasaría por local y escribiría en una base remota.
if ([...url.searchParams.keys()].length > 0) {
  fail("DATABASE_URL_DIRECT no puede traer parámetros.");
}
// Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene un
// usuario y una contraseña de fábrica que ninguna base remota tiene.
if (decodeURIComponent(url.username) !== "postgres" || decodeURIComponent(url.password) !== "postgres") {
  fail("DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.");
}
// Los recursos suben a Storage: también tiene que ser el local.
const storageRoot = process.env.NEXT_PUBLIC_SUPABASE_URL;
const storageKey = process.env.SUPABASE_SECRET_KEY;
if (!storageRoot || !storageKey) fail("faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY. Mira .env.example.");
try {
  if (!LOCAL_HOSTS.has(new URL(storageRoot).hostname)) fail("NEXT_PUBLIC_SUPABASE_URL no apunta al Storage local.");
} catch {
  fail("NEXT_PUBLIC_SUPABASE_URL no es una URL.");
}

/** Los datos, revisados antes de tocar la base. Lo que no tiene la forma esperada detiene todo. */
function readData() {
  if (!existsSync(DATA_FILE)) fail(`no existe ${DATA_FILE}.`);
  let data;
  try {
    data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    fail(`${DATA_FILE} no es JSON.`);
  }
  const texts = (value) => Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === "string" && each.trim() !== "");
  if (!texts(data.practices) || !texts(data.levels)) fail("las prácticas y los niveles son listas de nombres.");
  if (!Array.isArray(data.teachers) || !Array.isArray(data.courses) || data.courses.length === 0) {
    fail("faltan los maestros o los cursos.");
  }
  const teachers = new Set();
  for (const teacher of data.teachers) {
    if (!SLUG.test(teacher.slug ?? "") || typeof teacher.name !== "string" || teacher.name.trim() === "") {
      fail(`un maestro sin slug o sin nombre: ${JSON.stringify(teacher)}`);
    }
    teachers.add(teacher.slug);
  }
  for (const course of data.courses) {
    if (!teachers.has(course.teacher)) fail(`${course.slug}: su maestro no está en la lista.`);
    for (const part of course.modules ?? []) {
      for (const lesson of part.lessons ?? []) {
        if (!Number.isInteger(lesson.duration_seconds) || lesson.duration_seconds <= 0 || typeof lesson.file !== "string") {
          fail(`${course.slug}: «${lesson.title}» necesita su archivo y su duración en segundos enteros.`);
        }
      }
    }
  }
  return data;
}

/** Los videos de Mux por archivo, revisados. Vacío si todavía no se subió ninguno. */
function readVideos() {
  if (!existsSync(VIDEOS_FILE)) return new Map();
  let raw;
  try {
    raw = JSON.parse(readFileSync(VIDEOS_FILE, "utf8"));
  } catch {
    fail(`${VIDEOS_FILE} no es JSON.`);
  }
  const videos = new Map();
  for (const [file, video] of Object.entries(raw ?? {})) {
    const id = /^[A-Za-z0-9]{10,100}$/;
    if (!id.test(video?.asset_id ?? "") || !id.test(video?.playback_id ?? "") || !Number.isInteger(video?.duration_seconds) || video.duration_seconds <= 0) {
      fail(`${VIDEOS_FILE}: «${file}» no tiene la forma que deja media:upload-test.`);
    }
    videos.set(file, video);
  }
  return videos;
}

/** El curso en la forma que espera `private.system_load_course()`, con el video de cada lección. */
function courseOf(course) {
  // Los videos se numeran en todo el curso: por módulo, dos módulos repetirían identificador.
  let number = 0;
  return {
    slug: course.slug,
    title: course.title,
    summary: course.summary,
    practice: course.practice,
    level: course.level,
    modules: course.modules.map((part) => ({
      title: part.title,
      lessons: part.lessons.map((lesson) => ({
        title: lesson.title,
        video: {
          ...videoOf(course, lesson, (number += 1)),
        },
      })),
    })),
  };
}

const data = readData();
const videos = readVideos();

// Un video de Mux es de una sola lección (la base no repite un asset): desde T-210 varios cursos
// de prueba repiten archivo, y solo la primera lección que lo usa, en el orden del archivo, lo
// lleva de Mux. Las demás, de prueba.
const muxLesson = new Map();
for (const course of data.courses) {
  for (const part of course.modules) {
    for (const lesson of part.lessons) {
      if (videos.has(lesson.file) && !muxLesson.has(lesson.file)) muxLesson.set(lesson.file, lesson);
    }
  }
}

/** El video de una lección: el de Mux si ya se subió su archivo y es la lección que lo lleva, si no el de prueba. */
function videoOf(course, lesson, number) {
  const mux = muxLesson.get(lesson.file) === lesson ? videos.get(lesson.file) : undefined;
  if (mux) return { provider: "mux", asset_id: mux.asset_id, playback_id: mux.playback_id, duration_seconds: mux.duration_seconds };
  return { provider: "test", asset_id: `${course.slug}-video-${number}`, playback_id: `prueba:${lesson.file}`, duration_seconds: lesson.duration_seconds };
}

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: url.hostname.replace(/^\[|\]$/g, ""),
  port: url.port === "" ? 5432 : Number(url.port),
  user: "postgres",
  password: "postgres",
  database: decodeURIComponent(url.pathname.replace(/^\//, "")),
});

/** Publica un recurso de prueba, si ese lugar no tiene ya uno: sube el objeto y lo escribe con lo que Storage guardó. */
async function publishTestResource(courseId, teacherId, lessonId, title) {
  const { rows: existing } = await client.query(
    "select 1 from public.published_resources where course_id = $1::uuid and lesson_id is not distinct from $2::uuid and is_current",
    [courseId, lessonId],
  );
  if (existing.length > 0) return;
  const path = `${teacherId}/${courseId}/${randomUUID()}`;
  const response = await fetch(`${storageRoot.replace(/\/+$/, "")}/storage/v1/object/course-resources/${path}`, {
    method: "POST",
    headers: { apikey: storageKey, authorization: `Bearer ${storageKey}`, "content-type": "application/pdf" },
    body: new Uint8Array(TEST_PDF),
  });
  if (!response.ok) throw new Error(`Storage contestó ${response.status} al subir un recurso de prueba`);
  await client.query(
    `insert into public.published_resources (course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
     select $1::uuid, $2::uuid, $3::uuid, $4, 'pdf', 'application/pdf', o.name, o.id, o.version, (o.metadata ->> 'size')::bigint, 1
       from storage.objects o where o.bucket_id = 'course-resources' and o.name = $5`,
    [courseId, teacherId, lessonId, title, path],
  );
}

const loaded = [];
try {
  await client.connect();
  await client.query("begin");
  // Lo carga el sistema, no una persona: queda así en la auditoría.
  await client.query("select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)");
  for (const [list, names] of [
    ["practices", data.practices],
    ["levels", data.levels],
  ]) {
    for (const name of names) {
      const { rows } = await client.query("select private.system_catalog_add($1::text::public.catalog_list, $2::text) ->> 'answer' as answer", [
        list,
        name,
      ]);
      const answer = rows[0]?.answer;
      // Una desactivada con ese nombre no se reactiva sola: que lo decida alguien en PA-67.
      if (answer !== "added" && answer !== "duplicate") fail(`${list}: «${name}» contestó ${answer}.`);
    }
  }
  const teacherIds = new Map();
  for (const teacher of data.teachers) {
    const { rows } = await client.query("select private.system_add_teacher($1, $2, $3) as id", [teacher.name, teacher.slug, teacher.bio ?? null]);
    teacherIds.set(teacher.slug, rows[0]?.id);
  }
  for (const course of data.courses) {
    const { rows } = await client.query("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [
      teacherIds.get(course.teacher),
      JSON.stringify(courseOf(course)),
    ]);
    const answer = rows[0]?.answer;
    if (answer !== "loaded" && answer !== "already_loaded") fail(`${course.slug} contestó ${answer}.`);
    // Lo publicado no se edita: si ya estaba con otros videos (de prueba y ahora hay de Mux,
    // o un video de Mux que se volvió a subir), no se cambia en silencio.
    if (answer === "already_loaded") {
      const expected = courseOf(course).modules.flatMap((part) => part.lessons.map((lesson) => `${lesson.video.provider}:${lesson.video.asset_id}`));
      const { rows: stored } = await client.query(
        `select v.provider || ':' || v.provider_asset_id as video from public.published_lessons l
         join public.published_courses c on c.course_id = l.course_id
         join public.video_assets v on v.id = l.video_asset_id
         where c.slug = $1 order by l.position`,
        [course.slug],
      );
      if (stored.map((row) => row.video).join() !== expected.join()) {
        fail(`${course.slug} ya está cargado con otros videos. Para cargarlo con los de ${VIDEOS_FILE}: pnpm db:reset && pnpm db:courses.`);
      }
    }
    const { rows: places } = await client.query(
      `select c.course_id::text as course, c.teacher_id::text as teacher, l.id::text as lesson
         from public.published_courses c
         join public.published_lessons l on l.course_id = c.course_id and l.is_current
         join public.published_modules m on m.id = l.module_id
        where c.slug = $1 order by m.position, l.position limit 1`,
      [course.slug],
    );
    const place = places[0];
    if (place) {
      await publishTestResource(place.course, place.teacher, null, "Guía del curso");
      await publishTestResource(place.course, place.teacher, place.lesson, "Apuntes de la lección");
    }
    loaded.push(`${course.slug} (${answer === "loaded" ? "cargado" : "ya estaba"})`);
  }
  await client.query("commit");
} catch (error) {
  await client.query("rollback").catch(() => {});
  fail(`no se pudieron cargar los cursos de prueba (${error.code ?? "sin código"}): ${error.message}`);
} finally {
  await client.end().catch(() => {});
}

console.log(`db:courses: ${loaded.join(", ")}. Quedan por aprobar: los aprueba alguien con Contenido.`);
console.log("db:courses: dejó renglones en la auditoría. Antes de `pnpm test:db`, `pnpm db:reset`.");
