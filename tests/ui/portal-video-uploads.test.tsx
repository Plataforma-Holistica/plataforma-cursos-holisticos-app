import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Las subidas de video del editor (T-403; PA-43) con TUS y las acciones simulados: las carreras que el extremo a extremo no alcanza a
// provocar (la firma a los 90 minutos, un evento viejo de una subida cancelada, un doble clic) y lo que la pantalla dice en cada una.
// Que TUS suba de verdad lo prueban tests/integration/92-videos-subir.test.ts y tests/e2e/equipo/videos.equipo.ts.

const actions = vi.hoisted(() => ({
  beginVideoAction: vi.fn(),
  renewVideoAction: vi.fn(),
  confirmVideoAction: vi.fn(),
  removeVideoAction: vi.fn(),
  checkVideosAction: vi.fn(),
}));
vi.mock("@/app/portal/_editor/video-actions", () => actions);

const tus = vi.hoisted(() => {
  interface Options {
    onBeforeRequest: (request: { setHeader: (name: string, value: string) => void }) => Promise<void>;
    onProgress: (sent: number, total: number) => void;
    onSuccess: () => void;
    onError: (error: Error) => void;
  }
  class FakeUpload {
    static made: FakeUpload[] = [];
    static failNext = false;
    started = 0;
    aborted: boolean[] = [];
    options: Options;
    constructor(_file: unknown, options: Options) {
      if (FakeUpload.failNext) {
        FakeUpload.failNext = false;
        throw new Error("no cargó");
      }
      this.options = options;
      FakeUpload.made.push(this);
    }
    start() {
      this.started += 1;
    }
    abort(terminate = false) {
      this.aborted.push(terminate);
      return Promise.resolve();
    }
    findPreviousUploads() {
      return Promise.resolve([]);
    }
    resumeFromPreviousUpload() {
      return undefined;
    }
  }
  return { FakeUpload };
});
vi.mock("tus-js-client", () => ({ Upload: tus.FakeUpload }));

import { SavedStatus, UnsavedProvider } from "@/app/portal/_editor/unsaved";
import { VideoBlock } from "@/app/portal/_editor/video-block";
import { VideoUploadsProvider } from "@/app/portal/_editor/video-uploads";

const { FakeUpload } = tus;
const COURSE = "c0000000-0000-4000-8000-000000000001";
const L1 = "e0000000-0000-4000-8000-000000000001";
const L2 = "e0000000-0000-4000-8000-000000000002";
const VIDEO = "f0000000-0000-4000-8000-000000000001";
const file = new File(["contenido"], "clase.mp4", { type: "video/mp4" });
const GO = { kind: "go", target: { video: VIDEO, path: "p", mime: "video/mp4", bucket: "b", endpoint: "http://x" }, token: "firma-1", resumed: false };
const MINUTE = 60_000;

function Screen({ lessons = [L1, L2], row = null, every = null }: { lessons?: string[]; row?: Parameters<typeof VideoBlock>[0]["row"]; every?: number | null }) {
  return (
    <UnsavedProvider>
      <SavedStatus saved="Guardado hace poco" />
      <Link href="/portal/cursos">Mis cursos</Link>
      <VideoUploadsProvider course={COURSE} lessons={lessons} checkEverySeconds={every}>
        <VideoBlock lesson={L1} row={row} editable maxBytes={1000} maxText="1 KB" />
      </VideoUploadsProvider>
    </UnsavedProvider>
  );
}

const lastUpload = () => {
  const upload = FakeUpload.made.at(-1);
  if (upload === undefined) throw new Error("Sin subida.");
  return upload;
};

async function pick(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText("Elige el video"), file);
  await waitFor(() => expect(FakeUpload.made.length).toBeGreaterThan(0));
  await waitFor(() => expect(lastUpload().started).toBe(1));
}

/** La firma que manda la siguiente petición. */
async function nextToken(upload: InstanceType<typeof FakeUpload>): Promise<string> {
  let token = "";
  await upload.options.onBeforeRequest({
    setHeader: (_name, value) => {
      token = value;
    },
  });
  return token;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeUpload.made = [];
  FakeUpload.failNext = false;
  actions.checkVideosAction.mockResolvedValue({ blocked: {} });
  actions.beginVideoAction.mockResolvedValue(GO);
  actions.confirmVideoAction.mockResolvedValue({ kind: "uploaded" });
  actions.removeVideoAction.mockResolvedValue({ kind: "removed" });
  actions.renewVideoAction.mockResolvedValue({ kind: "renewed", token: "firma-2" });
});
afterEach(() => {
  vi.spyOn(Date, "now").mockRestore();
  vi.unstubAllGlobals();
  cleanup();
});

