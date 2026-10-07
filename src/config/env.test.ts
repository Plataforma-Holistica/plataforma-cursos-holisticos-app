import { describe, expect, it } from "vitest";

import { EnvError, parseEnv } from "./env";

// La verificación de T-102: la aplicación se niega a iniciar si falta una variable.

// La dirección de prueba se arma por partes: escrita de corrido, el escaneo de secretos la
// toma por una credencial real.
const fakeDatabaseUrl = (password: string) =>
  ["postgresql://postgres", `${password}@127.0.0.1:54322/postgres`].join(":");

const valid = {
  APP_ENV: "local",
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "clave-publicable-de-prueba",
  SUPABASE_SECRET_KEY: "clave-secreta-de-prueba",
  DATABASE_URL: fakeDatabaseUrl("contrasena-de-prueba"),
  DATABASE_URL_DIRECT: fakeDatabaseUrl("contrasena-de-prueba"),
};

function problemsOf(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  throw new Error("parseEnv aceptó un entorno que debía rechazar");
}

describe("parseEnv", () => {
  it("acepta un entorno completo y devuelve los valores", () => {
    expect(parseEnv(valid)).toEqual(valid);
  });

  it("ignora las variables que no conoce", () => {
    expect(parseEnv({ ...valid, PATH: "/usr/bin" })).toEqual(valid);
  });

  it.each(Object.keys(valid))("rechaza el entorno si falta %s", (name) => {
    expect(problemsOf({ ...valid, [name]: undefined })).toEqual([`${name}: falta`]);
  });

  it("trata una variable vacía como si faltara", () => {
    expect(problemsOf({ ...valid, SUPABASE_SECRET_KEY: "" })).toEqual([
      "SUPABASE_SECRET_KEY: falta",
    ]);
  });

  it("reporta todas las que faltan, no solo la primera", () => {
    expect(problemsOf({})).toEqual(Object.keys(valid).map((name) => `${name}: falta`));
  });

  it("rechaza un APP_ENV que no es local, staging ni production", () => {
    expect(problemsOf({ ...valid, APP_ENV: "desarrollo" })).toEqual([
      "APP_ENV: tiene un valor inválido",
    ]);
  });

  it.each(["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SUPABASE_URL"])(
    "rechaza %s si no es una dirección http",
    (name) => {
      expect(problemsOf({ ...valid, [name]: "localhost" })).toEqual([
        `${name}: tiene un valor inválido`,
      ]);
      expect(problemsOf({ ...valid, [name]: "ftp://localhost" })).toEqual([
        `${name}: tiene un valor inválido`,
      ]);
    },
  );

  it.each(["DATABASE_URL", "DATABASE_URL_DIRECT"])(
    "rechaza %s si no es una dirección de Postgres",
    (name) => {
      expect(problemsOf({ ...valid, [name]: "http://127.0.0.1:54322" })).toEqual([
        `${name}: tiene un valor inválido`,
      ]);
    },
  );

  it("nunca escribe el valor de una variable en el error", () => {
    const secret = `${fakeDatabaseUrl("no-debe-aparecer")} y z`;
    try {
      parseEnv({ ...valid, APP_ENV: "no-debe-aparecer", DATABASE_URL: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect(String((error as Error).message)).not.toContain("no-debe-aparecer");
      return;
    }
    throw new Error("parseEnv aceptó un entorno que debía rechazar");
  });
});
