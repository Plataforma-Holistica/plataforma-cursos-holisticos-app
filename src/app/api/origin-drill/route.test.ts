import { beforeEach, describe, expect, it, vi } from "vitest";

// La medición de la cabecera de la dirección: una ruta que solo existe fuera de producción
// y que contesta banderas, nunca una dirección.

vi.mock("@sentry/nextjs", () => ({ init: vi.fn(), captureRequestError: vi.fn() }));

const env = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));
vi.mock("@/config/env", () => ({ getEnv: () => env.current }));

const context = vi.hoisted(() => ({ origin: { realIp: null as string | null, userAgent: null as string | null } }));
vi.mock("@/app/_lib/request-context", () => ({ requestOrigin: () => Promise.resolve(context.origin) }));

import { NextRequest } from "next/server";

import { dynamic, GET } from "./route";

const SECRET = "secreto-de-prueba-para-las-huellas-0123";
const ask = (query: string) => GET(new NextRequest(`https://plataforma.example/api/origin-drill${query}`));

beforeEach(() => {
  env.current = { APP_ENV: "staging", VERCEL_ENV: "preview", RATE_LIMIT_HMAC_SECRET: SECRET };
  context.origin = { realIp: "198.51.100.20", userAgent: "prueba" };
});

describe("GET /api/origin-drill", () => {
  it("contesta las banderas de lo que llegó, sin ninguna dirección, y sin caché", async () => {
    const response = await ask("?probe=203.0.113.9");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: true, readable: true, matchesProbe: false, trusted: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("si la cabecera que llegó es la falsificada, lo dice", async () => {
    context.origin = { realIp: "203.0.113.9", userAgent: null };
    expect(await (await ask("?probe=203.0.113.9")).json()).toMatchObject({ matchesProbe: true });
  });

  it.each(["", "?probe=", "?probe=no-es-una-direccion", `?probe=${"1".repeat(200)}`])(
    "sin una sonda que sea una dirección no mide nada: «%s»",
    async (query) => {
      const response = await ask(query);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    },
  );

  it("en producción no existe", async () => {
    env.current = { ...env.current, APP_ENV: "production" };
    expect((await ask("?probe=203.0.113.9")).status).toBe(404);
    env.current = { ...env.current, APP_ENV: "staging", VERCEL_ENV: "production" };
    expect((await ask("?probe=203.0.113.9")).status).toBe(404);
  });

  it("no se resuelve al compilar", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
