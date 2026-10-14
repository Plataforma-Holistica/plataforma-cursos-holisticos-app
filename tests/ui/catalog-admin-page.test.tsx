import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La sección de las prácticas y los niveles (PA-67), servida por el comodín de
// administración, con la guarda y el servicio simulados: que el comodín pida Contenido, y que
// la sección no lea las listas antes de saber quién pide, y las lea con las claims de la
// guarda.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireAdmin: vi.fn(),
  catalogLists: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: vi.fn() }));
vi.mock("@/services/account/account", () => ({ teamRoster: vi.fn() }));
vi.mock("@/services/catalog/catalog", () => ({ catalogLists: mocks.catalogLists }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/admin/_equipo/actions", () => ({
  freshCodeAction: vi.fn(),
  inviteAction: vi.fn(),
  teamAction: vi.fn(),
  invitationsAction: vi.fn(),
  resetAction: vi.fn(),
}));
vi.mock("@/app/admin/_practicas/actions", () => ({ catalogCodeAction: vi.fn(), practicesAction: vi.fn(), levelsAction: vi.fn() }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import AdminRestPage from "@/app/admin/[...resto]/page";
import { CatalogSection } from "@/app/admin/_practicas/section";

import { a11yViolations } from "../setup/a11y";

const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: null, issuedAt: 0 };
async function at(...resto: string[]) {
  const page = (await AdminRestPage({ params: Promise.resolve({ resto }) })) as ReactElement<Parameters<typeof CatalogSection>[0]>;
  return page.type === CatalogSection ? CatalogSection(page.props) : page;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  mocks.requireAdmin.mockImplementation(() => {
    mocks.order.push("guarda");
    return Promise.resolve({ kind: "render", claims, capabilities: ["content"] });
  });
  mocks.catalogLists.mockImplementation(() => {
    mocks.order.push("listas");
    return Promise.resolve({ kind: "lists", lists: { freshCode: true, practices: [], levels: [] } });
  });
});

describe("la sección de las prácticas y los niveles (PA-67), servida por el comodín", () => {
  it("le pide a la guarda la ruta pedida y Contenido, antes de leer nada", async () => {
    render(await at("practicas"));
    expect(mocks.requireAdmin).toHaveBeenCalledExactlyOnceWith("/admin/practicas", "content");
    expect(mocks.order).toEqual(["guarda", "listas"]);
  });

  it("lee las listas con las claims que la guarda le dio", async () => {
    render(await at("practicas"));
    expect(mocks.catalogLists).toHaveBeenCalledExactlyOnceWith(claims);
  });

  it("a quien tiene Contenido le pinta las listas", async () => {
    const { container } = render(await at("practicas"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Prácticas y niveles");
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("a quien es del equipo sin Contenido, PA-88 con la capacidad que falta, sin leer nada", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "forbidden", capability: "content" });
    render(await at("practicas"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/permiso|capacidad/i);
    expect(screen.getByText(/Contenido/)).toBeVisible();
    expect(mocks.catalogLists).not.toHaveBeenCalled();
  });

  it("si las listas no se pudieron leer, «no se supo», con «Reintentar» a esta misma ruta", async () => {
    mocks.catalogLists.mockResolvedValue({ kind: "unavailable" });
    render(await at("practicas"));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin/practicas");
  });
});