describe("el camino normal", () => {
  it("sube, confirma y lo dice; la barra dice que sube, no que algo quedó sin guardar", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    expect(screen.getByText("Guardado hace poco")).toBeInTheDocument();
    await pick(user);
    expect(actions.beginVideoAction).toHaveBeenCalledWith({ course: COURSE, lesson: L1, fileName: "clase.mp4", size: file.size });
    expect(screen.getByText("Subiendo un video")).toBeInTheDocument();
    expect(screen.queryByText("Cambios sin guardar")).not.toBeInTheDocument();
    act(() => lastUpload().options.onProgress(4, 9));
    expect(screen.getByRole("progressbar", { name: "Avance de la subida del video" })).toHaveValue(4);
    act(() => lastUpload().options.onSuccess());
    expect(await screen.findByText("Listo: recibimos tu video.")).toBeInTheDocument();
    expect(actions.confirmVideoAction).toHaveBeenCalledWith({ course: COURSE, lesson: L1, video: VIDEO });
    expect(await screen.findByText("Guardado hace poco")).toBeInTheDocument();
  });

  it("salir con solo un video subiendo dice lo que pasa de verdad: se detiene y se retoma", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    await user.click(screen.getByRole("link", { name: "Mis cursos" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("La subida se detiene. Al volver, elige el mismo archivo y sigue donde iba.");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("Lo que escribiste");
    expect(screen.getByRole("button", { name: "Salir y detener la subida" })).toBeInTheDocument();
  });

  it("al terminar, el foco que tenía «Pausar» no se pierde", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    screen.getByRole("button", { name: "Pausar" }).focus();
    act(() => lastUpload().options.onSuccess());
    await screen.findByText("Listo: recibimos tu video.");
    expect(document.body).not.toHaveFocus();
    expect(screen.getByRole("region", { name: "Video de la lección" })).toHaveFocus();
  });

  it("otro archivo a medias dice cuál elegir, y un archivo que no se admite no pregunta", async () => {
    const user = userEvent.setup({ applyAccept: false });
    actions.beginVideoAction.mockResolvedValue({ kind: "pending", fileName: "otra.mp4" });
    render(<Screen />);
    await user.upload(screen.getByLabelText("Elige el video"), new File(["x"], "clase.mkv"));
    expect(screen.getByText(/Ese tipo de archivo no se admite/)).toBeInTheDocument();
    expect(actions.beginVideoAction).not.toHaveBeenCalled();
    await user.upload(screen.getByLabelText("Elige el video"), file);
    expect(await screen.findByText(/Elige «otra\.mp4» para seguir/)).toBeInTheDocument();
  });

  it("volver a una subida a medias confirma primero; si ya estaba completa no sube nada", async () => {
    const user = userEvent.setup();
    actions.beginVideoAction.mockResolvedValue({ ...GO, resumed: true });
    render(<Screen />);
    await user.upload(screen.getByLabelText("Elige el video"), file);
    expect(await screen.findByText("Listo: recibimos tu video.")).toBeInTheDocument();
    expect(FakeUpload.made).toHaveLength(0);
  });

  it("y si no estaba completa, sigue subiendo", async () => {
    const user = userEvent.setup();
    actions.beginVideoAction.mockResolvedValue({ ...GO, resumed: true });
    actions.confirmVideoAction.mockResolvedValue({ kind: "problem", problem: "notUploaded" });
    render(<Screen />);
    await pick(user);
    expect(screen.queryByText(/todavía no aparece/)).not.toBeInTheDocument();
  });
});

