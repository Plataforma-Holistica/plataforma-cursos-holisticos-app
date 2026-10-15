import { render } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// El reproductor de la pantalla de revisión (`player.tsx`), con Mux Player cambiado por uno de
// mentira: qué props recibe, qué apaga en el `<video>` interno y qué hace con cada error. Que
// Mux Player de verdad no salga a terceros lo prueba el extremo a extremo.

const mux = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  element: null as null | { media: { setAttribute: ReturnType<typeof vi.fn>; nativeEl: { disableRemotePlayback: boolean; disablePictureInPicture: boolean } }; currentTime: number; error: unknown },
}));
// Se llama una vez, al cargar el módulo: se anota aparte, porque las pruebas limpian las simulaciones.
const i18n = vi.hoisted(() => {
  const languages: string[] = [];
  return { languages, setLanguage: (language: string) => void languages.push(language) };
});

vi.mock("media-chrome/dist/lang/es.js", () => ({}));
vi.mock("media-chrome/dist/utils/i18n.js", () => i18n);
vi.mock("@mux/mux-player-react", () => ({
  default: forwardRef<unknown, Record<string, unknown>>(function FakeMuxPlayer(props, ref) {
    mux.props = props;
    const element = {
      media: { setAttribute: vi.fn(), nativeEl: { disableRemotePlayback: false, disablePictureInPicture: false } },
      currentTime: 42,
      error: null as unknown,
    };
    mux.element = element;
    useImperativeHandle(ref, () => element);
    return null;
  }),
}));

import { TOKEN_EXPIRED } from "@/app/admin/_revision/outcomes";
import { Player } from "@/app/admin/_revision/player";

const TOKENS = { playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" };

function show() {
  const onExpired = vi.fn();
  const onFailed = vi.fn();
  const onPlaying = vi.fn();
  render(<Player playbackId="PlaybackDePrueba" tokens={TOKENS} startTime={7} onExpired={onExpired} onFailed={onFailed} onPlaying={onPlaying} />);
  /** Lo que haría Mux Player al fallar: el error en `detail`, o solo en el elemento. */
  const fail = (detail: unknown, onElement = false) => {
    if (onElement) {
      if (mux.element) mux.element.error = detail;
      (mux.props?.onError as (event: unknown) => void)({ target: mux.element });
    } else {
      (mux.props?.onError as (event: unknown) => void)({ target: mux.element, detail });
    }
  };
  return { onExpired, onFailed, onPlaying, fail };
}

beforeEach(() => {
  mux.props = null;
  mux.element = null;
});

describe("el reproductor", () => {
  it("recibe el video, sus tres tokens y el segundo; sin analítica, sin cookies y sin recordar volumen", () => {
    show();
    const { ref: _ref, onError: _error, onPlaying: _playing, ...rest } = mux.props ?? {};
    void _ref;
    void _error;
    void _playing;
    expect(rest).toEqual({
      className: "block aspect-video w-full",
      playbackId: "PlaybackDePrueba",
      tokens: TOKENS,
      startTime: 7,
      disableTracking: true,
      disableCookies: true,
      noVolumePref: true,
      noMutedPref: true,
    });
  });

  it("apaga en el video interno el envío a otra pantalla y la imagen dentro de imagen", () => {
    show();
    expect(mux.element?.media.setAttribute).toHaveBeenCalledWith("disableremoteplayback", "");
    expect(mux.element?.media.setAttribute).toHaveBeenCalledWith("disablepictureinpicture", "");
    expect(mux.element?.media.nativeEl).toEqual({ disableRemotePlayback: true, disablePictureInPicture: true });
  });

  it("deja los controles en español", () => {
    expect(i18n.languages).toEqual(["es"]);
  });

  it("un error que Mux no da por fatal (reconectando): nada, Mux lo resuelve", () => {
    const { onExpired, onFailed, fail } = show();
    fail({ fatal: false, muxCode: 2000003 });
    fail({ fatal: false, muxCode: TOKEN_EXPIRED });
    expect(onExpired).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("la dirección caducó: lo dice, con el segundo en que iba", () => {
    const { onExpired, onFailed, fail } = show();
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    expect(onExpired).toHaveBeenCalledExactlyOnceWith(42);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("también si el error solo está en el elemento", () => {
    const { onExpired, fail } = show();
    fail({ fatal: true, muxCode: TOKEN_EXPIRED }, true);
    expect(onExpired).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("cualquier otro error fatal, o uno sin forma: falla", () => {
    const { onExpired, onFailed, fail } = show();
    fail({ fatal: true, muxCode: 2404000 });
    fail(null);
    expect(onFailed).toHaveBeenCalledTimes(2);
    expect(onExpired).not.toHaveBeenCalled();
  });
});
