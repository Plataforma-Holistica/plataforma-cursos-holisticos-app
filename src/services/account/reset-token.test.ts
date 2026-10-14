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
const MARK = "m".repeat(22);
const OTHER_MARK = "n".repeat(22);
/** Unos testigos cuya marca se sabe: la primera vez `MARK`, después `OTHER_MARK`. */
const tokensWith = (secure: boolean) => {
  const marks = [MARK, OTHER_MARK];
  return createResetTokens({ secure: () => secure, mark: () => marks.shift() ?? OTHER_MARK });
};

describe("el testigo de un restablecimiento", () => {
  it("se deja con la sesión, la persona y una marca, en una cookie que la página no lee", () => {
    const tokens = tokensWith(true);
    const jar = jarOf();
    expect(tokens.keepResetToken(jar, SESSION, PERSON)).toBe(MARK);
    expect(jar.writes).toEqual([
      {
        name: "__Host-plataforma-restablecer",
        value: `${SESSION}.${PERSON}.${MARK}`,
        options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: RESET_TOKEN_MAX_AGE_SECONDS },
      },
    ]);
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(true);
  });

  it("dura lo que tarda alguien en leer y confirmar", () => {
    expect(RESET_TOKEN_MAX_AGE_SECONDS).toBe(600);
  });

  it("la marca nace al azar con cada uno: veintidós caracteres que caben en el valor de un botón", () => {
    const tokens = createResetTokens({ secure: () => false });
    const first = tokens.keepResetToken(jarOf(), SESSION, PERSON);
    const second = tokens.keepResetToken(jarOf(), SESSION, PERSON);
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first).not.toBe(second);
  });

  it("sin https no lleva el prefijo, que un navegador rechazaría", () => {
    const tokens = tokensWith(false);
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    expect(jar.writes[0]).toMatchObject({ name: "plataforma-restablecer", options: { secure: false } });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(true);
  });

  it.each<[string, string, string, unknown]>([
    ["otra sesión", OTHER_SESSION, PERSON, MARK],
    ["otra persona", SESSION, OTHER_PERSON, MARK],
    ["las dos al revés", PERSON, SESSION, MARK],
    ["sin sesión", "", PERSON, MARK],
    ["sin persona", SESSION, "", MARK],
    ["otra marca", SESSION, PERSON, OTHER_MARK],
    ["sin marca", SESSION, PERSON, undefined],
    ["la marca vacía", SESSION, PERSON, ""],
    ["una marca que no es texto", SESSION, PERSON, [MARK]],
  ])("con %s no es el testigo, y no se gasta", (_what, session, person, mark) => {
    const tokens = tokensWith(false);
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    expect(tokens.holdsResetToken(jar, session, person, mark)).toBe(false);
    expect(tokens.spendResetToken(jar, session, person, mark)).toBe(false);
    // El de la otra confirmación sigue ahí.
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(true);
    expect(jar.writes).toHaveLength(1);
  });

  it("gastarlo lo borra: la segunda vez ya no está", () => {
    const tokens = tokensWith(true);
    const jar = jarOf();
    tokens.keepResetToken(jar, SESSION, PERSON);
    expect(tokens.spendResetToken(jar, SESSION, PERSON, MARK)).toBe(true);
    expect(jar.writes[1]).toEqual({
      name: "__Host-plataforma-restablecer",
      value: "",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 },
    });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(false);
    expect(tokens.spendResetToken(jar, SESSION, PERSON, MARK)).toBe(false);
    expect(jar.writes).toHaveLength(2);
  });

  it("dejar otro sustituye al anterior: una confirmación a la vez, también para la misma persona", () => {
    const tokens = tokensWith(false);
    const jar = jarOf();
    expect(tokens.keepResetToken(jar, SESSION, PERSON)).toBe(MARK);
    expect(tokens.keepResetToken(jar, SESSION, PERSON)).toBe(OTHER_MARK);
    // La marca de la confirmación de antes ya no vale: su formulario no restablece.
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(false);
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, OTHER_MARK)).toBe(true);
    tokens.keepResetToken(jar, SESSION, OTHER_PERSON);
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, OTHER_MARK)).toBe(false);
  });

  it.each([
    ["una sesión sin forma", "sesion", PERSON],
    ["una persona sin forma", SESSION, "persona"],
    ["una persona en mayúsculas", SESSION, PERSON.toUpperCase()],
    ["un punto de más", SESSION, `${PERSON}.${PERSON}`],
  ])("%s no se deja", (_what, session, person) => {
    const tokens = tokensWith(false);
    const jar = jarOf();
    expect(tokens.keepResetToken(jar, session, person)).toBeNull();
    expect(jar.writes).toEqual([]);
  });

  it.each([
    "",
    "cualquier cosa",
    SESSION,
    `${SESSION}.`,
    `${SESSION}.${PERSON}`,
    `${SESSION}.${PERSON}.`,
    `${SESSION}.${PERSON}.corta`,
    `${SESSION}.${PERSON}.${MARK}.${MARK}`,
    ` ${SESSION}.${PERSON}.${MARK}`,
  ])("una cookie que este código no escribió (%j) cuenta como ausente", (value) => {
    const tokens = tokensWith(false);
    const jar = jarOf({ "plataforma-restablecer": value });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(false);
    expect(tokens.spendResetToken(jar, SESSION, PERSON, MARK)).toBe(false);
    expect(jar.writes).toEqual([]);
  });

  it.each(["corta", `${MARK}m`, `${MARK.slice(1)}.`, ""])(
    "una cookie con una marca sin forma (%j) no vale ni presentando esa misma marca",
    (mark) => {
      const tokens = tokensWith(false);
      const jar = jarOf({ "plataforma-restablecer": `${SESSION}.${PERSON}.${mark}` });
      expect(tokens.holdsResetToken(jar, SESSION, PERSON, mark)).toBe(false);
      expect(tokens.spendResetToken(jar, SESSION, PERSON, mark)).toBe(false);
      expect(jar.writes).toEqual([]);
    },
  );

  it("con https no lee la cookie sin prefijo, que otro subdominio pudo plantar", () => {
    const tokens = tokensWith(true);
    const jar = jarOf({ "plataforma-restablecer": `${SESSION}.${PERSON}.${MARK}` });
    expect(tokens.holdsResetToken(jar, SESSION, PERSON, MARK)).toBe(false);
  });
});
