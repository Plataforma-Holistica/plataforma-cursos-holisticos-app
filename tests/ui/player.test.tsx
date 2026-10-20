import { act, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El reproductor compartido (`src/app/_video/player.tsx`; diseño, sección 5.4), con Mux Player
// cambiado por uno de mentira: qué props recibe, qué apaga en el `<video>` interno, qué hace
// con cada error, el contenedor propio que entra a pantalla completa, la pantalla completa
// dentro de la página donde el navegador no lleva el contenedor (iPhone), la marca de agua y
// los subtítulos. Que Mux Player de verdad no salga a terceros, y la pantalla completa en un
// navegador, lo prueba el extremo a extremo.

/** El `<video>` de verdad, de mentira: recibe eventos y tiene pistas de texto. */
type FakeVideo = EventTarget & {
  disableRemotePlayback: boolean;
  disablePictureInPicture: boolean;
  textTracks: { kind: string; mode: string }[];
  webkitExitFullscreen: ReturnType<typeof vi.fn>;
};

interface FakeElement {
  media: { setAttribute: ReturnType<typeof vi.fn>; nativeEl: FakeVideo };
  mediaController: { fullscreenElement: HTMLElement | null; setAttribute: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  currentTime: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  error: unknown;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

// Cada montaje del Mux Player de mentira es un elemento nuevo, como el de verdad: `element` es el
// último, y `elements`, todos los que se montaron.
const mux = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  element: null as null | FakeElement,
  elements: [] as FakeElement[],
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
    const [element] = useState<FakeElement>(() => {
      const created: FakeElement = {
        media: {
          setAttribute: vi.fn(),
          nativeEl: Object.assign(new EventTarget(), {
            disableRemotePlayback: false,
            disablePictureInPicture: false,
            textTracks: [] as { kind: string; mode: string }[],
            webkitExitFullscreen: vi.fn(),
          }),
        },
        mediaController: { fullscreenElement: null, setAttribute: vi.fn(), focus: vi.fn() },
        currentTime: 42,
        playbackRate: 1,
        volume: 1,
        muted: false,
        error: null,
        pause: vi.fn(),
        play: vi.fn(() => Promise.resolve()),
        focus: vi.fn(),
      };
      mux.elements.push(created);
      return created;
    });
    mux.element = element;
    useImperativeHandle(ref, () => element);
    return <div data-testid="mux" tabIndex={-1} />;
  }),
}));

import { TOKEN_EXPIRED } from "@/app/_video/errors";
import { Player, TURN_HINT_MS } from "@/app/_video/player";
import { WATERMARK_FADE_MS, WATERMARK_INTERVAL_MS } from "@/app/_video/watermark-cells";

