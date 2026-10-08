import { describe, expect, it } from "vitest";

import { buildPoolConfig } from "./config";

// Las URL se arman por partes: escritas de corrido, el escaneo de secretos las toma por
// credenciales reales.
const password = "contrasena-de-prueba";
const local = (user: string) => `postgresql://${user}:${password}@127.0.0.1:54322/postgres`;
const remote = (user: string, query = "") =>
  `postgresql://${user}:${password}@aws-0-us-east-1.pooler.supabase.com:6543/postgres${query}`;

describe("configuración de la conexión", () => {
  it("en local entra sin TLS", () => {
    const config = buildPoolConfig({ APP_ENV: "local", DATABASE_URL: local("app_service") });
    expect(config.ssl).toBe(false);
  });

  // `pg` deja que los parámetros de una cadena de conexión manden sobre lo demás. Por
  // eso no se le pasa la cadena: se le pasan sus partes, ya revisadas.
  it("le pasa a pg las partes de la URL, nunca la cadena", () => {
    const config = buildPoolConfig({
      APP_ENV: "staging",
      DATABASE_URL: remote("app_service.abcdefghijklmnopqrst"),
    });
    expect(config).not.toHaveProperty("connectionString");
    expect(config).toMatchObject({
      host: "aws-0-us-east-1.pooler.supabase.com",
      port: 6543,
      user: "app_service.abcdefghijklmnopqrst",
      password,
      database: "postgres",
    });
  });

  it("decodifica el usuario y la contraseña que vienen codificados en la URL", () => {
    const config = buildPoolConfig({
      APP_ENV: "local",
      // Por partes, como las demás: de corrido el escaneo de secretos la toma por real.
      DATABASE_URL: ["postgresql://app_service", "con%40arroba%2Fy%20espacio@127.0.0.1:54322/postgres"].join(":"),
    });
    expect(config.password).toBe("con@arroba/y espacio");
  });

  it.each([
    "?user=postgres",
    "?password=otra",
    "?host=otro.example",
    "?port=5432",
    "?options=-c%20role%3Dpostgres",
    "?application_name=x",
  ])("rechaza una URL con %s: ningún parámetro puede cambiar a quién o a dónde se entra", (query) => {
    expect(() =>
      buildPoolConfig({
        APP_ENV: "staging",
        DATABASE_URL: remote("app_service.abcdefghijklmnopqrst", query),
      }),
    ).toThrow(/DATABASE_URL/);
  });

  // El TLS depende de a dónde se conecta, no de cómo se llama el entorno: un APP_ENV mal
  // puesto no debe mandar la contraseña en claro por internet.
  it("con un servidor remoto verifica el certificado aunque APP_ENV diga local", () => {
    const config = buildPoolConfig({
      APP_ENV: "local",
      DATABASE_URL: remote("app_service.abcdefghijklmnopqrst"),
    });
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])("sin TLS solo en la propia máquina: %s", (host) => {
    const config = buildPoolConfig({
      APP_ENV: "local",
      DATABASE_URL: `postgresql://app_service:${password}@${host}:54322/postgres`,
    });
    expect(config.ssl).toBe(false);
  });

  it("rechaza una URL sin base, sin servidor o que no es de Postgres", () => {
    for (const url of [
      `postgresql://app_service:${password}@127.0.0.1:54322`,
      `https://app_service:${password}@127.0.0.1:54322/postgres`,
    ]) {
      expect(() => buildPoolConfig({ APP_ENV: "local", DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    }
  });

  it.each(["staging", "production"] as const)(
    "en %s verifica el certificado con la raíz de Supabase",
    (APP_ENV) => {
      const config = buildPoolConfig({
        APP_ENV,
        DATABASE_URL: remote("app_service.abcdefghijklmnopqrst"),
      });
      expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
      expect(config.ssl && config.ssl.ca).toContain("BEGIN CERTIFICATE");
    },
  );

  it.each([
    "?sslmode=no-verify",
    "?sslmode=disable",
    "?sslmode=require",
    "?ssl=false",
    "?sslrootcert=otra.crt",
    "?uselibpqcompat=true",
    "?application_name=x&SSLMODE=disable",
  ])("rechaza una URL con %s, que anularía la verificación", (query) => {
    expect(() =>
      buildPoolConfig({
        APP_ENV: "staging",
        DATABASE_URL: remote("app_service.abcdefghijklmnopqrst", query),
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it.each(["postgres", "postgres.abcdefghijklmnopqrst", "app_service_otro", "service_role"])(
    "rechaza entrar como %s: la aplicación entra como app_service",
    (user) => {
      expect(() => buildPoolConfig({ APP_ENV: "local", DATABASE_URL: local(user) })).toThrow(
        /app_service/,
      );
    },
  );

  it("el error nunca trae la URL ni la contraseña", () => {
    let message = "";
    try {
      buildPoolConfig({ APP_ENV: "staging", DATABASE_URL: remote("postgres", "?sslmode=disable") });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(password);
    expect(message).not.toContain("pooler.supabase.com");
  });

  it("pocas conexiones, y con tiempo límite para conectar", () => {
    const config = buildPoolConfig({ APP_ENV: "local", DATABASE_URL: local("app_service") });
    expect(config.max).toBeGreaterThan(1);
    expect(config.max).toBeLessThanOrEqual(5);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.idleTimeoutMillis).toBeGreaterThan(0);
  });
});
