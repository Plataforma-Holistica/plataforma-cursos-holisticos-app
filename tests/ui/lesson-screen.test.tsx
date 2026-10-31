import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

// La pantalla de una lección (PA-22, T-203), con la acción y el reproductor simulados: qué se
// pinta en el lugar del reproductor en cada estado, el temario y lo de alrededor. El reproductor
// de verdad lo prueba tests/ui/player.test.tsx, y la página entera, el extremo a extremo.

const actions = vi.hoisted(() => ({ watchLessonAction: vi.fn(), rememberCaptionsAction: vi.fn(), playbackPresenceAction: vi.fn(), flushHeartbeatsAction: vi.fn() }));
vi.mock("@/app/cursos/[slug]/lecciones/[leccion]/actions", () => actions);

// El cartero de los tramos vive en el módulo: cada prueba tiene el suyo, sobre el `localStorage`
// del DOM simulado (que no trae Web Locks).
const postman = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/app/cursos/[slug]/lecciones/[leccion]/watch-queue", async (original) => {
  const real = await original<Record<string, unknown>>();
  return { ...real, courier: new Proxy({}, { get: (_, key) => (postman.current as Record<PropertyKey, unknown>)[key] }) };
});

const player = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("@/app/_catalog/resources/actions", () => ({ downloadResourceAction: vi.fn() }));
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
    onWatch?: (signal: unknown) => void;
    notice?: string | null;
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
import { createCourier } from "@/app/cursos/[slug]/lecciones/[leccion]/watch-queue";
import { terms } from "@/messages/es/terms";

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
  durationSeconds: 356,
  startSeconds: 0,
};
/** Una reproducción viva en otra computadora: 01:40 UTC son las 19:40 en el centro de México. */
const ROW = { sessionId: OTHER, browser: "chrome", system: "windows", lesson: "Respirar", course: "Yoga suave", since: "2026-10-19T01:40:00.000Z" };

