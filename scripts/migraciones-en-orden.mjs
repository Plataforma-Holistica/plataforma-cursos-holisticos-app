// Comprueba que las migraciones que agrega un cambio van después de todas las de main (ola 0, dos
// carriles en paralelo). Supabase las aplica en orden de nombre: si una rama fusionada después
// trae una marca de tiempo anterior a otra ya fusionada, en una base nueva corre antes que ella, y
// lo que las dos reemplazan queda como lo dejó la otra.
//
//   node scripts/migraciones-en-orden.mjs <base> <cabeza>
//   pnpm db:orden                       # contra origin/main, antes de pedir una fusión
//
// En la integración continua, en una solicitud corre con `HEAD^1 HEAD` (HEAD es la fusión de prueba
// con main y HEAD^1 es main), y al entrar a main, contra lo que main tenía antes del empuje, que
// puede traer varios commits.
//
// Falla si una migración nueva no tiene la forma `AAAAMMDDHHMMSS_nombre.sql`, si su versión no es
// posterior a la última de la base, si repite una versión, o si el cambio edita o borra una
// migración que ya estaba en la base: esa ya corrió en alguna base, y se corrige con otra nueva.
// Sugiere el nombre con la marca que toca.

import { execFileSync } from "node:child_process";

const DIRECTORY = "supabase/migrations/";
const NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fail(message) {
  console.error(`migraciones-en-orden: ${message}`);
  process.exit(2);
}

/** La versión siguiente: la hora UTC de ahora o un segundo después de la última, la que sea mayor. */
function nextVersion(last) {
  const now = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  if (!last || now > last) return now;
  const at = new Date(
    Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8), +last.slice(8, 10), +last.slice(10, 12), +last.slice(12, 14) + 1),
  );
  return at.toISOString().replace(/\D/g, "").slice(0, 14);
}

const [base, head, ...rest] = process.argv.slice(2);
if (!base || !head || rest.length > 0) fail("uso: node scripts/migraciones-en-orden.mjs <base> <cabeza>");

let baseFiles;
let changes;
try {
  baseFiles = git("ls-tree", "--name-only", base, "--", DIRECTORY)
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(DIRECTORY.length));
  // Tres puntos: lo que cambió la cabeza desde donde se separó de la base. Lo que la base agregó
  // después no cuenta como borrado.
  changes = git("diff", "--name-status", "--no-renames", `${base}...${head}`, "--", DIRECTORY)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status, name: path.slice(DIRECTORY.length) };
    });
} catch {
  fail(`no se pudo leer ${base} o ${head} con git.`);
}

const versions = new Map();
for (const name of baseFiles) {
  const match = NAME.exec(name);
  if (match) versions.set(match[1], name);
}
const last = [...versions.keys()].sort().at(-1);

const problems = [];
const added = changes.filter((change) => change.status === "A").map((change) => change.name).sort();
for (const change of changes) {
  if (change.status !== "A") {
    problems.push(`${change.name}: ya estaba en ${base} y no se cambia (se corrige con una migración nueva).`);
  }
}
let suggestion = last;
for (const name of added) {
  const match = NAME.exec(name);
  if (!match) {
    problems.push(`${name}: el nombre no tiene la forma AAAAMMDDHHMMSS_nombre.sql (minúsculas, dígitos y guiones bajos).`);
    continue;
  }
  const version = match[1];
  const fixed = () => {
    suggestion = nextVersion(suggestion);
    return `${suggestion}${name.slice(14)}`;
  };
  if (versions.has(version)) {
    problems.push(`${name}: repite la versión de ${versions.get(version)}. Renómbrala: ${fixed()}`);
  } else if (last && version <= last) {
    problems.push(`${name}: va antes de la última de ${base} (${versions.get(last)}). Renómbrala: ${fixed()}`);
  } else {
    suggestion = suggestion && suggestion > version ? suggestion : version;
  }
  versions.set(version, name);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`migraciones-en-orden: ${problem}`);
  process.exit(1);
}
console.log(`migraciones-en-orden: ${added.length === 0 ? "ninguna nueva" : `${added.length} nueva(s), después de las de ${base}`}.`);
