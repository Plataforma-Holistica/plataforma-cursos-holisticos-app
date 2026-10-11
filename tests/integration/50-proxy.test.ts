import { NextRequest } from "next/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { readSession, signIn } from "@/adapters/supabase/auth";
import { decodeSessionCookie, encodeSessionCookie } from "@/adapters/supabase/auth-cookies";
import { proxy } from "@/proxy";

import { knownUser, memoryJar, sessionCount, type KnownUser } from "./helpers/auth";
import { deleteTestUsersByEmail } from "./helpers/users";

// El paso previo de punta a punta: una petición con la cookie de una sesión de verdad,
// contra el Auth local. Lo que hace con cada escritura, sin red, está en
// tests/proxy/proxy.test.ts.

const COOKIE = "plataforma-sesion";
const MINUTE = 60_000;

const emails: string[] = [];

async function signedIn(): Promise<{ account: KnownUser; cookie: string }> {
  const account = await knownUser();
  emails.push(account.email);
  const jar = memoryJar();
  const entered = await signIn(jar, account.email, account.password);
  if (!entered.ok) throw new Error(`La persona de prueba no entró: ${entered.reason}`);
  return { account, cookie: jar.get(COOKIE) ?? "" };
}

const request = (cookie?: string) =>
  new NextRequest("http://localhost:3000/inicio", cookie ? { headers: { cookie: `${COOKIE}=${cookie}; otra=1` } } : {});

/** Adelanta el reloj del proceso: el token de 15 minutos queda por vencer, o vencido. */
function advanceClock(minutes: number): void {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => real() + minutes * MINUTE);
}

/** La cookie de sesión que la respuesta le manda al navegador, con sus atributos. */
function sessionCookieIn(response: Response): { value: string; attributes: string } | null {
  const header = response.headers.getSetCookie().find((line) => line.startsWith(`${COOKIE}=`));
  if (header === undefined) return null;
  const [pair = "", ...attributes] = header.split("; ");
  return { value: pair.slice(COOKIE.length + 1), attributes: attributes.join("; ") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("el paso previo contra el Auth local", () => {
  it("sin cookie de sesión no toca nada", async () => {
    const response = await proxy(request());
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
  });

  it("con la sesión recién abierta no toca nada", async () => {
    const { cookie } = await signedIn();
    const response = await proxy(request(cookie));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
  });

  it("con el token por vencer, la respuesta trae la cookie nueva y la petición también", async () => {
    const { account, cookie } = await signedIn();
    advanceClock(14);

    const response = await proxy(request(cookie));

    const renewed = sessionCookieIn(response);
    expect(renewed).not.toBeNull();
    expect(renewed?.value).not.toBe(cookie);
    expect(renewed?.attributes).toMatch(/^Path=\/; Expires=[^;]+; Max-Age=34560000; HttpOnly; SameSite=lax$/);
    expect(response.headers.get("x-middleware-request-cookie")).toBe(`${COOKIE}=${renewed?.value}; otra=1`);
    expect(response.headers.get("cache-control")).toContain("no-store");

    // La cookie nueva es la misma sesión de la misma persona, con otros tokens.
    vi.restoreAllMocks();
    const read = await readSession(memoryJar(new Map([[COOKIE, renewed?.value ?? ""]])));
    expect(read).toMatchObject({ kind: "session", claims: { userId: account.id } });
    expect(decodeSessionCookie(renewed?.value ?? "")?.refreshToken).not.toBe(
      decodeSessionCookie(cookie)?.refreshToken,
    );
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("con una sesión que Auth ya no conoce, borra la cookie del navegador y de la petición", async () => {
    const { cookie } = await signedIn();
    const tokens = decodeSessionCookie(cookie);
    if (!tokens) throw new Error("La cookie de prueba no se entiende.");
    const stale = encodeSessionCookie({ ...tokens, refreshToken: "zzzzzzzzzzzz" }) ?? "";
    advanceClock(16);

    const response = await proxy(request(stale));

    expect(sessionCookieIn(response)).toEqual({
      value: "",
      attributes: "Path=/; Max-Age=0; HttpOnly; SameSite=lax",
    });
    expect(response.headers.get("x-middleware-request-cookie")).toBe("otra=1");
  });

  it("con una cookie inventada, la borra sin dejar de atender", async () => {
    const response = await proxy(request("v1.aaa.bbb.ccc.YWJj"));
    expect(sessionCookieIn(response)?.value).toBe("");
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  // Va al final a propósito: un corte deja en pausa la renovación de esta instancia, y con
  // el reloj adelantado esa pausa dura, para la hora de verdad, el resto del archivo.
  it("con Auth inalcanzable deja pasar, sin borrar la cookie y sin tardar", async () => {
    const { cookie } = await signedIn();
    advanceClock(16);
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes("/auth/v1/token")
        ? Promise.reject(new TypeError("fetch failed"))
        : real(input, init),
    );

    const started = performance.now();
    const response = await proxy(request(cookie));

    expect(performance.now() - started).toBeLessThan(4_000);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    vi.unstubAllGlobals();
  });
});
