import { describe, expect, it } from "vitest";

import type { OpenSession } from "@/services/account/account";

import { deviceName, sessionRows } from "./rows";

// Las sesiones abiertas, puestas en palabras (diseño, PA-25).

const session = (over: Partial<OpenSession> = {}): OpenSession => ({
  id: "5e560000-0000-0000-0000-000000000001",
  openedAt: "2026-10-10T18:00:00.000Z",
  lastActiveAt: "2026-10-12T06:30:00.000Z",
  device: { browser: "chrome", system: "windows" },
  current: false,
  ...over,
});

describe("de qué navegador y sistema dijo ser una sesión", () => {
  it.each([
    [{ browser: "chrome", system: "windows" }, "Chrome en Windows"],
    [{ browser: "edge", system: "macos" }, "Edge en macOS"],
    [{ browser: "firefox", system: "linux" }, "Firefox en Linux"],
    [{ browser: "safari", system: "ios" }, "Safari en iPhone o iPad"],
    [{ browser: "opera", system: "android" }, "Opera en Android"],
    [{ browser: "samsung", system: "chromeos" }, "Samsung Internet en ChromeOS"],
  ] as const)("%j: %s", (device, name) => {
    expect(deviceName(device)).toBe(name);
  });

  it("lo que no se reconoce se dice, y lo que sí, también", () => {
    expect(deviceName({ browser: "chrome", system: null })).toBe("Chrome");
    expect(deviceName({ browser: null, system: "android" })).toBe("Navegador desconocido en Android");
    expect(deviceName({ browser: null, system: null })).toBe("Navegador desconocido");
  });
});

describe("las filas de la lista", () => {
  it("cada sesión con su navegador, cuándo se abrió, su última actividad y lo que dice su botón", () => {
    expect(sessionRows([session()])).toEqual([
      {
        id: "5e560000-0000-0000-0000-000000000001",
        device: "Chrome en Windows",
        opened: "Se abrió el 10 de octubre de 2026.",
        lastActive: "Última actividad: 12 de octubre de 2026.",
        current: false,
        closeDetail: "la sesión de Chrome en Windows, abierta el 10 de octubre de 2026",
      },
    ]);
  });

  it("las fechas van en la zona del producto, no en la del servidor", () => {
    // Las 03:00 UTC del 12 son las 21:00 del 11 en el centro de México.
    const [row] = sessionRows([session({ openedAt: "2026-10-12T03:00:00.000Z", lastActiveAt: "2026-10-12T05:59:59.000Z" })]);
    expect(row?.opened).toBe("Se abrió el 11 de octubre de 2026.");
    expect(row?.lastActive).toBe("Última actividad: 11 de octubre de 2026.");
  });

  it("conserva el orden y cuál es la de ahora", () => {
    const rows = sessionRows([session({ id: "a", current: true }), session({ id: "b" }), session({ id: "c" })]);
    expect(rows.map((row) => [row.id, row.current])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
  });

  it("sin última actividad no dice ninguna", () => {
    expect(sessionRows([session({ lastActiveAt: null })])[0]?.lastActive).toBeNull();
  });

  it("de una fecha que no se entiende no inventa otra", () => {
    const [row] = sessionRows([session({ openedAt: "no es una fecha", lastActiveAt: "tampoco" })]);
    expect(row).toMatchObject({ opened: null, lastActive: null, closeDetail: "Chrome en Windows" });
  });

  it("sin sesiones no hay filas", () => {
    expect(sessionRows([])).toEqual([]);
  });
});
