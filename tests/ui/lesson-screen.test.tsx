import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

// La pantalla de una lección (PA-22, T-203), con la acción y el reproductor simulados: qué se
// pinta en el lugar del reproductor en cada estado, el temario y lo de alrededor. El reproductor
// de verdad lo prueba tests/ui/player.test.tsx, y la página entera, el extremo a extremo.

const actions = vi.hoisted(() => ({ watchLessonAction: vi.fn(), rememberCaptionsAction: vi.fn(), playbackPresenceAction: vi.fn() }));
vi.mock("@/app/cursos/[slug]/lecciones/[leccion]/actions", () => actions);

const player = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("@/app/_video/player", () => ({
  Player: (props: {
    watermark?: string;
    startTime: number;
    onExpired: (at: number) => void;
    onFailed: () => void;
    onPlaying: () => void;
    onEnded?: () => void;
    onCaptionsChange?: (on: boolean) => void;
    onAdvancing?: (advancing: boolean) => void;
    onProgress?: (at: number) => void;
  }) => {
    player.last = props;
    return (
      <div data-testid="reproductor" data-start={String(props.startTime)}>
        <button type="button" onClick={() => props.onExpired(42)}>
          caduca
        </button>
        <button type="button" onClick={() => props.onFailed()}>
          falla
        </button>
        <button type="button" onClick={() => props.onPlaying()}>
          reproduce
        </button>
        <button type="button" onClick={() => props.onEnded?.()}>
          termina
        </button>
        <button type="button" onClick={() => props.onCaptionsChange?.(true)}>
          enciende subtítulos
        </button>
        <button type="button" onClick={() => props.onAdvancing?.(true)}>
          avanza
        </button>
        <button type="button" onClick={() => props.onAdvancing?.(false)}>
          se detiene
        </button>
        <button type="button" onClick={() => props.onProgress?.(61)}>
          va en 61
        </button>
      </div>
    );
  },
}));

import { LessonScreen, type LessonScreenProps } from "@/app/cursos/[slug]/lecciones/[leccion]/screen";

