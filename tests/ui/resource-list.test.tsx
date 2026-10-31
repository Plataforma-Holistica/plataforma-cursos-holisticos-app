import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DownloadState } from "@/app/_catalog/resources/outcomes";
import { ResourceList, type ResourceItem } from "@/app/_catalog/resources/resource-list";
import { resources as text } from "@/messages/es/resources";

import { a11yViolations } from "../setup/a11y";

// La lista de recursos del alumno (RF-308; PA-02 y PA-22; T-404), con la acción simulada. Qué contesta cada respuesta lo
// prueba tests/actions/resource-download-actions.test.ts; aquí, lo que se ve, lo que se dice y que la dirección se abra una vez.

const mocks = vi.hoisted(() => ({ openFile: vi.fn(), reloadPage: vi.fn() }));
vi.mock("@/app/_catalog/resources/open-file", () => ({ openFile: mocks.openFile, reloadPage: mocks.reloadPage }));

type Action = (previous: DownloadState, form: FormData) => Promise<DownloadState>;

const FIRST: ResourceItem = { id: "e0000000-0000-4000-8000-000000000001", title: "Guía de la respiración", detail: "PDF, 2 MB" };
const SECOND: ResourceItem = { id: "e0000000-0000-4000-8000-000000000002", title: "Audio para la noche", detail: "Audio, 8 MB" };

function show(action: Action, canDownload = true, items: ResourceItem[] = [FIRST, SECOND]) {
  return render(<ResourceList items={items} canDownload={canDownload} action={action} permalink="/cursos/uno#recursos" />);
}

const answering = (state: DownloadState) => vi.fn<Action>(() => Promise.resolve(state));
const pressFirst = () => userEvent.click(screen.getByRole("button", { name: `Descargar ${FIRST.title}` }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lo que se ve", () => {
  it("cada recurso con su título, su tipo y su tamaño, y su botón con el nombre del recurso", async () => {
    const { container } = show(answering({ kind: "idle" }));
    expect(screen.getByText(FIRST.title)).toBeTruthy();
    expect(screen.getByText(FIRST.detail)).toBeTruthy();
    expect(screen.getByRole("button", { name: `Descargar ${SECOND.title}` })).toBeTruthy();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("quien no puede descargar ve la lista sin botones (PA-02, visitante)", () => {
    show(answering({ kind: "idle" }), false);
    expect(screen.getByText(FIRST.title)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });
});

describe("pedir un recurso", () => {
  it("manda qué botón y que hay JavaScript: nada de quién es la cuenta ni del archivo", async () => {
    const action = answering({ kind: "gone", attempt: 1 });
    show(action);
    await pressFirst();
    const sent = action.mock.calls[0]?.[1];
    expect(sent?.get("do")).toBe(`download:${FIRST.id}`);
    expect(sent?.get("canal")).toBe("js");
    expect([...(sent?.keys() ?? [])].sort()).toEqual(["canal", "do"]);
  });

  it("con la dirección, la abre una sola vez y lo dice, sin moverse de la página", async () => {
    show(answering({ kind: "granted", url: "https://storage/bajar?token=t", attempt: 1 }));
    await pressFirst();
    await screen.findByText(text.started);
    expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith("https://storage/bajar?token=t");
    // El botón sigue ahí y conserva el foco: se puede bajar otro.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: `Descargar ${FIRST.title}` }));
  });

  it("volver a pulsar pide otra dirección y la abre otra vez", async () => {
    let attempt = 0;
    const action = vi.fn<Action>(() => Promise.resolve({ kind: "granted", url: `https://storage/bajar?token=${++attempt}`, attempt }));
    show(action);
    await pressFirst();
    await pressFirst();
    await vi.waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(2));
    expect(mocks.openFile).toHaveBeenLastCalledWith("https://storage/bajar?token=2");
  });

  it("mientras va en camino no se manda otra vez, y el botón no suelta el foco", async () => {
    let finish: (state: DownloadState) => void = () => undefined;
    const action = vi.fn<Action>(() => new Promise((resolve) => (finish = resolve)));
    show(action);
    await pressFirst();
    const pressed = screen.getByRole("button", { name: new RegExp(text.preparing) });
    expect(document.activeElement).toBe(pressed);
    await userEvent.click(pressed);
    expect(action).toHaveBeenCalledTimes(1);
    // El otro recurso sigue libre: cada fila lleva su envío.
    expect(screen.getByRole("button", { name: `Descargar ${SECOND.title}` })).toBeTruthy();
    await act(async () => {
      finish({ kind: "gone", attempt: 1 });
      await Promise.resolve();
    });
    await screen.findAllByText(text.gone);
  });

  it.each<[string, DownloadState, string]>([
    ["ya no está", { kind: "gone", attempt: 1 }, text.gone],
    ["pidió de más", { kind: "throttled", attempt: 1 }, text.throttled],
    ["no se supo", { kind: "unavailable", attempt: 1 }, text.unavailable],
  ])("%s: se dice en la misma fila, sin abrir nada", async (_name, state, said) => {
    show(answering(state));
    await pressFirst();
    await screen.findAllByText(said);
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.reloadPage).not.toHaveBeenCalled();
  });

  it("si no se supo, el botón dice «Reintentar» (FL-14, E3)", async () => {
    show(answering({ kind: "unavailable", attempt: 1 }));
    await pressFirst();
    await screen.findByRole("button", { name: `Reintentar ${FIRST.title}` });
  });

  it("sin acceso: PA-33 junto al recurso, con el motivo que da el servidor", async () => {
    show(answering({ kind: "denied", title: "Tu acceso terminó", text: "Vuelve cuando quieras.", attempt: 1 }));
    await pressFirst();
    await screen.findByText("Tu acceso terminó");
    expect(screen.getByText("Vuelve cuando quieras.")).toBeTruthy();
    expect(mocks.openFile).not.toHaveBeenCalled();
  });

  it("si la sesión ya no pasa, vuelve a pedir la página, donde decide su guarda", async () => {
    show(answering({ kind: "reload", attempt: 1 }));
    await pressFirst();
    await vi.waitFor(() => expect(mocks.reloadPage).toHaveBeenCalledTimes(1));
    expect(mocks.openFile).not.toHaveBeenCalled();
  });
});
