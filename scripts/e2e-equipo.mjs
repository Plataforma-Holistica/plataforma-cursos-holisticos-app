import { spawnSync } from "node:child_process";

// Corre las pruebas de extremo a extremo del equipo (`tests/e2e/equipo/`) y rehace la base
// local al terminar, pasen o fallen.
//
// Esas pruebas invitan, atan un segundo factor y dan capacidades de verdad, y eso deja
// renglones en la auditoría, que no admite borrado. Las pruebas de base cuentan esos
// renglones: si la base no se rehace, la siguiente corrida de `pnpm test:db` falla sin que
// nada esté roto. Por eso no corren con `pnpm test:e2e`, y por eso esto no se puede cortar a
// la mitad sin correr después `pnpm db:reset`.
//
// Solo corre contra la pila local: `playwright.config.ts` lo comprueba antes de levantar
// la aplicación, y `supabase db reset` no sabe hablar con otra.

const run = (command, args, env = {}) =>
  spawnSync(command, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } }).status ?? 1;

const tests = run("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], { E2E_EQUIPO: "1" });

console.log("\nRehaciendo la base local: las pruebas del equipo dejaron renglones en la auditoría.\n");
const reset = run("pnpm", ["db:reset"]);
if (reset !== 0) {
  console.error("\nLa base no se pudo rehacer. Corre `pnpm db:reset` antes de `pnpm test:db`.\n");
}

process.exit(tests !== 0 ? tests : reset);