const LESSON = "b0000000-0000-4000-8000-000000000002";
const PLAYBACK = "d0000000-0000-4000-8000-000000000004";
const OTHER = "d0000000-0000-4000-8000-000000000005";
const GRANT = {
  kind: "granted",
  playbackId: "P",
  tokens: { playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" },
  speeds: [0.75, 1, 2],
  watermark: "ana@correo.com",
  playbackSessionId: PLAYBACK,
  heartbeatSeconds: 30,
};
/** Una reproducción viva en otra computadora: 01:40 UTC son las 19:40 en el centro de México. */
const ROW = { sessionId: OTHER, browser: "chrome", system: "windows", lesson: "Respirar", course: "Yoga suave", since: "2026-10-19T01:40:00.000Z" };

const PROPS: LessonScreenProps = {
  slug: "respirar",
  lessonId: LESSON,
  heading: "Lección 2 · Respirar acostado",
  byline: "Respirar para dormir · Ana Robles",
  summary: "Un curso corto.",
  about: "Dura 7 min. Es del módulo «Uno».",
  modules: [
    {
      id: "m1",
      title: "Uno",
      lessons: [
        { id: "l1", number: 1, title: "Soltar los hombros", duration: "5 min", current: false, href: "/cursos/respirar/lecciones/l1" },
        { id: LESSON, number: 2, title: "Respirar acostado", duration: "7 min", current: true, href: `/cursos/respirar/lecciones/${LESSON}` },
      ],
    },
  ],
  next: { title: "Alargar la salida", href: "/cursos/respirar/lecciones/l3" },
  initial: { kind: "ready" },
  captions: false,
};

function show(props: Partial<LessonScreenProps> = {}) {
  const user = userEvent.setup();
  const view = render(<LessonScreen {...PROPS} {...props} />);
  const area = () => screen.getByRole("region", { name: "Reproductor" });
  return { user, view, area };
}

beforeEach(() => {
  vi.clearAllMocks();
  player.last = null;
  actions.watchLessonAction.mockResolvedValue(GRANT);
  actions.rememberCaptionsAction.mockResolvedValue(undefined);
  actions.playbackPresenceAction.mockResolvedValue({ kind: "ok" });
});

describe("lo de alrededor del reproductor", () => {
  it("el título, el curso y quien lo imparte, y «Sobre esta lección»", () => {
    show();
    expect(screen.getByRole("heading", { level: 1, name: "Lección 2 · Respirar acostado" })).toBeVisible();
    expect(screen.getByText("Respirar para dormir · Ana Robles")).toBeVisible();
    expect(screen.getAllByText("Dura 7 min. Es del módulo «Uno».").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/inicio");
  });

  it("el temario marca la lección en curso, en la columna y en la pestaña, sin repetir un id", () => {
    const { view } = show();
    const current = screen.getAllByRole("link", { name: "Lección 2, Respirar acostado, 7 min, reproduciendo", hidden: true });
    expect(current.length).toBe(2);
    for (const link of current) expect(link).toHaveAttribute("aria-current", "page");
    const ids = [...view.container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("en teléfono, las pestañas son Temario y Sobre esta lección; Recursos y Comentarios no aparecen (T-404, T-501)", () => {
    show();
    const tabs = screen.getAllByRole("tab", { hidden: true }).map((tab) => tab.textContent);
    expect(tabs).toEqual(["Temario", "Sobre esta lección"]);
  });

  it("pasa las reglas de accesibilidad", async () => {
    const { view } = show();
    expect(await a11yViolations(view.container)).toEqual([]);
  });
});

describe("el lugar del reproductor", () => {
  it("con acceso: «Reproducir» pide la dirección de esta lección y monta el reproductor con la marca y las velocidades", async () => {
    const { user, area } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    expect(actions.watchLessonAction).toHaveBeenCalledExactlyOnceWith("respirar", LESSON, undefined);
    await screen.findByTestId("reproductor");
    expect(player.last).toMatchObject({ playbackId: "P", watermark: "ana@correo.com", speeds: [0.75, 1, 2], startTime: 0 });
    expect(within(area()).getByTestId("reproductor")).toBeVisible();
    // El botón se fue: el foco quedó en el lugar del reproductor.
    expect(area().querySelector("[tabindex='-1']")).toHaveFocus();
  });

  it("sin acceso desde que carga: PA-33, sin botón de reproducir", () => {
    show({ initial: { kind: "denied", denial: { reason: "expired", date: "1 de octubre de 2026" } } });
    expect(screen.getByRole("heading", { level: 2, name: "Tu acceso terminó el 1 de octubre de 2026" })).toBeVisible();
    expect(screen.getByText("Para seguir viendo las lecciones, suscríbete de nuevo.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reproducir la lección" })).toBeNull();
  });

  it.each([
    [{ reason: "never_subscribed" } as const, "Esta lección pide una suscripción", "Con una suscripción ves todo el catálogo."],
    [{ reason: "grace_ended", date: "2 de octubre de 2026" } as const, "Tu acceso terminó el 2 de octubre de 2026", "No pudimos cobrar tu suscripción."],
    [{ reason: "refunded", date: "3 de octubre de 2026" } as const, "Tu suscripción fue reembolsada", "Puedes volver cuando quieras."],
  ])("PA-33 por cada motivo: %j", (denial, title, sentence) => {
    show({ initial: { kind: "denied", denial } });
    expect(screen.getByRole("heading", { level: 2, name: title })).toBeVisible();
    expect(screen.getByText(sentence)).toBeVisible();
  });

  it("si el acceso se pierde al reproducir, PA-33 en el lugar del reproductor", async () => {
    actions.watchLessonAction.mockResolvedValue({ kind: "denied", denial: { reason: "never_subscribed" } });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Esta lección pide una suscripción" })).toBeVisible();
  });

  it.each([
    [{ kind: "no_video" } as const, "Esta lección no está disponible por ahora.", false],
    [{ kind: "unavailable" } as const, "Algo falló de nuestro lado. No es por algo que hayas hecho.", true],
  ])("al cargar %j: lo dice, también a quien no lo ve", (initial, sentence, retry) => {
    const { area } = show({ initial });
    expect(within(area()).getByText(sentence, { selector: "p:not([role=status])" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(sentence);
    expect(screen.queryByRole("button", { name: "Reintentar" }) !== null).toBe(retry);
  });

  it("si la acción no contesta: «algo falló», y «Reintentar» la pide otra vez", async () => {
    actions.watchLessonAction.mockRejectedValueOnce(new Error("sin red"));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    await screen.findByTestId("reproductor");
    expect(actions.watchLessonAction).toHaveBeenCalledTimes(2);
  });

  it("si la dirección caduca, pide otra una sola vez, desde el mismo segundo; si vuelve a caducar sin reproducirse, falla", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "caduca" }));
    await waitFor(() => expect(screen.getByTestId("reproductor")).toHaveAttribute("data-start", "42"));
    expect(actions.watchLessonAction).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "caduca" }));
    expect(await screen.findByRole("button", { name: "Reintentar" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No pudimos cargar el video.");
    expect(actions.watchLessonAction).toHaveBeenCalledTimes(2);
  });

  it("renovar no vuelve a montar el reproductor: le pasa la dirección nueva con otra concesión, y así no se sale de la pantalla completa", async () => {
    const renewed = { ...GRANT, tokens: { playback: "p2.p2.p2", thumbnail: "t2.t2.t2", storyboard: "s2.s2.s2" } };
    actions.watchLessonAction.mockResolvedValueOnce(GRANT).mockResolvedValueOnce(renewed);
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    const mounted = await screen.findByTestId("reproductor");
    const first = player.last?.grant;
    await user.click(screen.getByRole("button", { name: "caduca" }));
    await waitFor(() => expect(player.last?.tokens).toEqual(renewed.tokens));
    expect(screen.getByTestId("reproductor")).toBe(mounted);
    expect(player.last?.grant).not.toBe(first);
    expect(mounted).toHaveAttribute("data-start", "42");
  });

  it("si se reprodujo entre una caducidad y otra, la siguiente también se renueva", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "caduca" }));
    await waitFor(() => expect(actions.watchLessonAction).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "reproduce" }));
    await user.click(screen.getByRole("button", { name: "caduca" }));
    await waitFor(() => expect(actions.watchLessonAction).toHaveBeenCalledTimes(3));
  });

  it("cualquier otro error del reproductor: lo dice y lo anuncia, con «Reintentar»", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "falla" }));
    expect(screen.getByRole("status")).toHaveTextContent("No pudimos cargar el video.");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeVisible();
  });

  it("si el reproductor tenía el foco y se va con un error, el foco no cae al documento", async () => {
    const { user, area } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    const fails = await screen.findByRole("button", { name: "falla" });
    fails.focus();
    await user.click(fails);
    expect(area().querySelector("[tabindex='-1']")).toHaveFocus();
  });

  it("PA-33 que llega al reproducir se anuncia", async () => {
    actions.watchLessonAction.mockResolvedValue({ kind: "denied", denial: { reason: "never_subscribed" } });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Esta lección pide una suscripción Con una suscripción ves todo el catálogo."));
  });

  it("la acción que manda a la página (la sesión ya no pasa) no se toma por un error", async () => {
    actions.watchLessonAction.mockRejectedValueOnce(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/cursos/respirar;307;" }));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await waitFor(() => expect(actions.watchLessonAction).toHaveBeenCalledOnce());
    expect(screen.queryByText("Algo falló de nuestro lado. No es por algo que hayas hecho.")).toBeNull();
  });

  it("al terminar: «Lección terminada», la siguiente y volver a ver, sin arrancar sola (D-07)", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "termina" }));
    expect(screen.getByRole("status")).toHaveTextContent("Lección terminada");
    expect(screen.getByRole("link", { name: "Sigue: Alargar la salida" })).toHaveAttribute("href", "/cursos/respirar/lecciones/l3");
    await user.click(screen.getByRole("button", { name: "Volver a ver" }));
    await screen.findByTestId("reproductor");
    expect(actions.watchLessonAction).toHaveBeenCalledTimes(2);
  });

  it("la última lección termina sin «Sigue»", async () => {
    const { user } = show({ next: null });
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "termina" }));
    expect(screen.queryByRole("link", { name: /^Sigue/ })).toBeNull();
  });
});

