import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readResourceForm, checkFile, progressStep, resourceButton, titleFromFile } from "@/app/portal/_editor/resource-outcomes";
import { ResourcesBlock } from "@/app/portal/_editor/resources";
import type { ResourceRow } from "@/app/portal/_editor/rows";
import { UnsavedProvider } from "@/app/portal/_editor/unsaved";

import { a11yViolations } from "../setup/a11y";

const actions = vi.hoisted(() => ({
  resourceAction: vi.fn(),
  beginResourceAction: vi.fn(),
  confirmResourceAction: vi.fn(),
  cancelResourceAction: vi.fn(),
}));
vi.mock("@/app/portal/_editor/resource-actions", () => actions);

const COURSE = "c0000000-0000-4000-8000-000000000001";
const LESSON = "e0000000-0000-4000-8000-000000000001";
const R1 = "f0000000-0000-4000-8000-000000000001";
const R2 = "f0000000-0000-4000-8000-000000000002";
const LIMITS = { maxBytes: 1000, maxText: "1 KB", perPlace: 3 };

const row = (id: string, title: string, up: string | null, down: string | null): ResourceRow => ({ id, title, detail: "PDF, 2 MB", revision: 4, up, down });
const ITEMS = [row(R1, "Guía", null, resourceButton.down(R1, 1)), row(R2, "Audio", resourceButton.up(R2, 2), null)];

function show(items: ResourceRow[] = ITEMS, props: Partial<Parameters<typeof ResourcesBlock>[0]> = {}) {
  return render(
    <UnsavedProvider>
      <ResourcesBlock course={COURSE} lesson={LESSON} items={items} editable self={`/portal/cursos/${COURSE}?leccion=${LESSON}`} limits={LIMITS} {...props} />
    </UnsavedProvider>,
  );
}

const pdf = (name = "guia.pdf", size = 100) => new File([new Uint8Array(size)], name, { type: "application/pdf" });

