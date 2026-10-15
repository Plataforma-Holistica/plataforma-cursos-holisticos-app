import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La pantalla de revisión (PA-61 y PA-62 mínimas; T-108). Las acciones de servidor son la
// frontera con los servicios: aquí se cambian por lo que contestarían. Mux Player se cambia
// por uno de mentira que dice qué recibió y deja provocar sus avisos: lo que hace el de verdad
// lo prueba el extremo a extremo.
const actions = vi.hoisted(() => ({
  reviewCodeAction: vi.fn(),
  approveAction: vi.fn(),
  lessonVideoAction: vi.fn(),
}));
vi.mock("@/app/admin/_revision/actions", () => actions);

const player = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
vi.mock("@/app/_video/player", () => ({
  Player: (props: { playbackId: string; tokens: object; startTime: number; onExpired: (at: number) => void; onFailed: () => void; onPlaying: () => void }) => {
    player.last = props;
    return (
      <div data-testid="reproductor" data-playback={props.playbackId} data-start={String(props.startTime)} data-tokens={JSON.stringify(props.tokens)}>
        <button type="button" onClick={() => props.onExpired(42)}>
          caduca
        </button>
        <button type="button" onClick={() => props.onFailed()}>
          falla
        </button>
        <button type="button" onClick={() => props.onPlaying()}>
          reproduce
        </button>
      </div>
    );
  },
}));

import type { ReviewState } from "@/app/admin/_revision/outcomes";
import { reviewView } from "@/app/admin/_revision/rows";
import { ReviewScreen } from "@/app/admin/_revision/screen";
import type { ReviewQueue } from "@/services/review/review";

import { a11yViolations } from "../setup/a11y";

beforeEach(() => {
  // Sin respuestas pendientes de la prueba anterior.
  vi.resetAllMocks();
  player.last = null;
});

