import { act, render } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El reproductor compartido (`src/app/_video/player.tsx`; diseño, sección 5.4), con Mux Player
// cambiado por uno de mentira: qué props recibe, qué apaga en el `<video>` interno, qué hace
// con cada error, el contenedor propio que entra a pantalla completa y la marca de agua. Que
// Mux Player de verdad no salga a terceros, y la pantalla completa en un navegador, lo prueba
// el extremo a extremo.

interface FakeElement {
  media: { setAttribute: ReturnType<typeof vi.fn>; nativeEl: { disableRemotePlayback: boolean; disablePictureInPicture: boolean } };
  mediaController: { fullscreenElement: HTMLElement | null; setAttribute: ReturnType<typeof vi.fn> };
  currentTime: number;
  error: unknown;
  pause: ReturnType<typeof vi.fn>;
}

const mux = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  element: null as null | FakeElement,
}));
// Se llaman una vez, al cargar el módulo: se anotan aparte, porque las pruebas limpian las simulaciones.
const i18n = vi.hoisted(() => {
  const languages: string[] = [];
  const dictionaries: Record<string, Record<string, string>> = {};
  return {
    languages,
    dictionaries,
    setLanguage: (language: string) => void languages.push(language),
    addTranslation: (language: string, dictionary: Record<string, string>) => void (dictionaries[language] = dictionary),
  };
});

vi.mock("media-chrome/dist/lang/es.js", () => ({ Es: { Play: "Reproducir de fábrica", "Network Error": "Error de red" } }));
vi.mock("media-chrome/dist/utils/i18n.js", () => i18n);
vi.mock("@mux/mux-player-react", () => ({
  default: forwardRef<unknown, Record<string, unknown>>(function FakeMuxPlayer(props, ref) {
    mux.props = props;
    const element: FakeElement = mux.element ?? {
      media: { setAttribute: vi.fn(), nativeEl: { disableRemotePlayback: false, disablePictureInPicture: false } },
      mediaController: { fullscreenElement: null, setAttribute: vi.fn() },
      currentTime: 42,
      error: null,
      pause: vi.fn(),
    };
    mux.element = element;
    useImperativeHandle(ref, () => element);
    return <div data-testid="mux" />;
  }),
}));

import { TOKEN_EXPIRED } from "@/app/_video/errors";
import { Player } from "@/app/_video/player";
import { WATERMARK_FADE_MS, WATERMARK_INTERVAL_MS } from "@/app/_video/watermark-cells";

