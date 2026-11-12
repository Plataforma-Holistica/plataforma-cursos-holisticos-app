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
// La barra del alumno (T-616): sin accesos por rol ni correo, salvo que la prueba diga otra cosa.
vi.mock("@/app/_catalog/nav-facts", () => ({ studentNavFor: () => Promise.resolve({ access: { admin: false, portal: false }, email: null }) }));
vi.mock("@/app/_lib/guard", () => ({ publicViewer: mocks.publicViewer }));
vi.mock("@/services/billing/checkout-service", () => ({ planOffer: mocks.planOffer, planStanding: mocks.planStanding }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/app/_catalog/nav", () => ({ StudentNav: () => <p data-testid="barra-alumno" /> }));
vi.mock("@/app/_public/brand-bar", () => ({ BrandBar: () => <p data-testid="barra-logotipo" /> }));
vi.mock("@/app/_public/header", () => ({ PublicHeader: ({ onPlans }: { onPlans?: boolean }) => <p data-testid="barra-publica" data-on-plans={String(onPlans)} /> }));
vi.mock("@/app/_public/footer", () => ({ PublicFooter: ({ onPlans }: { onPlans?: boolean }) => <p data-testid="pie-publico" data-on-plans={String(onPlans)} /> }));
vi.mock("@/app/planes/screen", () => ({ PlansScreen: () => <p>planes</p> }));

import PlansPage from "@/app/planes/page";

const LESSON = "/cursos/uno/lecciones/a0000000-0000-4000-8000-000000000001";
const NOT_FOR_SALE = { kind: "ready", offer: { plans: [], recurring: null, refundPolicy: null, refundDays: null } };
const page = async (search: Record<string, string>) => render(await PlansPage({ searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planStanding.mockResolvedValue({ kind: "ready", access: false, blocking: false, open: null });
});

const BARS = ["barra-publica", "barra-alumno", "barra-logotipo"] as const;
const SALE = {
  kind: "ready",
  offer: {
    plans: [{ plan: "monthly", amountCents: 34900, lookupKey: "x", nextChargeAt: "2026-12-10T18:00:00Z" }],
    recurring: { id: "11111111-2222-4333-8444-555555555555", version: 1, title: "Cobro recurrente", body: "…" },
    refundPolicy: null,
    refundDays: null,
  },
};

describe("PA-04, una sola barra arriba en cada caso (T-616, solicitud 4: el logotipo en toda página)", () => {
  const STUDENT = { kind: "student", claims: { userId: "a0000000-0000-4000-8000-000000000001" } };
  const cases = [
    ["al visitante, la pública", { kind: "visitor" }, SALE, "barra-publica"],
    ["a la alumna, la suya", STUDENT, SALE, "barra-alumno"],
    ["a quien no se sabe quién es, solo el logotipo", { kind: "unknown" }, SALE, "barra-logotipo"],
    ["si la oferta no se pudo leer, solo el logotipo", { kind: "visitor" }, { kind: "unavailable" }, "barra-logotipo"],
    ["si la oferta no se pudo leer, también a la alumna", STUDENT, { kind: "unavailable" }, "barra-logotipo"],
  ] as const;
  for (const [name, who, offer, bar] of cases) {
    it(name, async () => {
      mocks.publicViewer.mockResolvedValue(who);
      mocks.planOffer.mockResolvedValue(offer);
      await page({});
      expect(BARS.filter((each) => screen.queryAllByTestId(each).length > 0)).toEqual([bar]);
      expect(screen.getAllByTestId(bar)).toHaveLength(1);
    });
  }
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
    // En el teléfono «Planes» de la barra no se ve: el del pie lo marca.
    expect(screen.getByTestId("pie-publico")).toHaveAttribute("data-on-plans", "true");
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
