import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-44 (T-405), con la acción simulada: los tres pasos, la casilla con la frase que se acepta, el foco en la respuesta, lo bloqueado sin pasos, y las reglas automáticas de
// accesibilidad. Lo que hace la acción de verdad lo prueban tests/actions y el extremo a extremo.

const actions = vi.hoisted(() => ({ submitCourseAction: vi.fn() }));
vi.mock("@/app/portal/_enviar/actions", () => actions);

import { submitView } from "@/app/portal/_enviar/rows";
import { SubmitScreen } from "@/app/portal/_enviar/screen";
import type { DraftCourse, SubmitPreview } from "@/services/drafts/editor";

import { a11yViolations } from "../setup/a11y";

const COURSE = "c0000000-0000-4000-8000-000000000002";
const LESSON = "d0000000-0000-4000-8000-000000000001";
const ANNEX = "a1000000-0000-4000-8000-000000000003";
const draft = {
  id: COURSE,
  state: "draft",
  title: "Respirar",
  modules: [{ id: "e0000000-0000-4000-8000-000000000001", title: "Inicio", position: 1, revision: 1, lessons: [{ id: LESSON, title: "Primera", description: null, position: 1, revision: 1 }] }],
  videos: [],
} as unknown as DraftCourse;
const STATEMENT = "Acepto el anexo de licencia, versión 1, para el curso «Respirar», versión 1, por 10 años.";
const READY: SubmitPreview = {
  kind: "ready",
  annex: { id: ANNEX, version: 1, title: "Anexo", body: "El texto completo.", effectiveFrom: "2026-11-01T06:00:00Z" },
  termYears: 10,
  statement: STATEMENT,
  submissionNo: 1,
  contentSha256: "c".repeat(64),
};
const show = (preview: SubmitPreview = READY) => ({ user: userEvent.setup(), ...render(<SubmitScreen view={submitView(preview, draft, null)} blocks={[{ kind: "paragraph", text: "El texto completo." }]} />) });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("PA-44", () => {
  it("los tres pasos, el anexo y la casilla con la frase que se acepta, sin fallas de accesibilidad", async () => {
    const { container } = show();
    expect(screen.getByRole("heading", { level: 2, name: "1. Tu curso está completo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "3. Anexo de licencia de este curso" })).toBeInTheDocument();
    expect(screen.getByText("El texto completo.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: STATEMENT })).not.toBeChecked();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("enviar manda lo que se vio y la casilla", async () => {
    actions.submitCourseAction.mockResolvedValue({ kind: "failed", reason: "changed", lessons: [], attempt: 1 });
    const { user } = show();
    await user.click(screen.getByRole("checkbox", { name: STATEMENT }));
    await user.click(screen.getByRole("button", { name: "Enviar a revisión" }));
    expect(Object.fromEntries(actions.submitCourseAction.mock.calls[0]?.[1] as FormData)).toEqual({ do: `submit:${COURSE}:${ANNEX}:${"c".repeat(64)}:10:1`, acepto: "on" });
  });

  it("la respuesta toma el foco, y un video que ya no está dice qué lección", async () => {
    actions.submitCourseAction.mockResolvedValue({ kind: "failed", reason: "video_not_ready", lessons: [LESSON], attempt: 1 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Enviar a revisión" }));
    const said = await screen.findByText(/ya no tiene listo el video de: «Primera»/);
    await waitFor(() => expect(document.activeElement?.contains(said)).toBe(true));
  });

  it("sin la casilla, la casilla queda marcada como pendiente", async () => {
    actions.submitCourseAction.mockResolvedValue({ kind: "failed", reason: "not_accepted", lessons: [], attempt: 1 });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Enviar a revisión" }));
    expect(await screen.findByText(/Marca la casilla para aceptar el anexo/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: STATEMENT })).toHaveAttribute("aria-invalid", "true");
  });

  it("bloqueado: lo dice, sin pasos ni botón", () => {
    show({ kind: "annex_missing" });
    expect(screen.getByText(/falta el texto vigente del anexo/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar a revisión" })).not.toBeInTheDocument();
  });

  it("con algo que falta, no hay anexo ni botón, y un pendiente se quita desde aquí", async () => {
    actions.submitCourseAction.mockResolvedValue({ kind: "removed", attempt: 1 });
    const { user } = show({ kind: "not_ready", missing: [{ what: "resource_pending", module: null, lesson: null, resource: "e0000000-0000-4000-8000-000000000009", title: "Guía", revision: 2 }] });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quitarlo" }));
    const said = await screen.findByText("Quitado. Ya no impide enviar.");
    await waitFor(() => expect(document.activeElement?.contains(said)).toBe(true));
  });
});