describe("los subtítulos (RF-310)", () => {
  it("el reproductor arranca con ellos como la cuenta los dejó", async () => {
    const { user } = show({ captions: true });
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await screen.findByTestId("reproductor");
    expect(player.last).toMatchObject({ captions: true });
  });

  it("encenderlos se recuerda en la cuenta, y una dirección renovada sigue con ellos encendidos", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "enciende subtítulos" }));
    expect(actions.rememberCaptionsAction).toHaveBeenCalledExactlyOnceWith(true);
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, tokens: { ...GRANT.tokens, playback: "otro.p.p" } });
    await user.click(screen.getByRole("button", { name: "caduca" }));
    await waitFor(() => expect(player.last).toMatchObject({ tokens: { playback: "otro.p.p" }, captions: true }));
  });

  it("si no se pudo recordar, el video sigue igual y no se dice nada", async () => {
    actions.rememberCaptionsAction.mockRejectedValue(new Error("sin red"));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "enciende subtítulos" }));
    expect(screen.getByTestId("reproductor")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
  });
});

describe("PA-34: la cuenta ya reproduce en otro lugar (T-204, RF-107)", () => {
  it("dice dónde, con su navegador, la lección y desde cuándo, y lo anuncia", async () => {
    actions.watchLessonAction.mockResolvedValue({ kind: "busy", live: [ROW] });
    const { user, area, view } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    expect(await within(area()).findByRole("heading", { level: 2, name: "Tu cuenta ya está reproduciendo en otro lugar" })).toBeVisible();
    expect(within(area()).getByText("Puedes cerrar esa reproducción para ver esta lección aquí.")).toBeVisible();
    const row = within(screen.getByRole("list", { name: "Dónde se está reproduciendo" })).getByRole("listitem");
    expect(row).toHaveTextContent("Chrome en Windows");
    expect(row).toHaveTextContent("Respirar · Yoga suave · Desde las 7:40 p.m.");
    expect(within(row).getByRole("button", { name: "Cerrar esa reproducción (la de Chrome en Windows)" })).toBeVisible();
    expect(within(area()).getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/inicio");
    expect(within(area()).getByRole("link", { name: "¿No reconoces alguno? Cambia tu contraseña y cierra todas las sesiones" })).toHaveAttribute(
      "href",
      "/cuenta#bloque-contrasena",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Tu cuenta ya está reproduciendo en otro lugar Puedes cerrar esa reproducción para ver esta lección aquí.");
    expect(screen.queryByTestId("reproductor")).toBeNull();
    expect(await a11yViolations(view.container)).toEqual([]);
  });

  it("con más de una, en plural; y lo que no se sabe no se inventa", async () => {
    actions.watchLessonAction.mockResolvedValue({
      kind: "busy",
      live: [ROW, { ...ROW, sessionId: "d0000000-0000-4000-8000-000000000006", browser: null, system: null, lesson: null, course: null, since: "no es una fecha" }],
    });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Tu cuenta ya está reproduciendo en 2 lugares" })).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Reproductor" })).getByText("Puedes cerrar una de esas reproducciones para ver esta lección aquí.")).toBeVisible();
    const second = screen.getAllByRole("listitem")[1];
    expect(second).toHaveTextContent(/^Navegador desconocidoCerrar/);
  });

  it("de la lección o del curso, el que se sepa", async () => {
    actions.watchLessonAction.mockResolvedValue({ kind: "busy", live: [{ ...ROW, course: null }] });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    expect(await screen.findByText("Respirar · Desde las 7:40 p.m.")).toBeVisible();
  });

  it("«Cerrar esa reproducción» la cierra y abre esta en el mismo pedido; «Reintentar» solo vuelve a pedir", async () => {
    actions.watchLessonAction.mockResolvedValueOnce({ kind: "busy", live: [ROW] });
    actions.watchLessonAction.mockResolvedValueOnce({ kind: "busy", live: [ROW] });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, undefined);
    await user.click(await screen.findByRole("button", { name: /^Cerrar esa reproducción/ }));
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
    expect(await screen.findByTestId("reproductor")).toBeVisible();
  });
});

