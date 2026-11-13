import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-04 (T-302), con la acción simulada: los planes sin elegir, «Antes de pagar» del elegido con su casilla, lo que manda el
// formulario, la respuesta con el foco, el visitante y quien ya tiene acceso, y las reglas automáticas de accesibilidad. Lo que hace la
// acción de verdad lo prueban tests/actions/checkout-actions.test.ts y el extremo a extremo.

const actions = vi.hoisted(() => ({ startCheckoutAction: vi.fn() }));
vi.mock("@/app/planes/actions", () => actions);

import { PlansScreen } from "@/app/planes/screen";
import { plansView, type PlansViewer } from "@/app/planes/view";
import { plans as text } from "@/messages/es/plans";
import { t } from "@/messages/format";
import { resolveDestination, signInPath, signUpPath } from "@/services/account/navigation";
import type { CheckoutPlan, Offer } from "@/services/billing/checkout";

import { a11yViolations } from "../setup/a11y";

const DOC = "11111111-2222-4333-8444-555555555555";
const OFFER: Offer = {
  plans: [
    { plan: "monthly", amountCents: 34900, lookupKey: "plataforma_monthly_34900_mxn", nextChargeAt: "2026-12-10T18:00:00Z" },
    { plan: "annual", amountCents: 349000, lookupKey: "plataforma_annual_349000_mxn", nextChargeAt: "2027-11-10T18:00:00Z" },
  ],
  recurring: { id: DOC, version: 0, title: "Cobro recurrente", body: "…" },
  refundPolicy: "66666666-2222-4333-8444-555555555555",
  refundDays: 7,
};
const legal = (doc: "recurring" | "refund", version: number | null) => (doc === "recurring" ? `/legal/cobro-recurrente?v=${version}` : "/legal/reembolsos");

