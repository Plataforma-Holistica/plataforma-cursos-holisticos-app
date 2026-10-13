import { describe, expect, it } from "vitest";

import { createEnrolledFactors, ENROLLED_FACTOR_MAX_AGE_SECONDS } from "./enrolled-factor";

function jarOf(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: { name: string; value: string; options: Record<string, unknown> }[] = [];
  return {
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
const FACTOR = "fa000000-0000-4000-8000-000000000001";

describe("el factor que el servidor dio de alta en este navegador", () => {
  it("se anota con la sesión que lo dio de alta, en una cookie que la página no lee", () => {
    const factors = createEnrolledFactors({ secure: () => true });
    const jar = jarOf();
    expect(factors.keepEnrolledFactor(jar, SESSION, FACTOR)).toBe(true);
    expect(jar.writes).toEqual([
      {
        name: "__Host-plataforma-factor",
        value: `${SESSION}.${FACTOR}`,
        options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: ENROLLED_FACTOR_MAX_AGE_SECONDS },
      },
    ]);
    expect(factors.readEnrolledFactor(jar, SESSION)).toBe(FACTOR);
  });

  it("dura lo que tarda alguien en teclear un código, no lo que dura el resguardo", () => {
    expect(ENROLLED_FACTOR_MAX_AGE_SECONDS).toBe(900);
  });

  it("sin https no lleva el prefijo, que un navegador rechazaría", () => {
    const factors = createEnrolledFactors({ secure: () => false });
    const jar = jarOf();
    factors.keepEnrolledFactor(jar, SESSION, FACTOR);
    expect(jar.writes[0]).toMatchObject({ name: "plataforma-factor", options: { secure: false } });
    expect(factors.readEnrolledFactor(jar, SESSION)).toBe(FACTOR);
  });

  it("con otra sesión no se lee: el factor es de la sesión que lo dio de alta", () => {
    const factors = createEnrolledFactors({ secure: () => false });
    const jar = jarOf();
    factors.keepEnrolledFactor(jar, SESSION, FACTOR);
    expect(factors.readEnrolledFactor(jar, OTHER_SESSION)).toBeNull();
    expect(factors.readEnrolledFactor(jar, "")).toBeNull();
  });

  it("anotar otro sustituye al anterior", () => {
    const factors = createEnrolledFactors({ secure: () => false });
    const jar = jarOf();
    const second = "fa000000-0000-4000-8000-000000000002";
    factors.keepEnrolledFactor(jar, SESSION, FACTOR);
    factors.keepEnrolledFactor(jar, SESSION, second);
    expect(factors.readEnrolledFactor(jar, SESSION)).toBe(second);
  });

  it.each([
    ["sin sesión", "", FACTOR],
    ["sin factor", SESSION, ""],
    ["una sesión que no es un identificador", "sesion", FACTOR],
    ["un factor que no es un identificador", SESSION, "factor"],
    ["un factor con algo detrás", SESSION, `${FACTOR}.${FACTOR}`],
    ["una sesión con mayúsculas", SESSION.toUpperCase(), FACTOR],
    ["un factor con un salto de línea", SESSION, `${FACTOR}\n`],
  ])("lo que no tiene forma no se anota: %s", (_what, session, factor) => {
    const factors = createEnrolledFactors({ secure: () => false });
    const jar = jarOf();
    expect(factors.keepEnrolledFactor(jar, session, factor)).toBe(false);
    expect(jar.writes).toEqual([]);
  });

  it.each([
    ["nada", undefined],
    ["vacía", ""],
    ["solo el factor", FACTOR],
    ["solo la sesión y el punto", `${SESSION}.`],
    ["otro separador", `${SESSION}:${FACTOR}`],
    ["tres partes", `${SESSION}.${FACTOR}.${FACTOR}`],
    ["algo delante", `x${SESSION}.${FACTOR}`],
    ["algo detrás", `${SESSION}.${FACTOR}x`],
    ["un salto de línea al final", `${SESSION}.${FACTOR}\n`],
    ["mayúsculas", `${SESSION}.${FACTOR.toUpperCase()}`],
    ["al revés", `${FACTOR}.${SESSION}`],
  ])("una cookie que no es exactamente lo que este código escribió cuenta como ausente: %s", (_what, value) => {
    const factors = createEnrolledFactors({ secure: () => false });
    const jar = jarOf(value === undefined ? {} : { "plataforma-factor": value });
    expect(factors.readEnrolledFactor(jar, SESSION)).toBeNull();
  });

  it("la cookie con el otro nombre no se lee: con https solo vale la del prefijo", () => {
    const secure = createEnrolledFactors({ secure: () => true });
    const plain = createEnrolledFactors({ secure: () => false });
    const value = `${SESSION}.${FACTOR}`;
    expect(secure.readEnrolledFactor(jarOf({ "plataforma-factor": value }), SESSION)).toBeNull();
    expect(plain.readEnrolledFactor(jarOf({ "__Host-plataforma-factor": value }), SESSION)).toBeNull();
  });

  it("borrarla la vence en el acto, con las mismas opciones con que se escribió", () => {
    const factors = createEnrolledFactors({ secure: () => true });
    const jar = jarOf({ "__Host-plataforma-factor": `${SESSION}.${FACTOR}` });
    factors.dropEnrolledFactor(jar);
    expect(jar.writes).toEqual([
      { name: "__Host-plataforma-factor", value: "", options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 } },
    ]);
    expect(factors.readEnrolledFactor(jar, SESSION)).toBeNull();
  });

  it("sin cookie, borrar no escribe nada", () => {
    const factors = createEnrolledFactors({ secure: () => true });
    const jar = jarOf({ "plataforma-factor": `${SESSION}.${FACTOR}` });
    factors.dropEnrolledFactor(jar);
    expect(jar.writes).toEqual([]);
  });
});