const COURSE = "c0000000-0000-4000-8000-000000000002";
const MUX = "d0000000-0000-4000-8000-000000000001";
const TEST = "d0000000-0000-4000-8000-000000000002";
const MODULE = "e0000000-0000-4000-8000-000000000001";
const GRANT = { kind: "granted", playbackId: "PlaybackDePrueba", tokens: { playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" }, speeds: [0.75, 1, 2] };

const queueOf = (over: Partial<ReviewQueue> = {}): ReviewQueue => ({
  freshCode: true,
  courses: [
    {
      courseId: COURSE,
      title: "Naturaleza",
      teacherName: "Ana Robles",
      teacherListed: false,
      practice: "Naturaleza",
      level: "Principiante",
      lessonCount: 2,
      totalDurationSeconds: 765,
      loadedAt: "2026-10-14T18:00:00Z",
      lessons: [
        { lessonId: MUX, moduleId: MODULE, module: "Uno", title: "El bosque", durationSeconds: 356, video: "playable" },
        { lessonId: TEST, moduleId: MODULE, module: "Uno", title: "El río", durationSeconds: 409, video: "test" },
      ],
    },
  ],
  ...over,
});
const show = (queue: ReviewQueue = queueOf()) => ({ user: userEvent.setup(), ...render(<ReviewScreen view={reviewView(queue)} />) });
const formOf = (call = 0) => Object.fromEntries(actions.approveAction.mock.calls[call]?.[1] as FormData);

describe("la pantalla, en reposo", () => {
  it("la cola con sus lecciones: «Ver» solo en la de Mux, y aprobar con el código reciente", async () => {
    const { container } = show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cursos por revisar");
    // Por maestro, y dentro, cada curso.
    expect(screen.getByRole("heading", { level: 3, name: "Ana Robles" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 4, name: "Naturaleza" })).toBeVisible();
    expect(screen.getByText("2 lecciones, 12:45 en total.")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Ver/ }).map((button) => button.textContent)).toEqual(["Ver «El bosque»"]);
    expect(screen.getByText("Sin video en Mux.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Aprobar y publicar «Naturaleza»" })).toBeVisible();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    // Con JavaScript no se dice que falta.
    expect(screen.queryByText(/hace falta JavaScript/)).not.toBeInTheDocument();
    // Nada del video al pintar: no se pidió ninguna dirección.
    expect(actions.lessonVideoAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("reproductor")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin el código reciente: se pide arriba, no se ofrece aprobar, y se puede reproducir", async () => {
    const { container } = show(queueOf({ freshCode: false }));
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("Tu código");
    expect(screen.queryByRole("button", { name: /Aprobar/ })).not.toBeInTheDocument();
    expect(screen.getByText("Escribe tu código, al inicio de esta página, para poder aprobar.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ver «El bosque»" })).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("vacía: lo dice", () => {
    show(queueOf({ courses: [] }));
    expect(screen.getByText("No hay cursos por revisar.")).toBeVisible();
  });

  it("sin JavaScript no hay «Ver»: el HTML del servidor no lo trae, y dice por qué", () => {
    const html = renderToString(<ReviewScreen view={reviewView(queueOf())} />);
    expect(html).not.toContain(">Ver<");
    expect(html).toContain("Para reproducir una lección hace falta JavaScript.");
    expect(html).toContain("Aprobar y publicar");
  });
});

describe("por maestro", () => {
  it("cada maestro con sus cursos, en encabezados que siguen su orden, y la cola pasa las reglas", async () => {
    const course = (id: string, title: string, teacherName: string, day: string) => ({
      ...queueOf().courses[0]!,
      courseId: id,
      title,
      teacherName,
      loadedAt: day,
    });
    const { container } = show({
      freshCode: true,
      courses: [
        course("c0000000-0000-4000-8000-000000000011", "Bosque", "Beto Luna", "2026-10-01T10:00:00Z"),
        course("c0000000-0000-4000-8000-000000000012", "Respirar", "Ana Robles", "2026-10-02T10:00:00Z"),
        course("c0000000-0000-4000-8000-000000000013", "Río", "Beto Luna", "2026-10-03T10:00:00Z"),
      ],
    });
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Beto Luna", "Ana Robles"]);
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(["Bosque", "Río", "Respirar"]);
    // Sin una región por maestro: el encabezado ya da la estructura.
    expect(screen.queryAllByRole("region", { name: "Beto Luna" })).toEqual([]);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("en reposo nada dice «En el reproductor.», y al cambiar de lección la marca se mueve", async () => {
    actions.lessonVideoAction.mockResolvedValue(GRANT);
    const two = queueOf();
    const [first] = two.courses;
    if (first) first.lessons = [first.lessons[0]!, { ...first.lessons[0]!, lessonId: TEST, title: "El río", video: "playable" }];
    const { user } = show(two);
    expect(screen.queryByText("En el reproductor.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    await screen.findByTestId("reproductor");
    await user.click(screen.getByRole("button", { name: "Ver «El río»" }));
    await waitFor(() => expect(screen.getByText("El río", { selector: "li span" }).closest("li")).toHaveTextContent("En el reproductor."));
    expect(screen.getByText("El bosque", { selector: "li span" }).closest("li")).not.toHaveTextContent("En el reproductor.");
    expect(screen.getAllByText("En el reproductor.")).toHaveLength(1);
  });
});

describe("reproducir", () => {
  it("«Ver» pide la dirección de esa lección, y el reproductor recibe los tres tokens; el foco va a él", async () => {
    actions.lessonVideoAction.mockResolvedValue(GRANT);
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    expect(actions.lessonVideoAction).toHaveBeenCalledWith(MUX);
    const shown = await screen.findByTestId("reproductor");
    expect(shown).toHaveAttribute("data-playback", "PlaybackDePrueba");
    expect(JSON.parse(shown.getAttribute("data-tokens") ?? "")).toEqual({ playback: "p.p.p", thumbnail: "t.t.t", storyboard: "s.s.s" });
    expect(shown).toHaveAttribute("data-start", "0");
    // El menú de velocidades, el que dio la función única de medios; y sin marca de agua (T-405).
    expect(player.last?.speeds).toEqual([0.75, 1, 2]);
    expect(player.last?.watermark).toBeUndefined();
    expect(screen.getByRole("heading", { level: 2, name: "Viendo: El bosque" })).toHaveFocus();
    // De qué curso y de qué maestro: con muchos en la cola, no se adivina.
    expect(screen.getByText("Del curso «Naturaleza», de Ana Robles.")).toBeVisible();
    expect(screen.getByText("Vista previa. No genera puntos.")).toBeVisible();
    // Al llegar el foco se anuncia también de qué curso es.
    expect(screen.getByRole("heading", { level: 2, name: "Viendo: El bosque" })).toHaveAccessibleDescription("Del curso «Naturaleza», de Ana Robles.");
    // Y en la cola, la lección que está en el reproductor lo dice.
    const row = screen.getByText("El bosque", { selector: "li span" }).closest("li");
    expect(row).toHaveTextContent("En el reproductor.");
    expect(screen.getByText("El río", { selector: "li span" }).closest("li")).not.toHaveTextContent("En el reproductor.");
    // La lección que se ve no se vuelve a pedir con el mismo botón.
    expect(screen.getByRole("button", { name: "Ver «El bosque»" })).toBeDisabled();
  });

  it("sin video en Mux, o sin respuesta: lo dice, y «Reintentar» lo pide otra vez", async () => {
    actions.lessonVideoAction.mockResolvedValueOnce({ kind: "no_video" });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    expect(await screen.findByText("Esta lección no tiene video en Mux.")).toBeVisible();

    actions.lessonVideoAction.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce(GRANT);
    const again = render(<ReviewScreen view={reviewView(queueOf())} />);
    await user.click(within(again.container).getByRole("button", { name: "Ver «El bosque»" }));
    expect(await within(again.container).findByText("No se pudo cargar el video.")).toBeVisible();
    await user.click(within(again.container).getByRole("button", { name: "Reintentar" }));
    expect(await within(again.container).findByTestId("reproductor")).toBeVisible();
  });

  it("si la dirección caduca, pide otra una sola vez y sigue desde el mismo segundo", async () => {
    actions.lessonVideoAction.mockResolvedValue(GRANT);
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    await user.click(await screen.findByRole("button", { name: "caduca" }));
    await waitFor(() => expect(screen.getByTestId("reproductor")).toHaveAttribute("data-start", "42"));
    expect(actions.lessonVideoAction).toHaveBeenCalledTimes(2);
    // Caduca otra vez sin haber vuelto a reproducirse: ya no se insiste.
    await user.click(screen.getByRole("button", { name: "caduca" }));
    expect(await screen.findByText("No se pudo cargar el video.")).toBeVisible();
    expect(actions.lessonVideoAction).toHaveBeenCalledTimes(2);
  });

  it("si volvió a reproducirse entre una caducidad y otra, la siguiente también se renueva", async () => {
    actions.lessonVideoAction.mockResolvedValue(GRANT);
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    await user.click(await screen.findByRole("button", { name: "caduca" }));
    await waitFor(() => expect(actions.lessonVideoAction).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "reproduce" }));
    await user.click(screen.getByRole("button", { name: "caduca" }));
    await waitFor(() => expect(actions.lessonVideoAction).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("No se pudo cargar el video.")).not.toBeInTheDocument();
  });

  it("«Reintentar» lleva el foco al reproductor otra vez", async () => {
    actions.lessonVideoAction.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValueOnce(GRANT);
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    const heading = screen.getByRole("heading", { level: 2, name: "Viendo: El bosque" });
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(heading).toHaveFocus());
    expect(await screen.findByTestId("reproductor")).toBeVisible();
  });

  it("dos avisos de caducidad seguidos piden una sola dirección nueva", async () => {
    let answer: (value: unknown) => void = () => undefined;
    actions.lessonVideoAction.mockResolvedValueOnce(GRANT).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    const expire = await screen.findByRole("button", { name: "caduca" });
    await user.click(expire);
    await user.click(expire);
    expect(actions.lessonVideoAction).toHaveBeenCalledTimes(2);
    await act(async () => answer(GRANT));
  });

  it("un error mientras se renueva manda sobre la dirección que llega tarde", async () => {
    let answer: (value: unknown) => void = () => undefined;
    actions.lessonVideoAction.mockResolvedValueOnce(GRANT).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    await user.click(await screen.findByRole("button", { name: "caduca" }));
    await user.click(screen.getByRole("button", { name: "falla" }));
    await act(async () => answer(GRANT));
    expect(screen.getByText("No se pudo cargar el video.")).toBeVisible();
    expect(screen.queryByTestId("reproductor")).not.toBeInTheDocument();
  });

  it("si se pide otra lección antes de que conteste la primera, la primera ya no pinta nada", async () => {
    let first: (value: unknown) => void = () => undefined;
    const second = { ...GRANT, playbackId: "PlaybackSegunda" };
    actions.lessonVideoAction.mockReturnValueOnce(new Promise((resolve) => (first = resolve))).mockResolvedValueOnce(second);
    const two = queueOf();
    const [course] = two.courses;
    if (course) course.lessons = [course.lessons[0]!, { ...course.lessons[0]!, lessonId: TEST, title: "El río", video: "playable" }];
    const { user } = show(two);
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    await user.click(screen.getByRole("button", { name: "Ver «El río»" }));
    expect(await screen.findByTestId("reproductor")).toHaveAttribute("data-playback", "PlaybackSegunda");
    await act(async () => first(GRANT));
    expect(screen.getByTestId("reproductor")).toHaveAttribute("data-playback", "PlaybackSegunda");
    expect(screen.getByRole("heading", { level: 2, name: "Viendo: El río" })).toBeVisible();
  });

  it("cualquier otro error del reproductor: lo dice, sin pedir otra dirección", async () => {
    actions.lessonVideoAction.mockResolvedValue(GRANT);
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Ver «El bosque»" }));
    await user.click(await screen.findByRole("button", { name: "falla" }));
    expect(await screen.findByText("No se pudo cargar el video.")).toBeVisible();
    expect(actions.lessonVideoAction).toHaveBeenCalledTimes(1);
  });
});

describe("aprobar", () => {
  it("en dos pasos: preguntar dice qué va a pasar y toma el foco; confirmar manda ese curso", async () => {
    const confirming: ReviewState = { kind: "confirming", course: COURSE, attempt: 1 };
    // Aprobado, la acción redirige: mientras tanto no contesta. Se suelta al final, porque una
    // acción que nunca termina deja enredadas las transiciones de las pruebas siguientes.
    let release: (value: unknown) => void = () => undefined;
    actions.approveAction.mockResolvedValueOnce(confirming).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Aprobar y publicar «Naturaleza»" }));
    expect(formOf(0)).toEqual({ do: `ask:${COURSE}` });
    const question = await screen.findByText("¿Aprobar y publicar este curso?");
    expect(question).toBeVisible();
    // El botón pulsado se fue con la pregunta: el foco lo toma ella.
    await waitFor(() => expect(question.parentElement).toHaveFocus());
    expect(screen.getByText("Es el primer curso de Ana Robles: su ficha también aparece en el catálogo.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sí, aprobar y publicar" }));
    expect(formOf(1)).toEqual({ do: `confirm:${COURSE}` });
    // Mientras va en camino, la pregunta sigue y el botón dice que trabaja.
    expect((await screen.findAllByText("Aprobando…")).length).toBeGreaterThan(0);
    expect(screen.getByText("¿Aprobar y publicar este curso?")).toBeVisible();
    await act(async () => release({ kind: "idle" }));
  });

  it("de vuelta con el aviso de aprobado: lo dice, y toma el foco si quedó sin dueño", async () => {
    const { container } = render(<ReviewScreen view={reviewView(queueOf({ courses: [] }))} published />);
    const notice = screen.getByText("Publicado. Ya aparece en el catálogo.");
    expect(notice).toBeVisible();
    await waitFor(() => expect(notice.closest("[tabindex]")).toHaveFocus());
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("lo que no se pudo, se dice en la cola", async () => {
    actions.approveAction.mockResolvedValueOnce({ kind: "failed", reason: "practice_inactive", attempt: 1 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Aprobar y publicar «Naturaleza»" }));
    expect(await screen.findByText(/La práctica de ese curso está desactivada/)).toBeVisible();
  });

  it("«tu código ya no es reciente» deja de decirse en cuanto la página lee uno reciente", async () => {
    actions.approveAction.mockResolvedValueOnce({ kind: "failed", reason: "needs_code", attempt: 1 });
    const { user, rerender } = show(queueOf({ freshCode: false }));
    // Sin código reciente no hay botón: se provoca con la página que sí lo tenía.
    rerender(<ReviewScreen view={reviewView(queueOf())} />);
    await user.click(screen.getByRole("button", { name: "Aprobar y publicar «Naturaleza»" }));
    await act(async () => undefined);
    expect(screen.queryByText(/Tu código ya no es reciente/)).not.toBeInTheDocument();
  });
});
