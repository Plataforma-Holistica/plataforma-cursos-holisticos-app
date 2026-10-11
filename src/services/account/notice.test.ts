import { describe, expect, it } from "vitest";

import { createNotices, NOTICE_MAX_AGE_SECONDS, NOTICES } from "./notice";

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

describe("el aviso que una pantalla le deja a la siguiente", () => {
  it("lo que se deja es lo que se lee", () => {
    const notices = createNotices({ secure: () => true });
    for (const notice of NOTICES) {
      const jar = jarOf();
      notices.leaveNotice(jar, notice);
      expect(notices.readNotice(jar)).toBe(notice);
    }
  });

  it("dura un minuto y no la lee el código de la página", () => {
    const jar = jarOf();
    createNotices({ secure: () => true }).leaveNotice(jar, "password_changed");
    expect(NOTICE_MAX_AGE_SECONDS).toBe(60);
    expect(jar.writes).toEqual([
      {
        name: "__Host-plataforma-aviso",
        value: "password_changed",
        options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 },
      },
    ]);
  });

  it("sin https no lleva el prefijo ni `Secure`: un navegador la rechazaría", () => {
    const jar = jarOf();
    const notices = createNotices({ secure: () => false });
    notices.leaveNotice(jar, "account_ready");
    expect(jar.writes[0]).toMatchObject({ name: "plataforma-aviso", options: { secure: false } });
    expect(notices.readNotice(jar)).toBe("account_ready");
  });

  it.each(["", "otra_cosa", "Tu contraseña se cambió", "password_changed ", "PASSWORD_CHANGED", "__proto__", "<b>hola</b>"])(
    "solo vale una clave de la lista: %s no dice nada",
    (value) => {
      const notices = createNotices({ secure: () => true });
      expect(notices.readNotice(jarOf({ "__Host-plataforma-aviso": value }))).toBeNull();
    },
  );

  it("sin cookie no hay aviso, y la del otro nombre no cuenta", () => {
    const notices = createNotices({ secure: () => true });
    expect(notices.readNotice(jarOf())).toBeNull();
    expect(notices.readNotice(jarOf({ "plataforma-aviso": "password_changed" }))).toBeNull();
  });

  it("borrarlo lo borra con sus mismos atributos, y solo si estaba", () => {
    const notices = createNotices({ secure: () => true });
    const jar = jarOf({ "__Host-plataforma-aviso": "password_changed" });
    notices.clearNotice(jar);
    expect(jar.writes).toEqual([
      { name: "__Host-plataforma-aviso", value: "", options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 } },
    ]);
    expect(notices.readNotice(jar)).toBeNull();

    const empty = jarOf();
    notices.clearNotice(empty);
    expect(empty.writes).toEqual([]);
  });
});
