import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Dos cosas de la sesión que el lint no alcanza a ver (TRD §4.2, §8.10 y §9.3):
//
// - El paso previo corre antes de cada petición y no debe poder abrir una transacción. El
//   lint solo mira las importaciones directas; aquí se sigue la cadena completa.
// - La llave secreta de Supabase salta todo permiso. Se lee en un solo archivo, y la API
//   de administración que la usa se llama desde dos funciones, las dos sobre una cuenta
//   que sale de un enlace recién canjeado.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(root, "src");
const posix = (path: string) => relative(root, path).replaceAll("\\", "/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Toda forma de traer otro módulo: `import … from`, `export … from`, `import "x"`,
// `import("x")` y `require("x")`, con comillas o con comillas invertidas. También los que
// solo traen tipos: si un día dejan de serlo, la cadena ya estaba vigilada.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`]+)["'`]/g;

/** Los nombres que `SPECIFIER` saca de un texto. */
const specifiersIn = (text: string) => [...text.matchAll(SPECIFIER)].map((match) => match[1]);

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(src, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const found = candidates.find((candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate));
  if (!found) throw new Error(`No se pudo seguir la importación "${specifier}" de ${posix(from)}.`);
  return found;
}

/** Todo lo que un archivo termina cargando: sus archivos de `src/` y sus paquetes. */
function reachableFrom(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      const local = resolveLocal(file, specifier);
      if (local) pending.push(local);
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

describe("cómo se sigue una importación", () => {
  it.each([
    ['import { a } from "./x";', "./x"],
    ["import { a } from './x';", "./x"],
    ['export { a } from "./x";', "./x"],
    ['export type { A } from "./x";', "./x"],
    ['import "./x";', "./x"],
    ['const load = () => import("./x");', "./x"],
    ["const load = () => import(`./x`);", "./x"],
    ['const x = require("./x");', "./x"],
    ["const x = require(`./x`);", "./x"],
  ])("ve %s", (code, expected) => {
    expect(specifiersIn(code)).toEqual([expected]);
  });
});

describe("lo que el paso previo termina cargando", () => {
  const reached = reachableFrom(join(src, "proxy.ts"));
  const files = [...reached.files].map(posix);

  it("llega al adaptador de Auth por el servicio de sesión", () => {
    // Si esto falla, la prueba dejó de seguir la cadena y lo de abajo no dice nada.
    expect(files).toContain("src/services/account/session.ts");
    expect(files).toContain("src/adapters/supabase/auth.ts");
    expect(files).toContain("src/adapters/supabase/claims.ts");
  });

  it("no llega al acceso a la base", () => {
    expect(files).not.toContain("src/adapters/supabase/db.ts");
    expect(files.filter((file) => /\/(db|sql|codecs|config|root-ca)\.ts$/.test(file) && file.includes("supabase"))).toEqual([]);
    expect([...reached.packages].filter((name) => /^pg($|[-/])|^postgres($|\/)/.test(name))).toEqual([]);
  });

  it("no llega a otro adaptador ni a una pantalla", () => {
    expect(files.filter((file) => /^src\/(adapters\/(?!supabase\/)|app\/|ui\/|payload\/|jobs\/)/.test(file))).toEqual([]);
  });
});

describe("la llave secreta de Supabase", () => {
  const sources = sourceFiles(src).map((path) => ({ file: posix(path), text: readFileSync(path, "utf8") }));

  it("solo se nombra en la configuración y en los clientes de Auth", () => {
    const naming = sources.filter((source) => source.text.includes("SUPABASE_SECRET_KEY")).map((source) => source.file);
    expect(naming.sort()).toEqual(["src/adapters/supabase/auth-client.ts", "src/config/env.ts"]);
  });

  it("la API de administración solo se usa en cuatro funciones del adaptador", () => {
    // Toda aparición del nombre, no solo las llamadas: guardarlo en otra variable o
    // importarlo con otro nombre también cuenta.
    const naming = sources.filter((source) => /\badminApi\b/.test(source.text)).map((source) => source.file);
    expect(naming.sort()).toEqual(["src/adapters/supabase/auth-client.ts", "src/adapters/supabase/auth.ts"]);

    const auth = sources.find((source) => source.file === "src/adapters/supabase/auth.ts")?.text ?? "";
    // El cuerpo de cada función del adaptador: desde su encabezado hasta la llave que la
    // cierra, que es la primera que vuelve a su misma sangría.
    const bodyOf = (name: string): string => {
      const from = auth.indexOf(`  async function ${name}(`);
      if (from === -1) throw new Error(`auth.ts ya no tiene la función ${name}.`);
      return auth.slice(from, auth.indexOf("\n  }\n", from));
    };
    // Invitar no parte de un canje: recibe un correo y no toca ninguna cuenta que ya
    // exista. Las otras tres actúan sobre la cuenta de un enlace recién canjeado.
    const users = ["requestSignUp", "setFirstPassword", "setRecoveredPassword", "slimDown"];
    const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

    // Una importación, y una llamada en cada una de las cuatro funciones. Nada más.
    expect(count(auth, /\badminApi\b/g)).toBe(5);
    expect(count(auth, /import \{[^}]*\badminApi\b[^}]*\} from "\.\/auth-client";/g)).toBe(1);
    expect(count(users.map(bodyOf).join(""), /\badminApi\(baseFetch\)\./g)).toBe(4);
    for (const name of users) expect(count(bodyOf(name), /\badminApi\(/g)).toBe(1);
    // Y cada una, lo suyo: una sola invita, y ninguna otra función del archivo fija contraseñas.
    expect(count(auth, /\.inviteUserByEmail\(/g)).toBe(1);
    expect(count(bodyOf("requestSignUp"), /\.inviteUserByEmail\(/g)).toBe(1);
    expect(count(auth, /\.updateUserById\(/g)).toBe(3);
    expect(count(bodyOf("requestSignUp"), /\.updateUserById\(/g)).toBe(0);
  });

  it("ningún otro archivo construye por su cuenta un cliente de administración", () => {
    const building = sources
      .filter((source) => /GoTrueAdminApi|AuthAdminApi|auth\.admin\b|\.admin\.(?:updateUserById|createUser|deleteUser|generateLink|signOut|inviteUserByEmail)/.test(source.text))
      .map((source) => source.file);
    expect(building).toEqual(["src/adapters/supabase/auth-client.ts"]);
  });
});
