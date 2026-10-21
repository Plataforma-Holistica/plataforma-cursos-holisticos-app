// Corre la consolidación nocturna en la base LOCAL, ahora, como la corre pg_cron cada noche
// (T-207): para revisar a mano los puntos sin esperar a las 03:00 (el hito de la semana 4).
//
//   pnpm db:rollup                 # los pares marcados del mes en curso y el anterior
//   pnpm db:rollup --completo      # el recálculo completo de los dos (RF-408)
//
// Después imprime cómo terminó cada corrida y el consolidado del periodo en curso: por alumno y
// lección, los segundos distintos que cuentan y los medios puntos (0, 1 o 2). Sin correos ni
// nombres: los identificadores, recortados.
//
// Solo corre contra la pila local, con las comprobaciones de `db:student`, y nunca imprime la
// cadena de conexión: de un error, solo su código. Las corridas que deja quedan en
// `public.job_runs`, y el consolidado en `public.watch_rollup`: antes de cualquier prueba,
// `pnpm db:reset`.

import { existsSync } from "node:fs";

import pg from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function fail(message) {
  console.error(`db:rollup: ${message}`);
  process.exit(1);
}

/** Lo único que se dice de un error: su código. El mensaje puede traer datos de la conexión. */
function codeOf(error) {
  const code = error?.code ?? error?.name;
  return typeof code === "string" || typeof code === "number" ? String(code) : "desconocido";
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--completo")) fail("el único argumento es --completo.");
const full = args.includes("--completo");

// Lo que ya está en el entorno gana sobre el archivo.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("no corre en la integración continua ni en Vercel: este guion es solo para una base local.");
}
if (process.env.APP_ENV !== "local") fail("APP_ENV no es local.");

const raw = process.env.DATABASE_URL_DIRECT;
if (!raw) fail("falta DATABASE_URL_DIRECT. Mira .env.example.");
let direct;
try {
  direct = new URL(raw);
} catch {
  fail("DATABASE_URL_DIRECT no es una URL.");
}
if (!LOCAL_HOSTS.has(direct.hostname)) fail("DATABASE_URL_DIRECT no apunta a la pila local. Este guion solo corre contra 127.0.0.1 o localhost.");
if ([...direct.searchParams.keys()].length > 0) fail("DATABASE_URL_DIRECT no puede traer parámetros.");
// Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene un
// usuario y una contraseña de fábrica que ninguna base remota tiene.
if (decodeURIComponent(direct.username) !== "postgres" || decodeURIComponent(direct.password) !== "postgres") {
  fail("DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.");
}

// A `pg` se le pasan las partes ya revisadas, nunca la cadena.
const client = new pg.Client({
  host: direct.hostname.replace(/^\[|\]$/g, ""),
  port: direct.port === "" ? 5432 : Number(direct.port),
  user: "postgres",
  password: "postgres",
  database: decodeURIComponent(direct.pathname.replace(/^\//, "")),
});

const short = (id) => (id ? `${String(id).slice(0, 8)}…` : "");

try {
  await client.connect();
  const start = (await client.query("select clock_timestamp()::text as now")).rows[0].now;
  // Una llamada suelta y sin parámetros, como la hace pg_cron: el procedimiento hace commit entre
  // lotes, y eso pide el protocolo simple.
  await client.query(full ? "call private.nightly_rollup(true)" : "call private.nightly_rollup()");
  const runs = await client.query(
    `select period_id, status::text as status, rows_read, rows_written, error, details ->> 'mode' as mode
     from public.job_runs where job = 'nightly_rollup' and started_at >= $1::timestamptz order by period_id`,
    [start],
  );
  console.log("Corridas:");
  for (const run of runs.rows) {
    console.log(
      `  ${run.period_id} (${run.mode}): ${run.status}, ${run.rows_read} pares leídos, ${run.rows_written} filas cambiadas` +
        (run.error ? `, error ${String(run.error).split(":")[0]}` : ""),
    );
  }
  const rollup = await client.query(
    `select w.profile_id, w.lesson_id, w.covered_seconds, w.lesson_duration_seconds, w.half_points
     from public.watch_rollup w
     where w.period_id = (select max(p) from private.rollup_window() as p)
     order by w.profile_id, w.lesson_id`,
  );
  console.log("Consolidado del periodo en curso (alumno, lección, segundos, medios puntos):");
  if (rollup.rows.length === 0) console.log("  (vacío)");
  for (const row of rollup.rows) {
    console.log(
      `  ${short(row.profile_id)} ${short(row.lesson_id)} ${row.covered_seconds} de ${row.lesson_duration_seconds} s: ${row.half_points}`,
    );
  }
} catch (error) {
  fail(`la base contestó con un error (${codeOf(error)}).`);
} finally {
  await client.end().catch(() => undefined);
}
