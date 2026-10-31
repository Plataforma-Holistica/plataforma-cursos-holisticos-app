import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTaxCipher, TaxCipherTampered, TaxCipherUnavailable, type SealedField, type TaxFieldContext } from "./tax-cipher";

// El cifrado de los datos fiscales (RF-510; 05 §10; T-409). Una columna cifrada no se copia a otro maestro, a otro campo ni a otra
// versión de la fila sin que falle al abrirla, y lo que no se puede abrir nunca devuelve otra cosa.

function keyEntry(version: number, raw: Buffer = randomBytes(32)): string {
  return `${version}:${raw.toString("base64")}:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

const TEACHER = "b0000000-0000-4000-8000-000000000002";
const OTHER = "b0000000-0000-4000-8000-000000000003";
const context: TaxFieldContext = { teacher: TEACHER, field: "rfc", rowVersion: 3 };
const clabeContext: TaxFieldContext = { teacher: TEACHER, field: "clabe", rowVersion: 3, last4: "7771" };

const K1 = keyEntry(1);
const K2 = keyEntry(2);
const cipherWith = (keys: string | undefined, ...active: [string?]) => createTaxCipher(() => ({ keys, active: active.length === 0 ? "1" : active[0] }));
const cipher = cipherWith(K1);

describe("cifrar y abrir", () => {
  it("lo cifrado se abre igual, con acentos y ñ", () => {
    for (const text of ["GOMA800101AB1", "Ñandú Peña y Asociados, S.A. de C.V.", "x"]) {
      expect(cipher.open(context, cipher.seal(context, text))).toBe(text);
    }
  });

  it("dos veces el mismo texto no da lo mismo: cada campo lleva su vector nuevo", () => {
    const one = cipher.seal(context, "GOMA800101AB1");
    const two = cipher.seal(context, "GOMA800101AB1");
    expect(Buffer.compare(one, two)).not.toBe(0);
    expect(one.subarray(3, 15).equals(two.subarray(3, 15))).toBe(false);
  });

  it("el formato: formato, versión de la llave, vector de 12, cifrado y etiqueta de 16", () => {
    const sealed = cipher.seal(clabeContext, "002010077777777771");
    expect(sealed[0]).toBe(1);
    expect(sealed.readUInt16BE(1)).toBe(1);
    // 1 + 2 + 12 + 18 + 16: la base exige este largo exacto en `clabe_enc`.
    expect(sealed.length).toBe(49);
  });

  it("lo cifrado no contiene el texto", () => {
    const sealed = cipher.seal(context, "GOMA800101AB1");
    expect(sealed.includes(Buffer.from("GOMA800101AB1"))).toBe(false);
  });

  it("dice con qué llave cifró", () => {
    expect(cipherWith(`${K1},${K2}`, "2").activeVersion()).toBe(2);
  });
});

describe("lo manipulado no se abre", () => {
  const sealed = cipher.seal(context, "GOMA800101AB1");

  it.each([
    ["otro maestro", { ...context, teacher: OTHER }],
    ["otro campo", { ...context, field: "legal_name" as const }],
    ["otra versión de la fila", { ...context, rowVersion: 4 }],
  ])("%s", (_name, other) => {
    expect(() => cipher.open(other, sealed)).toThrow(TaxCipherTampered);
  });

  it("la CLABE con otros últimos cuatro", () => {
    const clabe = cipher.seal(clabeContext, "002010077777777771");
    expect(() => cipher.open({ ...clabeContext, last4: "0000" }, clabe)).toThrow(TaxCipherTampered);
  });

  it("cualquier byte cambiado", () => {
    for (let position = 3; position < sealed.length; position += 1) {
      const changed = Buffer.from(sealed);
      changed[position] = (changed[position] ?? 0) ^ 1;
      expect(() => cipher.open(context, changed as SealedField), String(position)).toThrow(TaxCipherTampered);
    }
  });

  it.each([
    ["vacío", Buffer.alloc(0)],
    ["sin etiqueta", Buffer.alloc(20)],
    ["otro formato", Buffer.concat([Buffer.from([2]), Buffer.alloc(40)])],
  ])("%s", (_name, broken) => {
    expect(() => cipher.open(context, broken as SealedField)).toThrow(TaxCipherTampered);
  });

  it("el error no trae nada del dato ni de la llave", () => {
    const secret = randomBytes(32);
    const entry = keyEntry(1, secret);
    const own = cipherWith(entry);
    const changed = Buffer.from(own.seal(context, "GOMA800101AB1"));
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    try {
      own.open(context, changed as SealedField);
      throw new Error("abrió lo manipulado");
    } catch (error) {
      expect(error).toBeInstanceOf(TaxCipherTampered);
      const text = `${String(error)} ${(error as Error).stack ?? ""} ${String((error as Error).cause)}`;
      expect(text).not.toContain("GOMA");
      expect(text).not.toContain(secret.toString("base64"));
      expect(text).not.toContain(TEACHER);
    }
  });
});

describe("rotar", () => {
  it("con la llave nueva activa se sigue abriendo lo de la vieja, y lo nuevo sale con la nueva", () => {
    const old = cipherWith(K1).seal(context, "GOMA800101AB1");
    const both = cipherWith(`${K1},${K2}`, "2");
    expect(both.open(context, old)).toBe("GOMA800101AB1");
    expect(both.seal(context, "GOMA800101AB1").readUInt16BE(1)).toBe(2);
  });

  it("lo cifrado con una llave que ya no está es «no se puede», no «lo manipularon»", () => {
    const sealed = cipherWith(K2, "2").seal(context, "GOMA800101AB1");
    expect(() => cipherWith(K1).open(context, sealed)).toThrow(TaxCipherUnavailable);
  });

  it("nunca se prueban otras llaves: la versión del encabezado es parte de los datos asociados", () => {
    const raw = randomBytes(32);
    const same = cipherWith(`${keyEntry(1, raw)},${keyEntry(2, raw)}`, "1");
    const sealed = Buffer.from(same.seal(context, "GOMA800101AB1"));
    sealed.writeUInt16BE(2, 1);
    expect(() => same.open(context, sealed as SealedField)).toThrow(TaxCipherTampered);
  });
});

describe("sin llave no se cifra", () => {
  it.each([
    ["sin variables", undefined, undefined],
    ["sin la activa", K1, undefined],
    ["la activa no está en la lista", K1, "2"],
    ["una llave de otro largo", `1:${randomBytes(16).toString("base64")}:00000000`, "1"],
    ["la comprobación no coincide (mal pegada)", `1:${randomBytes(32).toString("base64")}:00000000`, "1"],
    ["versión repetida", `${K1},${keyEntry(1)}`, "1"],
    ["versión fuera de rango", keyEntry(70_000), "70000"],
    ["sin forma", "esto-no-es-una-llave", "1"],
  ])("%s: contesta que no se puede, nunca guarda en claro", (_name, keys, active) => {
    const broken = cipherWith(keys, active);
    expect(() => broken.seal(context, "GOMA800101AB1")).toThrow(TaxCipherUnavailable);
    expect(() => broken.open(context, Buffer.alloc(49) as SealedField)).toThrow(TaxCipherUnavailable);
    expect(broken.available()).toBe(false);
  });

  it("con llaves dice que se puede", () => {
    expect(cipher.available()).toBe(true);
  });

  it("el error no nombra la llave", () => {
    const entry = `1:${randomBytes(32).toString("base64")}:00000000`;
    try {
      cipherWith(entry).seal(context, "x");
      throw new Error("cifró");
    } catch (error) {
      expect(error).toBeInstanceOf(TaxCipherUnavailable);
      expect(String(error)).not.toContain(entry);
    }
  });
});
