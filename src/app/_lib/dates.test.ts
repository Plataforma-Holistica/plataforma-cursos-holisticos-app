import { describe, expect, it } from "vitest";

import { clockTime, longDate, PRODUCT_TIME_ZONE } from "./dates";

describe("la fecha completa", () => {
  it("se escribe en la zona del centro de México, no en la del servidor", () => {
    // Las 06:00 UTC son la medianoche del centro de México: un segundo antes todavía es el día anterior.
    expect(longDate("2026-11-12T05:59:59.000Z")).toBe("11 de noviembre de 2026");
    expect(longDate("2026-11-12T06:00:00.000Z")).toBe("12 de noviembre de 2026");
    expect(PRODUCT_TIME_ZONE).toBe("America/Mexico_City");
  });

  it.each(["", "x", "2026-13-40", "no es una fecha"])("una fecha que no se entiende no pinta nada: %j", (iso) => {
    expect(longDate(iso)).toBe("");
    expect(clockTime(iso)).toBe("");
    expect(clockTime(iso, PRODUCT_TIME_ZONE)).toBe("");
  });
});

describe("la hora", () => {
  it("en la zona que se pida", () => {
    expect(clockTime("2026-10-11T18:30:00.000Z", PRODUCT_TIME_ZONE)).toMatch(/^12:30/);
    expect(clockTime("2026-10-11T18:30:00.000Z", "Asia/Tokyo")).toMatch(/^3:30/);
    expect(clockTime("2026-10-11T18:05:00.000Z", "UTC")).toMatch(/^6:05/);
  });
});
