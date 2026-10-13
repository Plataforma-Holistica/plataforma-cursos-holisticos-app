import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { posix, reachableFrom, sourceFiles, specifiersIn, src, withoutTypeImports } from "./sources";

// Dos cosas de la sesión que el lint no alcanza a ver (TRD §4.2, §8.10 y §9.3):
//
// - El paso previo corre antes de cada petición y no debe poder abrir una transacción. El
//   lint solo mira las importaciones directas; aquí se sigue la cadena completa.
// - La llave secreta de Supabase salta todo permiso. Se lee en un solo archivo, y la API
//   de administración que la usa se llama desde cuatro funciones del adaptador.

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

  it.each([
    'import type { A } from "./x";',
    'export type { A } from "./x";',
    "import type { A, B } from './x'",
    'import type A from "./x";',
    'import type {\n  A,\n  B,\n} from "./x";',
  ])("una sentencia que solo trae tipos no viaja: %s", (code) => {
    expect(specifiersIn(withoutTypeImports(code))).toEqual([]);
  });

  it.each([
    ['import { type A, b } from "./x";', "./x"],
    ['import { a } from "./x";', "./x"],
    ['export { a } from "./x";', "./x"],
    ['import "./x";', "./x"],
    ['const type = 1; import { a } from "./x";', "./x"],
    ['export type A = B;\nimport { c } from "./x";', "./x"],
    ['import type { A } from "./tipos";\nimport { b } from "./x";', "./x"],
  ])("lo demás sí viaja: %s", (code, expected) => {
    expect(specifiersIn(withoutTypeImports(code))).toEqual([expected]);
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

  it("llega a la navegación, que le dice qué rutas piden sesión, y esta no llega a nada más", () => {
    expect(files).toContain("src/services/account/navigation.ts");
    const navigation = reachableFrom(join(src, "services/account/navigation.ts"));
    expect([...navigation.files].map(posix).sort()).toEqual([
      "src/domain/access/return-path.ts",
      "src/services/account/navigation.ts",
    ]);
    expect([...navigation.packages]).toEqual([]);
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
    // Invitar no parte de un canje: recibe un correo. A una cuenta confirmada no le hace
    // nada; a una que no ha confirmado le manda otro enlace, y el anterior deja de servir.
    // Las otras tres actúan sobre la cuenta de un enlace recién canjeado.
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

describe("lo que una persona lee de sí misma, lo lee como ella", () => {
  // `accountProfile` filtra por la cuenta de las claims, y además lee con `asUser`: la base
  // filtra por fila aunque la consulta se equivoque. Las pruebas de integración no
  // distinguen un camino del otro mientras la consulta filtre bien: se cuida aquí.
  const management = readFileSync(join(src, "services/account/management.ts"), "utf8");
  /** El cuerpo de una función del servicio: desde su encabezado hasta la llave que la cierra. */
  const bodyOf = (name: string) => {
    const start = management.indexOf(`async function ${name}(`);
    const end = management.indexOf("\n  }\n", start);
    return start === -1 || end === -1 ? "" : management.slice(start, end);
  };

  it("la lectura del perfil va por `asUser`, y nunca como servidor ni como sistema", () => {
    expect(bodyOf("accountProfile")).toMatch(/\basUser\(claims, /);
    expect(bodyOf("accountProfile")).not.toMatch(/\bas(?:Server|System)\(/);
  });

  it("el nombre se escribe como servidor, a nombre de las claims que dio la guarda", () => {
    expect(bodyOf("changeName")).toMatch(/\basServer\(\{ claims: check\.claims, reason: "change_name" \}, /);
    expect(bodyOf("changeName")).not.toMatch(/\bas(?:User|System)\(/);
  });
});

describe("el resguardo del buzón solo nace al terminar un enlace del correo", () => {
  // Aceptar una invitación de administración pide el resguardo que deja reclamar la cuenta
  // (TRD §9.2, fila «Invitaciones»). Si otro camino pudiera reclamar, o emitir un resguardo,
  // alguien probaría «su buzón» sin haber abierto ningún correo. Las pruebas no cuentan:
  // aquí se mira el código de la aplicación.
  const sources = sourceFiles(src)
    .filter((path) => !/\.test\.tsx?$/.test(path))
    .map((path) => ({ file: posix(path), text: readFileSync(path, "utf8") }));
  const naming = (pattern: RegExp) => sources.filter((source) => pattern.test(source.text)).map((source) => source.file).sort();
  /** Lo mismo, sin los comentarios: varios nombran la función de la base para explicarla. */
  const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const namingInCode = (pattern: RegExp) =>
    sources.filter((source) => pattern.test(withoutComments(source.text))).map((source) => source.file).sort();
  const onboarding = sources.find((source) => source.file === "src/services/account/onboarding.ts")?.text ?? "";
  /** El cuerpo de una función del servicio: desde su encabezado hasta la llave que la cierra. */
  const bodyOf = (name: string) => {
    const start = onboarding.indexOf(`  async function ${name}(`);
    const end = onboarding.indexOf("\n  }\n", start);
    return start === -1 || end === -1 ? "" : onboarding.slice(start, end);
  };

  /** Cuántas veces aparece algo en el código de un archivo, sin sus comentarios. */
  const countIn = (file: string, pattern: RegExp) =>
    withoutComments(sources.find((source) => source.file === file)?.text ?? "").match(pattern)?.length ?? 0;

  it("reclamar una cuenta solo se nombra donde se define y en el servicio de los enlaces", () => {
    // Se cuenta el nombre, no la forma de la llamada: importarlo con otro nombre, guardarlo
    // en una variable o llegar a él por el módulo entero también lo nombra. `claimAccount`
    // es además un campo de la tabla del dominio que dice si toca reclamar: ahí solo puede
    // aparecer como campo.
    expect(namingInCode(/\bclaimAccount\b/)).toEqual([
      "src/domain/access/password-outcome.ts",
      "src/services/account/onboarding.ts",
      "src/services/account/records.ts",
    ]);
    expect(countIn("src/domain/access/password-outcome.ts", /\bclaimAccount\b(?!\s*:)/g)).toBe(0);
    // En el servicio: la importación, las dos llamadas y la lectura de ese campo. Una
    // quinta aparición es otra manera de reclamar.
    expect(countIn("src/services/account/onboarding.ts", /\bclaimAccount\b/g)).toBe(4);
    // Y donde se define: una función, y una consulta que llama a la de la base.
    expect(countIn("src/services/account/records.ts", /\bclaimAccount\b/g)).toBe(1);
    expect(countIn("src/services/account/records.ts", /claim_account/g)).toBe(1);
    expect(namingInCode(/claim_account/)).toEqual(["src/services/account/records.ts"]);
  });

  it("cuánto dura el resguardo lo dice la base: en la aplicación nadie sustituye esa lectura", () => {
    expect(naming(/\bticketLifetime\b/)).toEqual([
      "src/services/account/account.ts",
      "src/services/account/deps.ts",
      "src/services/account/onboarding.ts",
    ]);
  });

  it("emitir un resguardo, también", () => {
    expect(naming(/\bissueTicket\b/)).toEqual(["src/services/account/mailbox-ticket.ts", "src/services/account/onboarding.ts"]);
    // Ni se arma otra fábrica de resguardos en otro lado.
    expect(naming(/\bcreateMailboxTickets\b/)).toEqual(["src/services/account/mailbox-ticket.ts"]);
  });

  it("y solo dentro de completar el registro y de completar la recuperación", () => {
    const calls = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
    expect(calls(onboarding, /\bclaimAccount\(tx, /g)).toBe(2);
    expect(calls(bodyOf("completeRegistration"), /\bclaimAccount\(tx, ticket\.print\)/g)).toBe(1);
    expect(calls(bodyOf("completeRecovery"), /\bclaimAccount\(tx, ticket\?\.print \?\? null\)/g)).toBe(1);
    // Una importación y dos emisiones: el secreto lo genera el servidor en cada una.
    expect(calls(onboarding, /\bissueTicket\b/g)).toBe(3);
    expect(calls(bodyOf("completeRegistration"), /= issueTicket\(\);/g)).toBe(1);
    expect(calls(bodyOf("completeRecovery"), /= jar \? issueTicket\(\) : null;/g)).toBe(1);
  });
});
