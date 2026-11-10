import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PA-32 (T-302), con la guarda y el servicio simulados: qué pinta con cada respuesta, que la espera es lo único que pregunta sola, que
// toda respuesta va dentro de una sola región de estado (así el lector anuncia «Listo» al llegar), y que la sesión de otra persona o una
// sin forma da lo mismo que una que no existe.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  checkoutProgress: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no existe");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/services/billing/checkout-service", () => ({ checkoutProgress: mocks.checkoutProgress, SESSION_ID: /^cs_(test|live)_[A-Za-z0-9]{1,250}$/ }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/suscripcion/confirmando" }));
vi.mock("@/app/_catalog/nav", () => ({ StudentNav: () => null }));
vi.mock("@/app/suscripcion/confirmando/poller", () => ({ ConfirmingPoller: () => <p>sondeo</p> }));

import ConfirmingPage from "@/app/suscripcion/confirmando/page";

const CLAIMS = { userId: "u" };
const page = async (sesion: string | undefined = "cs_test_1") => render(await ConfirmingPage({ searchParams: Promise.resolve(sesion === undefined ? {} : { sesion }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ kind: "render", claims: CLAIMS });
});

describe("PA-32", () => {
  it("esperando: solo ahí se pregunta sola, dentro de la región de estado", async () => {
    mocks.checkoutProgress.mockResolvedValue({ kind: "waiting", returnTo: "/inicio" });
    await page();
    expect(screen.getByRole("status")).toHaveTextContent("sondeo");
    expect(mocks.checkoutProgress).toHaveBeenCalledWith(CLAIMS, "cs_test_1");
  });

  it("con el aviso: «Listo» y su destino, en la misma región", async () => {
    mocks.checkoutProgress.mockResolvedValue({ kind: "live", returnTo: "/cursos/uno" });
    await page();
    expect(screen.getByRole("status")).toContainElement(screen.getByRole("heading", { name: "Listo. Ya tienes acceso." }));
    expect(screen.getByRole("link", { name: "Continuar" })).toHaveAttribute("href", "/cursos/uno");
    expect(screen.queryByText("sondeo")).not.toBeInTheDocument();
  });

  it("si Stripe dice que no se pagó: lo dice, sin preguntar sola, y vuelve a los planes", async () => {
    mocks.checkoutProgress.mockResolvedValue({ kind: "not_paid" });
    await page();
    expect(screen.getByRole("heading", { name: "Todavía no se completó el pago" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a los planes" })).toHaveAttribute("href", "/planes");
    expect(screen.queryByText("sondeo")).not.toBeInTheDocument();
  });

  it("si venció: no hubo cobro, y vuelve a los planes", async () => {
    mocks.checkoutProgress.mockResolvedValue({ kind: "expired" });
    await page();
    expect(screen.getByRole("heading", { name: "El pago no se completó" })).toBeInTheDocument();
    expect(screen.queryByText("sondeo")).not.toBeInTheDocument();
  });

  it("si no se supo: que no vuelva a pagar, con «Actualizar»", async () => {
    mocks.checkoutProgress.mockResolvedValue({ kind: "unavailable" });
    await page();
    expect(screen.getByText(/no vuelvas a pagar/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Actualizar" })).toHaveAttribute("href", "/suscripcion/confirmando?sesion=cs_test_1");
  });

  it("la de otra persona, y una sin forma, no existen; a una sin forma ni se le pregunta", async () => {
    mocks.checkoutProgress.mockResolvedValue({ kind: "not_found" });
    await expect(page()).rejects.toThrow("no existe");
    mocks.checkoutProgress.mockClear();
    await expect(page("sub_1")).rejects.toThrow("no existe");
    expect(mocks.checkoutProgress).not.toHaveBeenCalled();
  });
});