const TOKENS = { playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" };
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function show(watermark?: string) {
  const onExpired = vi.fn();
  const onFailed = vi.fn();
  const onPlaying = vi.fn();
  const view = render(
    <Player
      playbackId="PlaybackDePrueba"
      tokens={TOKENS}
      startTime={7}
      speeds={SPEEDS}
      watermark={watermark}
      onExpired={onExpired}
      onFailed={onFailed}
      onPlaying={onPlaying}
    />,
  );
  /** Lo que haría Mux Player al fallar: el error en `detail`, o solo en el elemento. */
  const fail = (detail: unknown, onElement = false) => {
    if (onElement) {
      if (mux.element) mux.element.error = detail;
      (mux.props?.onError as (event: unknown) => void)({ target: mux.element });
    } else {
      (mux.props?.onError as (event: unknown) => void)({ target: mux.element, detail });
    }
  };
  const frame = view.container.querySelector<HTMLElement>("[data-player-frame]");
  const mark = () => view.container.querySelector<HTMLElement>("[data-watermark]");
  return { onExpired, onFailed, onPlaying, fail, frame, mark, view };
}

beforeEach(() => {
  mux.props = null;
  mux.element = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("el reproductor", () => {
  it("recibe el video, sus tres tokens, el segundo y las velocidades; sin analítica, sin cookies y sin recordar volumen", () => {
    show();
    const { ref: _ref, onError: _error, onPlaying: _playing, onPlay: _play, onLoadedMetadata: _loaded, ...rest } = mux.props ?? {};
    void [_ref, _error, _playing, _play, _loaded];
    expect(rest).toEqual({
      className: "player-mux block h-full w-full",
      playbackId: "PlaybackDePrueba",
      tokens: TOKENS,
      startTime: 7,
      playbackRates: SPEEDS,
      forwardSeekOffset: 10,
      backwardSeekOffset: 10,
      // Mux los enciende por omisión; el diseño los quiere apagados al empezar.
      defaultHiddenCaptions: true,
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

  it("la pantalla completa toma el contenedor propio, no el reproductor: la marca entra con ella", () => {
    const { frame } = show("ana@correo.com");
    expect(frame).not.toBeNull();
    expect(mux.element?.mediaController.fullscreenElement).toBe(frame);
    // Y la marca vive dentro de ese contenedor.
    expect(frame?.querySelector("[data-watermark]")).not.toBeNull();
  });

  it("los controles se ocultan a los tres segundos, no a los dos de fábrica", () => {
    show();
    expect(mux.element?.mediaController.setAttribute).toHaveBeenCalledWith("autohide", "3");
  });

  it("los controles en español, con los nombres del diseño encima de los de media-chrome", () => {
    expect(i18n.languages).toEqual(["es-MX"]);
    const dictionary = i18n.dictionaries["es-MX"] ?? {};
    // Lo que el diseño nombra manda; lo demás queda en el español de fábrica.
    expect(dictionary.Play).toBe("Reproducir");
    expect(dictionary["seek back {seekOffset} seconds"]).toBe("Regresar 10 segundos");
    expect(dictionary["Network Error"]).toBe("Error de red");
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

describe("la marca de agua (RF-305)", () => {
  it("sin marca, no pinta ninguna (revisión, por ahora), y reproducir no pausa nada", () => {
    const { mark } = show();
    expect(mark()).toBeNull();
    (mux.props?.onPlay as (event: unknown) => void)({ target: mux.element });
    expect(mux.element?.pause).not.toHaveBeenCalled();
  });

  it("pinta el correo tal cual, sin que se lea, se seleccione ni reciba el toque", () => {
    const { mark } = show("ana@correo.com");
    const element = mark();
    expect(element).toHaveTextContent("ana@correo.com");
    expect(element).toHaveAttribute("aria-hidden", "true");
    expect(element?.className).toMatch(/\bwatermark\b/);
  });

  it("cambia de celda cada 30 segundos, desvaneciéndose, y nunca a la central", () => {
    vi.useFakeTimers();
    const { mark } = show("ana@correo.com");
    const cellOf = () => /\bwatermark-cell-(\d)\b/.exec(mark()?.className ?? "")?.[1];
    const seen = [cellOf()];
    // Hasta un instante antes del primer cambio, quieta y visible.
    act(() => void vi.advanceTimersByTime(WATERMARK_INTERVAL_MS - 1));
    expect(mark()?.className).not.toMatch(/\bopacity-0\b/);
    expect(cellOf()).toBe(seen[0]);
    for (let round = 0; round < 12; round += 1) {
      act(() => void vi.advanceTimersByTime(1));
      // A media vuelta va desvanecida.
      expect(mark()?.className).toMatch(/\bopacity-0\b/);
      act(() => void vi.advanceTimersByTime(1_000));
      expect(mark()?.className).not.toMatch(/\bopacity-0\b/);
      const cell = cellOf();
      expect(cell).not.toBe(seen.at(-1));
      expect(cell).not.toBe("4");
      seen.push(cell);
      // Hasta un instante antes del siguiente cambio.
      act(() => void vi.advanceTimersByTime(WATERMARK_INTERVAL_MS - 1_001));
    }
  });

  it("si la quitan de la página, el video se pausa", async () => {
    const { mark } = show("ana@correo.com");
    await act(async () => {
      mark()?.remove();
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("si la ocultan, también", async () => {
    const { mark } = show("ana@correo.com");
    await act(async () => {
      mark()?.style.setProperty("display", "none");
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("si le cambian el texto, también", async () => {
    const { mark } = show("ana@correo.com");
    await act(async () => {
      // El mismo nodo de texto, cambiado por dentro: no se quita ni se agrega nada.
      const node = mark()?.firstChild;
      if (node instanceof Text) node.data = "otra cosa";
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("si la desvanecen a mano, también", async () => {
    const { mark } = show("ana@correo.com");
    await act(async () => {
      mark()?.style.setProperty("opacity", "0");
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("su propio desvanecido no pausa: mientras se va y mientras vuelve, la opacidad no cuenta", async () => {
    vi.useFakeTimers();
    const { mark } = show("ana@correo.com");
    act(() => void vi.advanceTimersByTime(WATERMARK_INTERVAL_MS));
    // A media transición: lo que un navegador diría de su opacidad.
    await act(async () => {
      mark()?.style.setProperty("opacity", "0.4");
      await Promise.resolve();
    });
    act(() => void vi.advanceTimersByTime(WATERMARK_FADE_MS + 10));
    await act(async () => {
      mark()?.style.setProperty("opacity", "0.7");
      await Promise.resolve();
    });
    expect(mux.element?.pause).not.toHaveBeenCalled();
    // Ya de vuelta, la opacidad sí cuenta.
    await act(async () => {
      act(() => void vi.advanceTimersByTime(WATERMARK_FADE_MS));
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("y al darle reproducir otra vez sin marca, se vuelve a pausar", async () => {
    const { mark } = show("ana@correo.com");
    await act(async () => {
      mark()?.remove();
      await Promise.resolve();
    });
    mux.element?.pause.mockClear();
    (mux.props?.onPlay as (event: unknown) => void)({ target: mux.element });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("con la marca en su lugar, reproducir no pausa nada, tampoco al cambiar de celda", () => {
    vi.useFakeTimers();
    show("ana@correo.com");
    (mux.props?.onPlay as (event: unknown) => void)({ target: mux.element });
    act(() => void vi.advanceTimersByTime(WATERMARK_INTERVAL_MS * 3));
    expect(mux.element?.pause).not.toHaveBeenCalled();
  });
});