describe("la firma", () => {
  it("se pide otra a los 90 minutos, y no antes", async () => {
    const user = userEvent.setup();
    const now = vi.spyOn(Date, "now");
    const start = 1_000_000_000;
    now.mockReturnValue(start);
    render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    now.mockReturnValue(start + 89 * MINUTE);
    expect(await nextToken(upload)).toBe("firma-1");
    expect(actions.renewVideoAction).not.toHaveBeenCalled();
    now.mockReturnValue(start + 91 * MINUTE);
    expect(await nextToken(upload)).toBe("firma-2");
    expect(actions.renewVideoAction).toHaveBeenCalledWith({ course: COURSE, lesson: L1, video: VIDEO });
    // La nueva dura otros 90 minutos.
    now.mockReturnValue(start + 170 * MINUTE);
    expect(await nextToken(upload)).toBe("firma-2");
    expect(actions.renewVideoAction).toHaveBeenCalledTimes(1);
  });

  it("si el video ya no existe, detiene la subida y lo dice", async () => {
    const user = userEvent.setup();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000_000);
    actions.renewVideoAction.mockResolvedValue({ kind: "problem", problem: "gone" });
    render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    now.mockReturnValue(1_000_000_000 + 91 * MINUTE);
    await act(async () => {
      await expect(nextToken(upload)).rejects.toThrow();
    });
    expect(upload.aborted).toHaveLength(1);
    expect(await screen.findByText(/Esa lección o ese video ya no existe/)).toBeInTheDocument();
    expect(await screen.findByText("Guardado hace poco")).toBeInTheDocument();
  });

  it("si no se pudo renovar, no lo da por perdido: falla la petición y queda para reanudar", async () => {
    const user = userEvent.setup();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000_000);
    actions.renewVideoAction.mockResolvedValue({ kind: "problem", problem: "unavailable" });
    render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    now.mockReturnValue(1_000_000_000 + 91 * MINUTE);
    await expect(nextToken(upload)).rejects.toThrow();
    expect(upload.aborted).toHaveLength(0);
    act(() => upload.options.onError(new Error("sin firma")));
    expect(await screen.findByRole("button", { name: "Reanudar" })).toBeInTheDocument();
  });
});

describe("un corte", () => {
  it("se anuncia, y reanudar pide otra firma y sigue con la misma subida", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    act(() => upload.options.onProgress(4, 9));
    act(() => upload.options.onError(new Error("red")));
    expect(screen.getByText(/La subida se interrumpió/).closest("[role=status]")).not.toBeNull();
    expect(screen.getByRole("progressbar", { name: "Avance de la subida del video" })).toHaveValue(4);
    await user.click(screen.getByRole("button", { name: "Reanudar" }));
    expect(upload.started).toBe(2);
    expect(FakeUpload.made).toHaveLength(1);
    expect(await nextToken(upload)).toBe("firma-2");
  });

  it("un doble clic en reanudar arranca una sola vez", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    act(() => upload.options.onError(new Error("red")));
    const button = screen.getByRole("button", { name: "Reanudar" });
    act(() => {
      button.click();
      button.click();
    });
    expect(upload.started).toBe(2);
  });

  it("si ni siquiera arrancó (no cargó la biblioteca), reanudar la vuelve a armar", async () => {
    const user = userEvent.setup();
    FakeUpload.failNext = true;
    render(<Screen />);
    await user.upload(screen.getByLabelText("Elige el video"), file);
    await user.click(await screen.findByRole("button", { name: "Reanudar" }));
    await waitFor(() => expect(lastUpload().started).toBe(1));
  });

  it("el objeto que ya estaba no es un corte: toca confirmar", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    const error = Object.assign(new Error("409"), { originalResponse: { getStatus: () => 409, getBody: () => "The resource already exists" } });
    act(() => lastUpload().options.onError(error));
    expect(await screen.findByText("Listo: recibimos tu video.")).toBeInTheDocument();
  });
});

describe("pausar", () => {
  it("el foco se queda en el mismo botón, y un avance tardío no la saca de la pausa", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    act(() => upload.options.onProgress(4, 9));
    await user.click(screen.getByRole("button", { name: "Pausar" }));
    expect(upload.aborted).toEqual([false]);
    expect(screen.getByRole("button", { name: "Reanudar" })).toHaveFocus();
    act(() => upload.options.onProgress(5, 9));
    expect(screen.getByRole("button", { name: "Reanudar" })).toBeInTheDocument();
    expect(screen.getByText(/En pausa/)).toBeInTheDocument();
  });
});

