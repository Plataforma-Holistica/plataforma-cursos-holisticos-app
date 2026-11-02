import { describe, expect, it } from "vitest";

import { clabeWaitingText } from "./clabe-wait";

describe("lo que se dice mientras la CLABE espera", () => {
  it("la fecha y la hora van en la zona del producto, no en la del servidor", () => {
    // Las 05:30 UTC del 12 siguen siendo el 11 en el centro de México.
    const said = clabeWaitingText("2026-11-12T05:30:00.000Z");
    expect(said).toContain("11 de noviembre de 2026");
    expect(said).toMatch(/23:30|11:30/);
    expect(said).toContain("hora del centro de México");
  });

  it("dice qué hacer si no fue quien lee", () => {
    expect(clabeWaitingText("2026-11-12T05:30:00.000Z")).toContain("cambia tu contraseña");
  });
});
