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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DATA_FILE = join("supabase", "local", "test-courses.json");
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function fail(message) {
  console.error(`db:courses: ${message}`);
  process.exit(1);
}

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

/** El curso en la forma que espera `private.system_load_course()`: el video, del proveedor de prueba. */
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
          provider: "test",
          asset_id: `${course.slug}-video-${(number += 1)}`,
          playback_id: `prueba:${lesson.file}`,
          duration_seconds: lesson.duration_seconds,
        },
      })),
    })),
  };
}

const data = readData();

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: url.hostname.replace(/^\[|\]$/g, ""),
  port: url.port === "" ? 5432 : Number(url.port),
  user: "postgres",
  password: "postgres",
  database: decodeURIComponent(url.pathname.replace(/^\//, "")),
});

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
