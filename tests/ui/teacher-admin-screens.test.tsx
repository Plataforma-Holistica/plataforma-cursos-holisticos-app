import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-65 y PA-66, administrar a los maestros (T-401). Las acciones de servidor son la frontera con los servicios: aquí se
// cambian por lo que contestarían. Lo que se mira es lo que un DOM simulado sí ve: qué se pinta, a dónde va el foco, y
// que lo escrito no se pierda.
const actions = vi.hoisted(() => ({ teachersCodeAction: vi.fn(), teachersAction: vi.fn() }));
vi.mock("@/app/admin/_maestros/actions", () => actions);

import type { TeachersState } from "@/app/admin/_maestros/outcomes";
import { rosterView, teacherView } from "@/app/admin/_maestros/rows";
import { TeacherScreen } from "@/app/admin/_maestros/teacher-screen";
import { TeachersScreen } from "@/app/admin/_maestros/teachers-screen";
import { admin } from "@/messages/es/admin";
import type { FraudRequest, TeacherRoster, TeacherRow } from "@/services/teachers/admin";

import { a11yViolations } from "../setup/a11y";

const text = admin.teachers;
const detail = text.detail;

const TEACHER = "b0000000-0000-4000-8000-000000000002";
const REQUEST = "c0000000-0000-4000-8000-000000000004";
const ROW: TeacherRow = {
  id: TEACHER,
  name: "Ana",
  status: "active",
  founderSince: null,
  email: "ana@prueba.test",
  invitation: "accepted",
  expiresAt: null,
  suspension: null,
  suspendedAt: null,
  suspensionReason: null,
  suspensionNotice: null,
  fraudPending: false,
  isSelf: false,
  hasTaxData: false,
};
const FRAUD: FraudRequest = {
  id: REQUEST,
  teacherId: TEACHER,
  name: "Ana",
  reason: "Puntos inflados",
  proposedAt: "2026-10-30T12:00:00Z",
  proposedBySelf: false,
  markedBySelf: false,
  period: 202610,
  metric: 500,
  threshold: 300,
};
const roster = (row: TeacherRow = ROW, requests: FraudRequest[] = [], freshCode = true): TeacherRoster => ({ freshCode, teachers: [row], requests });
function showTeacher(read: TeacherRoster = roster()) {
  const view = teacherView(read, TEACHER);
  if (view === null) throw new Error("Sin ficha.");
  return { user: userEvent.setup(), ...render(<TeacherScreen view={view} />) };
}
const reasonField = () => screen.getByLabelText(detail.reasonLabel);
const noticeField = () => screen.getByLabelText(/^Lo que lee/);
const answering = (...states: TeachersState[]) => {
  for (const state of states) actions.teachersAction.mockResolvedValueOnce(state);
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("PA-66", () => {
  it("pasa las reglas de accesibilidad, y sin el código reciente no ofrece cambios", async () => {
    const { container, unmount } = showTeacher(roster(ROW, [FRAUD]));
    expect(await a11yViolations(container)).toEqual([]);
    unmount();
    showTeacher(roster(ROW, [FRAUD], false));
    expect(screen.queryByRole("button", { name: detail.askSuspend })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: detail.askConfirmFraud })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: detail.saveFounder })).not.toBeInTheDocument();
    expect(screen.getByText(text.changeLocked)).toBeVisible();
  });

  it("dice el día del fundador tal como se guardó, sin moverlo por la zona horaria", () => {
    showTeacher(roster({ ...ROW, founderSince: "2026-11-01" }));
    expect(screen.getByText("Fundador desde el 1 de noviembre de 2026")).toBeVisible();
  });

  it("un campo sin llenar: el resumen de errores toma el foco y dice qué falta", async () => {
    const { user } = showTeacher();
    answering({ kind: "invalid", step: "founder", teacher: TEACHER, problems: ["since"], drafts: { since: "" }, attempt: 1 });
    await user.click(screen.getByRole("button", { name: detail.saveFounder }));
    const link = await screen.findByRole("link", { name: detail.sinceProblem });
    await waitFor(() => expect(link.closest("[tabindex]") ?? link).toHaveFocus());
  });

  it("si confirmar falla, se cierra la pregunta, el aviso toma el foco y lo escrito se queda", async () => {
    const { user } = showTeacher();
    const drafts = { reason: "Motivo", notice: "Aviso" };
    answering(
      { kind: "asking", ask: "suspend", teacher: TEACHER, drafts, attempt: 1 },
      { kind: "failed", reason: "unknown", step: "suspend", teacher: TEACHER, drafts, attempt: 2 },
    );
    await user.type(reasonField(), "Motivo");
    await user.type(noticeField(), "Aviso");
    await user.click(screen.getByRole("button", { name: detail.askSuspend }));
    await user.click(await screen.findByRole("button", { name: detail.confirmSuspend }));
    const alert = await screen.findByText(text.failures.unknown);
    await waitFor(() => expect(alert.closest("[tabindex]")).toHaveFocus());
    expect(screen.queryByRole("button", { name: detail.confirmSuspend })).not.toBeInTheDocument();
    expect(reasonField()).toHaveValue("Motivo");
    expect(noticeField()).toHaveValue("Aviso");
  });

  it("«Seguir revisando» cierra la pregunta y deja lo escrito", async () => {
    const { user } = showTeacher();
    const drafts = { reason: "Motivo", notice: "Aviso" };
    answering({ kind: "asking", ask: "suspend", teacher: TEACHER, drafts, attempt: 1 }, { kind: "editing", form: "suspend", teacher: TEACHER, drafts, attempt: 2 });
    await user.type(reasonField(), "Motivo");
    await user.type(noticeField(), "Aviso");
    await user.click(screen.getByRole("button", { name: detail.askSuspend }));
    await user.click(await screen.findByRole("button", { name: detail.keepReviewing }));
    await screen.findByRole("button", { name: detail.askSuspend });
    expect(reasonField()).toHaveValue("Motivo");
    expect(noticeField()).toHaveValue("Aviso");
  });

  it("lo que falló en un formulario no borra lo que se escribía en otro", async () => {
    const { user } = showTeacher();
    await user.type(reasonField(), "A medio escribir");
    answering({ kind: "failed", reason: "too_early", step: "founder", teacher: TEACHER, drafts: { since: "2020-01-01" }, attempt: 1 });
    await user.click(screen.getByRole("button", { name: detail.saveFounder }));
    await screen.findByText(text.failures.tooEarly);
    expect(reasonField()).toHaveValue("A medio escribir");
  });

  it("lo escrito para suspender no aparece en el aviso de una propuesta de fraude, ni al revés", async () => {
    const { user } = showTeacher(roster({ ...ROW, fraudPending: true }, [FRAUD]));
    answering({ kind: "asking", ask: "suspend", teacher: TEACHER, drafts: { reason: "Motivo", notice: "Para la suspensión" }, attempt: 1 });
    await user.click(screen.getByRole("button", { name: detail.askSuspend }));
    await screen.findByRole("button", { name: detail.confirmSuspend });
    const [fraudNotice, suspendNotice] = screen.getAllByLabelText(/^Lo que lee/);
    expect(fraudNotice).toHaveValue("");
    expect(suspendNotice).toHaveValue("Para la suspensión");
  });

  it.each([
    ["quien la propuso", { proposedBySelf: true }, text.fraud.proposedBySelf],
    ["quien marcó la alerta", { markedBySelf: true }, text.fraud.markedBySelf],
  ])("a %s le dice por qué no decide, y no le ofrece hacerlo", (_who, extra, reason) => {
    showTeacher(roster({ ...ROW, fraudPending: true }, [{ ...FRAUD, ...extra }]));
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.queryByRole("button", { name: detail.askConfirmFraud })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: detail.rejectFraud })).not.toBeInTheDocument();
  });

  it("la ficha propia lo dice, y no ofrece ni el fundador ni suspender", () => {
    showTeacher(roster({ ...ROW, isSelf: true }));
    expect(screen.getByText(detail.isSelf)).toBeVisible();
    expect(screen.queryByRole("button", { name: detail.saveFounder })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: detail.askSuspend })).not.toBeInTheDocument();
  });

  it("mientras un envío va en camino, los campos quedan de solo lectura", async () => {
    const { user } = showTeacher();
    let release: (state: TeachersState) => void = () => undefined;
    actions.teachersAction.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await user.click(screen.getByRole("button", { name: detail.askSuspend }));
    await waitFor(() => expect(reasonField()).toHaveAttribute("readonly"));
    release({ kind: "idle" });
    await waitFor(() => expect(reasonField()).not.toHaveAttribute("readonly"));
  });
});

describe("PA-65", () => {
  const showList = (read: TeacherRoster = roster()) => ({ user: userEvent.setup(), ...render(<TeachersScreen view={rosterView(read)} />) });

  it("pasa las reglas de accesibilidad", async () => {
    const { container } = showList(roster({ ...ROW, status: "invited", invitation: "pending", expiresAt: "2026-11-30T12:00:00Z" }, [FRAUD]));
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("lo que falló en una fila no borra lo que se escribía para invitar", async () => {
    const { user } = showList(roster({ ...ROW, status: "invited", invitation: "pending" }));
    await user.type(screen.getByLabelText(text.invite.name), "Nora");
    answering({ kind: "failed", reason: "changed", step: "revoke", teacher: TEACHER, drafts: {}, attempt: 1 });
    await user.click(screen.getByRole("button", { name: text.list.revoke }));
    await screen.findByText(text.failures.changed);
    expect(screen.getByLabelText(text.invite.name)).toHaveValue("Nora");
  });

  it("sin el código reciente no se ofrece invitar", () => {
    showList(roster(ROW, [], false));
    expect(screen.queryByRole("button", { name: text.invite.submit })).not.toBeInTheDocument();
  });
});
