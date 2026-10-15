import { beforeEach, describe, expect, it, vi } from "vitest";

// La acción del reproductor de la lección (PA-22, T-203), con la función única de medios
// simulada: qué le pide y qué hace con cada respuesta. Lo que la función hace de verdad lo
// prueban sus pruebas de integración.

const mocks = vi.hoisted(() => ({
  getMediaGrant: vi.fn(),
  cookieJar: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/media/media", () => ({ getMediaGrant: mocks.getMediaGrant }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { watchLessonAction } from "@/app/cursos/[slug]/lecciones/[leccion]/actions";

const jar = { get: () => undefined, set: () => undefined };
const LESSON = "b0000000-0000-4000-8000-000000000002";
const PATH = `/cursos/respirar/lecciones/${LESSON}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieJar.mockResolvedValue(jar);
});

describe("watchLessonAction", () => {
  it("pide como el alumno, con la lección tal cual, y devuelve el video con la marca y las velocidades", async () => {
    mocks.getMediaGrant.mockResolvedValue({
      kind: "granted",
      playbackId: "P",
      tokens: { video: "v", thumbnail: "t", storyboard: "s" },
      expiresAt: 9,
      speeds: [1],
      watermark: "ana@correo.com",
      basis: "subscription",
      countsForPayout: true,
      until: null,
    });
    const answer = await watchLessonAction("respirar", LESSON);
    expect(mocks.getMediaGrant).toHaveBeenCalledExactlyOnceWith(jar, LESSON, "watch");
    expect(answer).toEqual({ kind: "granted", playbackId: "P", tokens: { playback: "v", thumbnail: "t", storyboard: "s" }, speeds: [1], watermark: "ana@correo.com" });
    // Nada de la base de acceso viaja al navegador.
    expect(JSON.stringify(answer)).not.toMatch(/basis|countsForPayout|until|expiresAt/);
  });

  it("lo que no tiene forma lo revisa la función: se le pasa tal cual", async () => {
    mocks.getMediaGrant.mockResolvedValue({ kind: "no_video" });
    expect(await watchLessonAction("respirar", { otra: "cosa" })).toEqual({ kind: "no_video" });
    expect(mocks.getMediaGrant).toHaveBeenCalledWith(jar, { otra: "cosa" }, "watch");
  });

  it.each([[{ kind: "suspended" }], [{ kind: "refused" }]])("%j: a la página de la lección, donde decide su guarda", async (grant) => {
    mocks.getMediaGrant.mockResolvedValue(grant);
    await expect(watchLessonAction("respirar", LESSON)).rejects.toThrow(`redirige a ${PATH}`);
  });

  it("si lo que llegó no tiene forma de dirección, al inicio", async () => {
    mocks.getMediaGrant.mockResolvedValue({ kind: "refused" });
    await expect(watchLessonAction("../otro", LESSON)).rejects.toThrow("redirige a /inicio");
    await expect(watchLessonAction(7, LESSON)).rejects.toThrow("redirige a /inicio");
  });
});