const PROPS: LessonScreenProps = {
  resources: [],
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
        { id: "l1", number: 1, title: "Soltar los hombros", duration: "5 min", current: false, href: "/cursos/respirar/lecciones/l1", state: "not_started" },
        {
          id: LESSON,
          number: 2,
          title: "Respirar acostado",
          duration: "7 min",
          current: true,
          href: `/cursos/respirar/lecciones/${LESSON}`,
          state: "not_started",
        },
      ],
    },
  ],
  progress: { completed: 0, total: 2 },
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
  window.localStorage.clear();
  postman.current = createCourier({
    storage: () => window.localStorage,
    locks: () => null,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer),
  });
  actions.flushHeartbeatsAction.mockImplementation((_id: string, events: { seq: number }[]) => Promise.resolve({ kind: "settled", seqs: events.map((event) => event.seq) }));
  actions.watchLessonAction.mockResolvedValue(GRANT);
  actions.rememberCaptionsAction.mockResolvedValue(undefined);
  actions.playbackPresenceAction.mockResolvedValue({ kind: "ok", batch: null });
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

  it("el deslinde (RF-809) va al pie", () => {
    show();
    const disclaimer = screen.getByText(`${terms.Plataforma} es educativa. No sustituye la atención médica ni psicológica profesional.`).closest("p");
    expect(disclaimer).toBeVisible();
    expect(screen.getByRole("main").lastElementChild).toBe(disclaimer);
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
    expect(screen.getByText("Tu avance sigue aquí.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reproducir la lección" })).toBeNull();
  });

  it.each([
    [{ reason: "never_subscribed" } as const, "Esta lección pide una suscripción", "Con una suscripción ves todo el catálogo."],
    [{ reason: "grace_ended", date: "2 de octubre de 2026" } as const, "Tu acceso terminó el 2 de octubre de 2026", "No pudimos cobrar tu suscripción. Tu avance sigue aquí."],
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
    expect(screen.getByRole("status")).toHaveTextContent("No pudimos cargar el video. Tu avance está guardado.");
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
    expect(screen.getByRole("status")).toHaveTextContent("No pudimos cargar el video. Tu avance está guardado.");
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
    expect(row).toHaveTextContent("Respirar · Yoga suave · desde las 7:40 p.m.");
    expect(within(row).getByRole("button", { name: "Cerrar esa reproducción (la de Chrome en Windows)" })).toBeVisible();
    expect(within(area()).getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/inicio");
    expect(within(area()).getByRole("link", { name: "¿No reconoces alguno? Cambia tu contraseña y cierra todas las sesiones" })).toHaveAttribute(
      "href",
      "/cuenta#bloque-contrasena",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Tu cuenta ya está reproduciendo en otro lugar Puedes cerrar esa reproducción para ver esta lección aquí.");
    expect(screen.queryByTestId("reproductor")).toBeNull();
    // Crece lo necesario, y en el teléfono no se queda pegado arriba: taparía la página.
    expect(screen.getByRole("region", { name: "Reproductor" })).not.toHaveClass("sticky");
    expect(await a11yViolations(view.container)).toEqual([]);
  });

  it("el reproductor sí va pegado arriba en el teléfono", async () => {
    const { user } = show();
    expect(screen.getByRole("region", { name: "Reproductor" })).toHaveClass("sticky");
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await screen.findByTestId("reproductor");
    expect(screen.getByRole("region", { name: "Reproductor" })).toHaveClass("sticky");
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
    expect(await screen.findByText("Respirar · desde las 7:40 p.m.")).toBeVisible();
  });

  it("«Cerrar esa reproducción» la cierra y abre esta en el mismo pedido; «Reintentar» solo vuelve a pedir", async () => {
    actions.watchLessonAction.mockResolvedValueOnce({ kind: "busy", live: [ROW] });
    actions.watchLessonAction.mockResolvedValueOnce({ kind: "busy", live: [ROW] });
    // Desde el primer pedido, la que se abre arranca donde se quedó: lo trae la concesión (T-206).
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, startSeconds: 120 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, undefined);
    await user.click(await screen.findByRole("button", { name: /^Cerrar esa reproducción/ }));
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "120");
  });

  it("«Reintentar» en PA-34 desde el primer pedido también arranca donde diga la concesión (T-206)", async () => {
    actions.watchLessonAction.mockResolvedValueOnce({ kind: "busy", live: [ROW] });
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, startSeconds: 120 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "120");
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
    expect(actions.playbackPresenceAction).toHaveBeenCalledExactlyOnceWith("respirar", LESSON, PLAYBACK, []);
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

  it("al irse de la pestaña no late", async () => {
    await playing();
    await press("avanza");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    visibility.mockRestore();
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
  });

  it("cerrada desde otro dispositivo: se va el video, lo dice, y «Reproducir aquí» toma el lugar desde el segundo en que iba", async () => {
    await playing();
    await press("va en 61");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "closed", from: "device", by: OTHER, batch: null });
    await press("avanza");
    expect(screen.queryByTestId("reproductor")).toBeNull();
    expect(within(playerArea()).getByText("Esta reproducción se cerró desde otro dispositivo.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Esta reproducción se cerró desde otro dispositivo.");
    vi.useRealTimers();
    actions.playbackPresenceAction.mockResolvedValue({ kind: "ok", batch: null });
    await userEvent.setup().click(screen.getByRole("button", { name: "Reproducir aquí" }));
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "61");
  });

  it("abierta en otra pestaña: su propio texto; sin la que tomó su lugar, «Reproducir aquí» pide sin cerrar nada", async () => {
    await playing();
    actions.playbackPresenceAction.mockResolvedValue({ kind: "closed", from: "tab", by: null, batch: null });
    await press("avanza");
    expect(within(playerArea()).getByText("Esta lección se abrió en otra pestaña o ventana.")).toBeVisible();
    await press("Reproducir aquí");
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, undefined);
  });

  it("vencida y con el lugar tomado: PA-34, y cerrar la otra vuelve al segundo en que iba", async () => {
    await playing();
    await press("va en 61");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "busy", live: [ROW], batch: null });
    await press("avanza");
    expect(screen.getByRole("heading", { level: 2, name: "Tu cuenta ya está reproduciendo en otro lugar" })).toBeVisible();
    actions.playbackPresenceAction.mockResolvedValue({ kind: "ok", batch: null });
    await press("Cerrar esa reproducción (la de Chrome en Windows)");
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER);
    expect(screen.getByTestId("reproductor")).toHaveAttribute("data-start", "61");
  });

  it("«Reintentar» en PA-34 también vuelve al segundo en que iba", async () => {
    await playing();
    await press("va en 61");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "busy", live: [ROW], batch: null });
    await press("avanza");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "ok", batch: null });
    await press("Reintentar");
    expect(actions.watchLessonAction).toHaveBeenLastCalledWith("respirar", LESSON, undefined);
    expect(screen.getByTestId("reproductor")).toHaveAttribute("data-start", "61");
  });

  it("si el latido no contesta o no se supo, el video sigue", async () => {
    await playing();
    actions.playbackPresenceAction.mockRejectedValueOnce(new Error("sin red"));
    actions.playbackPresenceAction.mockResolvedValueOnce({ kind: "unavailable", batch: null });
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
    // Si el Mux Player viejo aún dijera que avanza, tampoco: su reproducción está por reemplazarse.
    await press("avanza");
    await wait(30_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    // El latido viejo contesta: la reproducción anterior fue reemplazada por la renovación.
    await act(async () => {
      answer({ kind: "closed", from: "tab", by: OTHER, batch: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("reproductor")).toBeVisible();
    expect(screen.queryByText("Esta lección se abrió en otra pestaña o ventana.")).toBeNull();
    // Llega la nueva, con otra reproducción: no late hasta que su video avanza (en un iPhone puede
    // quedarse esperando un toque), y entonces late con ella.
    await act(async () => {
      renewed({ ...GRANT, playbackSessionId: OTHER });
      await vi.advanceTimersByTimeAsync(0);
    });
    await wait(60_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenLastCalledWith("respirar", LESSON, OTHER, []);
  });

  it("pausar y reanudar seguido no manda un latido por pulsación", async () => {
    await playing();
    await press("avanza");
    await press("se detiene");
    await press("avanza");
    await press("se detiene");
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    await press("se detiene");
    await wait(5_000);
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["cero", 0, 5_000],
    ["más de lo que cabe en un temporizador", 10_000_000, 300_000],
  ])("un `heartbeatSeconds` fuera de rango (%s) se acota", async (_what, seconds, every) => {
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, heartbeatSeconds: seconds });
    await playing();
    await press("avanza");
    await wait(every - 1);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
  });

  it("un latido que contesta después de que el video falló no lo pisa", async () => {
    await playing();
    let answer: (reply: unknown) => void = () => undefined;
    actions.playbackPresenceAction.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await press("avanza");
    // El error y la respuesta, en la misma vuelta: React todavía no aplicó el error ni limpió el
    // latido. El aviso llega del reproductor como lo manda Mux (no un clic, que se aplica al momento).
    await act(async () => {
      (player.last?.onFailed as () => void)();
      answer({ kind: "closed", from: "device", by: OTHER, batch: null });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(playerArea()).getByText("No pudimos cargar el video. Tu avance está guardado.")).toBeVisible();
    expect(within(playerArea()).queryByText("Esta reproducción se cerró desde otro dispositivo.")).toBeNull();
  });

  it("si el latido no llega (una redirección de la acción, o la red), el video sigue: la redirección la hace Next", async () => {
    await playing();
    actions.playbackPresenceAction.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/cursos/respirar;307;" }));
    await press("avanza");
    expect(screen.getByTestId("reproductor")).toBeVisible();
  });

  it.each([["termina"], ["falla"]])("si %s, deja de latir", async (what) => {
    await playing();
    await press("avanza");
    await press(what);
    await wait(120_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
  });
});

describe("los tramos vistos (T-205)", () => {
  // El latido resuelve lo que lleva, como el servidor cuando todo sale bien.
  beforeEach(() => {
    actions.playbackPresenceAction.mockImplementation((_slug: string, _lesson: string, _id: string, events: { seq: number }[]) =>
      Promise.resolve({ kind: "ok", batch: { kind: "settled", seqs: events.map((event) => event.seq) } }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function playing(props: Partial<LessonScreenProps> = {}) {
    vi.useFakeTimers();
    const view = show(props);
    fireEvent.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return view;
  }
  const press = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const signal = (value: unknown) => act(() => (player.last?.onWatch as (signal: unknown) => void)(value));
  /** El video avanza de `from` a `to` a velocidad normal: una muestra cada cuarto de segundo, con el reloj. */
  async function watch(from: number, to: number) {
    for (let at = from; at <= to; at += 0.25) {
      await signal({ kind: "tick", at, rate: 1, duration: 356 });
      if (at < to) await wait(250);
    }
  }
  const sent = (call: unknown[] | undefined) => (call?.at(-1) as { seq: number; from: number; to: number; visible: boolean }[] | undefined) ?? [];
  const stored = (id: string) => window.localStorage.getItem(`plataforma-latidos:${id}`);
  /** Todo lo que salió, con latido o sin presencia, una vez cada consecutivo y en orden. */
  const everything = () => {
    const all = [...actions.playbackPresenceAction.mock.calls, ...actions.flushHeartbeatsAction.mock.calls].flatMap((call) => sent(call));
    return [...new Map(all.map((event) => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
  };

  it("el latido corta el tramo abierto y lleva lo visto; lo resuelto sale de la cola", async () => {
    await playing();
    await press("avanza");
    expect(actions.playbackPresenceAction).toHaveBeenLastCalledWith("respirar", LESSON, PLAYBACK, []);
    // El latido sale a los 30 s del anterior, con la última muestra antes de él.
    await watch(0, 30);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(2);
    expect(sent(actions.playbackPresenceAction.mock.calls[1])).toEqual([{ seq: 0, from: 0, to: 29, rate: 1, visible: true }]);
    await wait(0);
    expect(stored(PLAYBACK)).toBeNull();
    // El siguiente sigue desde el borde, con el siguiente consecutivo.
    await watch(30.25, 60);
    await wait(250);
    expect(sent(actions.playbackPresenceAction.mock.calls[2])).toEqual([{ seq: 1, from: 29, to: 60, rate: 1, visible: true }]);
  });

  it("un latido que no contesta deja lo suyo en la cola, guardado, y sale sin presencia a los 5 s", async () => {
    await playing();
    await press("avanza");
    actions.playbackPresenceAction.mockRejectedValueOnce(new Error("sin red"));
    await watch(0, 30);
    expect(sent(actions.playbackPresenceAction.mock.calls[1])).toEqual([{ seq: 0, from: 0, to: 29, rate: 1, visible: true }]);
    expect(JSON.parse(stored(PLAYBACK) ?? "{}").events).toHaveLength(1);
    expect(actions.flushHeartbeatsAction).not.toHaveBeenCalled();
    await wait(5_000);
    expect(actions.flushHeartbeatsAction).toHaveBeenCalledExactlyOnceWith(PLAYBACK, [{ seq: 0, from: 0, to: 29, rate: 1, visible: true }]);
    expect(stored(PLAYBACK)).toBeNull();
  });

  it("si un latido va en camino, no sale otro", async () => {
    await playing();
    actions.playbackPresenceAction.mockImplementationOnce(() => new Promise(() => undefined));
    await press("avanza");
    await wait(120_000);
    expect(actions.playbackPresenceAction).toHaveBeenCalledTimes(1);
  });

  it("al pausar, lo visto sale sin presencia", async () => {
    await playing();
    await press("avanza");
    await watch(0, 10);
    await signal({ kind: "stop" });
    await press("se detiene");
    expect(actions.flushHeartbeatsAction).toHaveBeenCalledExactlyOnceWith(PLAYBACK, [{ seq: 0, from: 0, to: 10, rate: 1, visible: true }]);
    await wait(0);
    expect(stored(PLAYBACK)).toBeNull();
  });

  it("una muestra que no avanza no se cuenta: buscar en pausa y volver mucho después no acredita lo saltado", async () => {
    await playing();
    await press("avanza");
    await watch(0, 5);
    await signal({ kind: "stop" });
    await wait(600_000);
    await watch(300, 302);
    await signal({ kind: "stop" });
    await press("se detiene");
    expect(everything()).toEqual([
      { seq: 0, from: 0, to: 5, rate: 1, visible: true },
      { seq: 1, from: 300, to: 302, rate: 1, visible: true },
    ]);
  });

  it("con la pestaña oculta, lo visto sale como no visible; al ocultarla, se corta y se manda", async () => {
    await playing();
    await press("avanza");
    await watch(0, 5);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent(actions.flushHeartbeatsAction.mock.calls[0])).toEqual([{ seq: 0, from: 0, to: 5, rate: 1, visible: true }]);
    await watch(5.25, 9);
    visibility.mockRestore();
    await signal({ kind: "stop" });
    await press("se detiene");
    // Ocultar detuvo la cadena: lo oculto empieza en otra, hacia arriba.
    expect(sent(actions.flushHeartbeatsAction.mock.calls[1])).toEqual([{ seq: 1, from: 6, to: 9, rate: 1, visible: false }]);
  });

  it("ocultar y volver entre dos muestras detiene la cadena: lo de en medio no sale como visible", async () => {
    await playing();
    await press("avanza");
    await watch(0, 5);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    visibility.mockRestore();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await watch(5.25, 9);
    await signal({ kind: "stop" });
    await press("se detiene");
    expect(everything()).toEqual([
      { seq: 0, from: 0, to: 5, rate: 1, visible: true },
      { seq: 1, from: 6, to: 9, rate: 1, visible: true },
    ]);
  });

  it("al renovar la dirección, lo de la reproducción vieja sale a la vieja, y el viejo no suma mientras llega la nueva", async () => {
    await playing();
    await press("avanza");
    await watch(0, 10);
    let renewed: (grant: unknown) => void = () => undefined;
    actions.watchLessonAction.mockImplementationOnce(() => new Promise((resolve) => (renewed = resolve)));
    await signal({ kind: "stop" });
    await press("caduca");
    // El Mux Player viejo sigue con lo que tenía cargado: no suma.
    await watch(10, 20);
    await act(async () => {
      renewed({ ...GRANT, playbackSessionId: OTHER });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.flushHeartbeatsAction).toHaveBeenCalledExactlyOnceWith(PLAYBACK, [{ seq: 0, from: 0, to: 10, rate: 1, visible: true }]);
  });

  it("al salir de la pantalla (navegar dentro de la aplicación), el tramo abierto se cierra y sale", async () => {
    const { view } = await playing();
    await press("avanza");
    await watch(0, 12);
    view.unmount();
    await wait(0);
    expect(actions.flushHeartbeatsAction).toHaveBeenCalledExactlyOnceWith(PLAYBACK, [{ seq: 0, from: 0, to: 12, rate: 1, visible: true }]);
  });

  it("al irse la página, el tramo abierto se guarda, sin mandarse", async () => {
    await playing();
    await press("avanza");
    await watch(0, 12);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.flushHeartbeatsAction).not.toHaveBeenCalled();
    expect(JSON.parse(stored(PLAYBACK) ?? "{}").events).toEqual([{ seq: 0, from: 0, to: 12, rate: 1, visible: true }]);
  });

  it("al abrir una lección, lo que quedó guardado de otra visita sale", async () => {
    vi.useFakeTimers();
    const event = { seq: 3, from: 60, to: 90, rate: 1, visible: true };
    window.localStorage.setItem(`plataforma-latidos:${OTHER}`, JSON.stringify({ v: 1, touched: Date.now() - 3_600_000, next: 4, events: [event] }));
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.flushHeartbeatsAction).toHaveBeenCalledExactlyOnceWith(OTHER, [event]);
    expect(stored(OTHER)).toBeNull();
  });

  it("«Sin conexión. Reintentando…» a los dos envíos fallidos seguidos, y se va con el primero que contesta", async () => {
    await playing();
    actions.playbackPresenceAction.mockRejectedValue(new Error("sin red"));
    await press("avanza");
    expect(screen.queryAllByText("Sin conexión. Reintentando…")).toEqual([]);
    await wait(30_000);
    // Una sola vez, en su propia región viva; la del reproductor no la repite.
    const note = screen.getByText("Sin conexión. Reintentando…");
    expect(note).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status", { name: "" }).textContent).not.toContain("Sin conexión");
    expect(player.last?.notice).toBe("Sin conexión. Reintentando…");
    actions.playbackPresenceAction.mockResolvedValue({ kind: "ok", batch: null });
    await wait(30_000);
    expect(screen.queryAllByText("Sin conexión. Reintentando…")).toEqual([]);
    expect(player.last?.notice).toBeNull();
  });
});

describe("el progreso (T-206, RF-307)", () => {
  const modules = (first: "not_started" | "in_progress" | "completed", second: "not_started" | "in_progress" | "completed") =>
    PROPS.modules.map((group) => ({
      ...group,
      lessons: group.lessons.map((lesson, index) => ({ ...lesson, state: index === 0 ? first : second })),
    }));

  it("el temario dice el estado de cada lección y cuántas van, con su barra, en la columna y en la pestaña", async () => {
    const { view } = show({ modules: modules("completed", "in_progress"), progress: { completed: 1, total: 2 } });
    expect(screen.getAllByRole("link", { name: "Lección 1, Soltar los hombros, 5 min, terminada", hidden: true })).toHaveLength(2);
    // La que se está viendo dice «reproduciendo»: a medias ya va implícito.
    expect(screen.getAllByRole("link", { name: "Lección 2, Respirar acostado, 7 min, reproduciendo", hidden: true })).toHaveLength(2);
    const bars = screen.getAllByRole("progressbar", { hidden: true });
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar).toHaveAccessibleName("Avance del curso");
      expect(bar).toHaveAttribute("aria-valuetext", "1 de 2 lecciones");
    }
    expect(await a11yViolations(view.container)).toEqual([]);
  });

  it("el video arranca donde se quedó: el segundo lo trae la concesión", async () => {
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, startSeconds: 120 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "120");
  });

  it("«Volver a ver» arranca desde el principio, aunque la concesión diga otro segundo", async () => {
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, startSeconds: 120 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "termina" }));
    await user.click(screen.getByRole("button", { name: "Volver a ver" }));
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "0");
  });

  it("«Reintentar» después de un error sigue en el segundo en que iba, no en 0", async () => {
    actions.watchLessonAction.mockResolvedValue({ ...GRANT, startSeconds: 10 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "va en 61" }));
    await user.click(screen.getByRole("button", { name: "falla" }));
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "61");
  });

  it("«Reintentar» sin haber empezado arranca donde diga la concesión", async () => {
    actions.watchLessonAction.mockRejectedValueOnce(new Error("sin red")).mockResolvedValue({ ...GRANT, startSeconds: 30 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-start", "30");
  });

  describe("al momento", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const settled = (lessonId: string, completed: boolean, justCompleted: boolean) => ({
      kind: "settled",
      seqs: [] as number[],
      progress: { lessonId, coveredSeconds: completed ? 380 : 10, completed, justCompleted },
    });
    async function playing() {
      vi.useFakeTimers();
      show();
      fireEvent.click(screen.getByRole("button", { name: "Reproducir la lección" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    const press = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    /** El video avanza de `from` a `to`: una muestra cada cuarto de segundo, con el reloj. */
    async function seen(from: number, to: number) {
      for (let at = from; at <= to; at += 0.25) {
        await act(() => (player.last?.onWatch as (signal: unknown) => void)({ kind: "tick", at, rate: 1, duration: 356 }));
        if (at < to) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(250);
          });
        }
      }
    }

    it("el latido que la termina la marca sin recargar, cuenta una más, y lo dice una vez", async () => {
      actions.playbackPresenceAction.mockResolvedValue({ kind: "ok", batch: settled(LESSON, true, true) });
      await playing();
      await press("avanza");
      expect(screen.getAllByRole("link", { name: "Lección 2, Respirar acostado, 7 min, terminada, reproduciendo", hidden: true })).toHaveLength(2);
      for (const bar of screen.getAllByRole("progressbar", { hidden: true })) expect(bar).toHaveAttribute("aria-valuetext", "1 de 2 lecciones");
      expect(screen.getByText("Esta lección ya cuenta como terminada.")).toBeInTheDocument();
    });

    it("también si lo dice un envío sin presencia (al pausar), y de otra lección del temario", async () => {
      actions.flushHeartbeatsAction.mockResolvedValue(settled("l1", true, true));
      await playing();
      await seen(0, 3);
      await act(() => (player.last?.onWatch as (signal: unknown) => void)({ kind: "stop" }));
      await press("se detiene");
      expect(screen.getAllByRole("link", { name: "Lección 1, Soltar los hombros, 5 min, terminada", hidden: true })).toHaveLength(2);
      // De otra lección no se anuncia: no es la que se está viendo.
      expect(screen.queryByText("Esta lección ya cuenta como terminada.")).toBeNull();
    });

    it("lo que ya estaba terminada no se anuncia otra vez, y lo de una lección de otro curso no cambia nada", async () => {
      actions.playbackPresenceAction
        .mockResolvedValueOnce({ kind: "ok", batch: settled(LESSON, true, false) })
        .mockResolvedValue({ kind: "ok", batch: settled("de-otro-curso", true, true) });
      await playing();
      await press("avanza");
      expect(screen.getAllByRole("link", { name: "Lección 2, Respirar acostado, 7 min, terminada, reproduciendo", hidden: true })).toHaveLength(2);
      expect(screen.queryByText("Esta lección ya cuenta como terminada.")).toBeNull();
      for (const bar of screen.getAllByRole("progressbar", { hidden: true })) expect(bar).toHaveAttribute("aria-valuetext", "1 de 2 lecciones");
    });

    it("si el envío contesta ya con el video terminado, también se anuncia", async () => {
      let answer: (value: unknown) => void = () => undefined;
      actions.flushHeartbeatsAction.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      await playing();
      await seen(0, 3);
      await act(() => (player.last?.onWatch as (signal: unknown) => void)({ kind: "stop" }));
      await press("se detiene");
      await press("termina");
      await act(async () => {
        answer(settled(LESSON, true, true));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Esta lección ya cuenta como terminada.")).toBeInTheDocument();
    });

    it("una a medias que se empieza a ver queda a medias, sin anunciarse", async () => {
      actions.flushHeartbeatsAction.mockResolvedValue(settled("l1", false, false));
      await playing();
      await seen(0, 3);
      await act(() => (player.last?.onWatch as (signal: unknown) => void)({ kind: "stop" }));
      await press("se detiene");
      expect(screen.getAllByRole("link", { name: "Lección 1, Soltar los hombros, 5 min, a medias", hidden: true })).toHaveLength(2);
      for (const bar of screen.getAllByRole("progressbar", { hidden: true })) expect(bar).toHaveAttribute("aria-valuetext", "0 de 2 lecciones");
    });
  });
});

describe("el progreso, con lo que trae la página y lo que llega después (T-206)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const note = (lessonId: string, coveredSeconds: number, completed: boolean, justCompleted = false) => ({
    kind: "settled",
    seqs: [] as number[],
    progress: { lessonId, coveredSeconds, completed, justCompleted },
  });
  const states = (first: "not_started" | "in_progress" | "completed", second: "not_started" | "in_progress" | "completed") =>
    PROPS.modules.map((group) => ({ ...group, lessons: group.lessons.map((lesson, index) => ({ ...lesson, state: index === 0 ? first : second })) }));
  const seenWith = async (flushed: unknown, props: Partial<LessonScreenProps> = {}) => {
    vi.useFakeTimers();
    window.localStorage.setItem(
      `plataforma-latidos:${OTHER}`,
      JSON.stringify({ v: 1, touched: Date.now() - 3_600_000, next: 1, events: [{ seq: 0, from: 0, to: 30, rate: 1, visible: true }] }),
    );
    actions.flushHeartbeatsAction.mockResolvedValue(flushed);
    const view = show(props);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return view;
  };

  it("si la página llega después con la lección terminada (otro aparato), manda la página: el estado nunca baja", async () => {
    const { view } = await seenWith(note("l1", 30, false));
    expect(screen.getAllByRole("link", { name: "Lección 1, Soltar los hombros, 5 min, a medias", hidden: true })).toHaveLength(2);
    view.rerender(<LessonScreen {...PROPS} modules={states("completed", "not_started")} progress={{ completed: 1, total: 2 }} />);
    expect(screen.getAllByRole("link", { name: "Lección 1, Soltar los hombros, 5 min, terminada", hidden: true })).toHaveLength(2);
    for (const bar of screen.getAllByRole("progressbar", { hidden: true })) expect(bar).toHaveAttribute("aria-valuetext", "1 de 2 lecciones");
  });

  it("una nota sin segundos (lo visto, todo oculto) no baja una fila a medias", async () => {
    await seenWith(note("l1", 0, false), { modules: states("in_progress", "not_started") });
    expect(screen.getAllByRole("link", { name: "Lección 1, Soltar los hombros, 5 min, a medias", hidden: true })).toHaveLength(2);
  });

  it("lo que una cola de otra visita termina al abrir la página cambia la fila, pero no se anuncia: el video no está ahí", async () => {
    await seenWith(note(LESSON, 330, true, true));
    expect(screen.getAllByRole("link", { name: "Lección 2, Respirar acostado, 7 min, terminada, reproduciendo", hidden: true })).toHaveLength(2);
    expect(screen.queryByText("Esta lección ya cuenta como terminada.")).toBeNull();
  });

  it("al navegar a otra lección del curso, lo que contesta tarde el vaciado de la anterior le llega a la nueva", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => undefined;
    actions.flushHeartbeatsAction.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const view = show();
    fireEvent.click(screen.getByRole("button", { name: "Reproducir la lección" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const tick = (at: number) => act(() => (player.last?.onWatch as (signal: unknown) => void)({ kind: "tick", at, rate: 1, duration: 356 }));
    for (let at = 0; at <= 3; at += 0.25) {
      await tick(at);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
    }
    // Se va a la lección 1 del mismo curso: la pantalla se desmonta y su tramo sale sin presencia.
    view.view.unmount();
    const other = PROPS.modules.map((group) => ({
      ...group,
      lessons: group.lessons.map((lesson) => ({ ...lesson, current: lesson.id === "l1" })),
    }));
    show({ lessonId: "l1", modules: other });
    await act(async () => {
      answer(note(LESSON, 330, true, true));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByRole("link", { name: "Lección 2, Respirar acostado, 7 min, terminada", hidden: true })).toHaveLength(2);
    expect(screen.queryByText("Esta lección ya cuenta como terminada.")).toBeNull();
  });
});

// Los recursos de la lección (RF-308; T-404): en escritorio bajo «Sobre esta lección», en teléfono en su pestaña.
describe("los recursos de la lección", () => {
  const GUIDE = { id: "f0000000-0000-4000-8000-000000000001", title: "Guía", detail: "PDF, 2 MB" };

  it("con alguno: la lista con su botón, y su pestaña", () => {
    show({ resources: [GUIDE] });
    expect(screen.getByRole("heading", { name: "Recursos de esta lección" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Descargar Guía" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Recursos" })).toBeTruthy();
  });

  it("sin ninguno: ni bloque ni pestaña", () => {
    show({ resources: [] });
    expect(screen.queryByRole("heading", { name: "Recursos de esta lección" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Recursos" })).toBeNull();
  });

  it("si no se pudieron leer, se dice, y el resto de la página sigue", () => {
    show({ resources: null });
    expect(screen.getAllByText("No pudimos leer los recursos de esta lección. Recarga la página para intentar de nuevo.").length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "Recursos" })).toBeTruthy();
  });

  it("si el acceso termina con la página abierta, se van; y quien estaba en su pestaña no se queda sin ninguna", async () => {
    actions.watchLessonAction.mockResolvedValue({ kind: "denied", denial: { reason: "never_subscribed" } });
    const user = userEvent.setup();
    show({ resources: [GUIDE] });
    await user.click(screen.getByRole("tab", { name: "Recursos" }));
    expect(screen.getByRole("tab", { name: "Recursos" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Reproducir la lección" }));

    await screen.findByText("Esta lección pide una suscripción");
    expect(screen.queryByRole("heading", { name: "Recursos de esta lección" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Recursos" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Descargar Guía" })).toBeNull();
    // Una sigue seleccionada, con su panel a la vista y al alcance del teclado.
    const selected = screen.getByRole("tab", { selected: true });
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel", { name: selected.textContent })).toBeVisible();
  });
});
