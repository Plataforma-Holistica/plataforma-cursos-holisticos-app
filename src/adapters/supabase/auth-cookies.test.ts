import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_COOKIE_MAX_LENGTH,
  clearSessionCookie,
  decodeSessionCookie,
  encodeSessionCookie,
  isSecureSite,
  readSessionCookie,
  sessionCookieName,
  sessionCookieOptions,
  writeSessionCookie,
  type CookieJar,
  type CookieOptions,
} from "./auth-cookies";

const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/);
const accessToken = fc.tuple(segment, segment, segment).map((parts) => parts.join("."));
// Auth no promete una forma para el token de renovación: cualquier texto corto vale.
const refreshToken = fc.string({ minLength: 1, maxLength: 64, unit: "grapheme" });
const tokens = fc.record({ accessToken, refreshToken });

function jarWith(initial: Record<string, string> = {}): CookieJar & {
  writes: { name: string; value: string; options: CookieOptions }[];
} {
  const values = new Map(Object.entries(initial));
  const writes: { name: string; value: string; options: CookieOptions }[] = [];
  return {
    writes,
    get: (name) => values.get(name),
    set(name, value, options) {
      writes.push({ name, value, options });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

describe("el valor de la cookie", () => {
  it("lo que se codifica se decodifica igual", () => {
    fc.assert(
      fc.property(tokens, (session) => {
        const value = encodeSessionCookie(session);
        expect(value).not.toBeNull();
        expect(decodeSessionCookie(value ?? "")).toEqual(session);
      }),
    );
  });

  it("solo usa caracteres que ningún servidor tiene que escapar", () => {
    fc.assert(
      fc.property(tokens, (session) => {
        expect(encodeSessionCookie(session)).toMatch(/^v1\.[A-Za-z0-9_.-]+$/);
      }),
    );
  });

  it("lleva los dos tokens y nada más", () => {
    const value = encodeSessionCookie({ accessToken: "aaa.bbb.ccc", refreshToken: "abcdefghijkl" });
    expect(value).toBe(`v1.aaa.bbb.ccc.${Buffer.from("abcdefghijkl").toString("base64url")}`);
  });

  it("un texto cualquiera no lanza: o es una cookie canónica o no es nada", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (value) => {
        const decoded = decodeSessionCookie(value);
        if (decoded !== null) expect(encodeSessionCookie(decoded)).toBe(value);
      }),
    );
  });

  it.each([
    ["vacía", ""],
    ["de otra versión", "v2.aaa.bbb.ccc.YWJj"],
    ["sin versión", "aaa.bbb.ccc.YWJj"],
    ["con un segmento de menos", "v1.aaa.bbb.YWJj"],
    ["con un segmento de más", "v1.aaa.bbb.ccc.ddd.YWJj"],
    ["con un segmento vacío en el token", "v1.aaa..ccc.YWJj"],
    ["con un carácter ajeno en el token", "v1.aaa.b b.ccc.YWJj"],
    ["sin token de renovación", "v1.aaa.bbb.ccc."],
    ["con el token de renovación mal codificado", "v1.aaa.bbb.ccc.YWJj="],
    ["con el token de renovación en una forma no canónica", "v1.aaa.bbb.ccc.YWJ"],
    ["la que escribía la biblioteca de Supabase", "base64-eyJhY2Nlc3NfdG9rZW4iOiJhIn0"],
  ])("rechaza una cookie %s", (_name, value) => {
    expect(decodeSessionCookie(value)).toBeNull();
  });

  it.each([
    ["un token de acceso que no tiene tres partes", { accessToken: "aaa.bbb", refreshToken: "r" }],
    ["un token de acceso con una parte de más", { accessToken: "aaa.bbb.ccc.ddd", refreshToken: "r" }],
    ["un token de acceso con un carácter ajeno", { accessToken: "aaa.b~b.ccc", refreshToken: "r" }],
    ["un token de renovación vacío", { accessToken: "aaa.bbb.ccc", refreshToken: "" }],
  ])("no codifica %s", (_name, session) => {
    expect(encodeSessionCookie(session)).toBeNull();
  });

  it("no codifica lo que no cabe, y lo que cabe mide como mucho el tope", () => {
    const fits = "a".repeat(SESSION_COOKIE_MAX_LENGTH - "v1.".length - ".b.c.".length - "cg".length);
    const exact = encodeSessionCookie({ accessToken: `${fits}.b.c`, refreshToken: "r" });
    expect(exact).toHaveLength(SESSION_COOKIE_MAX_LENGTH);
    expect(encodeSessionCookie({ accessToken: `${fits}a.b.c`, refreshToken: "r" })).toBeNull();
    // Y lo que no cabría tampoco se lee: una cookie más larga no la escribió nadie de aquí.
    expect(decodeSessionCookie(`v1.${fits}a.b.c.cg`)).toBeNull();
  });
});

