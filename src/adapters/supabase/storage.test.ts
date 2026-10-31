import { describe, expect, it, vi } from "vitest";

import { createResourceStorage } from "./storage";

vi.mock("server-only", () => ({}));
vi.mock("@/config/env", () => ({
  getEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "https://proyecto.test/", SUPABASE_SECRET_KEY: "llave-secreta" }),
}));

const ROOT = "https://proyecto.test/storage/v1";
const PATH = "maestro/curso/recurso";

function storage(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const base = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { adapter: createResourceStorage(base), calls };
}

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;

describe("firmar una subida", () => {
  it("con la llave, sin upsert, y contesta la dirección entera", async () => {
    const { adapter, calls } = storage(() => Response.json({ url: `/object/upload/sign/course-resources/${PATH}?token=t` }));
    expect(await adapter.signUpload(PATH)).toBe(`${ROOT}/object/upload/sign/course-resources/${PATH}?token=t`);
    expect(calls[0]?.url).toBe(`${ROOT}/object/upload/sign/course-resources/${PATH}`);
    expect(calls[0]?.init.method).toBe("POST");
    const headers = headersOf(calls[0]?.init);
    expect(headers.authorization).toBe("Bearer llave-secreta");
    expect(headers["x-upsert"]).toBeUndefined();
  });

  it.each([
    ["Storage contesta un error", () => new Response("{}", { status: 400 })],
    ["la respuesta no trae dirección", () => Response.json({ otra: 1 })],
    ["la dirección no es de Storage", () => Response.json({ url: "https://otro.test/x" })],
    ["la respuesta no es JSON", () => new Response("<html>")],
  ])("si %s, nulo", async (_name, respond) => {
    expect(await storage(respond).adapter.signUpload(PATH)).toBeNull();
  });

  it("si no contesta, nulo", async () => {
    const { adapter } = storage(() => Promise.reject(new Error("sin red")));
    expect(await adapter.signUpload(PATH)).toBeNull();
  });
});

describe("leer por rango", () => {
  it("el principio y el final piden solo esos bytes", async () => {
    const { adapter, calls } = storage(() => new Response(new Uint8Array([1, 2]), { status: 206 }));
    expect(await adapter.readStart(PATH, 16)).toEqual(new Uint8Array([1, 2]));
    expect(headersOf(calls[0]?.init).range).toBe("bytes=0-15");
    await adapter.readEnd(PATH, 100);
    expect(headersOf(calls[1]?.init).range).toBe("bytes=-100");
    expect(calls[0]?.url).toBe(`${ROOT}/object/course-resources/${PATH}`);
  });

  it.each([404, 416, 500])("con %i no se pudo leer: nulo", async (status) => {
    expect(await storage(() => new Response("{}", { status })).adapter.readStart(PATH, 16)).toBeNull();
  });

  it("si no contesta, nulo", async () => {
    expect(await storage(() => Promise.reject(new Error("sin red"))).adapter.readEnd(PATH, 16)).toBeNull();
  });
});

describe("borrar", () => {
  it("manda las rutas", async () => {
    const { adapter, calls } = storage(() => Response.json([]));
    await adapter.remove([PATH]);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ prefixes: [PATH] }));
  });

  it("sin rutas no llama a nadie", async () => {
    const { adapter, calls } = storage(() => Response.json([]));
    await adapter.remove([]);
    expect(calls).toEqual([]);
  });

  it("si Storage contesta un error, lanza sin decir la ruta", async () => {
    const { adapter } = storage(() => new Response("{}", { status: 500 }));
    await expect(adapter.remove([PATH])).rejects.toThrow("storage remove: 500");
  });
});
