import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
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
  teacherStanding: vi.fn(() => Promise.resolve({ kind: "teacher", claims: {}, standing: { state: "none" } })),
  billingQueueCount: vi.fn((): Promise<{ kind: string; count?: number }> => Promise.resolve({ kind: "none" })),
  navAccess: vi.fn(() => Promise.resolve({ admin: true, portal: false })),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
// El menú de administración (T-616): a quien no es maestro, sin «Mi portal».
vi.mock("@/services/account/nav", () => ({ navAccess: mocks.navAccess }));
vi.mock("@/app/_lib/guard", () => ({
  requireAdmin: mocks.requireAdmin,
  requireSecondFactor: mocks.requireSecondFactor,
  requireFactorSetup: mocks.requireFactorSetup,
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", () => ({ sessionEmail: mocks.sessionEmail }));
vi.mock("@/services/teachers/teachers", () => ({ teacherStanding: mocks.teacherStanding }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("@/app/(cuenta)/entrar/segundo-factor/actions", () => ({ giveCodeAction: vi.fn() }));
vi.mock("@/app/(cuenta)/entrar/segundo-factor/configurar/actions", () => ({
  startSecondFactorAction: vi.fn(),
  confirmSecondFactorAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));
// El comodín conoce todas las secciones: las de las prácticas, simuladas.
vi.mock("@/services/catalog/catalog", () => ({ catalogLists: vi.fn() }));
vi.mock("@/services/teachers/teacher-admin", () => ({ teacherRoster: vi.fn() }));
vi.mock("@/app/admin/_practicas/actions", () => ({ catalogCodeAction: vi.fn(), practicesAction: vi.fn(), levelsAction: vi.fn() }));
vi.mock("@/app/admin/_revision/actions", () => ({ reviewCodeAction: vi.fn(), approveAction: vi.fn(), lessonVideoAction: vi.fn() }));
vi.mock("@/services/review/review", () => ({ reviewQueue: vi.fn() }));
vi.mock("@/app/admin/_avisos/actions", () => ({ billingCodeAction: vi.fn(), billingEventsAction: vi.fn() }));
vi.mock("@/services/billing/billing", () => ({ billingQueue: vi.fn(), billingQueueCount: mocks.billingQueueCount }));
vi.mock("@/app/admin/_alertas/actions", () => ({ alertsCodeAction: vi.fn(), alertsAction: vi.fn() }));
vi.mock("@/services/anomalies/anomalies", () => ({ anomalyAlerts: vi.fn() }));
vi.mock("@/services/periods/periods", () => ({ financePeriods: vi.fn(), financePeriod: vi.fn(), financeClose: vi.fn() }));
vi.mock("@/services/legal/legal-admin", () => ({ legalDocuments: vi.fn(), legalVersion: vi.fn(), legalBlocks: vi.fn(() => []) }));

import FactorSetupPage from "@/app/(cuenta)/entrar/segundo-factor/configurar/page";
import SecondFactorPage from "@/app/(cuenta)/entrar/segundo-factor/page";
import AdminRestPage from "@/app/admin/[...resto]/page";
import { AdminFrame, adminEntryOf } from "@/app/admin/_lib/frame";
import { ForbiddenScreen } from "@/app/admin/_lib/states";
import AdminHomePage from "@/app/admin/page";

import { a11yViolations } from "../setup/a11y";

const reader = { get: () => undefined };
const claims = { userId: "u", aal: "aal2", sessionId: null, issuedAt: 0 };
const FACTOR = "22222222-2222-4222-8222-222222222222";
const query = (params: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(params) });
const rest = (...resto: string[]) => ({ params: Promise.resolve({ resto }) });
/** Las direcciones del menú, sin repetir: va dos veces (la hoja del teléfono y la columna), y el logotipo también lleva al inicio. */
const menuOf = (nav: ReturnType<typeof within>) => [...new Set(nav.getAllByRole("link").map((link: HTMLElement) => link.getAttribute("href")))];

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

  it.each([
    ["invited", true],
    ["invited_unproven", true],
    ["none", false],
    ["active", false],
  ])("quien es del equipo y su estado de maestro es %s: ¿ve el enlace a su invitación? %s", async (state, shown) => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["content"] });
    mocks.teacherStanding.mockResolvedValueOnce({ kind: "teacher", claims: {}, standing: { state } });
    render(await AdminHomePage());
    expect(screen.queryAllByRole("link", { name: /invitación/ }).length > 0).toBe(shown);
  });

  it("a quien es del equipo le dice con qué correo entró, que no tiene pendientes, y sus capacidades en palabras", async () => {
    // En el orden de siempre, no en el que las devuelva la base.
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["config", "content", "finance"] });
    const { container } = render(await AdminHomePage());
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("heading", { level: 1 })).toHaveTextContent("Administración");
    expect(main.getByText("Entraste como ana@prueba.test.")).toBeVisible();
    expect(main.getByText("No tienes pendientes.")).toBeVisible();
    expect(main.getByRole("heading", { level: 2 })).toHaveTextContent("Tus capacidades");
    expect(main.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Contenido", "Finanzas", "Configuración"]);
    // Los enlaces de antes se fueron al menú (T-614, parte 6).
    expect(main.queryAllByRole("link")).toHaveLength(0);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el menú lleva el logotipo, el inicio marcado, los grupos de sus capacidades, la cuenta y la salida", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["finance", "content", "moderation"] });
    render(await AdminHomePage());
    const nav = within(screen.getByRole("navigation", { name: "Administración" }));
    // «Ir a mi inicio» va arriba, después del logotipo (T-616: al pie no se encontraba).
    expect(menuOf(nav)).toEqual(["/admin", "/inicio", "/admin/revision", "/admin/maestros", "/admin/practicas", "/admin/periodos", "/admin/avisos-cobro", "/admin/alertas", "/cuenta"]);
    // Un grupo por capacidad con pantallas, con su nombre: moderación todavía no tiene ninguna. Cada
    // cosa va dos veces: en la hoja del teléfono (cerrada) y en la columna.
    expect(nav.getAllByRole("list", { name: "Contenido" })).toHaveLength(2);
    expect(nav.getAllByRole("list", { name: "Finanzas" })).toHaveLength(2);
    expect(nav.queryAllByRole("list", { name: "Moderación" })).toHaveLength(0);
    expect(nav.queryAllByRole("list", { name: "Configuración" })).toHaveLength(0);
    for (const link of nav.getAllByRole("link", { name: "Inicio" })) expect(link).toHaveAttribute("aria-current", "page");
    expect(nav.getAllByRole("link", { current: "page" })).toHaveLength(2);
    expect(nav.getAllByRole("button", { name: "Cerrar sesión" })).toHaveLength(2);
  });

  it.each<[string, string[], string[]]>([
    ["config", ["support", "config"], ["/admin/equipo", "/admin/textos-legales"]],
    ["content", ["support", "content"], ["/admin/revision", "/admin/maestros", "/admin/practicas"]],
    ["finance", ["finance"], ["/admin/periodos", "/admin/avisos-cobro", "/admin/alertas"]],
    ["ninguna con pantallas", ["support", "moderation"], []],
  ])("con %s, el menú ofrece solo sus secciones", async (_, capabilities, sections) => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities });
    render(await AdminHomePage());
    const nav = within(screen.getByRole("navigation", { name: "Administración" }));
    expect(menuOf(nav)).toEqual(["/admin", "/inicio", ...sections, "/cuenta"]);
  });

  // T-616, solicitud 2: quien también es maestro vuelve a su portal desde el menú. La misma lectura que el enlace
  // a la invitación: ninguna de más.
  it.each([
    ["active", true],
    ["needs_notice", true],
    ["suspended", true],
    ["none", false],
    ["invited", false],
    ["invited_unproven", false],
  ] as const)("con el estado de maestro %s, ¿«Mi portal» en el menú? %s", async (state, shown) => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["finance"] });
    mocks.teacherStanding.mockResolvedValueOnce({ kind: "teacher", claims: {}, standing: { state } });
    render(await AdminHomePage());
    const nav = within(screen.getByRole("navigation", { name: "Administración" }));
    expect(nav.queryAllByRole("link", { name: "Mi portal" })).toHaveLength(shown ? 2 : 0);
    if (shown) expect(menuOf(nav).slice(0, 3)).toEqual(["/admin", "/inicio", "/portal"]);
    expect(mocks.teacherStanding).toHaveBeenCalledTimes(1);
  });

  it("con finanzas, la tarjeta de los avisos de cobro dice cuántos fallaron y lleva a la cola; con alguno, ya no dice que no hay pendientes", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["finance"] });
    mocks.billingQueueCount.mockResolvedValueOnce({ kind: "count", count: 3 });
    const { container } = render(await AdminHomePage());
    const main = within(screen.getByRole("main"));
    expect(mocks.billingQueueCount).toHaveBeenCalledWith(claims, ["finance"]);
    expect(main.getByText("Avisos de cobro sin procesar")).toBeVisible();
    expect(main.getByText("3")).toBeVisible();
    expect(main.getByRole("link", { name: "Ver los avisos de cobro" })).toHaveAttribute("href", "/admin/avisos-cobro");
    expect(main.queryByText("No tienes pendientes.")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin ninguno fallido sigue sin pendientes; si no se pudo leer, lo dice y no promete nada", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["finance"] });
    mocks.billingQueueCount.mockResolvedValueOnce({ kind: "count", count: 0 });
    const { unmount } = render(await AdminHomePage());
    expect(screen.getByText("No tienes pendientes.")).toBeVisible();
    expect(screen.getByText("0")).toBeVisible();
    unmount();
    mocks.billingQueueCount.mockResolvedValueOnce({ kind: "unavailable" });
    render(await AdminHomePage());
    expect(screen.getByText("No se pudo leer cuántos hay.")).toBeVisible();
    expect(screen.queryByText("No tienes pendientes.")).not.toBeInTheDocument();
  });

  it("una capacidad que el catálogo no sabe nombrar no se pinta a medias", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["support", "otra_cosa"] });
    render(await AdminHomePage());
    expect(within(screen.getByRole("main")).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Soporte"]);
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

describe("el marco de las secciones (T-614, parte 6)", () => {
  it("el comodín pinta la sección dentro del marco, con la ruta pedida y las capacidades que dio la guarda", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["finance", "content"] });
    const answer = (await AdminRestPage(rest("periodos", "2027-10", "cierre"))) as ReactElement<{ path: string; capabilities: string[]; children: ReactElement }>;
    expect(answer.type).toBe(AdminFrame);
    expect(answer.props.path).toBe("/admin/periodos/2027-10/cierre");
    expect(answer.props.capabilities).toEqual(["finance", "content"]);
    expect((answer.props.children.type as { name: string }).name).toBe("CloseSection");
    expect(answer.props).toMatchObject({ portal: false });
  });

  it.each([true, false])("el comodín le pasa al marco si también es maestro (%s), leído con las claims de la guarda (T-616)", async (portal) => {
    mocks.requireAdmin.mockResolvedValue({ kind: "render", claims, capabilities: ["finance"] });
    mocks.navAccess.mockResolvedValueOnce({ admin: true, portal });
    const answer = (await AdminRestPage(rest("periodos"))) as ReactElement<{ portal: boolean }>;
    expect(answer.props.portal).toBe(portal);
    expect(mocks.navAccess).toHaveBeenCalledWith(claims);
  });

  it("si la guarda no deja pasar, el comodín no pregunta por los accesos", async () => {
    mocks.requireAdmin.mockResolvedValue({ kind: "unavailable" });
    render(await AdminRestPage(rest("periodos")));
    expect(mocks.navAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["/admin", "/admin"],
    ["/admin/equipo", "/admin/equipo"],
    ["/admin/periodos/2027-10", "/admin/periodos"],
    ["/admin/periodos/2027-10/liquidaciones", "/admin/periodos"],
    ["/admin/maestros/a0000000-0000-4000-8000-000000000001", "/admin/maestros"],
  ])("en %s se marca %s", (path, entry) => {
    expect(adminEntryOf(path)).toBe(entry);
  });

  it("marca la entrada de la sección, también desde lo que cuelga de ella", () => {
    render(
      <AdminFrame path="/admin/periodos/2027-10" capabilities={["finance"]} portal={false}>
        <main>contenido</main>
      </AdminFrame>,
    );
    const nav = within(screen.getByRole("navigation", { name: "Administración" }));
    for (const link of nav.getAllByRole("link", { current: "page" })) expect(link).toHaveAttribute("href", "/admin/periodos");
    expect(nav.getAllByRole("link", { current: "page" })).toHaveLength(2);
  });
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
