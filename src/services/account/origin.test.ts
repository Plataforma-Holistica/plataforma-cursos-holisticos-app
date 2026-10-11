import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  current: { RATE_LIMIT_HMAC_SECRET: "secreto-de-prueba-para-las-huellas-0123" } as Record<string, string | undefined>,
}));
vi.mock("@/config/env", () => ({ getEnv: () => env.current }));

import { fingerprint } from "./fingerprint";
import { USER_AGENT_MAX_LENGTH, proxyIsTrusted, resolveOrigin } from "./origin";

// De dónde viene una petición (TRD §9.2, fila «Dirección de quien pide»). La cabecera solo
// se cree cuando hay un alojamiento de fiar delante; todo lo demás es «desconocida», que
// va a un solo cubo compartido y nunca queda como dispositivo de confianza.

describe("resolveOrigin", () => {
  it("sin un alojamiento de fiar, la dirección es desconocida aunque la cabecera venga", () => {
    const origin = resolveOrigin({ realIp: "203.0.113.7", userAgent: null }, false);
    expect(origin.known).toBe(false);
    expect(origin.address).toBeNull();
    expect(origin.ip.hex).toBe(fingerprint("ip", "unknown").hex);
  });

  it.each([null, "", "desconocida", "203.0.113.7, 198.51.100.1"])(
    "con la cabecera ausente o ilegible («%s») también es desconocida, en el mismo cubo",
    (realIp) => {
      const origin = resolveOrigin({ realIp, userAgent: null }, true);
      expect(origin.known).toBe(false);
      expect(origin.address).toBeNull();
      expect(origin.ip.hex).toBe(fingerprint("ip", "unknown").hex);
    },
  );

  it("una IPv4 de fiar da su huella y su dirección canónica", () => {
    const origin = resolveOrigin({ realIp: "203.0.113.7", userAgent: null }, true);
    expect(origin).toMatchObject({ known: true, address: "203.0.113.7" });
    expect(origin.ip.hex).toBe(fingerprint("ip", "v4:203.0.113.7").hex);
  });

  it("dos IPv6 de la misma red comparten huella, y cada una conserva su dirección", () => {
    const first = resolveOrigin({ realIp: "2001:db8:85a3:8d3::1", userAgent: null }, true);
    const second = resolveOrigin({ realIp: "2001:DB8:85A3:8D3:ffff::2", userAgent: null }, true);
    expect(first.ip.hex).toBe(second.ip.hex);
    expect(first.address).toBe("2001:db8:85a3:8d3:0:0:0:1");
    expect(second.address).toBe("2001:db8:85a3:8d3:ffff:0:0:2");
  });

  it("una dirección conocida nunca cae en el cubo de las desconocidas", () => {
    const origin = resolveOrigin({ realIp: "203.0.113.7", userAgent: null }, true);
    expect(origin.ip.hex).not.toBe(fingerprint("ip", "unknown").hex);
  });

  describe("el navegador, que lo dice quien pide", () => {
    const agent = (userAgent: string | null) => resolveOrigin({ realIp: null, userAgent }, true).userAgent;

    it("se guarda sin espacios en los extremos", () => {
      expect(agent("  Mozilla/5.0 (X11; Linux)  ")).toBe("Mozilla/5.0 (X11; Linux)");
    });

    it.each([null, "", "   ", "\n\t"])("vacío («%j») es nulo", (value) => {
      expect(agent(value)).toBeNull();
    });

    it("se recorta: es un texto de fuera y va a dar a un libro", () => {
      const long = "a".repeat(USER_AGENT_MAX_LENGTH + 50);
      expect(agent(long)).toHaveLength(USER_AGENT_MAX_LENGTH);
      expect(USER_AGENT_MAX_LENGTH).toBe(512);
    });

    it("pierde los caracteres de control", () => {
      expect(agent("Mozilla\u0000/5.0\r\n(X11)\u007f")).toBe("Mozilla/5.0(X11)");
    });
  });
});

describe("proxyIsTrusted", () => {
  // `VERCEL_ENV` la pone Vercel, no una persona. Solo en sus despliegues hay delante un
  // alojamiento que pisa la cabecera que mande quien pide.
  it.each([
    ["production", true],
    ["preview", true],
    ["development", false],
    ["cualquier-otra-cosa", false],
    ["", false],
    [undefined, false],
  ])("con VERCEL_ENV = %j: %s", (value, trusted) => {
    env.current.VERCEL_ENV = value;
    try {
      expect(proxyIsTrusted()).toBe(trusted);
    } finally {
      delete env.current.VERCEL_ENV;
    }
  });
});
