import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveClientIp } from "./client-ip";

// De qué dirección viene una petición, para el freno y los topes (TRD §9.9). Solo se lee
// la cabecera que pone el alojamiento, y solo cuando hay un alojamiento de fiar delante: en
// local quien pide puede mandar la cabecera que quiera. La clave que sale es la que el
// servicio pasa por la huella con secreto, así que la misma dirección debe dar siempre la
// misma clave, se escriba como se escriba.

const trusted = { proxyTrusted: true };

describe("resolveClientIp", () => {
  it("sin un alojamiento de fiar delante, la cabecera no se cree", () => {
    expect(resolveClientIp("203.0.113.7", { proxyTrusted: false })).toEqual({
      kind: "unknown",
      reason: "untrusted_proxy",
    });
  });

  it.each([null, undefined, ""])("sin cabecera («%s») la dirección es desconocida", (value) => {
    expect(resolveClientIp(value, trusted)).toEqual({ kind: "unknown", reason: "absent" });
  });

  it.each([
    ["203.0.113.7", "v4:203.0.113.7"],
    ["0.0.0.0", "v4:0.0.0.0"],
    ["255.255.255.255", "v4:255.255.255.255"],
    ["10.0.0.1", "v4:10.0.0.1"],
  ])("lee la IPv4 %s", (value, key) => {
    expect(resolveClientIp(value, trusted)).toEqual({ kind: "ip", key });
  });

  it.each([
    ["2001:db8:85a3:8d3:1319:8a2e:370:7348", "v6:2001:db8:85a3:8d3::/64"],
    ["2001:0db8:85a3:08d3:ffff:ffff:ffff:ffff", "v6:2001:db8:85a3:8d3::/64"],
    ["2001:DB8:85A3:8D3::1", "v6:2001:db8:85a3:8d3::/64"],
    ["2001:db8::1", "v6:2001:db8:0:0::/64"],
    ["::1", "v6:0:0:0:0::/64"],
    ["::", "v6:0:0:0:0::/64"],
    ["fe80::", "v6:fe80:0:0:0::/64"],
    ["1:2:3:4:5:6:7::", "v6:1:2:3:4::/64"],
    ["::2:3:4:5:6:7:8", "v6:0:2:3:4::/64"],
    ["64:ff9b::192.0.2.33", "v6:64:ff9b:0:0::/64"],
  ])("agrupa la IPv6 %s por su prefijo de 64 bits", (value, key) => {
    expect(resolveClientIp(value, trusted)).toEqual({ kind: "ip", key });
  });

  it.each(["::ffff:203.0.113.7", "::FFFF:203.0.113.7", "::ffff:cb00:7107", "0:0:0:0:0:ffff:cb00:7107"])(
    "una IPv4 escrita dentro de una IPv6 (%s) da la clave de la IPv4",
    (value) => {
      expect(resolveClientIp(value, trusted)).toEqual({ kind: "ip", key: "v4:203.0.113.7" });
    },
  );

  it.each([
    ["una lista de direcciones", "203.0.113.7, 198.51.100.1"],
    ["un espacio al final", "203.0.113.7 "],
    ["un puerto", "203.0.113.7:443"],
    ["un octeto de más de 255", "203.0.113.256"],
    ["un octeto de cuatro cifras", "203.0.113.1000"],
    ["un cero a la izquierda, que otros leen en octal", "203.0.113.07"],
    ["tres octetos", "203.0.113"],
    ["cinco octetos", "203.0.113.7.1"],
    ["un número suelto", "3405803783"],
    ["hexadecimal", "0xcb.0.113.7"],
    ["corchetes", "[2001:db8::1]"],
    ["corchetes con puerto", "[2001:db8::1]:443"],
    ["una zona", "fe80::1%eth0"],
    ["dos saltos", "2001::db8::1"],
    ["tres dos puntos seguidos", "2001:::1"],
    ["nueve grupos", "1:2:3:4:5:6:7:8:9"],
    ["siete grupos sin salto", "1:2:3:4:5:6:7"],
    ["ocho grupos y un salto", "1:2:3:4::5:6:7:8"],
    ["un grupo de cinco cifras", "2001:db8:85a3:08d30::1"],
    ["un grupo que no es hexadecimal", "2001:db8:xyz::1"],
    ["dos puntos sueltos al inicio", ":2001:db8::1"],
    ["dos puntos sueltos al final", "2001:db8::1:"],
    ["una IPv4 mal formada dentro de una IPv6", "::ffff:203.0.113.256"],
    ["una IPv4 en medio de una IPv6", "::203.0.113.7:1"],
    ["una IPv4 con puntos y sin dos puntos", "203.0.113.7.ffff"],
    ["texto", "desconocida"],
  ])("no lee %s", (_name, value) => {
    expect(resolveClientIp(value, trusted)).toEqual({ kind: "unknown", reason: "malformed" });
  });

  const group = fc.integer({ min: 0, max: 0xffff });
  const groups = fc.array(group, { minLength: 8, maxLength: 8 });
  const padded = (value: number) => value.toString(16).padStart(4, "0");
  const prefix = (values: number[]) =>
    `v6:${values
      .slice(0, 4)
      .map((value) => value.toString(16))
      .join(":")}::/64`;

  // Todas las formas de escribir los mismos ocho grupos: completa, con ceros a la
  // izquierda, en mayúsculas y abreviando una racha de ceros.
  function compressed(values: number[]): string | null {
    const start = values.indexOf(0);
    if (start === -1) return null;
    let end = start;
    while (end < values.length && values[end] === 0) end += 1;
    const hex = (list: number[]) => list.map((value) => value.toString(16)).join(":");
    return `${hex(values.slice(0, start))}::${hex(values.slice(end))}`;
  }

  it("la misma IPv6 escrita de formas distintas da la misma clave", () => {
    fc.assert(
      fc.property(groups, (values) => {
        // Una IPv4 dentro de una IPv6 tiene su propia regla y su propia prueba.
        fc.pre(!(values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff));
        const expected = { kind: "ip", key: prefix(values) };
        const full = values.map((value) => value.toString(16)).join(":");
        expect(resolveClientIp(full, trusted)).toEqual(expected);
        expect(resolveClientIp(values.map(padded).join(":"), trusted)).toEqual(expected);
        expect(resolveClientIp(full.toUpperCase(), trusted)).toEqual(expected);
        const short = compressed(values);
        if (short !== null) expect(resolveClientIp(short, trusted)).toEqual(expected);
      }),
    );
  });

  it("dos IPv6 con el mismo prefijo de 64 bits comparten clave, y con otro prefijo no", () => {
    fc.assert(
      fc.property(groups, groups, (first, second) => {
        fc.pre(first[0] !== 0);
        const sameNetwork = [...first.slice(0, 4), ...second.slice(4)];
        const key = (values: number[]) => resolveClientIp(values.map(padded).join(":"), trusted);
        expect(key(sameNetwork)).toEqual(key(first));
        const otherNetwork = [(first[0] ?? 0) ^ 1, ...first.slice(1)];
        expect(key(otherNetwork)).not.toEqual(key(first));
      }),
    );
  });

  it("toda IPv4 da su clave, sola o escrita dentro de una IPv6", () => {
    fc.assert(
      fc.property(fc.ipV4(), (address) => {
        const expected = { kind: "ip", key: `v4:${address}` };
        expect(resolveClientIp(address, trusted)).toEqual(expected);
        expect(resolveClientIp(`::ffff:${address}`, trusted)).toEqual(expected);
      }),
    );
  });

  it("una IPv4 escrita en octal o en hexadecimal no se lee", () => {
    fc.assert(
      fc.property(fc.ipV4Extended(), (address) => {
        const plain = /^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(address);
        fc.pre(!plain);
        expect(resolveClientIp(address, trusted)).toEqual({ kind: "unknown", reason: "malformed" });
      }),
    );
  });

  it("toda IPv6 bien escrita se lee, y nunca da una clave con otra forma", () => {
    fc.assert(
      fc.property(fc.ipV6(), (address) => {
        const result = resolveClientIp(address, trusted);
        expect(result.kind).toBe("ip");
        if (result.kind !== "ip") return;
        expect(result.key).toMatch(
          /^(?:v4:\d{1,3}(?:\.\d{1,3}){3}|v6:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3}::\/64)$/,
        );
      }),
    );
  });

  it("ningún texto hace que falle: o da una clave con la forma esperada, o es desconocida", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 50 }), (value) => {
        const result = resolveClientIp(value, trusted);
        if (result.kind === "ip") {
          expect(result.key).toMatch(
            /^(?:v4:\d{1,3}(?:\.\d{1,3}){3}|v6:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3}::\/64)$/,
          );
        } else {
          expect(["absent", "malformed"]).toContain(result.reason);
        }
      }),
    );
  });
});
