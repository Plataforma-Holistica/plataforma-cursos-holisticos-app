import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Las páginas del equipo (PA-12, PA-60 mínimo, PA-88), con la guarda y los servicios
// simulados: qué pinta cada una con cada respuesta. La tabla de la guarda (quién redirige a
// dónde, y a quién se le contesta que la ruta no existe) está en
// src/app/_lib/guard-steps.test.ts; aquí se cuida que cada página obedezca lo que no es una
// redirección, que es justo lo que los tipos no ven.

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireSecondFactor: vi.fn(),
  requireFactorSetup: vi.fn(),
  cookieReader: vi.fn(),
  sessionEmail: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({
  requireAdmin: mocks.requireAdmin,
  requireSecondFactor: mocks.requireSecondFactor,
  requireFactorSetup: mocks.requireFactorSetup,
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", () => ({ sessionEmail: mocks.sessionEmail }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/(cuenta)/entrar/segundo-factor/actions", () => ({ giveCodeAction: vi.fn() }));
vi.mock("@/app/(cuenta)/entrar/segundo-factor/configurar/actions", () => ({
  startSecondFactorAction: vi.fn(),
  confirmSecondFactorAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));
// El comodín conoce todas las secciones: las de las prácticas, simuladas.
vi.mock("@/services/catalog/catalog", () => ({ catalogLists: vi.fn() }));
vi.mock("@/app/admin/_practicas/actions", () => ({ catalogCodeAction: vi.fn(), practicesAction: vi.fn(), levelsAction: vi.fn() }));

import FactorSetupPage from "@/app/(cuenta)/entrar/segundo-factor/configurar/page";
import SecondFactorPage from "@/app/(cuenta)/entrar/segundo-factor/page";
import AdminRestPage from "@/app/admin/[...resto]/page";
import { ForbiddenScreen } from "@/app/admin/_lib/states";
import AdminHomePage from "@/app/admin/page";

import { a11yViolations } from "../setup/a11y";

const reader = { get: () => undefined };
const claims = { userId: "u", aal: "aal2", sessionId: null, issuedAt: 0 };
const FACTOR = "22222222-2222-4222-8222-222222222222";
const query = (params: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(params) });
const rest = (...resto: string[]) => ({ params: Promise.resolve({ resto }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieReader.mockResolvedValue(reader);
  mocks.sessionEmail.mockResolvedValue("ana@prueba.test");
});

describe("el inicio de administración (PA-60, mínimo)", () => {
  it("le pide a la guarda del equipo su propia ruta, sin pedir ninguna capacidad", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["content"] });
    render(await AdminHomePage());
    expect(mocks.requireAdmin).toHaveBeenCalledExactlyOnceWith("/admin");
  });

  it("a quien es del equipo le dice con qué correo entró, que no tiene pendientes, y sus capacidades en palabras", async () => {
    // En el orden de siempre, no en el que las devuelva la base.
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["config", "content", "finance"] });
    const { container } = render(await AdminHomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Administración");
    expect(screen.getByText("Entraste como ana@prueba.test.")).toBeVisible();
    expect(screen.getByText("No tienes pendientes.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Tus capacidades");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Contenido", "Finanzas", "Configuración"]);
    expect(screen.getByRole("link", { name: "Cuenta" })).toHaveAttribute("href", "/cuenta");
    expect(screen.getByRole("button", { name: "Salir" })).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("a quien tiene configuración le ofrece la pantalla del equipo; a quien no, no", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["support", "config"] });
    const withConfig = render(await AdminHomePage());
    expect(screen.getByRole("link", { name: "Equipo de administración" })).toHaveAttribute("href", "/admin/equipo");
    withConfig.unmount();
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["support", "content", "finance", "moderation"] });
    render(await AdminHomePage());
    expect(screen.queryByRole("link", { name: "Equipo de administración" })).not.toBeInTheDocument();
  });

  it("a quien tiene Contenido le ofrece las prácticas y los niveles; a quien no, no", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["support", "content"] });
    const withContent = render(await AdminHomePage());
    expect(screen.getByRole("link", { name: "Prácticas y niveles" })).toHaveAttribute("href", "/admin/practicas");
    withContent.unmount();
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["support", "config", "finance", "moderation"] });
    render(await AdminHomePage());
    expect(screen.queryByRole("link", { name: "Prácticas y niveles" })).not.toBeInTheDocument();
  });

  it("una capacidad que el catálogo no sabe nombrar no se pinta a medias", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["support", "otra_cosa"] });
    render(await AdminHomePage());
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Soporte"]);
  });

  it("a una cuenta suspendida no le pinta administración: ve PA-35, con «Cerrar sesión»", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "suspended" });
    render(await AdminHomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByText("No tienes pendientes.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Entraste como/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });

  it("cuando no se supo, tampoco: ofrece reintentar ahí mismo, y no dice nada del equipo", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "unavailable" });
    render(await AdminHomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Algo falló de nuestro lado");
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin");
    expect(screen.queryByText("Tus capacidades")).not.toBeInTheDocument();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });

  it("si la guarda dijera que falta una capacidad, pinta PA-88 y no la pantalla", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "forbidden", capability: "config" });
    render(await AdminHomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Esta sección pide la capacidad de Configuración");
    expect(screen.queryByText("No tienes pendientes.")).not.toBeInTheDocument();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });
});