describe("el latido de presencia (T-204)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Reproduce, con relojes falsos: los clics van con fireEvent, que no espera tiempo. */
  async function playing() {
    vi.useFakeTimers();
    show();
    fireEvent.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("reproductor")).toBeVisible();
  }

  const press = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  /** El lugar del reproductor, sin la región que anuncia (que repite el texto). */
  const playerArea = () => screen.getByRole("region", { name: "Reproductor" }).querySelector<HTMLElement>("[tabindex='-1']") ?? document.body;
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("no late hasta que el video avanza; entonces late al momento y cada `heartbeatSeconds`, y deja de latir en pausa", async () => {
    await playing();
    await wait(60_000);
    expect(actions.playbackPresenceAction).not.toHaveBeenCalled();
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenCalledExactlyOnceWith("respirar", LESSON, PLAYBACK);
    await wait(29_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    await wait(1_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
    await press("se detiene");
    await wait(120_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
    // Al reanudar, otra vez al momento.
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(3);
  });

  it("al volver a la pestaña late, si avanza", async () => {
    await playing();
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
  });

  it("cerrada desde otro dispositivo: se va el video, lo dice, y «Reproducir aquí» toma el lugar desde el segundo en que iba", async () => {
    await playing();
    await press("va en 61");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "closed", from: "device", by: OTHER });
    await press("avanza");
    expect(screen.queryByTestId("reproductor")).toBeNull();
    expect(within(playerArea()).getByText("Esta reproducción se cerró desde otro dispositivo.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Esta reproducción se cerró desde otro dispositivo.");
    vi.useRealTimers();
    actions.playbackPresenceAction.mockResolvedValue({ kind: "ok" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Reproducir aquí" }));
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "61");
  });

  it("abierta en otra pestaña: su propio texto; sin la que tomó su lugar, «Reproducir aquí» pide sin cerrar nada", async () => {
    await playing();
    actions.playbackPresenceAction.mockResolvedValue({ kind: "closed", from: "tab", by: null });
    await press("avanza");
    expect(within(playerArea()).getByText("Esta lección se abrió en otra pestaña o ventana.")).toBeVisible();
    await press("Reproducir aquí");
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, undefined);
  });

  it("vencida y con el lugar tomado: PA-34, y cerrar la otra vuelve al segundo en que iba", async () => {
    await playing();
    await press("va en 61");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "busy", live: [ROW] });
    await press("avanza");
    expect(screen.getByRole("heading", { level: 2, name: "Tu cuenta ya está reproduciendo en otro lugar" })).toBeVisible();
    actions.playbackPresenceAction.mockResolvedValue({ kind: "ok" });
    await press("Cerrar esa reproducción (la de Chrome en Windows)");
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
    expect(screen.getByTestId("reproductor")).toHaveAttribute("data-start", "61");
  });

  it("si el latido no contesta o no se supo, el video sigue", async () => {
    await playing();
    actions.playbackPresenceAction.mockRejectedValueOnce(new Error("sin red"));
    actions.playbackPresenceAction.mockResolvedValueOnce({ kind: "unavailable" });
    await press("avanza");
    await wait(30_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("reproductor")).toBeVisible();
  });

  it("mientras se renueva la dirección no late, y un latido de la reproducción anterior que llega tarde no pinta nada", async () => {
    await playing();
    let answer: (reply: unknown) => void = () => undefined;
    actions.playbackPresenceAction.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await press("avanza");
    // La dirección caduca con el latido en camino; la nueva tarda en llegar.
    let renewed: (grant: unknown) => void = () => undefined;
    actions.watchLessonAction.mockImplementationOnce(() => new Promise((resolve) => (renewed = resolve)));
    await press("caduca");
    await wait(90_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    // El latido viejo contesta: la reproducción anterior fue reemplazada por la renovación.
    await act(async () => {
      answer({ kind: "closed", from: "tab", by: OTHER });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("reproductor")).toBeVisible();
    expect(screen.queryByText("Esta lección se abrió en otra pestaña o ventana.")).toBeNull();
    // Llega la nueva, con otra reproducción: late con ella.
    await act(async () => {
      renewed({ ...GRANT, playbackSessionId: OTHER });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.playbackPresenceAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
  });

  it("si la acción manda a la página (la sesión ya no pasa, o la cuenta se suspendió), no se toma por un error", async () => {
    await playing();
    actions.playbackPresenceAction.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/cursos/respirar;307;" }));
    await press("avanza");
    expect(screen.getByTestId("reproductor")).toBeVisible();
  });

  it("al terminar o fallar deja de latir", async () => {
    await playing();
    await press("avanza");
    await press("termina");
    await wait(120_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
  });
});