describe("confirmar", () => {
  it("lo que no se supo se reintenta sin subir de nuevo", async () => {
    const user = userEvent.setup();
    actions.confirmVideoAction.mockResolvedValueOnce({ kind: "problem", problem: "unavailable" });
    render(<Screen />);
    await pick(user);
    act(() => lastUpload().options.onSuccess());
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Listo: recibimos tu video.")).toBeInTheDocument();
    expect(FakeUpload.made).toHaveLength(1);
  });

  it("un rechazo lo dice, y deja elegir otro", async () => {
    const user = userEvent.setup();
    actions.confirmVideoAction.mockResolvedValue({ kind: "problem", problem: "rejectedTooLong" });
    render(<Screen />);
    await pick(user);
    act(() => lastUpload().options.onSuccess());
    expect(await screen.findByText(/pasa de la duración máxima/)).toBeInTheDocument();
    expect(screen.getByLabelText("Elige el video")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });
});

describe("cancelar", () => {
  it("pregunta, y seguir devuelve el foco a «Cancelar subida»", async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await pick(user);
    await user.click(screen.getByRole("button", { name: "Cancelar subida" }));
    expect(screen.getByText(/¿Cancelar la subida de «clase\.mp4»\?/).parentElement).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Seguir con la subida" }));
    expect(screen.getByRole("button", { name: "Cancelar subida" })).toHaveFocus();
    expect(lastUpload().aborted).toEqual([]);
  });

  it("mientras se cancela no ofrece elegir: reanudaría una fila que se está borrando", async () => {
    const user = userEvent.setup();
    let finish: (value: unknown) => void = () => undefined;
    actions.removeVideoAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<Screen row={{ id: VIDEO, state: "uploading", fileName: "clase.mp4", size: "1 KB" }} />);
    await user.click(screen.getByRole("button", { name: "Cancelar subida" }));
    await user.click(screen.getAllByRole("button", { name: "Cancelar subida" }).at(-1) as HTMLElement);
    expect(screen.queryByLabelText(/Elige/)).not.toBeInTheDocument();
    expect(screen.getByText("Quitando…")).toBeInTheDocument();
    await act(async () => {
      finish({ kind: "removed" });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText("Quitando…")).not.toBeInTheDocument());
  });

  it("los eventos de la subida cancelada no tocan la siguiente de esa lección", async () => {
    const user = userEvent.setup();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000_000);
    render(<Screen />);
    await pick(user);
    const old = lastUpload();
    await user.click(screen.getByRole("button", { name: "Cancelar subida" }));
    await user.click(screen.getAllByRole("button", { name: "Cancelar subida" }).at(-1) as HTMLElement);
    expect(old.aborted).toEqual([true]);
    await waitFor(() => expect(screen.getByLabelText("Elige el video")).toBeInTheDocument());

    actions.beginVideoAction.mockResolvedValue({ ...GO, target: { ...GO.target, video: "f0000000-0000-4000-8000-000000000002" } });
    await user.upload(screen.getByLabelText("Elige el video"), file);
    await waitFor(() => expect(FakeUpload.made).toHaveLength(2));
    const fresh = lastUpload();
    await waitFor(() => expect(fresh.started).toBe(1));
    act(() => fresh.options.onProgress(3, 9));

    // La vieja termina de cancelarse tarde: nada de esto le cambia nada a la nueva.
    now.mockReturnValue(1_000_000_000 + 91 * MINUTE);
    expect(await nextToken(old)).toBe("firma-1");
    expect(actions.renewVideoAction).not.toHaveBeenCalled();
    act(() => {
      old.options.onError(new Error("tarde"));
      old.options.onProgress(1, 9);
    });
    expect(screen.queryByText(/La subida se interrumpió/)).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Avance de la subida del video" })).toHaveValue(3);
    expect(screen.getByRole("button", { name: "Pausar" })).toBeInTheDocument();
  });

  it("una lección borrada se lleva su subida, y salir del editor las detiene", async () => {
    const user = userEvent.setup();
    const { rerender, unmount } = render(<Screen />);
    await pick(user);
    const upload = lastUpload();
    rerender(<Screen lessons={[L2]} />);
    expect(upload.aborted).toHaveLength(1);
    unmount();
    expect(upload.aborted).toHaveLength(1);

    FakeUpload.made = [];
    const again = render(<Screen />);
    await pick(user);
    const next = lastUpload();
    again.unmount();
    expect(next.aborted).toHaveLength(1);
  });
});