/** Un `XMLHttpRequest` de mentira: dice qué recibió y contesta cuando se le pide. */
class FakeRequest {
  static last: FakeRequest | null = null;
  url = "";
  method = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeRequest.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeRequest.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  actions.resourceAction.mockResolvedValue({ kind: "idle" });
  actions.beginResourceAction.mockResolvedValue({ kind: "go", resource: R1, url: "https://storage/subir", mime: "application/pdf" });
  actions.confirmResourceAction.mockResolvedValue({ kind: "ready" });
  actions.cancelResourceAction.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

async function attach(user: ReturnType<typeof userEvent.setup>, file = pdf()) {
  await user.upload(screen.getByLabelText("Archivo"), file);
  await user.click(screen.getByRole("button", { name: "Adjuntar recurso" }));
}

describe("la lista", () => {
  it("cada recurso con lo que es; el primero no sube y el último no baja; sin fallas de accesibilidad", async () => {
    const { container } = show();
    expect(screen.getByRole("heading", { level: 3, name: "Recursos de esta lección" })).toBeTruthy();
    expect(screen.getAllByText("PDF, 2 MB")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Subir Guía" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bajar Guía" }).getAttribute("value")).toBe(`resource-move:${R1}:1:2`);
    expect(screen.getByRole("button", { name: "Subir Audio" }).getAttribute("value")).toBe(`resource-move:${R2}:2:1`);
    expect(screen.queryByRole("button", { name: "Bajar Audio" })).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("del curso, dice que son del curso; sin recursos, lo dice", () => {
    show([], { lesson: null });
    expect(screen.getByRole("heading", { level: 3, name: "Recursos del curso" })).toBeTruthy();
    expect(screen.getByText("Todavía no hay recursos aquí.")).toBeTruthy();
  });

  it("quitar pregunta antes, y la confirmación lleva lo que se vio", async () => {
    actions.resourceAction.mockResolvedValueOnce({ kind: "confirming", resource: R1, attempt: 1 });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Quitar Guía" }));
    const asked = await screen.findByText(/¿Quitar «Guía»\?/);
    // El botón pulsado se fue con la pregunta: ella toma el foco.
    await waitFor(() => expect(asked.closest("[tabindex='-1']")).toHaveFocus());
    const confirm = screen.getAllByRole("button", { name: "Quitar" });
    expect(confirm).toHaveLength(1);
    expect(confirm[0]?.getAttribute("value")).toBe(`resource-remove:${R1}:4`);
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    // Mientras se pregunta, no se ofrece mover: Enter enviaría el primer botón del formulario.
    expect(screen.queryByRole("button", { name: "Subir Audio" })).toBeNull();
  });

  it("cancelar devuelve el foco al bloque", async () => {
    actions.resourceAction.mockResolvedValueOnce({ kind: "confirming", resource: R1, attempt: 1 }).mockResolvedValueOnce({ kind: "kept", attempt: 2 });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Quitar Guía" }));
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    await screen.findByRole("button", { name: "Quitar Guía" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Recursos de esta lección" })).toHaveFocus());
  });

  it("si lo que se preguntaba ya no está, vuelven los botones", async () => {
    actions.resourceAction.mockResolvedValueOnce({ kind: "confirming", resource: "f0000000-0000-4000-8000-0000000000ff", attempt: 1 });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Quitar Guía" }));
    await waitFor(() => expect(actions.resourceAction).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Bajar Guía" })).toBeTruthy();
  });

  it("lo que falló se dice en el bloque", async () => {
    actions.resourceAction.mockResolvedValueOnce({ kind: "failed", reason: "changed", attempt: 1 });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Bajar Guía" }));
    expect(await screen.findByText(/Esto cambió mientras lo veías/)).toBeTruthy();
  });

  it("en solo lectura se ve la lista, sin botones ni adjuntar", () => {
    show(ITEMS, { editable: false });
    expect(screen.getByText("Guía")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("Archivo")).toBeNull();
  });
});

describe("adjuntar", () => {
  it("el título por omisión es el nombre del archivo, y se puede cambiar", async () => {
    const user = userEvent.setup();
    show();
    await user.upload(screen.getByLabelText("Archivo"), pdf("Guía de respiración.pdf"));
    expect((screen.getByRole("textbox", { name: "Título del recurso" }) as HTMLInputElement).value).toBe("Guía de respiración");
  });

  it("empieza, sube a la dirección con el tipo del servidor y confirma, en ese orden", async () => {
    const user = userEvent.setup();
    show();
    const file = pdf();
    await attach(user, file);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    expect(actions.beginResourceAction).toHaveBeenCalledExactlyOnceWith({ course: COURSE, lesson: LESSON, title: "guia", fileName: "guia.pdf", size: 100 });
    const request = FakeRequest.last as FakeRequest;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://storage/subir");
    expect(request.headers["content-type"]).toBe("application/pdf");
    expect(request.body).toBe(file);
    expect(actions.confirmResourceAction).not.toHaveBeenCalled();
    request.respond(200);
    await waitFor(() => expect(actions.confirmResourceAction).toHaveBeenCalledExactlyOnceWith({ course: COURSE, lesson: LESSON, resource: R1 }));
    expect(await screen.findByText("Listo: el recurso quedó adjunto.")).toBeTruthy();
  });

  it("el avance se anuncia en pasos, no con cada evento, y mientras sube salir pregunta", async () => {
    const user = userEvent.setup();
    show();
    await attach(user);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    const leaving = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leaving()).toBe(true);
    const request = FakeRequest.last as FakeRequest;
    request.upload.onprogress?.({ loaded: 30, total: 100 });
    expect((await screen.findAllByText("Subiendo: 25 %")).length).toBeGreaterThan(0);
    request.upload.onprogress?.({ loaded: 49, total: 100 });
    expect(screen.getAllByText("Subiendo: 25 %").length).toBeGreaterThan(0);
    request.respond(200);
    await screen.findByText("Listo: el recurso quedó adjunto.");
    expect(leaving()).toBe(false);
  });

  it.each([
    ["un tipo que no se admite", pdf("programa.exe"), /Ese tipo de archivo no se admite/],
    ["uno que pasa del tope", pdf("guia.pdf", 2000), /pasa del tamaño máximo/],
    ["uno vacío", pdf("guia.pdf", 0), /está vacío/],
  ])("%s se dice antes de subir", async (_name, file, words) => {
    const user = userEvent.setup({ applyAccept: false });
    show();
    await attach(user, file);
    expect(await screen.findByText(words)).toBeTruthy();
    expect(actions.beginResourceAction).not.toHaveBeenCalled();
  });

  it("sin título no empieza", async () => {
    const user = userEvent.setup();
    show();
    await user.upload(screen.getByLabelText("Archivo"), pdf());
    await user.clear(screen.getByRole("textbox", { name: "Título del recurso" }));
    await user.click(screen.getByRole("button", { name: "Adjuntar recurso" }));
    const field = screen.getByRole("textbox", { name: "Título del recurso" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(actions.beginResourceAction).not.toHaveBeenCalled();
  });

  it("un título que no pasa la regla se dice en su campo, sin llamar a nadie", async () => {
    const user = userEvent.setup();
    show();
    await user.upload(screen.getByLabelText("Archivo"), pdf());
    const field = screen.getByRole("textbox", { name: "Título del recurso" });
    await user.clear(field);
    await user.type(field, "a".repeat(121));
    await user.click(screen.getByRole("button", { name: "Adjuntar recurso" }));
    await waitFor(() => expect(field).toHaveFocus());
    expect(actions.beginResourceAction).not.toHaveBeenCalled();
  });

  it("adjuntar sin archivo lo dice, en una región viva", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Adjuntar recurso" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Elige un archivo para adjuntar.");
  });

  it("elegir archivo no pisa el título que ya se escribió", async () => {
    const user = userEvent.setup();
    show();
    await user.type(screen.getByRole("textbox", { name: "Título del recurso" }), "Mi título");
    await user.upload(screen.getByLabelText("Archivo"), pdf("otro-nombre.pdf"));
    expect((screen.getByRole("textbox", { name: "Título del recurso" }) as HTMLInputElement).value).toBe("Mi título");
  });

  it("si confirmar no se pudo saber, «Reintentar» solo confirma: no sube otra vez", async () => {
    actions.confirmResourceAction.mockResolvedValueOnce({ kind: "problem", problem: "unavailable" });
    const user = userEvent.setup();
    show();
    await attach(user);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    const request = FakeRequest.last as FakeRequest;
    request.respond(200);
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    await screen.findByText("Listo: el recurso quedó adjunto.");
    expect(actions.beginResourceAction).toHaveBeenCalledOnce();
    expect(FakeRequest.last).toBe(request);
    expect(actions.confirmResourceAction).toHaveBeenCalledTimes(2);
    expect(actions.cancelResourceAction).not.toHaveBeenCalled();
  });

  it("elegir otro archivo en lugar de reintentar cancela la fila que quedó", async () => {
    actions.confirmResourceAction.mockResolvedValueOnce({ kind: "problem", problem: "unavailable" });
    const user = userEvent.setup();
    show();
    await attach(user);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    (FakeRequest.last as FakeRequest).respond(200);
    await screen.findByRole("button", { name: "Reintentar" });
    await user.upload(screen.getByLabelText("Archivo"), pdf("otro.pdf"));
    expect(actions.cancelResourceAction).toHaveBeenCalledExactlyOnceWith({ course: COURSE, resource: R1 });
    expect(screen.getByRole("button", { name: "Adjuntar recurso" })).toBeTruthy();
  });

  it("mientras sube, el botón no pierde el foco y un segundo envío no empieza otra subida", async () => {
    const user = userEvent.setup();
    show();
    await attach(user);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    const button = screen.getByRole("button", { name: "Un momento…" });
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(actions.beginResourceAction).toHaveBeenCalledOnce();
  });

  it("lo que contesta la base al empezar se dice, y no se sube nada", async () => {
    actions.beginResourceAction.mockResolvedValue({ kind: "problem", problem: "throttled" });
    const user = userEvent.setup();
    show();
    await attach(user);
    expect(await screen.findByText(/Subiste muchos archivos/)).toBeTruthy();
    expect(FakeRequest.last).toBeNull();
  });

  it("si la subida no llega a la cubeta, se cancela la fila y se dice", async () => {
    const user = userEvent.setup();
    show();
    await attach(user);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    (FakeRequest.last as FakeRequest).respond(400);
    await waitFor(() => expect(actions.cancelResourceAction).toHaveBeenCalledExactlyOnceWith({ course: COURSE, resource: R1 }));
    expect(await screen.findByText(/No pudimos subir el archivo/)).toBeTruthy();
    expect(actions.confirmResourceAction).not.toHaveBeenCalled();
  });

  it("un rechazo por el contenido se dice con su razón", async () => {
    actions.confirmResourceAction.mockResolvedValue({ kind: "problem", problem: "rejectedContent" });
    const user = userEvent.setup();
    show();
    await attach(user);
    await waitFor(() => expect(FakeRequest.last).not.toBeNull());
    (FakeRequest.last as FakeRequest).respond(200);
    expect((await screen.findByRole("alert")).textContent).toMatch(/no es lo que dice su nombre.*conviértelo a MP3/);
  });

  it("con el lugar lleno no se ofrece", () => {
    show([...ITEMS, row("f0000000-0000-4000-8000-000000000003", "Otra", null, null)]);
    expect(screen.getByText(/ya no caben más recursos/)).toBeTruthy();
    // Se queda montado y oculto: dice «Listo» del que acaba de llenar el lugar.
    expect(screen.getByRole("form", { name: "Adjuntar recurso" }).closest(".hidden")).not.toBeNull();
  });

  it("el formulario de adjuntar nombra lo que hace", () => {
    show();
    const form = screen.getByRole("form", { name: "Adjuntar recurso" });
    expect(within(form).getByRole("button", { name: "Adjuntar recurso" })).toBeTruthy();
  });
});

describe("lo puro", () => {
  const form = (fields: Record<string, string | string[]>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) for (const each of [value].flat()) data.append(name, each);
    return data;
  };

  it("lee lo que se pidió, con lo que se vio", () => {
    expect(readResourceForm(form({ course: COURSE, lesson: LESSON, do: `resource-move:${R1}:2:1` }))).toEqual({ step: "move", course: COURSE, lesson: LESSON, resource: R1, seen: 2, to: 1 });
    expect(readResourceForm(form({ course: COURSE, do: `resource-remove:${R1}:4` }))).toEqual({ step: "remove", course: COURSE, lesson: null, resource: R1, seen: 4 });
    expect(readResourceForm(form({ course: COURSE, do: `resource-ask:${R1}` }))).toEqual({ step: "ask", course: COURSE, lesson: null, resource: R1 });
    expect(readResourceForm(form({ course: COURSE, do: "cancel" }))).toEqual({ step: "cancel", course: COURSE, lesson: null });
  });

  it.each([
    ["sin curso", { do: `resource-ask:${R1}` }],
    ["una lección sin forma", { course: COURSE, lesson: "x", do: `resource-ask:${R1}` }],
    ["dos intenciones", { course: COURSE, do: [`resource-ask:${R1}`, `resource-ask:${R2}`] }],
    ["sin intención", { course: COURSE }],
    ["un recurso sin forma", { course: COURSE, do: "resource-ask:x" }],
    ["de más", { course: COURSE, do: `resource-move:${R1}:1:2:3` }],
    ["mover a su mismo lugar", { course: COURSE, do: `resource-move:${R1}:2:2` }],
    ["una posición cero", { course: COURSE, do: `resource-move:${R1}:0:1` }],
    ["una revisión cero", { course: COURSE, do: `resource-remove:${R1}:0` }],
    ["otro verbo", { course: COURSE, do: `lesson-up:${R1}:1` }],
  ])("%s cuenta como vacío", (_name, fields) => {
    expect(readResourceForm(form(fields))).toEqual({ step: "none" });
  });

  it("lo que llega puede no ser un formulario", () => {
    expect(readResourceForm(null)).toEqual({ step: "none" });
    expect(readResourceForm({ do: "cancel" })).toEqual({ step: "none" });
  });

  it("los botones del primero no suben a cero: la vista no los ofrece, y el lector no los acepta", () => {
    expect(readResourceForm(form({ course: COURSE, do: resourceButton.up(R1, 1) }))).toEqual({ step: "none" });
  });

  it("revisar antes de subir", () => {
    expect(checkFile({ size: 10 }, true, 100)).toBeNull();
    expect(checkFile({ size: 100 }, true, 100)).toBeNull();
    expect(checkFile({ size: 101 }, true, 100)).toBe("fileSize");
    expect(checkFile({ size: 0 }, true, 100)).toBe("fileSize");
    expect(checkFile({ size: 10 }, false, 100)).toBe("fileType");
    expect(checkFile({ size: 10 ** 9 }, true, null)).toBeNull();
  });

  it("el título sale del nombre, sin la extensión y en lo que cabe", () => {
    expect(titleFromFile("guia.final.pdf")).toBe("guia.final");
    expect(titleFromFile(`${"a".repeat(200)}.pdf`)).toHaveLength(120);
    expect(titleFromFile("sin-extension")).toBe("sin-extension");
  });

  it("el avance va de 25 en 25", () => {
    expect([0, 24, 25, 49, 50, 99, 100].map((loaded) => progressStep(loaded, 100))).toEqual([0, 0, 25, 25, 50, 75, 100]);
    expect(progressStep(5, 0)).toBe(0);
    expect(progressStep(200, 100)).toBe(100);
  });
});
