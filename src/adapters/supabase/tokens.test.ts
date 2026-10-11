import { describe, expect, it } from "vitest";

import { emailClaim, isLinkToken } from "./tokens";

const token = (payload: unknown) =>
  `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.firma`;

describe("la forma de un enlace de correo", () => {
  it.each(["a".repeat(8), "a".repeat(56), "Ab0_-xyz", "a".repeat(256)])("puede ser un enlace: %s", (value) => {
    expect(isLinkToken(value)).toBe(true);
  });

  it.each([
    "",
    "a".repeat(7),
    "a".repeat(257),
    "abc def gh",
    "abcdefg/",
    "abcdefg.",
    "abcdefg%",
    "abcdefgñ",
    "../../etc",
    "aaaaaaaa\n",
    "\naaaaaaaa",
  ])("no puede ser un enlace: %j", (value) => {
    expect(isLinkToken(value)).toBe(false);
  });
});

describe("el correo que dice un token", () => {
  it("lo saca del cuerpo del token", () => {
    expect(emailClaim(token({ sub: "u", email: "ana@prueba.test" }))).toBe("ana@prueba.test");
  });

  it("acepta un correo del largo máximo, y uno más largo no", () => {
    const longest = `${"a".repeat(242)}@prueba.test`;
    expect(longest).toHaveLength(254);
    expect(emailClaim(token({ email: longest }))).toBe(longest);
    expect(emailClaim(token({ email: `a${longest}` }))).toBeNull();
  });

  it.each([
    ["sin correo", { sub: "u" }],
    ["correo vacío", { email: "" }],
    ["correo que no es texto", { email: 42 }],
    ["correo nulo", { email: null }],
    ["correo en una lista", { email: ["ana@prueba.test"] }],
    ["cuerpo que es una lista", ["ana@prueba.test"]],
    ["cuerpo que es un texto", "ana@prueba.test"],
    ["cuerpo nulo", null],
  ])("%s: nulo", (_name, payload) => {
    expect(emailClaim(token(payload))).toBeNull();
  });

  it.each(["", "sin-puntos", "a.b", "a.%%%.c", `a.${Buffer.from("no es json").toString("base64url")}.c`])(
    "un token que no se entiende no dice nada: %j",
    (value) => {
      expect(emailClaim(value)).toBeNull();
    },
  );
});
