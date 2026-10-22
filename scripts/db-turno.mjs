// El turno de la base local (ola 0: dos carriles en paralelo). Las dos copias del repositorio
// (`plataforma/` y el `git worktree` `plataforma-b/`) comparten una sola pila de Supabase y el
// puerto 3000: un `db:reset` desde una deja la base con las migraciones de esa copia y rompe lo
// que corre la otra. Este guion reparte el turno.
//
//   pnpm db:turno                  # de quién es el turno, desde cuándo y qué corre con él
//   pnpm db:turno soltar           # esta copia lo suelta
//   pnpm db:turno soltar --forzar  # lo suelta aunque sea de la otra, si nada suyo sigue vivo
//
// Los guiones que tocan la base lo piden solos (`package.json`): `exigir` pasa si el turno es de
// esta copia, si está libre o si está vencido, y entonces lo toma; si es de la otra, se niega. Un
// turno está vencido cuando ningún proceso que lo pidió sigue vivo y nadie lo usó en 30 minutos:
// mientras corre un `pnpm dev` o un extremo a extremo, no se vence. `exigir --base` además exige
// que la base tenga exactamente las migraciones de esta copia, y si no, pide `pnpm db:reset`;
// `--base=aviso` solo avisa (lo usan `dev` y `start`).
//
// `exigir --base` toma el turno aunque la base no coincida: quien falla es quien sigue, con su
// `db:reset`. Si un turno no se suelta (en Windows un número de proceso se puede reusar), la copia
// dueña lo suelta, o se borra el candado: `pnpm db:turno` dice dónde está.
//
// El candado vive en el directorio común de git, que comparten las dos copias y que nunca se
// versiona. En la integración continua y en Vercel no hace nada: ahí no hay dos copias.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const EXPIRES_MS = 30 * 60 * 1000;
// Un proceso anotado hace más de doce horas ya no cuenta: Windows reusa los números de proceso.
const PROCESS_MAX_MS = 12 * 60 * 60 * 1000;
const MUTEX_STALE_MS = 5 * 1000;

function fail(message) {
  console.error(`db:turno: ${message}`);
  process.exit(1);
}

if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) process.exit(0);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let copy;
let lockPath;
try {
  copy = resolve(git("rev-parse", "--show-toplevel"));
  lockPath = join(resolve(git("rev-parse", "--path-format=absolute", "--git-common-dir")), "plataforma-turno.json");
} catch {
  fail("no estoy dentro de una copia del repositorio.");
}
const mutexPath = `${lockPath}.mutex`;
const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Corre `fn` con el mutex del candado: crear el archivo con `wx` es atómico, también en NTFS. `fn`
 * no sale del proceso: devuelve un mensaje de error o nada, y el mutex se suelta siempre.
 */
function withMutex(fn) {
  // 200 intentos de 50 ms: más que lo que tarda un mutex huérfano en tenerse por viejo.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      closeSync(openSync(mutexPath, "wx"));
    } catch (error) {
      // En Windows, un archivo que se está borrando contesta EPERM o EACCES, y uno abierto, EBUSY.
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      try {
        if (Date.now() - statSync(mutexPath).mtimeMs > MUTEX_STALE_MS) rmSync(mutexPath, { force: true });
      } catch {
        // Se fue entre una cosa y otra: se reintenta.
      }
      sleep(50);
      continue;
    }
    try {
      return fn();
    } finally {
      rmSync(mutexPath, { force: true });
    }
  }
  return `el candado del turno sigue tomado; vuelve a intentarlo, y si insiste, borra ${mutexPath}`;
}

/** El estado del candado, o `null` si no se pudo leer o no tiene forma. */
function read() {
  if (!existsSync(lockPath)) return { turno: null };
  try {
    const state = JSON.parse(readFileSync(lockPath, "utf8"));
    if (state && typeof state === "object" && (state.turno === null || typeof state.turno?.copia === "string")) return state;
  } catch {
    // Se trata igual que uno sin forma.
  }
  return null;
}

