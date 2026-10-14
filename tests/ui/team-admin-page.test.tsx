import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La página del equipo (PA-86), con la guarda y el servicio simulados: qué pinta con cada
// respuesta. La tabla de la guarda está en src/app/_lib/guard-steps.test.ts; aquí se cuida
// que la página obedezca lo que no es una redirección, y que no lea la lista antes de saber
// quién pide.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireAdmin: vi.fn(),
  cookieReader: vi.fn(),
  teamRoster: vi.fn(),
}));
vi.mock("@/app/_lib/guard", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", async () => {
  const real = await vi.importActual<typeof import("@/services/account/team-admin")>("@/services/account/team-admin");
  return { teamRoster: mocks.teamRoster, effectsKey: real.effectsKey, removalEffects: real.removalEffects, resetEffects: real.resetEffects };
});
vi.mock("@/app/admin/equipo/actions", () => ({
  freshCodeAction: vi.fn(),
  inviteAction: vi.fn(),
  teamAction: vi.fn(),
  invitationsAction: vi.fn(),
  resetAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import TeamPage from "@/app/admin/equipo/page";

import { a11yViolations } from "../setup/a11y";

const reader = { get: () => undefined };
const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: null, issuedAt: 0 };
const roster = (freshCode = true) => ({
  freshCode,
  members: [
    {
      profileId: claims.userId,
      email: "yo@prueba.test",
      displayName: null,
      status: "active",
      capabilities: ["config"],
      factor: "bound",
      rebind: "none",
      configRemovable: false,
      isSelf: true,
    },
  ],
  invitations: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order = [];
  mocks.cookieReader.mockResolvedValue(reader);
  mocks.requireAdmin.mockImplementation(() => {
    mocks.order.push("guarda");
    return Promise.resolve({ kind: "render", claims, capabilities: ["config"] });
  });
  mocks.teamRoster.mockImplementation(() => {
    mocks.order.push("lista");
    return Promise.resolve({ kind: "roster", roster: roster() });
  });
});

describe("la página del equipo (PA-86)", () => {
  it("le pide a la guarda su propia ruta y la capacidad de configuración, antes de leer nada", async () => {
    render(await TeamPage());
    expect(mocks.requireAdmin).toHaveBeenCalledExactlyOnceWith("/admin/equipo", "config");
    expect(mocks.order).toEqual(["guarda", "lista"]);
  });

  it("lee la lista con las claims que la guarda le dio", async () => {
    render(await TeamPage());
    expect(mocks.teamRoster).toHaveBeenCalledExactlyOnceWith(reader, claims);
  });

  it("a quien tiene configuración le pinta el equipo", async () => {
    const { container } = render(await TeamPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Equipo de administración");
    expect(screen.getByText("yo@prueba.test")).toBeVisible();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("si su código ya no es reciente, arriba se le pide: lo decide lo que la página leyó", async () => {
    mocks.teamRoster.mockResolvedValue({ kind: "roster", roster: roster(false) });
    render(await TeamPage());
    expect(screen.getByRole("heading", { level: 2, name: "Tu código" })).toBeVisible();
    expect(screen.getByLabelText("Código")).toBeVisible();
  });

  it("a una cuenta suspendida no le pinta el equipo ni lo lee: ve PA-35", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "suspended" });
    render(await TeamPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });

  it("cuando no se supo quién pide, tampoco: ofrece reintentar ahí mismo", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "unavailable" });
    render(await TeamPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin/equipo");
    expect(screen.queryByText("Equipo de administración")).not.toBeInTheDocument();
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });

  it("a alguien del equipo sin configuración le dice qué capacidad falta (PA-88), sin leer la lista", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "forbidden", capability: "config" });
    render(await TeamPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Esta sección pide la capacidad de Configuración");
    expect(screen.queryByText("Equipo de administración")).not.toBeInTheDocument();
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });

  it("si la lista no se pudo leer, no se pinta a medias: ofrece reintentar, y ahí decide la guarda", async () => {
    mocks.teamRoster.mockResolvedValue({ kind: "unavailable" });
    render(await TeamPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin/equipo");
    expect(screen.queryByText("Equipo de administración")).not.toBeInTheDocument();
  });
});
