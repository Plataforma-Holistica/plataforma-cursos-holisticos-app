import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  GRANT_MARGIN_SECONDS,
  GRANT_MAX_SECONDS,
  grantLifetimeSeconds,
  mayRequestMedia,
  resolveMediaAccess,
  type MediaLesson,
  type MediaViewer,
} from "./media-access";

// La regla de quién recibe una dirección firmada (RF-305, RF-306) y cuánto dura (ADR-27).

const READY: MediaLesson = { isCurrent: true, provider: "mux", ready: true };
const CONTENT: MediaViewer = { kind: "team", content: true };

describe("resolveMediaAccess", () => {
  it("alguien del equipo con Contenido ve una lección lista, para revisar", () => {
    expect(resolveMediaAccess(CONTENT, READY)).toEqual({ ok: true, basis: "review" });
  });

  it.each<[string, MediaViewer]>([
    ["alguien que no es del equipo", { kind: "other" }],
    ["alguien del equipo sin Contenido", { kind: "team", content: false }],
  ])("%s no la ve, exista o no la lección", (_who, viewer) => {
    expect(resolveMediaAccess(viewer, READY)).toEqual({ ok: false, reason: "no_access" });
    expect(resolveMediaAccess(viewer, null)).toEqual({ ok: false, reason: "no_access" });
  });

  it.each<[string, MediaLesson | null]>([
    ["una lección que no existe", null],
    ["una retirada", { ...READY, isCurrent: false }],
    ["una con video de prueba", { ...READY, provider: "test" }],
    ["una con video sin terminar", { ...READY, ready: false }],
  ])("%s no tiene video que firmar", (_what, lesson) => {
    expect(resolveMediaAccess(CONTENT, lesson)).toEqual({ ok: false, reason: "no_video" });
  });
});

describe("mayRequestMedia", () => {
  it.each<[MediaViewer, boolean]>([
    [{ kind: "team", content: true }, true],
    [{ kind: "team", content: false }, false],
    [{ kind: "other" }, false],
  ])("%j: %s", (viewer, expected) => {
    expect(mayRequestMedia(viewer)).toBe(expected);
  });
});

describe("grantLifetimeSeconds", () => {
  it.each([
    ["una lección de 6 minutos a 0.75×", 356, 0.75, 475 + GRANT_MARGIN_SECONDS],
    ["una de 20 minutos a 0.75×", 1200, 0.75, 1600 + GRANT_MARGIN_SECONDS],
    ["una de 25 minutos a 0.75×: 43 minutos, bajo la hora", 1500, 0.75, 2000 + GRANT_MARGIN_SECONDS],
    ["una de 40 minutos: el tope", 2400, 0.75, GRANT_MAX_SECONDS],
    ["a velocidad normal", 600, 1, 600 + GRANT_MARGIN_SECONDS],
  ])("%s", (_what, duration, speed, expected) => {
    expect(grantLifetimeSeconds(duration, speed)).toBe(expected);
  });

  it("redondea hacia arriba: nunca caduca antes de terminar", () => {
    expect(grantLifetimeSeconds(1, 0.75)).toBe(2 + GRANT_MARGIN_SECONDS);
  });

  it.each([
    ["una duración cero", 0, 0.75],
    ["una duración negativa", -10, 0.75],
    ["una duración que no es un número", Number.NaN, 0.75],
    ["una velocidad cero", 600, 0],
    ["una velocidad negativa", 600, -1],
    ["una velocidad infinita", 600, Number.POSITIVE_INFINITY],
  ])("%s: nulo", (_what, duration, speed) => {
    expect(grantLifetimeSeconds(duration, speed)).toBeNull();
  });

  it("el tope es menos de una hora, y nada lo pasa", () => {
    expect(GRANT_MAX_SECONDS).toBeLessThan(3600);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.double({ min: 0.1, max: 4, noNaN: true }), (duration, speed) => {
        const life = grantLifetimeSeconds(duration, speed);
        expect(life).not.toBeNull();
        expect(life ?? 0).toBeLessThanOrEqual(GRANT_MAX_SECONDS);
        // Y alcanza para la lección entera a esa velocidad, o llega al tope.
        expect((life ?? 0) >= Math.min(duration / speed + GRANT_MARGIN_SECONDS, GRANT_MAX_SECONDS)).toBe(true);
      }),
    );
  });
});
