import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La sección del equipo (PA-86), servida por el comodín de administración, con la guarda y
// el servicio simulados: qué pinta con cada respuesta. La tabla de la guarda está en
// src/app/_lib/guard-steps.test.ts; aquí se cuida que el comodín pida la capacidad de la
// sección, obedezca lo que no es una redirección, y no lea la lista antes de saber quién pide.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  requireAdmin: vi.fn(),
  cookieReader: vi.fn(),
  teamRoster: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", async () => {
  const real = await vi.importActual<typeof import("@/services/account/team-admin")>("@/services/account/team-admin");
  return { teamRoster: mocks.teamRoster, effectsKey: real.effectsKey, removalEffects: real.removalEffects, resetEffects: real.resetEffects };
});
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/admin/_equipo/actions", () => ({
  freshCodeAction: vi.fn(),
  inviteAction: vi.fn(),
  teamAction: vi.fn(),
  invitationsAction: vi.fn(),
  resetAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));
// El comodín conoce todas las secciones: las de las prácticas, simuladas (su página se
// prueba en catalog-admin-page.test.tsx).
vi.mock("@/services/catalog/catalog", () => ({ catalogLists: vi.fn() }));
vi.mock("@/app/admin/_practicas/actions", () => ({ catalogCodeAction: vi.fn(), practicesAction: vi.fn(), levelsAction: vi.fn() }));
vi.mock("@/app/admin/_revision/actions", () => ({ reviewCodeAction: vi.fn(), approveAction: vi.fn(), lessonVideoAction: vi.fn() }));
vi.mock("@/services/review/review", () => ({ reviewQueue: vi.fn() }));

import AdminRestPage from "@/app/admin/[...resto]/page";
import { TeamSection } from "@/app/admin/_equipo/section";
import { sectionAt } from "@/app/admin/_lib/sections";

import { a11yViolations } from "../setup/a11y";

const reader = { get: () => undefined };
const claims = { userId: "a0000000-0000-4000-8000-000000000001", aal: "aal2", sessionId: null, issuedAt: 0 };
/**
 * Lo que el comodín pinta en esa ruta. La sección es un componente asíncrono del servidor:
 * Next lo espera al servir la página, y aquí se espera a mano.
 */
async function at(...resto: string[]) {
  const page = (await AdminRestPage({ params: Promise.resolve({ resto }) })) as ReactElement<Parameters<typeof TeamSection>[0]>;
  return page.type === TeamSection ? TeamSection(page.props) : page;
}
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

describe("qué sección atiende cada ruta de administración", () => {
  it("el equipo pide la capacidad de configuración", () => {
    expect(sectionAt(["equipo"])?.capability).toBe("config");
  });

  it("las prácticas y los niveles piden Contenido", () => {
    expect(sectionAt(["practicas"])?.capability).toBe("content");
  });

  it.each<[string[]]>([[[]], [["otra"]], [["equipo", "invitar"]], [["Equipo"]], [["equipo", ""]], [["practicas", "niveles"]], [["Practicas"]], [["constructor"]], [["__proto__"]], [["toString"]]])(
    "en %j no hay ninguna: solo vale la ruta exacta de una sección de la tabla",
    (rest) => {
      expect(sectionAt(rest)).toBeNull();
    },
  );
});

describe("la sección del equipo (PA-86), servida por el comodín", () => {
  it("le pide a la guarda la ruta pedida y la capacidad de configuración, antes de leer nada", async () => {
    render(await at("equipo"));
    expect(mocks.requireAdmin).toHaveBeenCalledExactlyOnceWith("/admin/equipo", "config");
    expect(mocks.order).toEqual(["guarda", "lista"]);
  });

  it("lee la lista con las claims que la guarda le dio", async () => {
    render(await at("equipo"));
    expect(mocks.teamRoster).toHaveBeenCalledExactlyOnceWith(reader, claims);
  });

  it("a quien tiene configuración le pinta el equipo", async () => {
    const { container } = render(await at("equipo"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Equipo de administración");
    expect(screen.getByText("yo@prueba.test")).toBeVisible();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("si su código ya no es reciente, arriba se le pide: lo decide lo que se leyó de la base", async () => {
    mocks.teamRoster.mockResolvedValue({ kind: "roster", roster: roster(false) });
    render(await at("equipo"));
    expect(screen.getByRole("heading", { level: 2, name: "Tu código" })).toBeVisible();
    expect(screen.getByLabelText("Código")).toBeVisible();
  });

  it("la guarda va primero: si redirige o dice que no existe, no se lee la lista ni se pinta nada", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("no encontrado"));
    await expect(at("equipo")).rejects.toThrow("no encontrado");
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });

  it("a una cuenta suspendida no le pinta el equipo ni lo lee: ve PA-35", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "suspended" });
    render(await at("equipo"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });

  it("cuando no se supo quién pide, tampoco: ofrece reintentar ahí mismo", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "unavailable" });
    render(await at("equipo"));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin/equipo");
    expect(screen.queryByText("Equipo de administración")).not.toBeInTheDocument();
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });

  it("a alguien del equipo sin configuración le dice qué capacidad falta (PA-88), sin leer la lista", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "forbidden", capability: "config" });
    render(await at("equipo"));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Esta sección pide la capacidad de Configuración");
    expect(screen.queryByText("Equipo de administración")).not.toBeInTheDocument();
    expect(mocks.teamRoster).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("si la lista no se pudo leer, no se pinta a medias: ofrece reintentar, y ahí decide la guarda", async () => {
    mocks.teamRoster.mockResolvedValue({ kind: "unavailable" });
    render(await at("equipo"));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin/equipo");
    expect(screen.queryByText("Equipo de administración")).not.toBeInTheDocument();
  });

  it("lo que cuelga de la sección sin ser una sección no existe, ni pide su capacidad, ni lee la lista", async () => {
    await expect(at("equipo", "invitar")).rejects.toThrow("no encontrado");
    expect(mocks.requireAdmin).toHaveBeenCalledExactlyOnceWith("/admin/equipo/invitar", undefined);
    expect(mocks.teamRoster).not.toHaveBeenCalled();
  });
});
