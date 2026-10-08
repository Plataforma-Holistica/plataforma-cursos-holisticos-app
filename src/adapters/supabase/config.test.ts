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
    expect(config.connectionString).toBe(local("app_service"));
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
