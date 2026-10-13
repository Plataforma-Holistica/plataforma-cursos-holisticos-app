import { describe, expect, it } from "vitest";

import { createResetTokens, RESET_TOKEN_MAX_AGE_SECONDS } from "./reset-token";

function jarOf(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: { name: string; value: string; options: Record<string, unknown> }[] = [];
  return {
    values,
    writes,
    get: (name: string) => values.get(name),
    set(name: string, value: string, options: { maxAge: number }) {
      writes.push({ name, value, options: { ...options } });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

const SESSION = "5e000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "5e000000-0000-4000-8000-000000000002";
const PERSON = "b0000000-0000-4000-8000-000000000001";
const OTHER_PERSON = "b0000000-0000-4000-8000-000000000002";

describe("el testigo de un restablecimiento", () => {
  it("se deja con la sesión y la persona, en una cookie que la página no lee", () => {
    const tokens = createResetTokens({ secure: () => true });
    const jar = jarOf();
    expect(tokens.keepResetToken(jar, SESSION, PERSON)).toBe(true);
    expect(jar.writes).toEqual([
      {
        name: "__Host-plataforma-restablecer",
        value: `${SESSION}.${PERSON}`,
        options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: RESET_TOKEN_MAX_AGE_SECONDS },
      },
    ]);
    expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(true);
  });

  it("dura lo que tarda alguien en leer y confirmar", () => {
    expect(RESET_TOKEN_MAX_AGE_SECONDS).toBe(600);
  });

  it("sin https no lleva el prefijo, que un navegador rechazaría", () => {
    const tokens = createResetTokens({ secure: () => false });
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    expect(jar.writes[0]).toMatchObject({ name: "plataforma-restablecer", options: { secure: false } });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(true);
  });

  it.each([
    ["otra sesión", OTHER_SESSION, PERSON],
    ["otra persona", SESSION, OTHER_PERSON],
    ["las dos al revés", PERSON, SESSION],
    ["sin sesión", "", PERSON],
    ["sin persona", SESSION, ""],
  ])("con %s no es el testigo, y no se gasta", (_what, session, person) => {
    const tokens = createResetTokens({ secure: () => false });
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    expect(tokens.holdsResetToken(jar, session, person)).toBe(false);
    expect(tokens.spendResetToken(jar, session, person)).toBe(false);
    // El de la otra confirmación sigue ahí.
    expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(true);
    expect(jar.writes).toHaveLength(1);
  });

  it("gastarlo lo borra: la segunda vez ya no está", () => {
    const tokens = createResetTokens({ secure: () => true });
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    expect(tokens.spendResetToken(jar, SESSION, PERSON)).toBe(true);
    expect(jar.writes[1]).toEqual({
      name: "__Host-plataforma-restablecer",
      value: "",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 },
    });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(false);
    expect(tokens.spendResetToken(jar, SESSION, PERSON)).toBe(false);
    expect(jar.writes).toHaveLength(2);
  });

  it("dejar otro sustituye al anterior: una confirmación a la vez", () => {
    const tokens = createResetTokens({ secure: () => false });
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    tokens.keepResetToken(jar, SESSION, OTHER_PERSON);
    expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(false);
    expect(tokens.holdsResetToken(jar, SESSION, OTHER_PERSON)).toBe(true);
  });

  it.each([
    ["una sesión sin forma", "sesion", PERSON],
    ["una persona sin forma", SESSION, "persona"],
    ["una persona en mayúsculas", SESSION, PERSON.toUpperCase()],
    ["un punto de más", SESSION, `${PERSON}.${PERSON}`],
  ])("%s no se deja", (_what, session, person) => {
    const tokens = createResetTokens({ secure: () => false });
    const jar = jarOf();
    expect(tokens.keepResetToken(jar, session, person)).toBe(false);
    expect(jar.writes).toEqual([]);
  });

  it.each(["", "cualquier cosa", SESSION, `${SESSION}.`, `${SESSION}.${PERSON}.${PERSON}`, ` ${SESSION}.${PERSON}`])(
    "una cookie que este código no escribió (%j) cuenta como ausente",
    (value) => {
      const tokens = createResetTokens({ secure: () => false });
      const jar = jarOf({ "plataforma-restablecer": value });
      expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(false);
      expect(tokens.spendResetToken(jar, SESSION, PERSON)).toBe(false);
      expect(jar.writes).toEqual([]);
    },
  );

  it("con https no lee la cookie sin prefijo, que otro subdominio pudo plantar", () => {
    const tokens = createResetTokens({ secure: () => true });
    const jar = jarOf({ "plataforma-restablecer": `${SESSION}.${PERSON}` });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON)).toBe(false);
  });
});
