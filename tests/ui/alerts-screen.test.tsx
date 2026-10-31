import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-68 mínima, las alertas de anomalía (T-208). Las acciones de servidor son la frontera con los
// servicios: aquí se cambian por lo que contestarían.
const actions = vi.hoisted(() => ({ alertsCodeAction: vi.fn(), alertsAction: vi.fn() }));
vi.mock("@/app/admin/_alertas/actions", () => actions);

import type { AlertsState } from "@/app/admin/_alertas/outcomes";
import { alertsView } from "@/app/admin/_alertas/rows";
import { AlertsScreen } from "@/app/admin/_alertas/screen";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import type { FinanceAlert, FinanceAlerts } from "@/services/anomalies/anomalies";

import { a11yViolations } from "../setup/a11y";

const text = admin.alerts;

beforeEach(() => {
  vi.resetAllMocks();
});

const ALERT = "a1e70000-0000-4000-8000-000000000002";
const EXCLUSION = "e0000000-0000-4000-8000-000000000003";
const ACCOUNT = "0123456789ab";
const OTHER = "ba9876543210";

const JUMP: FinanceAlert = {
  id: ALERT,
  period: 202610,
  kind: "teacher_points_jump",
  status: "open",
  metric: 6666.667,
  threshold: 5000,
  today: 7000,
  details: { before: 6, after: 10 },
  detectedAt: "2026-11-01T09:00:00Z",
  reviewNote: null,
  isFraud: null,
  evidence: null,
  reviewedAt: null,
  reviewedByName: null,
  suspension: null,
  teacherName: "Maestra Uno",
  canExclude: true,
  accounts: [
    { account: ACCOUNT, age: "under_7", share: "only", halfPoints: 4, halfPointsBefore: 0, lessons: 2, coveredSeconds: null, excluded: false },
    { account: OTHER, age: "over_90", share: "most", halfPoints: 2, halfPointsBefore: 2, lessons: 1, coveredSeconds: null, excluded: true },
  ],
  moreAccounts: 0,
  exclusions: [
    {
      id: EXCLUSION,
      account: OTHER,
      scope: "account",
      reasonCode: "test_account",
      reason: "Es de prueba.",
      createdByName: "Ana",
      createdAt: "2026-11-02T18:00:00Z",
      revokedAt: null,
      revokedByName: null,
      revokeReason: null,
    },
  ],
};

const readOf = (over: Partial<FinanceAlerts> = {}, alert: Partial<FinanceAlert> = {}): FinanceAlerts => ({
  freshCode: true,
  total: 1,
  alerts: [{ ...JUMP, ...alert }],
  ...over,
});
const show = (read: FinanceAlerts = readOf()) => ({ user: userEvent.setup(), ...render(<AlertsScreen view={alertsView(read)} />) });
const formOf = (call = 0) => Object.fromEntries(actions.alertsAction.mock.calls[call]?.[1] as FormData);
const card = () => screen.getByRole("article", { name: t(text.kinds.teacherPointsJump) });
/** Revisada: decidir fraude solo se ofrece así (la base pide la nota de la revisión antes). */
const REVIEWED: Partial<FinanceAlert> = { status: "reviewed", reviewedAt: "2026-11-03T18:00:00Z", reviewedByName: "Beto", reviewNote: "Lo revisé." };

