import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-89: los textos legales (T-110). Las acciones de servidor son la frontera con los servicios: aquí se
// cambian por lo que contestarían.
const actions = vi.hoisted(() => ({ legalCodeAction: vi.fn(), legalAction: vi.fn() }));
vi.mock("@/app/admin/_textos/actions", () => actions);

import { legalButton } from "@/app/admin/_textos/outcomes";
import { legalView } from "@/app/admin/_textos/rows";
import { LegalScreen } from "@/app/admin/_textos/screen";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { LEGAL_DOC_TYPES } from "@/services/legal/admin";
import type { LegalDocuments, LegalVersion } from "@/services/legal/legal-admin";

import { a11yViolations } from "../setup/a11y";

const text = admin.legal;
const SHA = "ab".repeat(32);
const V1 = "b0000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.resetAllMocks();
});

const version = (over: Partial<LegalVersion> = {}): LegalVersion => ({
  id: V1,
  version: 1,
  title: "Política de reembolsos",
  effectiveFrom: "2026-10-28T18:00:00Z",
  publishedAt: "2026-10-28T18:00:00Z",
  bodySha256: SHA,
  isDraft: false,
  state: "current",
  ...over,
});

function read(over: Partial<LegalDocuments> = {}): LegalDocuments {
  return {
    freshCode: true,
    today: "2026-10-28",
    documents: LEGAL_DOC_TYPES.map((docType) => {
      const versions = docType === "refund_policy" ? [version()] : [];
      return { docType, lastVersion: versions[0]?.version ?? null, versions };
    }),
    ...over,
  };
}

const sent = (action: ReturnType<typeof vi.fn>, call = 0) => {
  const args = action.mock.calls[call] ?? [];
  return Object.fromEntries(args[args.length - 1] as FormData);
};
const refundSection = () => screen.getByRole("region", { name: "Política de reembolsos" });
const DRAFT = { docType: "refund_policy", seen: 1, title: null, body: "", day: "2026-10-28" } as const;