/** Escribe a un archivo temporal y lo renombra encima: nadie lee un candado a medias. */
function write(state) {
  const temporary = `${lockPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, lockPath);
      return;
    } catch (error) {
      // En Windows, un antivirus o un lector pueden tener el archivo un momento.
      if (attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      sleep(50);
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function liveProcesses(turno, now) {
  return (turno?.procesos ?? []).filter((p) => now - Date.parse(p.desde) < PROCESS_MAX_MS && alive(p.pid));
}

function minutes(ms) {
  return `${Math.max(0, Math.round(ms / 60000))} min`;
}

function describe(turno, now) {
  const live = liveProcesses(turno, now);
  const running = live.length > 0 ? `; corriendo: ${live.map((p) => p.comando).join(", ")}` : "";
  return `${turno.copia} (desde hace ${minutes(now - Date.parse(turno.desde))}, último uso hace ${minutes(now - Date.parse(turno.ultimoUso))}${running})`;
}

const UNREADABLE = "el candado del turno no se pudo leer: pnpm db:turno soltar --forzar.";

/** Las versiones de las migraciones de esta copia contra las que la base dice que aplicó. */
async function compareBase() {
  const envFile = join(copy, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.APP_ENV !== "local") return "APP_ENV no es local: no hay base local que comparar. Mira .env.local.";
  const raw = process.env.DATABASE_URL_DIRECT;
  if (!raw) return "falta DATABASE_URL_DIRECT: no hay con qué comparar la base. Mira .env.example.";
  let direct;
  try {
    direct = new URL(raw);
  } catch {
    return "DATABASE_URL_DIRECT no es una URL.";
  }
  if (!LOCAL_HOSTS.has(direct.hostname) || [...direct.searchParams.keys()].length > 0) {
    return "DATABASE_URL_DIRECT no apunta a la pila local.";
  }
  // Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene un
  // usuario y una contraseña de fábrica que ninguna base remota tiene.
  if (decodeURIComponent(direct.username) !== "postgres" || decodeURIComponent(direct.password) !== "postgres") {
    return "DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.";
  }
  const files = readdirSync(join(copy, "supabase", "migrations"))
    .map((name) => /^(\d{14})_.+\.sql$/.exec(name)?.[1])
    .filter(Boolean);
  const { default: pg } = await import("pg");
  // A `pg` se le pasan las partes ya revisadas, nunca la cadena.
  const client = new pg.Client({
    host: direct.hostname.replace(/^\[|\]$/g, ""),
    port: direct.port === "" ? 5432 : Number(direct.port),
    user: "postgres",
    password: "postgres",
    database: decodeURIComponent(direct.pathname.replace(/^\//, "")),
  });
  let applied;
  try {
    await client.connect();
    applied = (await client.query("select version from supabase_migrations.schema_migrations")).rows.map((row) => row.version);
  } catch (error) {
    if (error?.code === "42P01") return "la base no tiene registro de migraciones: pnpm db:reset.";
    return `no se pudo leer qué migraciones tiene la base (${error?.code ?? "desconocido"}): ¿está arriba? pnpm db:start.`;
  } finally {
    await client.end().catch(() => {});
  }
  const missing = files.filter((version) => !applied.includes(version)).sort();
  const extra = applied.filter((version) => !files.includes(version)).sort();
  if (missing.length === 0 && extra.length === 0) return null;
  return [
    "la base no tiene las migraciones de esta copia: pnpm db:reset.",
    missing.length > 0 ? `  le faltan: ${missing.join(", ")}` : "",
    extra.length > 0 ? `  tiene de más (de la otra copia o de otra rama): ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const [command = "estado", ...args] = process.argv.slice(2);

if (command === "estado") {
  if (args.length > 0) fail("uso: estado");
  const state = withMutex(read);
  if (typeof state === "string") fail(state);
  if (state === null) fail(UNREADABLE);
  const now = Date.now();
  if (!state.turno) console.log("db:turno: libre.");
  else console.log(`db:turno: ${same(state.turno.copia, copy) ? "de esta copia" : "de la otra copia"}: ${describe(state.turno, now)}.`);
  console.log(`db:turno: el candado está en ${lockPath}`);
} else if (command === "exigir") {
  const base = args[0];
  if (args.length > 1 || (base !== undefined && base !== "--base" && base !== "--base=aviso")) fail("uso: exigir [--base | --base=aviso]");
  const problem = withMutex(() => {
    const state = read();
    if (state === null) return UNREADABLE;
    const now = Date.now();
    const turno = state.turno;
    const mine = turno !== null && same(turno.copia, copy);
    if (turno && !mine && (liveProcesses(turno, now).length > 0 || now - Date.parse(turno.ultimoUso) < EXPIRES_MS)) {
      return `el turno de la base es de la otra copia, ${describe(turno, now)}. Espera a que termine, o en esa copia: pnpm db:turno soltar.`;
    }
    const at = new Date(now).toISOString();
    write({
      turno: {
        copia: copy,
        desde: mine ? turno.desde : at,
        ultimoUso: at,
        // El proceso que corre la cadena de `package.json` (`cmd` o `sh`): vive mientras ella vive.
        procesos: [...(mine ? liveProcesses(turno, now) : []), { pid: process.ppid, comando: process.env.npm_lifecycle_event ?? "a mano", desde: at }],
      },
    });
    return undefined;
  });
  if (problem) fail(problem);
  if (base) {
    const difference = await compareBase();
    if (difference && base === "--base=aviso") console.warn(`db:turno: aviso: ${difference}`);
    else if (difference) fail(difference);
  }
} else if (command === "soltar") {
  const force = args[0] === "--forzar";
  if (args.length > (force ? 1 : 0)) fail("uso: soltar [--forzar]");
  const problem = withMutex(() => {
    const state = read();
    const now = Date.now();
    if (state === null && !force) return UNREADABLE;
    if (state?.turno && !same(state.turno.copia, copy)) {
      if (!force) return `el turno es de la otra copia, ${describe(state.turno, now)}. Suéltalo allá, o con --forzar si nada suyo sigue vivo.`;
      if (liveProcesses(state.turno, now).length > 0) return `la otra copia tiene procesos vivos: ${describe(state.turno, now)}.`;
    }
    write({ turno: null });
    return undefined;
  });
  if (problem) fail(problem);
  console.log("db:turno: libre.");
} else {
  fail("uso: estado | exigir [--base | --base=aviso] | soltar [--forzar]");
}