describe("en reposo", () => {
  it("cada alerta con sus cifras, sus cuentas por huella y sus exclusiones, sin reglas rotas", async () => {
    const { container } = show();
    expect(screen.getByRole("heading", { level: 1, name: text.title })).toBeVisible();
    const alert = within(card());
    expect(alert.getByText(text.open)).toBeVisible();
    expect(alert.getByText(t(text.teacher, { name: "Maestra Uno" }))).toBeVisible();
    expect(alert.getByText(t(text.account, { account: ACCOUNT }), { selector: "p" })).toBeVisible();
    expect(alert.getByText(text.excluded)).toBeVisible();
    expect(alert.getByRole("button", { name: text.markReviewed })).toBeVisible();
    // Abierta: decidir fraude espera a la revisión, y lo dice.
    expect(alert.queryByRole("button", { name: text.decideFraud })).not.toBeInTheDocument();
    expect(alert.getByText(text.fraudAfterReview)).toBeVisible();
    // La cuenta ya excluida no se ofrece otra vez; su exclusión vigente, revertir sí.
    expect(alert.getAllByRole("button", { name: new RegExp(`^${text.exclude} `) })).toHaveLength(1);
    expect(alert.getByRole("button", { name: `${text.exclude} ${t(text.account, { account: ACCOUNT })}` })).toBeVisible();
    expect(alert.getAllByRole("button", { name: new RegExp(`^${text.revoke} `) })).toHaveLength(1);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin el código reciente: se pide arriba, y no se ofrece ninguna decisión", () => {
    show(readOf({ freshCode: false }));
    expect(screen.getByText(text.codeBody)).toBeVisible();
    expect(screen.getByText(text.changeLocked)).toBeVisible();
    expect(within(card()).queryAllByRole("button")).toEqual([]);
  });

  it("con el periodo cerrado lo dice, y no ofrece excluir ni revertir", () => {
    show(readOf({}, { canExclude: false }));
    const alert = within(card());
    expect(alert.getByText(text.closed)).toBeVisible();
    expect(alert.queryByRole("button", { name: new RegExp(`^${text.exclude}`) })).not.toBeInTheDocument();
    expect(alert.queryByRole("button", { name: new RegExp(`^${text.revoke}`) })).not.toBeInTheDocument();
  });

  it("revisada y decidida como fraude: lo dice, y no ofrece revisar ni decidir otra vez", () => {
    show(readOf({}, { status: "reviewed", reviewedAt: "2026-11-03T18:00:00Z", reviewedByName: "Beto", reviewNote: "Lo revisé.", isFraud: true, evidence: "Once cuentas." }));
    const alert = within(card());
    expect(alert.getByText(text.reviewed)).toBeVisible();
    expect(alert.getByText(t(text.note, { note: "Lo revisé." }))).toBeVisible();
    expect(alert.queryByRole("button", { name: text.markReviewed })).not.toBeInTheDocument();
    expect(alert.queryByRole("button", { name: text.decideFraud })).not.toBeInTheDocument();
  });

  it("vacía: lo dice", () => {
    show(readOf({ total: 0, alerts: [] }));
    expect(screen.getByText(text.empty)).toBeVisible();
  });

  it("sin JavaScript los formularios ya vienen en el HTML", () => {
    const html = renderToString(<AlertsScreen view={alertsView(readOf())} />);
    expect(html).toContain(`value="review:${ALERT}"`);
    expect(html).toContain(`value="ask_exclude:${ALERT}:${ACCOUNT}"`);
  });
});

