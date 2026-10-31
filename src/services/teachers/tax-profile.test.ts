import { createHash, randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { clabeCheckDigit } from "@/domain/fiscal/clabe";

import { createTaxCipher } from "./tax-cipher";
import { createTaxProfile, type PasswordCheck, type TaxProfileDeps, type TaxProfileRow, type TaxStore } from "./tax-profile";

// El servicio de los datos fiscales, con el cifrado de verdad y lo demás simulado: en qué orden pregunta, qué hace con cada respuesta,
// y que nada en claro salga de aquí. La base y Auth, en tests/integration/83-datos-fiscales.test.ts.

const TEACHER = "b0000000-0000-4000-8000-000000000002";
const PAYOUT = "d0000000-0000-4000-8000-000000000003";
const claims = { userId: "a0000000-0000-4000-8000-000000000001", sessionId: "s", email: "ana@prueba.test" } as never;
const jar = { get: () => undefined, set: () => undefined } as never;
const origin = { ip: "203.0.113.1", userAgent: "prueba" } as never;
const first17 = "01218000123456789";
const CLABE = `${first17}${clabeCheckDigit(first17)}`;
const RFC = "GODE561231GR8";
const NAME = "Elena Gómez Díaz";
const FORM = { rfc: RFC, regime: "626", legalName: NAME, clabe: CLABE, seen: 0, password: "la-de-ella" };
const AT = "2026-10-31T18:00:00.000Z";

function keyEntry(raw: Buffer = randomBytes(32)): string {
  return `1:${raw.toString("base64")}:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}
const KEYS = keyEntry();
const workingCipher = () => createTaxCipher(() => ({ keys: KEYS, active: "1" }));

let order: string[];
let confirm: PasswordCheck;
let saved: Parameters<TaxStore["save"]>[1] | null;
let saveAnswer: Awaited<ReturnType<TaxStore["save"]>>;
let stored: TaxProfileRow | null;
let reports: string[];
let standing: Awaited<ReturnType<TaxProfileDeps["standing"]>>;

function sealedRow(cipher: ReturnType<typeof workingCipher>): TaxProfileRow {
  const last4 = CLABE.slice(-4);
  return {
    teacherId: TEACHER,
    version: 3,
    regime: "626",
    payee: "person",
    last4,
    updatedAt: AT,
    rfc: cipher.seal({ teacher: TEACHER, rowVersion: 3, field: "rfc" }, RFC),
    legalName: cipher.seal({ teacher: TEACHER, rowVersion: 3, field: "legal_name" }, NAME),
    clabe: cipher.seal({ teacher: TEACHER, rowVersion: 3, field: "clabe", last4 }, CLABE),
  };
}

function service(cipher: TaxProfileDeps["cipher"]) {
  const store: TaxStore = {
    state: () => Promise.resolve({ version: 3, updatedAt: AT }),
    mine: () => {
      order.push("mine");
      return Promise.resolve(stored === null ? { outcome: "no_profile" as const } : { outcome: "ok" as const, row: stored });
    },
    save: (_claims, row) => {
      order.push("save");
      saved = row;
      return Promise.resolve(saveAnswer);
    },
    forPayout: (_claims, payout) => {
      order.push(`forPayout:${payout}`);
      return Promise.resolve(stored === null ? { outcome: "no_profile" as const } : { outcome: "ok" as const, row: stored });
    },
  };
  return createTaxProfile({
    store,
    cipher,
    confirmPassword: () => {
      order.push("confirm");
      return Promise.resolve(confirm);
    },
    standing: () => {
      order.push("standing");
      return Promise.resolve(standing);
    },
    checkSession: () => Promise.resolve({ kind: "pass", claims } as never),
    report: (code) => {
      reports.push(code);
      return Promise.resolve();
    },
  });
}

beforeEach(() => {
  order = [];
  confirm = { kind: "confirmed", claims };
  saved = null;
  saveAnswer = "saved";
  stored = null;
  reports = [];
  standing = { state: "active", teacher: { id: TEACHER } };
});

describe("guardar", () => {
  it("revisa lo escrito antes de pedir la contraseña: un error de forma no cuenta como intento", async () => {
    const result = await service(workingCipher()).saveTaxProfile(jar, { ...FORM, clabe: "123" }, origin);
    expect(result).toEqual({ kind: "invalid", problems: { clabe: "length" } });
    expect(order).toEqual([]);
  });

  it("sin contraseña no pregunta a nadie", async () => {
    const result = await service(workingCipher()).saveTaxProfile(jar, { ...FORM, password: "" }, origin);
    expect(result).toEqual({ kind: "wrong_password" });
    expect(order).toEqual([]);
  });

  it("en orden: la contraseña, quién es, y guarda cifrado con la versión que sigue a la vista", async () => {
    const cipher = workingCipher();
    expect(await service(cipher).saveTaxProfile(jar, { ...FORM, seen: 4 }, origin)).toEqual({ kind: "saved" });
    expect(order).toEqual(["confirm", "standing", "save"]);
    expect(saved).not.toBeNull();
    const row = saved!;
    expect(row).toMatchObject({ teacher: TEACHER, seen: 4, regime: "626", payee: "person", last4: CLABE.slice(-4), keyVersion: 1 });
    expect(cipher.open({ teacher: TEACHER, rowVersion: 5, field: "rfc" }, row.rfc)).toBe(RFC);
    expect(cipher.open({ teacher: TEACHER, rowVersion: 5, field: "legal_name" }, row.legalName)).toBe(NAME);
    expect(cipher.open({ teacher: TEACHER, rowVersion: 5, field: "clabe", last4: CLABE.slice(-4) }, row.clabe)).toBe(CLABE);
  });

  it("a la base no le llega nada en claro", async () => {
    await service(workingCipher()).saveTaxProfile(jar, FORM, origin);
    for (const value of [saved!.rfc, saved!.legalName, saved!.clabe]) {
      const text = Buffer.from(value).toString("latin1");
      for (const plain of [RFC, CLABE, "Elena"]) expect(text).not.toContain(plain);
    }
  });

  it.each<[string, PasswordCheck, object]>([
    ["equivocada", { kind: "wrong" }, { kind: "wrong_password" }],
    ["frenada", { kind: "throttled", retryAt: new Date(AT) }, { kind: "throttled", retryAt: new Date(AT) }],
    ["con tope", { kind: "capped" }, { kind: "capped" }],
    ["no se supo", { kind: "unavailable" }, { kind: "unavailable" }],
    ["sin sesión", { kind: "session", check: { kind: "no_session" } as never }, { kind: "session", check: { kind: "no_session" } }],
  ])("con la contraseña %s no sigue", async (_name, answer, expected) => {
    confirm = answer;
    expect(await service(workingCipher()).saveTaxProfile(jar, FORM, origin)).toEqual(expected);
    expect(order).toEqual(["confirm"]);
  });

  it.each<[string, Awaited<ReturnType<TaxProfileDeps["standing"]>>, object]>([
    ["suspendido", { state: "suspended", teacher: { id: TEACHER }, notice: null }, { kind: "suspended" }],
    ["con el aviso pendiente", { state: "needs_notice", teacher: { id: TEACHER } }, { kind: "not_teacher" }],
    ["que no es maestro", { state: "none" }, { kind: "not_teacher" }],
  ])("un maestro %s no llega a guardar", async (_name, answer, expected) => {
    standing = answer;
    expect(await service(workingCipher()).saveTaxProfile(jar, FORM, origin)).toEqual(expected);
    expect(order).toEqual(["confirm", "standing"]);
  });

  it.each([
    ["changed", { kind: "changed" }],
    ["suspended", { kind: "suspended" }],
    ["needs_notice", { kind: "not_teacher" }],
    ["not_teacher", { kind: "not_teacher" }],
  ] as const)("la base contesta %s", async (answer, expected) => {
    saveAnswer = answer;
    expect(await service(workingCipher()).saveTaxProfile(jar, FORM, origin)).toEqual(expected);
    expect(reports).toEqual([]);
  });

  it("si la base no reconoce la forma de lo cifrado, es una falla de código: se reporta", async () => {
    saveAnswer = "invalid";
    expect(await service(workingCipher()).saveTaxProfile(jar, FORM, origin)).toEqual({ kind: "unavailable" });
    expect(reports).toEqual(["tax_profile_unavailable"]);
  });

  it("sin llave no pide la contraseña, no guarda y lo reporta", async () => {
    const off = createTaxCipher(() => ({ keys: undefined, active: undefined }));
    expect(await service(off).saveTaxProfile(jar, FORM, origin)).toEqual({ kind: "off" });
    expect(order).toEqual([]);
    expect(reports).toEqual(["tax_cipher_unavailable"]);
  });

  it("nunca devuelve lo escrito", async () => {
    const answers = [
      await service(workingCipher()).saveTaxProfile(jar, FORM, origin),
      await service(workingCipher()).saveTaxProfile(jar, { ...FORM, clabe: "123" }, origin),
    ];
    const text = JSON.stringify(answers);
    for (const plain of [RFC, NAME, CLABE, FORM.password]) expect(text).not.toContain(plain);
  });
});

describe("ver lo guardado", () => {
  it("pide la contraseña, lee y devuelve solo los últimos cuatro", async () => {
    const cipher = workingCipher();
    stored = sealedRow(cipher);
    const result = await service(cipher).revealTaxProfile(jar, "la-de-ella", origin);
    expect(order).toEqual(["confirm", "mine"]);
    expect(result).toEqual({
      kind: "revealed",
      data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: `•••• ${CLABE.slice(-4)}`, updatedAt: AT },
    });
    const text = JSON.stringify(result);
    for (const plain of [RFC, NAME, CLABE]) expect(text).not.toContain(plain);
  });

  it("sin contraseña no lee: una lectura queda en la auditoría", async () => {
    expect(await service(workingCipher()).revealTaxProfile(jar, "", origin)).toEqual({ kind: "wrong_password" });
    expect(order).toEqual([]);
  });

  it("con la contraseña equivocada no lee", async () => {
    confirm = { kind: "wrong" };
    expect(await service(workingCipher()).revealTaxProfile(jar, "otra", origin)).toEqual({ kind: "wrong_password" });
    expect(order).toEqual(["confirm"]);
  });

  it("sin llave no pide la contraseña ni lee: no quedaría una lectura que nadie vio", async () => {
    const off = createTaxCipher(() => ({ keys: undefined, active: undefined }));
    expect(await service(off).revealTaxProfile(jar, "la-de-ella", origin)).toEqual({ kind: "off" });
    expect(order).toEqual([]);
  });

  it("sin datos lo dice", async () => {
    expect(await service(workingCipher()).revealTaxProfile(jar, "la-de-ella", origin)).toEqual({ kind: "no_profile" });
  });

  it("lo que no abre no se muestra, y se reporta", async () => {
    const cipher = workingCipher();
    const row = sealedRow(cipher);
    stored = { ...row, version: 4 };
    expect(await service(cipher).revealTaxProfile(jar, "la-de-ella", origin)).toEqual({ kind: "unavailable" });
    expect(reports).toEqual(["tax_profile_unreadable"]);
  });

  it("con otra llave tampoco", async () => {
    stored = sealedRow(workingCipher());
    const other = createTaxCipher(() => ({ keys: keyEntry(), active: "1" }));
    expect(await service(other).revealTaxProfile(jar, "la-de-ella", origin)).toEqual({ kind: "unavailable" });
    expect(reports).toEqual(["tax_profile_unreadable"]);
  });
});

describe("finanzas lee por una liquidación", () => {
  it("un identificador sin forma no llega a la base", async () => {
    expect(await service(workingCipher()).taxProfileForPayout(jar, "x")).toEqual({ kind: "not_found" });
    expect(order).toEqual([]);
  });

  it("devuelve los datos completos: con ellos se paga", async () => {
    const cipher = workingCipher();
    stored = sealedRow(cipher);
    expect(await service(cipher).taxProfileForPayout(jar, PAYOUT)).toEqual({
      kind: "ok",
      data: { rfc: RFC, legalName: NAME, regime: "626", payee: "person", clabe: CLABE, version: 3, updatedAt: AT },
    });
    expect(order).toEqual([`forPayout:${PAYOUT}`]);
  });
});
