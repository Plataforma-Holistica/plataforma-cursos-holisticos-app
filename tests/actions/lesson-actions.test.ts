import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones del reproductor de la lección (PA-22, T-203), con sus servicios simulados: qué
// le piden a la función única de medios y qué hacen con cada respuesta, y qué se guarda de los
// subtítulos, y el latido de presencia (T-204). Lo que los servicios hacen de verdad lo prueban
// sus pruebas de integración.

const mocks = vi.hoisted(() => ({
  getMediaGrant: vi.fn(),
  playbackPresence: vi.fn(),
  rememberCaptions: vi.fn(),
  cookieJar: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar }));
vi.mock("@/services/media/media", () => ({ getMediaGrant: mocks.getMediaGrant, playbackPresence: mocks.playbackPresence }));
vi.mock("@/services/account/account", () => ({ rememberCaptions: mocks.rememberCaptions }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { playbackPresenceAction, rememberCaptionsAction, watchLessonAction } from "@/app/cursos/[slug]/lecciones/[leccion]/actions";

const jar = { get: () => undefined, set: () => undefined };
const LESSON = "b0000000-0000-4000-8000-000000000002";
const PATH = `/cursos/respirar/lecciones/${LESSON}`;
const PLAYBACK = "d0000000-0000-4000-8000-000000000004";
const OTHER = "d0000000-0000-4000-8000-000000000005";

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
      playbackSessionId: PLAYBACK,
      heartbeatSeconds: 30,
    });
    const answer = await watchLessonAction("respirar", LESSON);
    expect(mocks.getMediaGrant).toHaveBeenCalledExactlyOnceWith(jar, LESSON, "watch", { closing: undefined });
    expect(answer).toEqual({
      kind: "granted",
      playbackId: "P",
      tokens: { playback: "v", thumbnail: "t", storyboard: "s" },
      speeds: [1],
      watermark: "ana@correo.com",
      playbackSessionId: PLAYBACK,
      heartbeatSeconds: 30,
    });
    // Nada de la base de acceso viaja al navegador.
    expect(JSON.stringify(answer)).not.toMatch(/basis|countsForPayout|until|expiresAt/);
  });

  it("lo que no tiene forma lo revisa la función: se le pasa tal cual", async () => {
    mocks.getMediaGrant.mockResolvedValue({ kind: "no_video" });
    expect(await watchLessonAction("respirar", { otra: "cosa" })).toEqual({ kind: "no_video" });
    expect(mocks.getMediaGrant).toHaveBeenCalledWith(jar, { otra: "cosa" }, "watch", { closing: undefined });
  });

  it("la reproducción que se pide cerrar viaja tal cual: la función la revisa", async () => {
    mocks.getMediaGrant.mockResolvedValue({ kind: "busy", live: [] });
    expect(await watchLessonAction("respirar", LESSON, OTHER)).toEqual({ kind: "busy", live: [] });
    expect(mocks.getMediaGrant).toHaveBeenCalledExactlyOnceWith(jar, LESSON, "watch", { closing: OTHER });
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

describe("rememberCaptionsAction", () => {
  it.each([true, false])("guarda %s en la cuenta de la sesión que pide", async (on) => {
    mocks.rememberCaptions.mockResolvedValue({ kind: "saved", on });
    await rememberCaptionsAction(on);
    expect(mocks.rememberCaptions).toHaveBeenCalledExactlyOnceWith(jar, on);
  });

  it.each([["sí"], [1], [null], [undefined], [{ on: true }]])("lo que no es encendido o apagado (%j) no se guarda", async (value) => {
    await rememberCaptionsAction(value);
    expect(mocks.rememberCaptions).not.toHaveBeenCalled();
  });

  it("no le dice nada al navegador, tampoco si no se guardó", async () => {
    mocks.rememberCaptions.mockResolvedValue({ kind: "unavailable" });
    expect(await rememberCaptionsAction(true)).toBeUndefined();
  });
});

describe("playbackPresenceAction (T-204)", () => {
  it("late la reproducción tal cual llegó, y dice si sigue", async () => {
    mocks.playbackPresence.mockResolvedValue({ kind: "ok" });
    expect(await playbackPresenceAction("respirar", LESSON, PLAYBACK)).toEqual({ kind: "ok" });
    expect(mocks.playbackPresence).toHaveBeenCalledExactlyOnceWith(jar, PLAYBACK);
  });

  it("cerrada desde otro dispositivo: con la que tomó su lugar", async () => {
    mocks.playbackPresence.mockResolvedValue({ kind: "revoked", reason: "closed_by_user", by: OTHER });
    expect(await playbackPresenceAction("respirar", LESSON, PLAYBACK)).toEqual({ kind: "closed", from: "device", by: OTHER });
  });

  it.each([[{ kind: "suspended" }], [{ kind: "refused" }], [{ kind: "revoked", reason: "session_closed", by: null }]])(
    "%j: a la página de la lección, donde decide su guarda",
    async (answer) => {
      mocks.playbackPresence.mockResolvedValue(answer);
      await expect(playbackPresenceAction("respirar", LESSON, PLAYBACK)).rejects.toThrow(`redirige a ${PATH}`);
    },
  );

  it("si lo que llegó no tiene forma de dirección, al inicio", async () => {
    mocks.playbackPresence.mockResolvedValue({ kind: "refused" });
    await expect(playbackPresenceAction(null, LESSON, PLAYBACK)).rejects.toThrow("redirige a /inicio");
  });
});
