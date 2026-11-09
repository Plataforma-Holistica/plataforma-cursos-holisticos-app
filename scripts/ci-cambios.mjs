// Dice si un cambio toca algo que la integración continua tenga que verificar (2026-11-09, para gastar menos corridas). Con un cambio que
// solo toca documentos en Markdown fuera del código, el trabajo `verificar` no levanta la base ni el navegador: se saltan sus pasos
// pesados, y el trabajo sigue y contesta. Todo lo demás se verifica entero. En la cola de fusión no se pregunta: siempre entero.
//
//   node scripts/ci-cambios.mjs <base> <cabeza>      # imprime codigo=true o codigo=false, para $GITHUB_OUTPUT
//
// Los Markdown de `src/`, `supabase/`, `tests/` y `scripts/` sí son código: los borradores legales de `supabase/local/legal-drafts/`
// los carga la base y los leen las pruebas. Un renombre cuenta con sus dos nombres (`--no-renames`): mover `x.ts` a `notas.md` borra
// código. Si git falla, o no hay archivos que comparar, se verifica entero.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CODE_DIRECTORIES = ["src/", "supabase/", "tests/", "scripts/"];

/** Si alguno de esos archivos pide la verificación entera. Una lista vacía también: no se supo qué cambió. */
export function touchesCode(files) {
  if (files.length === 0) return true;
  return files.some((file) => !file.endsWith(".md") || CODE_DIRECTORIES.some((directory) => file.startsWith(directory)));
}

/** Los archivos que cambian entre dos commits; un renombre, con su nombre de antes y el de ahora. */
export function changedFiles(base, head, cwd = process.cwd()) {
  return execFileSync("git", ["diff", "--name-only", "--no-renames", base, head], { encoding: "utf8", cwd })
    .split("\n")
    .filter((line) => line !== "");
}

function main([base, head]) {
  if (!base || !head) {
    console.error("ci-cambios: uso: node scripts/ci-cambios.mjs <base> <cabeza>");
    process.exit(2);
  }
  const files = changedFiles(base, head);
  const code = touchesCode(files);
  console.error(`ci-cambios: ${files.length} archivos; ${code ? "se verifica entero" : "solo documentos: se saltan los pasos pesados"}`);
  for (const file of files) console.error(`  ${file}`);
  console.log(`codigo=${code}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