describe("dos pestañas", () => {
  it("quien no alcanza el candado no sube y lo dice; quien lo tiene lo suelta al terminar", async () => {
    const user = userEvent.setup();
    let free = false;
    let held: Promise<unknown> | null = null;
    vi.stubGlobal("navigator", {
      ...window.navigator,
      locks: {
        request: (_name: string, _options: unknown, work: (lock: unknown) => Promise<unknown>) => {
          held = work(free ? {} : null);
          return held;
        },
      },
    });
    const first = render(<Screen />);
    await user.upload(screen.getByLabelText("Elige el video"), file);
    expect(await screen.findByText(/ya se está subiendo en otra pestaña/)).toBeInTheDocument();
    expect(FakeUpload.made).toHaveLength(0);
    first.unmount();

    free = true;
    render(<Screen />);
    await pick(user);
    let released = false;
    void (held as unknown as Promise<unknown>).then(() => (released = true));
    await Promise.resolve();
    expect(released).toBe(false);
    act(() => lastUpload().options.onSuccess());
    await screen.findByText("Listo: recibimos tu video.");
    await waitFor(() => expect(released).toBe(true));
  });
});

describe("preguntar por lo que ya llegó", () => {
  const RECEIVED = { id: VIDEO, state: "uploaded" as const, fileName: "clase.mp4", size: "1 KB" };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pregunta al cargar, una vez, aunque no haya nada en camino", async () => {
    render(<Screen />);
    await waitFor(() => expect(actions.checkVideosAction).toHaveBeenCalledWith({ course: COURSE }));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(1);
  });

  it("pregunta en cuanto se confirma: el video no espera al siguiente turno", async () => {
    const user = userEvent.setup();
    actions.confirmVideoAction.mockResolvedValue({ kind: "uploaded" });
    render(<Screen />);
    await waitFor(() => expect(actions.checkVideosAction).toHaveBeenCalledTimes(1));
    await pick(user);
    act(() => lastUpload().options.onSuccess());
    await waitFor(() => expect(actions.checkVideosAction).toHaveBeenCalledTimes(2));
  });

  it("con algo en camino pregunta cada tanto; sin nada, no", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Screen every={null} />);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(1);
    rerender(<Screen every={15} />);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(3);
    rerender(<Screen every={null} />);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(3);
  });

  it("con la pantalla oculta no pregunta", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<Screen every={15} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it("una pregunta a la vez: si la anterior no ha contestado, no se apila otra", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => undefined;
    actions.checkVideosAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    render(<Screen every={15} />);
    await act(() => vi.advanceTimersByTimeAsync(45_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(1);
    await act(async () => answer({ blocked: {} }));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(2);
  });

  it("una falla al preguntar no dice nada: es algo que nadie pidió, y se vuelve a preguntar", async () => {
    vi.useFakeTimers();
    actions.checkVideosAction.mockRejectedValueOnce(new Error("sin red"));
    render(<Screen every={15} />);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(actions.checkVideosAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["throttled", /en poco tiempo/],
    ["over_minutes", /tope de minutos/],
    ["closed", /en pausa/],
  ])("dice por qué un video recibido no se procesa (%s), sin decir que se perdió", async (kind, text) => {
    actions.checkVideosAction.mockResolvedValue({ blocked: { [VIDEO]: kind } });
    render(<Screen row={RECEIVED} />);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText(/Tu video está guardado/)).toBeTruthy();
  });

  it("lo que le pasa a otro video, o a uno que ya no está recibido, no se dice aquí", async () => {
    actions.checkVideosAction.mockResolvedValue({ blocked: { otro: "closed" } });
    const { unmount } = render(<Screen row={RECEIVED} />);
    await waitFor(() => expect(actions.checkVideosAction).toHaveBeenCalled());
    expect(screen.queryByText(/Tu video está guardado/)).toBeNull();
    unmount();
    actions.checkVideosAction.mockResolvedValue({ blocked: { [VIDEO]: "closed" } });
    render(<Screen row={{ ...RECEIVED, state: "processing" }} />);
    await waitFor(() => expect(actions.checkVideosAction).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Tu video está guardado/)).toBeNull();
  });
});
