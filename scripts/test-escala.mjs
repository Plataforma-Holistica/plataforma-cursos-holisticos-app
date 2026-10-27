import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Corre la prueba de escala de la consolidación (`tests/escala/`, T-611) y rehace la base local al
// terminar, pase o falle.
//
// La prueba confirma en la base local 13 000 cuentas, sus cobros y 9.36 millones de latidos, que
// son un libro y no se borran: sin rehacerla, `pnpm test:db` y `pnpm test:int` ya no corren. Por
// eso no se corta a la mitad sin correr después `pnpm db:reset`. No corre en la integración
// continua ni en Vercel: ocupa la base de 10 a 20 minutos y unos 3 GB de Docker.
//
// Solo corre contra la pila local: la prueba lo comprueba antes de escribir, y `supabase db reset`
// no sabe hablar con otra.

if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) {
  console.error("test:escala no corre en la integración continua ni en Vercel.");
  process.exit(1);
}

const run = (command, args, env = process.env) => spawnSync(command, args, { stdio: "inherit", shell: true, env }).status ?? 1;

// Las cifras: la prueba las escribe aquí, porque Vitest calla la consola de un archivo que pasa.
const reportDir = mkdtempSync(join(tmpdir(), "plataforma-escala-"));
const report = join(reportDir, "cifras.txt");
const tests = run("pnpm", ["exec", "vitest", "run", "--project", "escala", ...process.argv.slice(2)], {
  ...process.env,
  ESCALA_REPORT: report,
});
if (existsSync(report)) console.log(`\n${readFileSync(report, "utf8")}`);
rmSync(reportDir, { recursive: true, force: true });

console.log("\nRehaciendo la base local: la prueba de escala dejó millones de latidos.\n");
const reset = run("pnpm", ["db:reset"]);
if (reset !== 0) {
  console.error("\nLa base no se pudo rehacer. Corre `pnpm db:reset` antes de cualquier otra prueba.\n");
}

process.exit(tests !== 0 ? tests : reset);
