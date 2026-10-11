import { createHmac } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ current: { RATE_LIMIT_HMAC_SECRET: "secreto-de-prueba-para-las-huellas-0123" } }));
vi.mock("@/config/env", () => ({ getEnv: () => env.current }));

import { buckets, fingerprint } from "./fingerprint";

// Las huellas con secreto (TRD §9.9): lo que la base guarda en lugar del correo y de la
// dirección de quien pide. La misma entrada da siempre la misma huella, y sin el secreto no
// se puede calcular ni comprobar.

const expected = (text: string, secret = env.current.RATE_LIMIT_HMAC_SECRET) =>
  createHmac("sha256", secret).update(text).digest();

describe("fingerprint", () => {
  it("es el HMAC-SHA256 del valor, con el uso por delante", () => {
    const print = fingerprint("account", "ana@ejemplo.com");
    expect(Buffer.from(print.bytes)).toEqual(expected("account|ana@ejemplo.com"));
    expect(print.hex).toBe(expected("account|ana@ejemplo.com").toString("hex"));
  });

  it("mide los 32 bytes que exige la tabla del freno", () => {
    expect(fingerprint("ip", "v4:203.0.113.7").bytes).toHaveLength(32);
    expect(fingerprint("ip", "v4:203.0.113.7").hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el mismo valor con otro uso da otra huella: un correo no choca con un buzón", () => {
    const value = "ana@ejemplo.com";
    const prints = [fingerprint("account", value), fingerprint("mailbox", value), fingerprint("ip", value)];
    expect(new Set(prints.map((print) => print.hex)).size).toBe(3);
    expect(new Set(prints.map((print) => print.lockKey)).size).toBe(3);
  });

  it("depende del secreto: con otro, la huella es otra", () => {
    const first = fingerprint("account", "ana@ejemplo.com").hex;
    const original = env.current.RATE_LIMIT_HMAC_SECRET;
    env.current.RATE_LIMIT_HMAC_SECRET = "otro-secreto-de-prueba-para-las-huellas-99";
    try {
      expect(fingerprint("account", "ana@ejemplo.com").hex).not.toBe(first);
      expect(fingerprint("account", "ana@ejemplo.com").hex).toBe(
        expected("account|ana@ejemplo.com", "otro-secreto-de-prueba-para-las-huellas-99").toString("hex"),
      );
    } finally {
      env.current.RATE_LIMIT_HMAC_SECRET = original;
    }
  });

  it("no deja ver el valor: ni la huella ni el cubo traen el correo", () => {
    const print = fingerprint("account", "ana@ejemplo.com");
    expect(`${print.hex} ${buckets.signInAccount(print)}`).not.toContain("ana");
  });

  // El candado consultivo de Postgres recibe un entero de 64 bits con signo. Los primeros
  // ocho bytes de la huella, leídos sin signo, se saldrían de rango la mitad de las veces.
  it("la clave del candado es un entero de 64 bits con signo, sacado de la huella", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (value) => {
        const print = fingerprint("account", value);
        expect(print.lockKey >= -(2n ** 63n) && print.lockKey <= 2n ** 63n - 1n).toBe(true);
        expect(print.lockKey).toBe(Buffer.from(print.bytes).readBigInt64BE(0));
      }),
    );
  });

  it("las claves de candado salen con los dos signos", () => {
    const signs = new Set(
      Array.from({ length: 64 }, (_, index) => fingerprint("ip", `v4:203.0.113.${index}`).lockKey < 0n),
    );
    expect(signs).toEqual(new Set([true, false]));
  });
});

describe("los cubos de los contadores", () => {
  const print = fingerprint("ip", "v4:203.0.113.7");

  it.each([
    ["signInIp", "signin:ip:"],
    ["signInAccount", "signin:account:"],
    ["signUpIp", "signup:ip:"],
    ["recoverIp", "recover:ip:"],
    ["signUpMail", "mail:signup:"],
    ["recoverMail", "mail:recover:"],
  ] as const)("%s empieza con %s y sigue con la huella", (name, prefix) => {
    expect(buckets[name](print)).toBe(`${prefix}${print.hex}`);
  });

  it("cada uso tiene su cubo: la misma huella no comparte contador entre dos usos", () => {
    const names = Object.values(buckets).map((bucket) => bucket(print));
    expect(new Set(names).size).toBe(names.length);
  });
});