describe("el nombre y los atributos", () => {
  it.each([
    ["https://plataforma.example", true],
    ["https://rama-abc.vercel.app/", true],
    ["http://localhost:3000", false],
    ["http://127.0.0.1:3000", false],
    ["no es una dirección", false],
  ])("%s es un sitio seguro: %s", (site, secure) => {
    expect(isSecureSite(site)).toBe(secure);
  });

  it("con https lleva el prefijo que impide que otro subdominio la plante", () => {
    expect(sessionCookieName(true)).toBe("__Host-plataforma-sesion");
    expect(sessionCookieName(false)).toBe("plataforma-sesion");
  });

  it("es HttpOnly, SameSite=Lax y de todo el sitio; Secure cuando el sitio lo es", () => {
    expect(sessionCookieOptions(true)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    });
    expect(sessionCookieOptions(false).secure).toBe(false);
    expect(sessionCookieOptions(false).httpOnly).toBe(true);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(400 * 24 * 60 * 60);
  });
});

describe("leer, escribir y borrar en un tarro", () => {
  const session = { accessToken: "aaa.bbb.ccc", refreshToken: "abcdefghijkl" };

  it.each([true, false])("lo que se escribe se lee (sitio seguro: %s)", (secure) => {
    const jar = jarWith();
    expect(writeSessionCookie(jar, session, secure)).toBe(true);
    expect(jar.writes).toEqual([
      {
        name: sessionCookieName(secure),
        value: encodeSessionCookie(session),
        options: sessionCookieOptions(secure),
      },
    ]);
    expect(readSessionCookie(jar, secure)).toEqual({ kind: "tokens", tokens: session });
  });

  it("lo que no cabe no se escribe", () => {
    const jar = jarWith();
    const huge = { accessToken: `${"a".repeat(SESSION_COOKIE_MAX_LENGTH)}.b.c`, refreshToken: "r" };
    expect(writeSessionCookie(jar, huge, true)).toBe(false);
    expect(jar.writes).toEqual([]);
  });

  it("borrar es escribir vacío con los mismos atributos y vida cero", () => {
    const jar = jarWith({ [sessionCookieName(true)]: "v1.aaa.bbb.ccc.YWJj" });
    clearSessionCookie(jar, true);
    expect(jar.writes).toEqual([
      { name: "__Host-plataforma-sesion", value: "", options: { ...sessionCookieOptions(true), maxAge: 0 } },
    ]);
    expect(readSessionCookie(jar, true)).toEqual({ kind: "absent" });
  });

  it("distingue que no haya cookie de que no se entienda", () => {
    expect(readSessionCookie(jarWith(), false)).toEqual({ kind: "absent" });
    expect(readSessionCookie(jarWith({ "plataforma-sesion": "" }), false)).toEqual({ kind: "absent" });
    expect(readSessionCookie(jarWith({ "plataforma-sesion": "basura" }), false)).toEqual({
      kind: "malformed",
    });
  });

  it("no lee la cookie del otro nombre", () => {
    const local = jarWith({ "plataforma-sesion": encodeSessionCookie(session) ?? "" });
    expect(readSessionCookie(local, true)).toEqual({ kind: "absent" });
  });
});
