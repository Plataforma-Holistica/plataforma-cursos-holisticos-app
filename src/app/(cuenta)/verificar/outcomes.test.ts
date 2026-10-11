import { describe, expect, it } from "vitest";

import { resendWait } from "./outcomes";

// La espera que pinta el botón «Reenviar» (diseño, PA-14, «Revisa tu correo»).

const NOW = Date.parse("2026-10-11T18:00:00.000Z");

describe("la espera que le queda a «Reenviar»", () => {
  it("recién enviado, falta la espera entera", () => {
    expect(resendWait(NOW, 60, NOW)).toEqual({ until: "2026-10-11T18:01:00.000Z", seconds: 60 });
  });

  it("a media espera, termina a la misma hora", () => {
    expect(resendWait(NOW - 20_000, 60, NOW)).toEqual({ until: "2026-10-11T18:00:40.000Z", seconds: 60 });
  });

  it("en el último milisegundo todavía falta", () => {
    expect(resendWait(NOW - 59_999, 60, NOW)).toEqual({ until: "2026-10-11T18:00:00.001Z", seconds: 60 });
  });

  it("cumplida la espera ya se puede", () => {
    expect(resendWait(NOW - 60_000, 60, NOW)).toBeNull();
    expect(resendWait(NOW - 3_600_000, 60, NOW)).toBeNull();
    expect(resendWait(0, 60, NOW)).toBeNull();
  });

  it("una hora de envío que todavía no llega cuenta como ahora: la cookie la escribe quien quiere", () => {
    expect(resendWait(NOW + 86_400_000, 60, NOW)).toEqual({ until: "2026-10-11T18:01:00.000Z", seconds: 60 });
    expect(resendWait(Number.MAX_SAFE_INTEGER, 60, NOW)).toEqual({ until: "2026-10-11T18:01:00.000Z", seconds: 60 });
  });

  it.each([
    [Number.NaN, 60, NOW],
    [Infinity, 60, NOW],
    [NOW, 60, Number.NaN],
    [NOW, 0, NOW],
    [NOW, -60, NOW],
    [NOW, 1.5, NOW],
    [NOW, Number.NaN, NOW],
    [NOW, 86_401, NOW],
  ])("con algo que no es una hora o una espera no hay espera que pintar: %s, %s, %s", (sentAt, wait, now) => {
    expect(resendWait(sentAt, wait, now)).toBeNull();
  });

  it("la espera más larga que se pinta es de un día", () => {
    expect(resendWait(NOW, 86_400, NOW)).toEqual({ until: "2026-10-12T18:00:00.000Z", seconds: 86_400 });
  });
});
