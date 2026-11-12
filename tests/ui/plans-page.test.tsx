import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La página de los planes (PA-04, T-302), con la guarda y el servicio simulados: a quién manda a entrar cuando no se venden planes, y
// que una falla pasajera se queda con su «Reintentar».

const mocks = vi.hoisted(() => ({
  publicViewer: vi.fn(),
  planOffer: vi.fn(),
  planStanding: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`redirige a ${to}`);
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ publicViewer: mocks.publicViewer }));
vi.mock("@/services/billing/checkout-service", () => ({ planOffer: mocks.planOffer, planStanding: mocks.planStanding }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/app/_catalog/nav", () => ({ StudentNav: () => null }));
vi.mock("@/app/_public/header", () => ({ PublicHeader: ({ onPlans }: { onPlans?: boolean }) => <p data-testid="barra-publica" data-on-plans={String(onPlans)} /> }));
vi.mock("@/app/_public/footer", () => ({ PublicFooter: () => null }));
vi.mock("@/app/planes/screen", () => ({ PlansScreen: () => <p>planes</p> }));

import PlansPage from "@/app/planes/page";

const LESSON = "/cursos/uno/lecciones/a0000000-0000-4000-8000-000000000001";
const NOT_FOR_SALE = { kind: "ready", offer: { plans: [], recurring: null, refundPolicy: null, refundDays: null } };
const page = async (search: Record<string, string>) => render(await PlansPage({ searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planStanding.mockResolvedValue({ kind: "ready", access: false, blocking: false, open: null });
});

describe("PA-04, cuando no se venden planes", () => {
  it("el visitante que iba a otra pantalla va a entrar con su destino", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.planOffer.mockResolvedValue(NOT_FOR_SALE);
    await expect(page({ volver: LESSON })).rejects.toThrow(`redirige a /entrar?volver=${encodeURIComponent(LESSON)}`);
  });

  it("el visitante sin destino se queda: se le dice, y puede entrar", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.planOffer.mockResolvedValue(NOT_FOR_SALE);
    await page({});
    expect(screen.getByText("Por ahora no se pueden contratar planes. Vuelve pronto.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", `/entrar?volver=${encodeURIComponent("/planes")}`);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("al visitante, la barra pública marca «Planes» como la página en que está (T-616, solicitud 4)", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.planOffer.mockResolvedValue(NOT_FOR_SALE);
    await page({});
    expect(screen.getByTestId("barra-publica")).toHaveAttribute("data-on-plans", "true");
  });

  it("quien tiene sesión nunca es redirigido", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "student", claims: {} });
    mocks.planOffer.mockResolvedValue(NOT_FOR_SALE);
    await page({ volver: LESSON });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Ya tengo cuenta" })).not.toBeInTheDocument();
  });

  it("una falla pasajera no manda a nadie a entrar: se queda con «Reintentar»", async () => {
    mocks.publicViewer.mockResolvedValue({ kind: "visitor" });
    mocks.planOffer.mockResolvedValue({ kind: "unavailable" });
    await page({ volver: LESSON });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Reintentar" })).toBeInTheDocument();
  });
});