describe("las decisiones", () => {
  it("revisar manda la alerta del botón y la nota", async () => {
    actions.alertsAction.mockResolvedValueOnce({ kind: "idle" });
    const { user } = show();
    await user.type(within(card()).getByLabelText(text.noteLabel), "La revisé.");
    await user.click(within(card()).getByRole("button", { name: text.markReviewed }));
    expect(formOf(0)).toEqual({ do: `review:${ALERT}`, note: "La revisé." });
  });

  it("si revisar falla, lo escrito vuelve a su campo y lo que pasó se dice arriba", async () => {
    actions.alertsAction.mockResolvedValueOnce({ kind: "failed", reason: "unknown", step: "review", alert: ALERT, drafts: { note: "La revisé." }, attempt: 1 });
    const { user } = show();
    await user.click(within(card()).getByRole("button", { name: text.markReviewed }));
    expect(await screen.findByText(text.unknown)).toBeVisible();
    expect(within(card()).getByLabelText(text.noteLabel)).toHaveValue("La revisé.");
  });

  it("decidir fraude: preguntar toma el foco y pide la evidencia; confirmar la manda", async () => {
    const confirming: AlertsState = { kind: "confirming", confirming: { step: "fraud", alert: ALERT }, drafts: {}, problem: null, attempt: 1 };
    let release: (value: unknown) => void = () => undefined;
    actions.alertsAction.mockResolvedValueOnce(confirming).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { user } = show(readOf({}, REVIEWED));
    await user.click(within(card()).getByRole("button", { name: text.decideFraud }));
    expect(formOf(0)).toEqual({ do: `ask_fraud:${ALERT}` });
    const question = await screen.findByText(text.confirmFraudTitle);
    await waitFor(() => expect(question.parentElement).toHaveFocus());
    await user.type(screen.getByLabelText(text.evidenceLabel), "Once cuentas nuevas.");
    await user.click(screen.getByRole("button", { name: text.confirmFraud }));
    expect(formOf(1)).toEqual({ do: `fraud:${ALERT}`, evidence: "Once cuentas nuevas." });
    expect((await screen.findAllByText(text.working)).length).toBeGreaterThan(0);
    await act(async () => release({ kind: "idle" }));
  });

  it("confirmar sin evidencia: la pregunta sigue, con lo que falta en su campo y lo escrito en él", async () => {
    const asked: AlertsState = { kind: "confirming", confirming: { step: "fraud", alert: ALERT }, drafts: {}, problem: null, attempt: 1 };
    const again: AlertsState = { ...asked, drafts: { evidence: "  " }, problem: "missing_evidence", attempt: 2 };
    actions.alertsAction.mockResolvedValueOnce(asked).mockResolvedValueOnce(again);
    const { user } = show(readOf({}, REVIEWED));
    await user.click(within(card()).getByRole("button", { name: text.decideFraud }));
    await user.click(await screen.findByRole("button", { name: text.confirmFraud }));
    await waitFor(() => expect(screen.getByLabelText(text.evidenceLabel)).toHaveAccessibleDescription(text.missingEvidence));
    expect(screen.getByLabelText(text.evidenceLabel)).toHaveValue("  ");
    expect(screen.getByText(text.confirmFraudTitle)).toBeVisible();
  });

  it("excluir: pregunta en la fila de esa cuenta, sin el motivo de fraude, y manda motivo y texto", async () => {
    actions.alertsAction.mockResolvedValueOnce({
      kind: "confirming",
      confirming: { step: "exclude", alert: ALERT, account: ACCOUNT },
      drafts: {},
      problem: null,
      attempt: 1,
    });
    actions.alertsAction.mockResolvedValueOnce({ kind: "idle" });
    const { user } = show();
    await user.click(within(card()).getByRole("button", { name: `${text.exclude} ${t(text.account, { account: ACCOUNT })}` }));
    expect(formOf(0)).toEqual({ do: `ask_exclude:${ALERT}:${ACCOUNT}` });
    expect(await screen.findByText(t(text.confirmExcludeTitle, { account: ACCOUNT }))).toBeVisible();
    const reason = screen.getByLabelText(text.reasonCodeLabel);
    expect(within(reason).queryByRole("option", { name: text.reasons.fraud })).not.toBeInTheDocument();
    await user.selectOptions(reason, text.reasons.testAccount);
    await user.type(screen.getByLabelText(text.reasonLabel), "Es de prueba.");
    await user.click(screen.getByRole("button", { name: text.confirmExclude }));
    expect(formOf(1)).toEqual({ do: `exclude:${ALERT}:${ACCOUNT}`, reason_code: "test_account", reason: "Es de prueba." });
  });

  it("con fraude decidido, el motivo de fraude sí se ofrece", async () => {
    actions.alertsAction.mockResolvedValueOnce({
      kind: "confirming",
      confirming: { step: "exclude", alert: ALERT, account: ACCOUNT },
      drafts: {},
      problem: null,
      attempt: 1,
    });
    const { user } = show(readOf({}, { isFraud: true, evidence: "Once cuentas." }));
    await user.click(within(card()).getByRole("button", { name: `${text.exclude} ${t(text.account, { account: ACCOUNT })}` }));
    const reason = await screen.findByLabelText(text.reasonCodeLabel);
    expect(within(reason).getByRole("option", { name: text.reasons.fraud })).toBeInTheDocument();
  });

  it("revertir: pregunta en la fila de la exclusión y manda su motivo", async () => {
    actions.alertsAction.mockResolvedValueOnce({
      kind: "confirming",
      confirming: { step: "revoke", alert: ALERT, exclusion: EXCLUSION },
      drafts: {},
      problem: "missing_reason",
      attempt: 1,
    });
    actions.alertsAction.mockResolvedValueOnce({ kind: "idle" });
    const { user } = show();
    await user.click(within(card()).getByRole("button", { name: new RegExp(`^${text.revoke} `) }));
    expect(formOf(0)).toEqual({ do: `ask_revoke:${ALERT}:${EXCLUSION}` });
    const field = await screen.findByLabelText(text.revokeReasonLabel);
    expect(field).toHaveAccessibleDescription(text.missingReason);
    await user.type(field, "Era un error.");
    await user.click(screen.getByRole("button", { name: text.confirmRevoke }));
    expect(formOf(1)).toEqual({ do: `revoke:${ALERT}:${EXCLUSION}`, reason: "Era un error." });
  });

  it("«Cancelar» quita la pregunta", async () => {
    actions.alertsAction
      .mockResolvedValueOnce({ kind: "confirming", confirming: { step: "fraud", alert: ALERT }, drafts: {}, problem: null, attempt: 1 })
      .mockResolvedValueOnce({ kind: "idle" });
    const { user } = show(readOf({}, REVIEWED));
    await user.click(within(card()).getByRole("button", { name: text.decideFraud }));
    await user.click(await screen.findByRole("button", { name: text.cancel }));
    expect(formOf(1)).toEqual({ do: "cancel", evidence: "" });
    await waitFor(() => expect(screen.queryByText(text.confirmFraudTitle)).not.toBeInTheDocument());
  });

  it("si la confirmación se cerró sin hacerse, lo escrito se dice con el resultado", async () => {
    actions.alertsAction.mockResolvedValueOnce({ kind: "failed", reason: "needs_fraud_decision", step: "exclude", alert: ALERT, drafts: { reason: "Once cuentas.", reasonCode: "fraud" }, attempt: 1 });
    const { user } = show();
    await user.click(within(card()).getByRole("button", { name: text.markReviewed }));
    expect(await screen.findByText(`${text.needsFraudDecision} ${t(text.written, { text: "Once cuentas." })}`)).toBeVisible();
  });

  it("«tu código ya no es reciente» deja de decirse en cuanto la página lee uno reciente", async () => {
    actions.alertsAction.mockResolvedValueOnce({ kind: "failed", reason: "needs_code", step: "review", alert: ALERT, drafts: {}, attempt: 1 });
    const { user } = show();
    await user.click(within(card()).getByRole("button", { name: text.markReviewed }));
    await act(async () => undefined);
    expect(screen.queryByText(text.needsCode)).not.toBeInTheDocument();
  });

  it("la nota que no se envió no se borra porque falle otra decisión de la misma alerta", async () => {
    actions.alertsAction
      .mockResolvedValueOnce({ kind: "failed", reason: "closed", step: "exclude", alert: ALERT, drafts: {}, attempt: 1 });
    const { user } = show();
    await user.type(within(card()).getByLabelText(text.noteLabel), "A medio escribir.");
    await user.click(within(card()).getByRole("button", { name: `${text.exclude} ${t(text.account, { account: ACCOUNT })}` }));
    expect(await screen.findByText(text.closedNow)).toBeVisible();
    expect(within(card()).getByLabelText(text.noteLabel)).toHaveValue("A medio escribir.");
  });

  it("la nota que volvió porque falló revisar se queda aunque después se pregunte otra cosa", async () => {
    actions.alertsAction
      .mockResolvedValueOnce({ kind: "failed", reason: "unknown", step: "review", alert: ALERT, drafts: { note: "La revisé." }, attempt: 1 })
      .mockResolvedValueOnce({ kind: "confirming", confirming: { step: "exclude", alert: ALERT, account: ACCOUNT }, drafts: {}, problem: null, attempt: 2 });
    const { user } = show();
    await user.click(within(card()).getByRole("button", { name: text.markReviewed }));
    await waitFor(() => expect(within(card()).getByLabelText(text.noteLabel)).toHaveValue("La revisé."));
    await user.click(within(card()).getByRole("button", { name: `${text.exclude} ${t(text.account, { account: ACCOUNT })}` }));
    expect(await screen.findByText(t(text.confirmExcludeTitle, { account: ACCOUNT }))).toBeVisible();
    expect(within(card()).getByLabelText(text.noteLabel)).toHaveValue("La revisé.");
  });

  it("el aviso de lo que salió bien deja de decirse con otra respuesta", async () => {
    actions.alertsAction.mockResolvedValueOnce({ kind: "failed", reason: "unknown", step: "review", alert: ALERT, drafts: {}, attempt: 1 });
    const user = userEvent.setup();
    render(<AlertsScreen view={alertsView(readOf())} done="account_excluded" />);
    expect(screen.getByText(text.done.accountExcluded)).toBeVisible();
    await user.click(within(card()).getByRole("button", { name: text.markReviewed }));
    expect(await screen.findByText(text.unknown)).toBeVisible();
    expect(screen.queryByText(text.done.accountExcluded)).not.toBeInTheDocument();
  });

  it("los campos no dejan escribir más que el tope de la base", () => {
    show();
    expect(within(card()).getByLabelText(text.noteLabel)).toHaveAttribute("maxlength", String(alertsView(readOf()).limits.note));
  });

  it("de vuelta con el aviso de una decisión: lo dice, y toma el foco si quedó sin dueño", async () => {
    const { container } = render(<AlertsScreen view={alertsView(readOf())} done="account_excluded" />);
    const notice = screen.getByText(text.done.accountExcluded);
    await waitFor(() => expect(notice.closest("[tabindex]")).toHaveFocus());
    expect(await a11yViolations(container)).toEqual([]);
  });
});