describe("lo que cuelga de administración y no tiene página", () => {
  it("corre la guarda del equipo con la ruta que se pidió, y a quien sí es del equipo le dice que no existe", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["config"] });
    await expect(AdminRestPage(rest("equipo", "invitar"))).rejects.toThrow("no encontrado");
    // Ahí no hay ninguna sección: no se pide ninguna capacidad.
    expect(mocks.requireAdmin).toHaveBeenCalledExactlyOnceWith("/admin/equipo/invitar", undefined);
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("la guarda va primero: si redirige o dice que no existe, la página no llega a decidir nada", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("redirige a /entrar"));
    await expect(AdminRestPage(rest("equipo"))).rejects.toThrow("redirige a /entrar");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("a una cuenta suspendida le pinta PA-35, igual que en una ruta de administración que sí existe", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "suspended" });
    render(await AdminRestPage(rest("equipo")));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("cuando no se supo pinta lo mismo que una ruta que sí existe, y reintenta en la ruta pedida", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "unavailable" });
    render(await AdminRestPage(rest("equipo", "invitar")));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Algo falló de nuestro lado");
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin/equipo/invitar");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each<[string[]]>([[["..", "entrar"]], [["%2e%2e"]], [["a b"]], [["", "otro.example"]], [["javascript:alert(1)"]], [["x", "..", ".."]]])(
    "una ruta que no vale como destino (%j) no se usa para reintentar: va a administración",
    async (segments) => {
      mocks.requireAdmin.mockResolvedValue({ kind: "unavailable" });
      render(await AdminRestPage(rest(...segments)));
      expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/admin");
    },
  );
});