const TOKENS = { playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" };
const RENEWED = { playback: "p2.p2.p2", thumbnail: "t2.t2.t2", storyboard: "s2.s2.s2" };
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function show(watermark?: string, captions?: { on?: boolean; onChange?: (on: boolean) => void }) {
  const onExpired = vi.fn();
  const onFailed = vi.fn();
  const onPlaying = vi.fn();
  const player = (grant: number, tokens: typeof TOKENS, startTime: number) => (
    <Player
      grant={grant}
      playbackId="PlaybackDePrueba"
      tokens={tokens}
      startTime={startTime}
      speeds={SPEEDS}
      watermark={watermark}
      captions={captions?.on}
      onCaptionsChange={captions?.onChange}
      onExpired={onExpired}
      onFailed={onFailed}
      onPlaying={onPlaying}
    />
  );
  const view = render(player(1, TOKENS, 7));
  /** Lo que hace la pantalla con una dirección renovada: otra concesión, otros tokens, el segundo en que iba. */
  const renew = (grant = 2, tokens = RENEWED, startTime = 42) => view.rerender(player(grant, tokens, startTime));
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
  /** Lo que haría Mux Player al cargar los datos del video. */
  const loaded = () => act(() => (mux.props?.onLoadedMetadata as (event: unknown) => void)({ target: mux.element }));
  return { onExpired, onFailed, onPlaying, fail, frame, mark, view, renew, loaded };
}

beforeEach(() => {
  mux.props = null;
  mux.element = null;
  mux.elements = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("el reproductor", () => {
  it("recibe el video, sus tres tokens, el segundo y las velocidades; sin analítica, sin cookies y sin recordar volumen", () => {
    show();
    const {
      ref: _ref,
      onError: _error,
      onPlaying: _playing,
      onPlay: _play,
      onPause: _pause,
      onLoadedMetadata: _loaded,
      onEnded: _ended,
      onTimeUpdate: _time,
      onRateChange: _rate,
      onSeeking: _seeking,
      onWaiting: _waiting,
      onEmptied: _emptied,
      ...rest
    } = mux.props ?? {};
    void [_ref, _error, _playing, _play, _pause, _loaded, _ended, _time, _rate, _seeking, _waiting, _emptied];
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
    expect(mux.element?.media.nativeEl.disableRemotePlayback).toBe(true);
    expect(mux.element?.media.nativeEl.disablePictureInPicture).toBe(true);
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

  it("al llegar al final, lo dice", () => {
    const onEnded = vi.fn();
    render(<Player grant={1} playbackId="P" tokens={TOKENS} startTime={0} speeds={SPEEDS} onExpired={vi.fn()} onFailed={vi.fn()} onPlaying={vi.fn()} onEnded={onEnded} />);
    (mux.props?.onEnded as () => void)();
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("dice cuándo avanza y cuándo se detiene, y en qué segundo va (T-204)", () => {
    const onAdvancing = vi.fn();
    const onProgress = vi.fn();
    const onPlaying = vi.fn();
    render(
      <Player
        grant={1}
        playbackId="P"
        tokens={TOKENS}
        startTime={0}
        speeds={SPEEDS}
        onExpired={vi.fn()}
        onFailed={vi.fn()}
        onPlaying={onPlaying}
        onAdvancing={onAdvancing}
        onProgress={onProgress}
      />,
    );
    act(() => (mux.props?.onPlaying as () => void)());
    expect(onAdvancing).toHaveBeenLastCalledWith(true);
    expect(onPlaying).toHaveBeenCalledOnce();
    act(() => (mux.props?.onTimeUpdate as (event: unknown) => void)({ target: { currentTime: 61.5 } }));
    expect(onProgress).toHaveBeenLastCalledWith(61.5);
    act(() => (mux.props?.onTimeUpdate as (event: unknown) => void)({ target: null }));
    expect(onProgress).toHaveBeenLastCalledWith(0);
    // Cualquier pausa lo detiene, también la que acompaña a un error.
    act(() => (mux.props?.onPause as (event: unknown) => void)({ target: { error: { fatal: true } } }));
    expect(onAdvancing).toHaveBeenLastCalledWith(false);
    act(() => (mux.props?.onPlaying as () => void)());
    act(() => (mux.props?.onEnded as () => void)());
    expect(onAdvancing.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("dice cada muestra mientras avanza, y cuándo se detiene el tramo, desde el evento mismo (T-205)", () => {
    const onWatch = vi.fn();
    const onExpired = vi.fn();
    render(<Player grant={1} playbackId="P" tokens={TOKENS} startTime={0} speeds={SPEEDS} onExpired={onExpired} onFailed={vi.fn()} onPlaying={vi.fn()} onWatch={onWatch} />);
    const fire = (name: string, target: unknown, more: Record<string, unknown> = {}) => act(() => (mux.props?.[name] as (event: unknown) => void)({ target, ...more }));
    const playingAt = (currentTime: number) => ({ currentTime, playbackRate: 1.5, duration: 356, paused: false });
    fire("onTimeUpdate", playingAt(10));
    expect(onWatch).toHaveBeenLastCalledWith({ kind: "tick", at: 10, rate: 1.5, duration: 356 });
    fire("onRateChange", { ...playingAt(11), playbackRate: 2 });
    expect(onWatch).toHaveBeenLastCalledWith({ kind: "tick", at: 11, rate: 2, duration: 356 });
    // Una muestra con el video en pausa (después de buscar, por ejemplo) no extiende nada: detiene.
    fire("onTimeUpdate", { ...playingAt(200), paused: true });
    expect(onWatch).toHaveBeenLastCalledWith({ kind: "stop" });
    fire("onTimeUpdate", null);
    expect(onWatch).toHaveBeenLastCalledWith({ kind: "stop" });
    onWatch.mockClear();
    for (const name of ["onSeeking", "onWaiting", "onEmptied", "onEnded"]) fire(name, playingAt(12));
    fire("onPause", { error: null });
    expect(onWatch.mock.calls).toEqual([[{ kind: "stop" }], [{ kind: "stop" }], [{ kind: "stop" }], [{ kind: "stop" }], [{ kind: "stop" }]]);
    // Un error fatal detiene antes de decir que caducó; uno que no es fatal, no.
    onWatch.mockClear();
    fire("onError", mux.element, { detail: { fatal: false, muxCode: 2000003 } });
    expect(onWatch).not.toHaveBeenCalled();
    fire("onError", mux.element, { detail: { fatal: true, muxCode: TOKEN_EXPIRED } });
    expect(onWatch).toHaveBeenCalledExactlyOnceWith({ kind: "stop" });
    expect(onWatch.mock.invocationCallOrder[0]).toBeLessThan(onExpired.mock.invocationCallOrder[0] ?? 0);
  });

  it("sin quien escuche cuándo avanza (la revisión), nada cambia", () => {
    const { onPlaying } = show();
    act(() => {
      (mux.props?.onPlaying as () => void)();
      (mux.props?.onTimeUpdate as (event: unknown) => void)({ target: { currentTime: 3 } });
      (mux.props?.onPause as (event: unknown) => void)({ target: { error: null } });
      (mux.props?.onEnded as () => void)();
      for (const name of ["onRateChange", "onSeeking", "onWaiting", "onEmptied"]) (mux.props?.[name] as (event: unknown) => void)({ target: null });
    });
    expect(onPlaying).toHaveBeenCalledOnce();
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
    // Terminado el periodo protegido, el navegador todavía puede estarla trayendo de vuelta
    // (la transición empieza un cuadro después): mientras corra, no pausa.
    const element = mark()!;
    const returning = [{ playState: "running", transitionProperty: "opacity" }];
    Object.defineProperty(element, "getAnimations", { configurable: true, value: () => returning });
    await act(async () => {
      act(() => void vi.advanceTimersByTime(WATERMARK_FADE_MS));
      await Promise.resolve();
    });
    expect(mux.element?.pause).not.toHaveBeenCalled();
    // Una transición de opacidad detenida a mano tampoco la excusa.
    returning.splice(0, 1, { playState: "paused", transitionProperty: "opacity" });
    await act(async () => {
      element.style.setProperty("opacity", "0.5");
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
    mux.element?.pause.mockClear();
    // La deriva es otra animación, que siempre corre: no la excusa.
    returning.splice(0, 1, { playState: "running", transitionProperty: "translate" });
    await act(async () => {
      element.style.setProperty("opacity", "0.8");
      await Promise.resolve();
    });
    expect(mux.element?.pause).toHaveBeenCalled();
  });

  it("no la lee un traductor del navegador", () => {
    const { mark } = show("ana@correo.com");
    expect(mark()).toHaveAttribute("translate", "no");
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

/** Lo que mandan los controles de Mux (media-chrome) al pedir algo: sube y sale de su sombra. */
function request(type: string) {
  const event = new CustomEvent(type, { bubbles: true, composed: true });
  act(() => void screen.getByTestId("mux").dispatchEvent(event));
}

/** Si el navegador lleva a pantalla completa un elemento cualquiera (en computadora y Android, sí). */
function elementFullscreen(enabled: boolean) {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: enabled });
}

/** El aparato, en vertical o en horizontal. Devuelve con qué girarlo después. */
function orientation(portrait: boolean): (portrait: boolean) => void {
  const listeners = new Set<() => void>();
  const query = {
    matches: portrait,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return (next) => {
    query.matches = next;
    act(() => listeners.forEach((listener) => listener()));
  };
}

describe("la pantalla completa dentro de la página (iPhone; diseño, sección 5.4)", () => {
  beforeEach(() => {
    elementFullscreen(false);
    orientation(false);
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "fullscreenEnabled");
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("player-locked");
  });

  it("donde el navegador no lleva el contenedor, el pedido de Mux no llega a su controlador: el contenedor ocupa la ventana, con la marca", () => {
    const { frame } = show("ana@correo.com");
    const controller = vi.fn();
    screen.getByTestId("mux").addEventListener("mediaenterfullscreenrequest", controller);
    request("mediaenterfullscreenrequest");
    expect(controller).not.toHaveBeenCalled();
    expect(frame).toHaveAttribute("data-filled");
    expect(frame?.className).toMatch(/\bplayer-frame-filled\b/);
    expect(frame?.className).not.toMatch(/\baspect-video\b/);
    expect(frame?.querySelector("[data-watermark]")).not.toBeNull();
    // La página de atrás no se desplaza, y el foco va a salir.
    expect(document.documentElement).toHaveClass("player-locked");
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toHaveFocus();
  });

  it("la nota de la pantalla («Sin conexión») va abajo, sin fondo que tape la marca y sin anunciarse aquí; fuera, no se pinta", () => {
    render(
      <Player
        grant={1}
        playbackId="P"
        tokens={TOKENS}
        startTime={0}
        speeds={SPEEDS}
        watermark="ana@correo.com"
        onExpired={vi.fn()}
        onFailed={vi.fn()}
        onPlaying={vi.fn()}
        notice="Sin conexión. Reintentando…"
      />,
    );
    expect(screen.queryByText("Sin conexión. Reintentando…")).toBeNull();
    request("mediaenterfullscreenrequest");
    const note = screen.getByText("Sin conexión. Reintentando…");
    expect(note).toHaveAttribute("aria-hidden", "true");
    expect(note.closest("[role=status]")).toHaveClass("player-filled-hint");
    expect(note.className).not.toMatch(/\bbg-/);
  });

  it("«Salir de pantalla completa» la deja como estaba", () => {
    const { frame } = show("ana@correo.com");
    request("mediaenterfullscreenrequest");
    fireEvent.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    expect(frame).not.toHaveAttribute("data-filled");
    expect(frame?.className).toMatch(/\baspect-video\b/);
    expect(document.documentElement).not.toHaveClass("player-locked");
    expect(screen.queryByRole("button", { name: "Salir de pantalla completa" })).toBeNull();
  });

  it("con un teclado, Escape sale, y la tecla F (otro pedido de entrar) también", () => {
    const { frame } = show();
    request("mediaenterfullscreenrequest");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(frame).not.toHaveAttribute("data-filled");
    request("mediaenterfullscreenrequest");
    expect(frame).toHaveAttribute("data-filled");
    request("mediaenterfullscreenrequest");
    expect(frame).not.toHaveAttribute("data-filled");
  });

  it("un pedido de salir, de Mux, también sale; y fuera de ella no hace nada", () => {
    const { frame } = show();
    request("mediaexitfullscreenrequest");
    expect(frame).not.toHaveAttribute("data-filled");
    request("mediaenterfullscreenrequest");
    request("mediaexitfullscreenrequest");
    expect(frame).not.toHaveAttribute("data-filled");
  });

  it("donde el navegador sí lleva el contenedor (computadora, Android), el pedido sigue a Mux", () => {
    elementFullscreen(true);
    const { frame } = show("ana@correo.com");
    const controller = vi.fn();
    screen.getByTestId("mux").addEventListener("mediaenterfullscreenrequest", controller);
    request("mediaenterfullscreenrequest");
    expect(controller).toHaveBeenCalledOnce();
    expect(frame).not.toHaveAttribute("data-filled");
  });

  it("si iOS entra solo a la del sistema (un pellizco), se sale de ella y pasa a la propia", () => {
    const { frame } = show("ana@correo.com");
    const video = mux.element?.media.nativeEl;
    act(() => void video?.dispatchEvent(new Event("webkitbeginfullscreen")));
    expect(video?.webkitExitFullscreen).toHaveBeenCalledOnce();
    expect(frame).toHaveAttribute("data-filled");
  });

  it("si iOS entra a la del sistema estando ya dentro y girado, se sale de ella y sigue girado", () => {
    orientation(true);
    const { frame } = show("ana@correo.com");
    request("mediaenterfullscreenrequest");
    fireEvent.click(screen.getByRole("button", { name: "Girar" }));
    const video = mux.element?.media.nativeEl;
    act(() => void video?.dispatchEvent(new Event("webkitbeginfullscreen")));
    expect(video?.webkitExitFullscreen).toHaveBeenCalledOnce();
    expect(frame).toHaveAttribute("data-turned");
    expect(screen.getByRole("button", { name: "Girar" })).toHaveAttribute("aria-pressed", "true");
  });

  it("el aviso de girar se dice en una región viva que ya estaba antes de entrar: una que nace llena no se anuncia", () => {
    orientation(true);
    show();
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");
    request("mediaenterfullscreenrequest");
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Gira tu teléfono para verlo más grande");
    fireEvent.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("");
  });

  it("los botones y el aviso respetan los márgenes seguros, y la franja entre los botones no se queda con el toque", () => {
    orientation(true);
    show();
    request("mediaenterfullscreenrequest");
    const exit = screen.getByRole("button", { name: "Salir de pantalla completa" });
    const bar = exit.parentElement;
    expect(bar?.className).toMatch(/\bplayer-filled-bar\b/);
    expect(bar?.className).toMatch(/\bpointer-events-none\b/);
    for (const button of [exit, screen.getByRole("button", { name: "Girar" })]) expect(button.className).toMatch(/\bpointer-events-auto\b/);
    expect(screen.getByRole("status").className).toMatch(/\bplayer-filled-hint\b/);
  });

  it("en vertical: el aviso de girar un momento, y «Girar» rota el contenedor", () => {
    vi.useFakeTimers();
    orientation(true);
    const { frame } = show("ana@correo.com");
    request("mediaenterfullscreenrequest");
    expect(screen.getByRole("status")).toHaveTextContent("Gira tu teléfono para verlo más grande");
    const turn = screen.getByRole("button", { name: "Girar" });
    expect(turn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(turn);
    expect(turn).toHaveAttribute("aria-pressed", "true");
    expect(frame).toHaveAttribute("data-turned");
    // Ya girado, el aviso sobra.
    expect(screen.getByRole("status")).toHaveTextContent("");
    fireEvent.click(turn);
    expect(frame).not.toHaveAttribute("data-turned");
    expect(screen.getByRole("status")).toHaveTextContent("Gira tu teléfono para verlo más grande");
    act(() => void vi.advanceTimersByTime(TURN_HINT_MS));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("al salir y volver a entrar, ni girado ni sin aviso: empieza de nuevo", () => {
    orientation(true);
    const { frame } = show();
    request("mediaenterfullscreenrequest");
    fireEvent.click(screen.getByRole("button", { name: "Girar" }));
    fireEvent.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    request("mediaenterfullscreenrequest");
    expect(frame).not.toHaveAttribute("data-turned");
    expect(screen.getByRole("button", { name: "Girar" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Gira tu teléfono para verlo más grande");
  });

  it("girado, si el teléfono se pone en horizontal, deja de rotar: ya cabe sin girar", () => {
    const turnPhone = orientation(true);
    const { frame } = show();
    request("mediaenterfullscreenrequest");
    fireEvent.click(screen.getByRole("button", { name: "Girar" }));
    expect(frame).toHaveAttribute("data-turned");
    turnPhone(false);
    expect(frame).not.toHaveAttribute("data-turned");
    expect(screen.queryByRole("button", { name: "Girar" })).toBeNull();
  });

  it("el aviso dura su momento entero desde la última vez que se entró", () => {
    vi.useFakeTimers();
    orientation(true);
    show();
    request("mediaenterfullscreenrequest");
    act(() => void vi.advanceTimersByTime(TURN_HINT_MS - 1_000));
    fireEvent.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    request("mediaenterfullscreenrequest");
    // Cuando se habría ido el de la primera vez, el de ahora sigue.
    act(() => void vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status")).toHaveTextContent("Gira tu teléfono para verlo más grande");
    act(() => void vi.advanceTimersByTime(TURN_HINT_MS - 1_000));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("en horizontal: sin aviso y sin «Girar»", () => {
    show();
    request("mediaenterfullscreenrequest");
    expect(screen.queryByRole("button", { name: "Girar" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("al salir, si el foco quedó sin dueño, lo recibe el controlador de Mux (el elemento no lo recibe)", () => {
    show();
    request("mediaenterfullscreenrequest");
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Salir de pantalla completa" }));
    expect(mux.element?.mediaController.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("si el reproductor se va estando dentro (terminó la lección), la página vuelve a desplazarse", () => {
    const { view } = show();
    request("mediaenterfullscreenrequest");
    view.unmount();
    expect(document.documentElement).not.toHaveClass("player-locked");
  });
});

describe("los subtítulos (RF-310)", () => {
  it("arrancan como la cuenta los dejó: encendidos, si así quedaron", () => {
    show(undefined, { on: true });
    expect(mux.props?.defaultHiddenCaptions).toBe(false);
  });

  it("cuando la persona los enciende o los apaga, se avisa una vez por cambio", () => {
    const onChange = vi.fn();
    show(undefined, { onChange });
    const tracks = mux.element?.media.nativeEl.textTracks ?? [];
    tracks.push({ kind: "metadata", mode: "showing" }, { kind: "subtitles", mode: "disabled" });
    // Una pista que no es de subtítulos, a la vista, no cuenta.
    request("mediatogglesubtitlesrequest");
    expect(onChange).not.toHaveBeenCalled();
    tracks[1]!.mode = "showing";
    request("mediashowsubtitlesrequest");
    expect(onChange).toHaveBeenLastCalledWith(true);
    request("mediashowsubtitlesrequest");
    expect(onChange).toHaveBeenCalledOnce();
    tracks[1]!.mode = "disabled";
    request("mediadisablesubtitlesrequest");
    expect(onChange).toHaveBeenLastCalledWith(false);
    tracks.push({ kind: "captions", mode: "showing" });
    request("mediatogglesubtitlesrequest");
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("si arrancaron encendidos, apagarlos se avisa", () => {
    const onChange = vi.fn();
    show(undefined, { on: true, onChange });
    mux.element?.media.nativeEl.textTracks.push({ kind: "subtitles", mode: "disabled" });
    request("mediadisablesubtitlesrequest");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("renovar la dirección, sin salir de la pantalla completa", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "fullscreenEnabled");
    vi.unstubAllGlobals();
    document.documentElement.classList.remove("player-locked");
  });

  it("otra concesión monta otro Mux Player dentro del mismo contenedor, con los tokens y el segundo nuevos, ligado al contenedor", () => {
    const { frame, renew, view } = show("ana@correo.com");
    const first = mux.element;
    renew();
    expect(mux.elements).toHaveLength(2);
    expect(mux.element).not.toBe(first);
    // El contenedor (lo que está a pantalla completa) y la marca son los mismos.
    expect(view.container.querySelector("[data-player-frame]")).toBe(frame);
    expect(frame?.querySelector("[data-watermark]")).not.toBeNull();
    expect(mux.props).toMatchObject({ tokens: RENEWED, startTime: 42 });
    expect(mux.element?.mediaController.fullscreenElement).toBe(frame);
    expect(mux.element?.mediaController.setAttribute).toHaveBeenCalledWith("autohide", "3");
    expect(mux.element?.media.nativeEl.disableRemotePlayback).toBe(true);
  });

  it("si la pantalla vuelve a pintar con la misma concesión, no monta otro", () => {
    const { renew } = show();
    renew(1, TOKENS, 7);
    expect(mux.elements).toHaveLength(1);
  });

  it("en la pantalla completa propia (iPhone), renovar no la deshace: sigue girada y con la página quieta", () => {
    elementFullscreen(false);
    orientation(true);
    const { frame, renew } = show("ana@correo.com");
    request("mediaenterfullscreenrequest");
    fireEvent.click(screen.getByRole("button", { name: "Girar" }));
    renew();
    expect(frame).toHaveAttribute("data-filled");
    expect(frame).toHaveAttribute("data-turned");
    expect(document.documentElement).toHaveClass("player-locked");
    expect(screen.getByRole("button", { name: "Girar" })).toHaveAttribute("aria-pressed", "true");
  });

  it("el pellizco se atrapa en el video del Mux Player nuevo, y ya no en el del viejo", () => {
    elementFullscreen(false);
    const { frame, renew } = show();
    const old = mux.element?.media.nativeEl;
    renew();
    const now = mux.element?.media.nativeEl;
    act(() => void old?.dispatchEvent(new Event("webkitbeginfullscreen")));
    expect(old?.webkitExitFullscreen).not.toHaveBeenCalled();
    expect(frame).not.toHaveAttribute("data-filled");
    act(() => void now?.dispatchEvent(new Event("webkitbeginfullscreen")));
    expect(now?.webkitExitFullscreen).toHaveBeenCalledOnce();
    expect(frame).toHaveAttribute("data-filled");
  });

  it("al cargar se repone lo que la persona tenía: velocidad, volumen y silencio; y si le dio reproducir, sigue", () => {
    const { fail, renew, loaded } = show();
    const old = mux.element;
    if (old === null) throw new Error("Sin reproductor");
    Object.assign(old, { playbackRate: 1.5, volume: 0.4, muted: true });
    // Volvió de una pausa larga y pulsó reproducir: Mux contesta que la dirección caducó.
    request("mediaplayrequest");
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    const now = mux.element;
    expect(now?.play).not.toHaveBeenCalled();
    loaded();
    expect(now).toMatchObject({ playbackRate: 1.5, volume: 0.4, muted: true });
    expect(now?.play).toHaveBeenCalledOnce();
    // Otro aviso de carga no repite nada.
    loaded();
    expect(now?.play).toHaveBeenCalledOnce();
  });

  it("también si se le dio reproducir sin los controles de Mux (el video avisó que empezó)", () => {
    const { fail, renew, loaded } = show();
    act(() => (mux.props?.onPlay as (event: unknown) => void)({ target: mux.element }));
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    loaded();
    expect(mux.element?.play).toHaveBeenCalledOnce();
  });

  it("si pausó mientras llegaba la dirección nueva, no sigue solo", () => {
    const { fail, renew, loaded } = show();
    request("mediaplayrequest");
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    request("mediapauserequest");
    renew();
    loaded();
    expect(mux.element?.play).not.toHaveBeenCalled();
  });

  it("una pausa que no viene de sus controles (la pantalla de bloqueo) también cuenta; la que acompaña al error, no", () => {
    const first = show();
    request("mediaplayrequest");
    act(() => (mux.props?.onPause as (event: unknown) => void)({ target: { error: null } }));
    first.fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    first.renew();
    first.loaded();
    expect(mux.element?.play).not.toHaveBeenCalled();
    first.view.unmount();

    const second = show();
    request("mediaplayrequest");
    act(() => (mux.props?.onPause as (event: unknown) => void)({ target: { error: { fatal: true } } }));
    second.fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    second.renew();
    second.loaded();
    expect(mux.element?.play).toHaveBeenCalledOnce();
  });

  it("si estaba en pausa, sigue en pausa en el segundo en que iba, con lo demás repuesto", () => {
    const { fail, renew, loaded } = show();
    const old = mux.element;
    if (old === null) throw new Error("Sin reproductor");
    old.playbackRate = 2;
    request("mediaplayrequest");
    request("mediapauserequest");
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    loaded();
    expect(mux.element?.play).not.toHaveBeenCalled();
    expect(mux.element?.playbackRate).toBe(2);
  });

  it("si el navegador no deja reproducir sin un toque (Safari), queda en pausa, sin error", async () => {
    const { fail, renew, loaded, onFailed } = show();
    request("mediaplayrequest");
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    // La negativa se atrapa: sin eso sería un rechazo sin manejar. No sirve devolver una promesa
    // rechazada, porque el espía de Vitest se engancha a ella para anotar su resultado y ya cuenta
    // como atendida: se mira que se llame a su `catch`.
    const refusal = Promise.reject(new Error("NotAllowedError"));
    const caught = vi.fn((onRejected: (reason: unknown) => unknown) => refusal.catch(onRejected));
    mux.element?.play.mockReturnValue({ catch: caught });
    loaded();
    await act(async () => await Promise.resolve());
    expect(caught).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("un aviso de carga del reproductor viejo, antes de la dirección nueva, no se queda con lo que hay que reponer", () => {
    const { fail, renew, loaded } = show();
    const old = mux.element;
    request("mediaplayrequest");
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    loaded();
    expect(old?.play).not.toHaveBeenCalled();
    renew();
    loaded();
    expect(mux.element?.play).toHaveBeenCalledOnce();
  });

  it("si llegó al final, no sigue solo", () => {
    const { fail, renew, loaded } = show();
    request("mediaplayrequest");
    act(() => (mux.props?.onEnded as () => void)());
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    loaded();
    expect(mux.element?.play).not.toHaveBeenCalled();
  });

  it("sin una caducidad antes, cargar no toca nada", () => {
    const { loaded } = show();
    request("mediaplayrequest");
    loaded();
    expect(mux.element?.play).not.toHaveBeenCalled();
    expect(mux.element?.playbackRate).toBe(1);
  });

  it("el foco que estaba en el reproductor viejo pasa al controlador del nuevo: sin eso, los atajos del teclado dejan de servir", () => {
    const { fail, renew } = show();
    screen.getByTestId("mux").focus();
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    // El elemento de Mux no recibe el foco (su sombra no lo delega): lo recibe su controlador.
    expect(mux.element?.mediaController.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(mux.element?.focus).not.toHaveBeenCalled();
  });

  it("si la persona movió el foco a otra parte mientras se renovaba, se queda donde lo puso", () => {
    const { fail, renew } = show();
    screen.getByTestId("mux").focus();
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    renew();
    expect(mux.element?.mediaController.focus).not.toHaveBeenCalled();
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it("si nadie tenía el foco, el reproductor nuevo no lo toma", () => {
    const { fail, renew } = show();
    (document.activeElement as HTMLElement | null)?.blur();
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    expect(mux.element?.mediaController.focus).not.toHaveBeenCalled();
  });

  it("si el foco estaba en otra parte, se queda donde estaba", () => {
    const { fail, renew } = show();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    fail({ fatal: true, muxCode: TOKEN_EXPIRED });
    renew();
    expect(mux.element?.mediaController.focus).not.toHaveBeenCalled();
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });
});