describe("PA-89, los textos legales", () => {
  it("una sección por texto, con lo que rige y sus versiones, sin violaciones de accesibilidad", async () => {
    const { container } = render(<LegalScreen view={legalView(read())} done={false} />);
    expect(screen.getByRole("heading", { level: 1, name: text.title })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(9);
    const section = refundSection();
    expect(within(section).getByText("Vigente: versión 1, desde el 28 de octubre de 2026.")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: text.viewText })).toHaveAttribute("href", `/admin/textos-legales/${V1}`);
    expect(within(section).getByRole("button", { name: "Nueva versión de Política de reembolsos" })).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin código reciente, «Tu código» arriba y ninguna «Nueva versión»", () => {
    render(<LegalScreen view={legalView(read({ freshCode: false }))} done={false} />);
    expect(screen.getByRole("heading", { name: admin.code.title })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Nueva versión/ })).not.toBeInTheDocument();
  });

  it("sin la zona del periodo, se dice y no se ofrece publicar", () => {
    render(<LegalScreen view={legalView(read({ today: null }))} done={false} />);
    expect(screen.getByText(text.noZone)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Nueva versión/ })).not.toBeInTheDocument();
  });

  it("«Nueva versión» manda la última versión que se vio y abre el formulario en su lugar, con el título de la última", async () => {
    actions.legalAction.mockResolvedValueOnce({ kind: "composing", draft: DRAFT, problems: {}, changed: false, attempt: 1 });
    const user = userEvent.setup();
    render(<LegalScreen view={legalView(read())} done={false} />);
    await user.click(within(refundSection()).getByRole("button", { name: "Nueva versión de Política de reembolsos" }));
    expect(sent(actions.legalAction)).toEqual({ do: legalButton.new("refund_policy", 1) });
    const title = await within(refundSection()).findByRole("textbox", { name: text.compose.titleLabel });
    expect(title).toHaveValue("Política de reembolsos");
    await waitFor(() => expect(title).toHaveFocus());
    expect(within(refundSection()).getByLabelText(text.compose.dayLabel)).toHaveValue("2026-10-28");
    // El primer botón del formulario es el que envía Enter: «Ver cómo queda».
    const [first] = within(refundSection()).getAllByRole("button");
    expect(first).toHaveAccessibleName(text.compose.preview);
  });

  it("los errores de lo escrito se dicen en su campo, con lo escrito", async () => {
    actions.legalAction.mockResolvedValueOnce({
      kind: "composing",
      draft: { ...DRAFT, title: "  ", body: "algo", day: "2026-10-01" },
      problems: { title: "required", day: "past" },
      changed: false,
      attempt: 2,
    });
    const user = userEvent.setup();
    render(<LegalScreen view={legalView(read())} done={false} />);
    await user.click(within(refundSection()).getByRole("button", { name: "Nueva versión de Política de reembolsos" }));
    const body = await within(refundSection()).findByRole("textbox", { name: text.compose.bodyLabel });
    expect(body).toHaveValue("algo");
    expect(within(refundSection()).getByRole("textbox", { name: text.compose.titleLabel })).toHaveAccessibleDescription(text.problems.titleRequired);
    expect(within(refundSection()).getByLabelText(text.compose.dayLabel)).toHaveAccessibleDescription(
      `${text.compose.dayHint} ${text.problems.dayPast}`,
    );
  });

  it("la vista previa: el texto como se leerá, la consecuencia y «Publicar» con la versión y la huella", async () => {
    actions.legalAction.mockResolvedValueOnce({
      kind: "previewing",
      draft: { ...DRAFT, title: "Reembolsos", body: "# Reembolsos\n\nSe devuelve el pago.", day: "2026-10-28" },
      sha: SHA,
      blocks: [
        { kind: "heading", level: 1, text: "Reembolsos" },
        { kind: "paragraph", text: "Se devuelve el pago." },
      ],
      when: text.preview.today,
      failure: null,
      attempt: 1,
    });
    const user = userEvent.setup();
    const { container } = render(<LegalScreen view={legalView(read())} done={false} />);
    await user.click(within(refundSection()).getByRole("button", { name: "Nueva versión de Política de reembolsos" }));
    const heading = await within(refundSection()).findByRole("heading", { name: t(text.preview.title, { name: "Política de reembolsos", version: 2 }) });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(refundSection()).getByText("Se devuelve el pago.")).toBeInTheDocument();
    expect(within(refundSection()).getByText(text.consequences.refundPolicy)).toBeInTheDocument();
    expect(within(refundSection()).getByText(text.preview.today)).toBeInTheDocument();
    const publish = within(refundSection()).getByRole("button", { name: t(text.compose.publish, { version: 2 }) });
    actions.legalAction.mockResolvedValueOnce({ kind: "idle" });
    await user.click(publish);
    expect(sent(actions.legalAction, 1)).toEqual({
      do: legalButton.publish("refund_policy", 1, SHA),
      title: "Reembolsos",
      body: "# Reembolsos\n\nSe devuelve el pago.",
      day: "2026-10-28",
    });
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("si alguien publicó antes, se vuelve al formulario y se dice", async () => {
    actions.legalAction.mockResolvedValueOnce({ kind: "composing", draft: { ...DRAFT, seen: 2, title: "T", body: "B" }, problems: {}, changed: true, attempt: 3 });
    const user = userEvent.setup();
    render(<LegalScreen view={legalView(read())} done={false} />);
    await user.click(within(refundSection()).getByRole("button", { name: "Nueva versión de Política de reembolsos" }));
    expect(await within(refundSection()).findByText(text.failures.changed)).toBeInTheDocument();
  });

  it("lo que no se supo se dice arriba de la lista", async () => {
    actions.legalAction.mockResolvedValueOnce({ kind: "failed", reason: "unknown", attempt: 1 });
    const user = userEvent.setup();
    render(<LegalScreen view={legalView(read())} done={false} />);
    await user.click(within(refundSection()).getByRole("button", { name: "Nueva versión de Política de reembolsos" }));
    expect(await screen.findByText(text.failures.unknown)).toBeInTheDocument();
  });

  it("lo publicado se dice con el aviso que aceptó la página", () => {
    render(<LegalScreen view={legalView(read())} done />);
    expect(screen.getByText(text.published)).toBeInTheDocument();
  });

  it("el aviso de un texto del maestro usa el término", () => {
    render(<LegalScreen view={legalView(read())} done={false} />);
    expect(screen.getByRole("region", { name: "Contrato del maestro" })).toBeInTheDocument();
  });
});
