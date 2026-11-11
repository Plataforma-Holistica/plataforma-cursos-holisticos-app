import { describe, expect, it } from "vitest";

import { createPendingRegistration, PENDING_REGISTRATION_MAX_AGE_LIMIT } from "./pending-registration";

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

const SECURE = "__Host-plataforma-registro";
const PLAIN = "plataforma-registro";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("el correo de un registro a medias, para decir «revisa tu correo»", () => {
  it("lo que se guarda es lo que se lee", () => {
    const pending = createPendingRegistration({ secure: () => true });
    const jar = jarOf();
    pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 1_791_744_000_000 }, 3_600);
    expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 1_791_744_000_000 });
  });

  it("no la lee el código de la página, dura lo que se le pide y va solo por https", () => {
    const jar = jarOf();
    createPendingRegistration({ secure: () => true }).rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5 }, 3_600);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]).toMatchObject({
      name: SECURE,
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3_600 },
    });
    // El valor no lleva el correo a la vista ni caracteres que una cookie no admite.
    expect(jar.writes[0]?.value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jar.writes[0]?.value).not.toContain("ana");
  });

  it("sin https no lleva el prefijo ni `Secure`", () => {
    const pending = createPendingRegistration({ secure: () => false });
    const jar = jarOf();
    pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5 }, 60);
    expect(jar.writes[0]).toMatchObject({ name: PLAIN, options: { secure: false } });
    expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 5 });
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, PENDING_REGISTRATION_MAX_AGE_LIMIT + 1])(
    "con una vida que no tiene sentido (%s) no guarda nada",
    (maxAge) => {
      const jar = jarOf();
      createPendingRegistration({ secure: () => true }).rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5 }, maxAge);
      expect(jar.writes).toEqual([]);
    },
  );

  it("guarda el correo ya normalizado, y uno sin forma no se guarda", () => {
    const pending = createPendingRegistration({ secure: () => true });
    const jar = jarOf();
    pending.rememberRegistration(jar, { email: "  Ana@Prueba.TEST ", sentAt: 5 }, 60);
    expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 5 });

    const empty = jarOf();
    pending.rememberRegistration(empty, { email: "no es un correo", sentAt: 5 }, 60);
    expect(empty.writes).toEqual([]);
  });

  it.each([
    ["no es base64", "%%%"],
    ["no es JSON", Buffer.from("hola").toString("base64url")],
    ["una lista", encode(["ana@prueba.test", 5])],
    ["sin correo", encode({ t: 5 })],
    ["correo sin forma", encode({ e: "no es un correo", t: 5 })],
    ["correo que no es texto", encode({ e: 42, t: 5 })],
    ["correo sin normalizar", encode({ e: "Ana@Prueba.test", t: 5 })],
    ["sin hora", encode({ e: "ana@prueba.test" })],
    ["hora que no es un entero", encode({ e: "ana@prueba.test", t: "5" })],
    ["hora negativa", encode({ e: "ana@prueba.test", t: -1 })],
    ["hora con decimales", encode({ e: "ana@prueba.test", t: 1.5 })],
    ["con campos de más", encode({ e: "ana@prueba.test", t: 5, admin: true })],
    ["vacía", ""],
    ["enorme", encode({ e: `${"a".repeat(5_000)}@prueba.test`, t: 5 })],
  ])("una cookie que no escribió este código (%s) cuenta como ausente", (_name, value) => {
    const pending = createPendingRegistration({ secure: () => true });
    expect(pending.readRegistration(jarOf({ [SECURE]: value }))).toBeNull();
  });

  it("sin cookie no hay registro a medias, y la del otro nombre no cuenta", () => {
    const pending = createPendingRegistration({ secure: () => true });
    expect(pending.readRegistration(jarOf())).toBeNull();
    expect(pending.readRegistration(jarOf({ [PLAIN]: encode({ e: "ana@prueba.test", t: 5 }) }))).toBeNull();
  });

  it("olvidarla la borra con sus mismos atributos, y solo si estaba", () => {
    const pending = createPendingRegistration({ secure: () => true });
    const jar = jarOf({ [SECURE]: encode({ e: "ana@prueba.test", t: 5 }) });
    pending.forgetRegistration(jar);
    expect(jar.writes).toEqual([
      { name: SECURE, value: "", options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 } },
    ]);
    expect(pending.readRegistration(jar)).toBeNull();

    const empty = jarOf();
    pending.forgetRegistration(empty);
    expect(empty.writes).toEqual([]);
  });
});

describe("el destino de un registro a medias (FL-04: volver a donde se iba al completar la cuenta)", () => {
  const pending = createPendingRegistration({ secure: () => true });

  it("un destino permitido se guarda y se lee", () => {
    const jar = jarOf();
    pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5, returnTo: "/planes?plan=anual" }, 60);
    expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 5, returnTo: "/planes?plan=anual" });
  });

  it.each(["https://otro.example/planes", "//otro.example", "/registro", "/entrar?volver=/inicio", "", "/planes/../admin"])(
    "un destino que la lista no admite (%j) no se guarda, y el registro se anota igual",
    (returnTo) => {
      const jar = jarOf();
      pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5, returnTo }, 60);
      expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 5 });
      expect(JSON.parse(Buffer.from(jar.writes[0]?.value ?? "", "base64url").toString("utf8"))).toEqual({ e: "ana@prueba.test", t: 5 });
    },
  );

  it("un destino largo no deja ilegible la cookie: se guarda sin él", () => {
    const jar = jarOf();
    const long = `/planes?x=${"a".repeat(600)}`;
    pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5, returnTo: long }, 60);
    expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 5 });
    expect((jar.writes[0]?.value ?? "").length).toBeLessThanOrEqual(1_024);
  });

  it("un correo largo y un destino que juntos no caben en la cookie: se guarda el correo, sin destino", () => {
    const jar = jarOf();
    const email = `${"a".repeat(64)}@${`${"b".repeat(60)}.`.repeat(3)}test`;
    pending.rememberRegistration(jar, { email, sentAt: 5, returnTo: `/planes?x=${"a".repeat(495)}` }, 60);
    expect(jar.writes).toHaveLength(1);
    expect((jar.writes[0]?.value ?? "").length).toBeLessThanOrEqual(1_024);
    expect(pending.readRegistration(jar)).toEqual({ email, sentAt: 5 });
  });

  it("una cookie de antes, sin destino, sigue valiendo", () => {
    expect(pending.readRegistration(jarOf({ [SECURE]: encode({ e: "ana@prueba.test", t: 5 }) }))).toEqual({ email: "ana@prueba.test", sentAt: 5 });
  });

  it.each([["https://otro.example"], ["/registro"], [`/planes?x=${"a".repeat(600)}`], [7], [null]])(
    "un destino que este código no habría escrito (%j) se lee como sin destino: no se confía en la cookie",
    (r) => {
      expect(pending.readRegistration(jarOf({ [SECURE]: encode({ e: "ana@prueba.test", t: 5, r }) }))).toEqual({ email: "ana@prueba.test", sentAt: 5 });
    },
  );

  it("anotar otra vez sin destino borra el de antes", () => {
    const jar = jarOf();
    pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 5, returnTo: "/planes?plan=anual" }, 60);
    pending.rememberRegistration(jar, { email: "ana@prueba.test", sentAt: 6 }, 60);
    expect(pending.readRegistration(jar)).toEqual({ email: "ana@prueba.test", sentAt: 6 });
  });
});