describe("sin permiso (PA-88)", () => {
  it.each([
    ["content", "Contenido"],
    ["finance", "Finanzas"],
    ["moderation", "Moderación"],
    ["support", "Soporte"],
    ["config", "Configuración"],
  ] as const)("dice qué capacidad falta (%s) y quién la asigna, sin nombres, con la salida a administración", async (capability, name) => {
    const { container } = render(<ForbiddenScreen capability={capability} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(`Esta sección pide la capacidad de ${name}`);
    expect(screen.getByText("La asigna quien tiene configuración.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Ir al inicio de administración" })).toHaveAttribute("href", "/admin");
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("la página de dar el código (PA-12, pedir)", () => {
  it("le pasa a la guarda el destino guardado tal como llegó, y pinta el formulario con él", async () => {
    mocks.requireSecondFactor.mockResolvedValue({ kind: "render", view: "code" });
    const { container } = render(await SecondFactorPage(query({ volver: "/admin/equipo" })));
    expect(mocks.requireSecondFactor).toHaveBeenCalledExactlyOnceWith("/admin/equipo");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Escribe tu código");
    expect(container.querySelector('input[type="hidden"][name="volver"]')).toHaveValue("/admin/equipo");
  });

  it.each([[{}], [{ volver: ["/admin", "/cuenta"] }], [{ otro: "/admin" }]])("sin un destino, o con uno repetido (%j), no hay destino", async (params) => {
    mocks.requireSecondFactor.mockResolvedValue({ kind: "render", view: "code" });
    const { container } = render(await SecondFactorPage(query(params)));
    expect(mocks.requireSecondFactor).toHaveBeenCalledExactlyOnceWith("");
    expect(container.querySelector('input[type="hidden"][name="volver"]')).toHaveValue("");
  });

  it("a quien perdió su atadura le explica, en vez de pedirle un código que no tiene", async () => {
    mocks.requireSecondFactor.mockResolvedValue({ kind: "render", view: "unbound" });
    render(await SecondFactorPage(query({})));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu segundo factor ya no está");
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
  });

  it("a una cuenta suspendida le pinta PA-35, sin formulario", async () => {
    mocks.requireSecondFactor.mockResolvedValue({ kind: "suspended" });
    render(await SecondFactorPage(query({})));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
  });

  it("cuando no se supo ofrece reintentar ahí mismo, conservando el destino si vale", async () => {
    mocks.requireSecondFactor.mockResolvedValue({ kind: "unavailable" });
    render(await SecondFactorPage(query({ volver: "/admin/equipo" })));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/entrar/segundo-factor?volver=%2Fadmin%2Fequipo");
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
  });

  it("un destino que no vale no llega al enlace de reintentar", async () => {
    mocks.requireSecondFactor.mockResolvedValue({ kind: "unavailable" });
    render(await SecondFactorPage(query({ volver: "//otro.example" })));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/entrar/segundo-factor");
  });
});

describe("la página de configurar el segundo factor (PA-12, configurar)", () => {
  it("pinta lo que la guarda dijo: empezar", async () => {
    mocks.requireFactorSetup.mockResolvedValue({ kind: "render", view: "start", handoff: false });
    render(await FactorSetupPage());
    expect(mocks.requireFactorSetup).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Configura tu segundo factor");
    expect(screen.getByRole("button", { name: "Empezar" })).toBeVisible();
  });

  it("pinta lo que la guarda dijo: probar el buzón", async () => {
    mocks.requireFactorSetup.mockResolvedValue({ kind: "render", view: "prove_mailbox" });
    render(await FactorSetupPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Primero abre el enlace de tu correo");
    expect(screen.queryByRole("button", { name: "Empezar" })).not.toBeInTheDocument();
  });

  it("pinta lo que la guarda dijo: seguir con el factor que ese navegador ya empezó, sin clave", async () => {
    mocks.requireFactorSetup.mockResolvedValue({ kind: "render", view: "resume", painted: FACTOR, handoff: true });
    const { container } = render(await FactorSetupPage());
    expect(container.querySelector('input[type="hidden"][name="painted"]')).toHaveValue(FACTOR);
    expect(screen.getByLabelText("Código que te dictaron")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("a una cuenta suspendida le pinta PA-35, y cuando no se supo ofrece reintentar ahí mismo", async () => {
    mocks.requireFactorSetup.mockResolvedValue({ kind: "suspended" });
    const suspended = render(await FactorSetupPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    suspended.unmount();

    mocks.requireFactorSetup.mockResolvedValue({ kind: "unavailable" });
    render(await FactorSetupPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/entrar/segundo-factor/configurar");
    expect(screen.queryByRole("button", { name: "Empezar" })).not.toBeInTheDocument();
  });
});
