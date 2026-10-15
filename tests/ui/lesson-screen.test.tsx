import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

// La pantalla de una lección (PA-22, T-203), con la acción y el reproductor simulados: qué se
// pinta en el lugar del reproductor en cada estado, el temario y lo de alrededor. El reproductor
// de verdad lo prueba tests/ui/player.test.tsx, y la página entera, el extremo a extremo.

const actions = vi.hoisted(() => ({ watchLessonAction: vi.fn() }));
vi.mock("@/app/cursos/[slug]/lecciones/[leccion]/actions", () => actions);

const player = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("@/app/_video/player", () => ({
  Player: (props: { watermark?: string; startTime: number; onExpired: (at: number) => void; onFailed: () => void; onPlaying: () => void; onEnded?: () => void }) => {
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
      </div>
    );
  },
}));

import { LessonScreen, type LessonScreenProps } from "@/app/cursos/[slug]/lecciones/[leccion]/screen";

const LESSON = "b0000000-0000-4000-8000-000000000002";
const GRANT = {
  kind: "granted",
  playbackId: "P",
  tokens: { playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" },
  speeds: [0.75, 1, 2],
  watermark: "ana@correo.com",
};

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
    expect(actions.watchLessonAction).toHaveBeenCalledExactlyOnceWith("respirar", LESSON);
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