function show(plan: "monthly" | "annual" | null, viewer: PlansViewer = { kind: "pay" }, returnTo: string | null = null) {
  const view = plansView(OFFER, { plan, returnTo, canceled: false }, viewer, legal);
  if (view.kind !== "ready") throw new Error("se vende");
  return { user: userEvent.setup(), ...render(<PlansScreen view={view} />) };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("PA-04", () => {
  // Cambió por el requisito (T-616, 3b-4): lo que incluye sube a la cabecera de la página (`page.tsx`), con el título; su prueba
  // pasa a tests/ui/plans-page.test.tsx.

  it("sin elegir: los dos planes con su precio e «IVA incluido», y sin formulario; sin fallas de accesibilidad", async () => {
    const { container } = show(null);
    expect(screen.getByRole("heading", { level: 3, name: "Mensual" })).toBeInTheDocument();
    expect(screen.getByText("$349.00 al mes")).toBeInTheDocument();
    expect(screen.getByText("$3,490.00 al año")).toBeInTheDocument();
    expect(screen.getAllByText(/IVA incluido/)).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Elegir el plan Anual" })).toHaveAttribute("href", "/planes?plan=annual#bloque-pagar");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continuar al pago" })).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con el plan elegido: el total, la periodicidad, el siguiente cobro, la casilla sin marcar y el reembolso", async () => {
    const { container } = show("annual");
    expect(screen.getByText("Plan elegido")).toBeInTheDocument();
    expect(screen.getByText("$3,490.00, IVA incluido")).toBeInTheDocument();
    expect(screen.getByText("cada año")).toBeInTheDocument();
    expect(screen.getByText("10 de noviembre de 2027, por $3,490.00")).toBeInTheDocument();
    const box = screen.getByRole("checkbox", { name: /Acepto que el cobro se repite cada año/ });
    expect(box).not.toBeChecked();
    expect(screen.getByRole("link", { name: /Leer el texto completo/ })).toHaveAttribute("href", "/legal/cobro-recurrente?v=0");
    expect(screen.getByText(/Reembolso completo dentro de 7 días/)).toBeInTheDocument();
    expect(screen.getByText(/Texto de borrador/)).toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("continuar manda el plan, el monto y el texto que se ven, el destino y la casilla", async () => {
    actions.startCheckoutAction.mockResolvedValue({ kind: "answer", answer: "changed", plan: "annual", attempt: 1 });
    const { user } = show("annual", { kind: "pay" }, "/cursos/uno");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Continuar al pago" }));
    expect(Object.fromEntries(actions.startCheckoutAction.mock.calls[0]?.[1] as FormData)).toEqual({ plan: "annual", monto: "349000", texto: DOC, volver: "/cursos/uno", acepto: "on" });
  });

  it("la respuesta se dice y toma el foco", async () => {
    actions.startCheckoutAction.mockResolvedValue({ kind: "answer", answer: "in_progress", plan: "monthly", attempt: 1 });
    const { user } = show("monthly");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Continuar al pago" }));
    await waitFor(() => expect(screen.getByText(/Tienes un pago en confirmación/).closest("[tabindex='-1']")).toHaveFocus(), { timeout: 3_000 });
  });

  it("sin la casilla, lo dice junto a ella", async () => {
    actions.startCheckoutAction.mockResolvedValue({ kind: "problem", problem: "must_accept", plan: "monthly", attempt: 1 });
    const { user } = show("monthly");
    await user.click(screen.getByRole("button", { name: "Continuar al pago" }));
    await waitFor(() => expect(screen.getByText("Para continuar, marca que aceptas el cobro recurrente.")).toBeInTheDocument(), { timeout: 3_000 });
    await waitFor(() => expect(screen.getByRole("checkbox")).toHaveAttribute("aria-invalid", "true"), { timeout: 3_000 });
  });

  it("al visitante: crear cuenta o entrar, volviendo al plan elegido; sin casilla", () => {
    show("monthly", { kind: "visitor", signUp: (to) => `/registro?volver=${encodeURIComponent(to)}`, signIn: (to) => `/entrar?volver=${encodeURIComponent(to)}` });
    expect(screen.getByRole("link", { name: "Crear cuenta para continuar" })).toHaveAttribute("href", `/registro?volver=${encodeURIComponent("/planes?plan=monthly")}`);
    expect(screen.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", `/entrar?volver=${encodeURIComponent("/planes?plan=monthly")}`);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("al visitante que todavía no elige plan se le ofrece entrar, directo a donde iba: quien ya paga no da la vuelta por los planes (T-302)", () => {
    const { unmount } = show(null, { kind: "visitor", signUp: signUpPath, signIn: signInPath }, "/cursos/uno/lecciones/a");
    expect(screen.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", `/entrar?volver=${encodeURIComponent("/cursos/uno/lecciones/a")}`);
    unmount();
    // Sin destino, vuelve a los planes.
    show(null, { kind: "visitor", signUp: signUpPath, signIn: signInPath });
    expect(screen.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", `/entrar?volver=${encodeURIComponent("/planes")}`);
  });

  it("con un plan elegido, entrar vuelve a ese plan con su destino, por las rutas de verdad", () => {
    show("monthly", { kind: "visitor", signUp: signUpPath, signIn: signInPath }, "/cursos/uno/lecciones/a");
    const back = "/planes?plan=monthly&volver=%2Fcursos%2Funo%2Flecciones%2Fa";
    expect(screen.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", `/entrar?volver=${encodeURIComponent(back)}`);
    expect(resolveDestination(back)).toBe(back);
  });

  it("con acceso y un destino guardado, «Continuar» lleva ahí; sin destino, al inicio", () => {
    const { unmount } = show(null, { kind: "has_access" }, "/cursos/uno/lecciones/a");
    expect(screen.getByRole("link", { name: "Continuar a donde iba" })).toHaveAttribute("href", "/cursos/uno/lecciones/a");
    unmount();
    show(null, { kind: "has_access" });
    expect(screen.getByRole("link", { name: "Ir a mi inicio" })).toHaveAttribute("href", "/inicio");
  });

  it("con acceso: que ya lo tiene, sin formulario", () => {
    show("monthly", { kind: "has_access" });
    expect(screen.getByText("Ya tienes acceso a todo el catálogo.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continuar al pago" })).not.toBeInTheDocument();
  });

  it("con un pago en confirmación: que no vuelva a pagar, con el enlace a cómo va", () => {
    show("monthly", { kind: "in_progress", session: "cs_test_1" });
    expect(screen.getByRole("link", { name: "Ver cómo va" })).toHaveAttribute("href", "/suscripcion/confirmando?sesion=cs_test_1");
    expect(screen.queryByRole("button", { name: "Continuar al pago" })).not.toBeInTheDocument();
  });
});

// T-616, 3b-4: el anual destacado («Conviene más» y su ahorro). Destacado no es elegido: elegido lleva el contorno y «Plan elegido»;
// destacado, el antetítulo, la cifra y, sin plan elegido, el botón principal. El antetítulo y la cifra se leen, pero no entran al
// nombre del encabezado ni al del botón. Los textos salen de los mensajes: si cambian, la prueba no.
describe("PA-04, el anual destacado (T-616, 3b-4)", () => {
  // 12 × $349.00 − $3,490.00 = $698.
  const SAVING = t(text.saving, { saving: "$698" });
  const cardOf = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("li") as HTMLElement;
  const chooseOf = (plan: "Mensual" | "Anual") => screen.getByRole("link", { name: `Elegir el plan ${plan}` });

  it("sin elegir: el anual con «Conviene más», su ahorro y el botón principal; el mensual, secundario", async () => {
    const { container } = show(null);
    const annual = cardOf("Anual");
    const monthly = cardOf("Mensual");
    expect(within(annual).getByText(text.featured)).toBeInTheDocument();
    expect(within(annual).getByText(SAVING)).toBeInTheDocument();
    expect(within(monthly).queryByText(text.featured)).toBeNull();
    expect(within(monthly).queryByText(SAVING)).toBeNull();
    // El antetítulo va antes del encabezado, fuera de él.
    const eyebrow = within(annual).getByText(text.featured);
    expect(eyebrow.compareDocumentPosition(within(annual).getByRole("heading")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chooseOf("Anual")).toHaveClass("bg-accent");
    expect(chooseOf("Mensual")).not.toHaveClass("bg-accent");
    // Destacado no es elegido: sin contorno del acento ni «Plan elegido».
    expect(annual).not.toHaveClass("border-accent");
    expect(screen.queryByText(text.chosen)).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con el mensual elegido: el mensual con el estilo de elegido; el anual destacado, con su botón en secundario", async () => {
    const { container } = show("monthly");
    expect(cardOf("Mensual")).toHaveClass("border-accent");
    expect(within(cardOf("Mensual")).getByText(text.chosen)).toHaveAttribute("aria-current", "true");
    const annual = cardOf("Anual");
    expect(annual).not.toHaveClass("border-accent");
    expect(within(annual).getByText(text.featured)).toBeInTheDocument();
    expect(within(annual).getByText(SAVING)).toBeInTheDocument();
    // Un solo principal: «Continuar al pago».
    expect(chooseOf("Anual")).not.toHaveClass("bg-accent");
    const cards = screen.getByRole("region", { name: text.choose });
    expect(within(cards).queryAllByRole("link").filter((link) => link.classList.contains("bg-accent"))).toEqual([]);
    expect(screen.getByRole("button", { name: "Continuar al pago" })).toHaveClass("bg-accent");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con el anual elegido: el anual con el estilo de elegido, su antetítulo y su ahorro; el mensual, secundario", async () => {
    const { container } = show("annual");
    const annual = cardOf("Anual");
    expect(annual).toHaveClass("border-accent");
    expect(within(annual).getByText(text.chosen)).toHaveAttribute("aria-current", "true");
    expect(within(annual).getByText(text.featured)).toBeInTheDocument();
    expect(within(annual).getByText(SAVING)).toBeInTheDocument();
    expect(chooseOf("Mensual")).not.toHaveClass("bg-accent");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el ahorro nunca entra en «Antes de pagar» ni en el formulario, que lleva lo de siempre", async () => {
    actions.startCheckoutAction.mockResolvedValue({ kind: "answer", answer: "changed", plan: "annual", attempt: 1 });
    const { user, container } = show("annual");
    const pay = container.querySelector("#bloque-pagar") as HTMLElement;
    expect(pay.textContent).not.toContain(SAVING);
    expect(pay.textContent).not.toContain(text.featured);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Continuar al pago" }));
    expect(Object.fromEntries(actions.startCheckoutAction.mock.calls[0]?.[1] as FormData)).toEqual({ plan: "annual", monto: "349000", texto: DOC, acepto: "on" });
  });

  it("sin ahorro, ni antetítulo, ni cifra, ni botón principal en las tarjetas", () => {
    const offer: Offer = { ...OFFER, plans: OFFER.plans.map((each) => (each.plan === "annual" ? { ...each, amountCents: 418800 } : each)) };
    const view = plansView(offer, { plan: null, returnTo: null, canceled: false }, { kind: "pay" }, legal);
    if (view.kind !== "ready") throw new Error("se vende");
    render(<PlansScreen view={view} />);
    expect(screen.queryByText(text.featured)).toBeNull();
    expect(screen.queryByText(/Ahorras/)).toBeNull();
    expect(chooseOf("Anual")).not.toHaveClass("bg-accent");
    expect(chooseOf("Mensual")).not.toHaveClass("bg-accent");
  });

  it("una cifra de siete dígitos sale entera, y la frase puede partirse en renglones (320 px)", () => {
    // 12 × $1,000,000.00 − $10,765,433.00 = $1,234,567.
    const plans: { plan: CheckoutPlan; amountCents: number }[] = [
      { plan: "monthly", amountCents: 100_000_000 },
      { plan: "annual", amountCents: 1_076_543_300 },
    ];
    const offer: Offer = { ...OFFER, plans: plans.map((each) => ({ ...each, lookupKey: "x", nextChargeAt: "2026-12-10T18:00:00Z" })) };
    const view = plansView(offer, { plan: null, returnTo: null, canceled: false }, { kind: "pay" }, legal);
    if (view.kind !== "ready") throw new Error("se vende");
    render(<PlansScreen view={view} />);
    const line = screen.getByText(t(text.saving, { saving: "$1,234,567" }));
    expect(line.className).not.toMatch(/truncate|whitespace-nowrap|line-clamp|overflow-hidden/);
  });
});
