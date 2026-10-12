import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La pantalla de la cuenta (PA-25) y su página, con la guarda, los servicios y la acción
// simulados: qué pinta con cada respuesta. Lo que la acción hace de verdad lo prueban su
// tabla (`outcomes.test.ts`), `tests/actions/` y las pruebas de extremo a extremo.

const mocks = vi.hoisted(() => ({
  changeNameAction: vi.fn(),
  signOutAction: vi.fn(),
  requireSession: vi.fn(),
  cookieReader: vi.fn(),
  accountProfile: vi.fn(),
  sessionEmail: vi.fn(),
}));
vi.mock("@/app/(cuenta)/cuenta/actions", () => ({ changeNameAction: mocks.changeNameAction }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: mocks.signOutAction }));
vi.mock("@/app/_lib/guard", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", () => ({ accountProfile: mocks.accountProfile, sessionEmail: mocks.sessionEmail }));

import type { NameState } from "@/app/(cuenta)/cuenta/outcomes";
import AccountPage from "@/app/(cuenta)/cuenta/page";
import { AccountScreen } from "@/app/(cuenta)/cuenta/screen";

import { a11yViolations } from "../setup/a11y";

const reader = { get: () => undefined };
const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieReader.mockResolvedValue(reader);
});

const nameField = () => screen.getByRole("textbox", { name: "Nombre" });
const saveButton = () => screen.getByRole("button", { name: "Guardar" });
// El aviso de que quedó guardado se busca por su texto y no por su papel: el botón lleva
// siempre su propia región viva, vacía mientras no hay nada en camino.
const savedNotice = () => screen.queryByText("Guardado.");

/** Pinta la pantalla, escribe ese nombre y guarda, con la acción contestando `state`. */
async function saveName(typed: string, state: NameState) {
  mocks.changeNameAction.mockResolvedValue(state);
  const user = userEvent.setup();
  const view = render(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" />);
  await user.clear(nameField());
  if (typed !== "") await user.type(nameField(), typed);
  await user.click(saveButton());
  return { user, ...view };
}

describe("la pantalla de la cuenta (PA-25)", () => {
  it("en reposo: el nombre guardado en su campo, el correo a la vista y sin nada que anunciar", async () => {
    const { container } = render(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cuenta");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Nombre", "Correo"]);
    expect(nameField()).toHaveValue("Ana de Prueba");
    expect(nameField()).toHaveAttribute("autocomplete", "name");
    // Cada bloque es una región con el nombre de su título.
    expect(within(screen.getByRole("region", { name: "Correo" })).getByText("ana@prueba.test")).toBeVisible();
    expect(screen.getByText("Por ahora no se puede cambiar desde aquí.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/inicio");
    expect(savedNotice()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("el correo no se puede escribir: no hay campo para él", () => {
    render(<AccountScreen name="Ana" email="ana@prueba.test" />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("sin correo en el token no inventa uno, y la nota sigue", () => {
    render(<AccountScreen name="Ana" email={null} />);
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    expect(screen.getByText("Por ahora no se puede cambiar desde aquí.")).toBeVisible();
  });

  it("sin JavaScript se pinta entera: el formulario es un formulario, con su campo lleno", () => {
    const html = renderToString(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" />);
    expect(html).toContain('name="name"');
    expect(html).toContain('value="Ana de Prueba"');
    expect(html).toContain("ana@prueba.test");
  });

  it("manda a la acción el nombre y nada más", async () => {
    await saveName("Beatriz", { kind: "saved", name: "Beatriz", attempt: 1 });
    expect(mocks.changeNameAction).toHaveBeenCalledOnce();
    const form = mocks.changeNameAction.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(form)).toEqual({ name: "Beatriz" });
  });

  it("guardado: lo anuncia junto al botón y el campo queda con el nombre como se guardó", async () => {
    const { container } = await saveName("  Beatriz  ", { kind: "saved", name: "Beatriz", attempt: 1 });
    const saved = await screen.findByText("Guardado.");
    // Un aviso, no una alerta: espera su turno, no interrumpe.
    expect(saved.closest('[role="status"]')).toHaveTextContent("Listo: Guardado.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nameField()).toHaveValue("Beatriz");
    expect(nameField()).not.toBeInvalid();
    expect(saveButton()).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    ["too_long", "Ese nombre es demasiado largo. Escribe uno más corto."],
    ["invalid", "Ese nombre tiene caracteres que no podemos guardar. Escríbelo de nuevo."],
    ["empty", "Escribe tu nombre."],
  ] as const)("el servicio no lo aceptó (%s): el campo marcado, lo escrito intacto y un resumen que enlaza al campo", async (problem, message) => {
    // Con un nombre que el navegador sí deja pasar: lo rechaza quien manda, el servicio.
    await saveName("Beatriz", { kind: "invalid", name: "Beatriz", problem, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: message })).toHaveAttribute("href", "#cuenta-nombre");
    expect(nameField()).toBeInvalid();
    expect(nameField()).toHaveValue("Beatriz");
    expect(savedNotice()).not.toBeInTheDocument();
  });

  it("no se supo: lo dice en una alerta y conserva lo escrito", async () => {
    await saveName("Beatriz", { kind: "unavailable", name: "Beatriz", attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(nameField()).toHaveValue("Beatriz");
    expect(nameField()).not.toBeInvalid();
  });

  it("cuenta suspendida: la pantalla es PA-35, con «Cerrar sesión» y sin formulario", async () => {
    await saveName("Beatriz", { kind: "suspended" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
  });

  it("un nombre vacío no se envía: se marca antes, y el servicio ni se entera", async () => {
    await saveName("", { kind: "saved", name: "x", attempt: 1 });
    expect(mocks.changeNameAction).not.toHaveBeenCalled();
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Escribe tu nombre." })).toHaveAttribute("href", "#cuenta-nombre");
    expect(nameField()).toBeInvalid();
  });

  it("después de guardar, un envío que el navegador detiene deja de decir «Guardado»", async () => {
    const { user } = await saveName("Beatriz", { kind: "saved", name: "Beatriz", attempt: 1 });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    await user.clear(nameField());
    await user.click(saveButton());
    expect(savedNotice()).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Escribe tu nombre.");
    expect(mocks.changeNameAction).toHaveBeenCalledOnce();
  });

  it("mientras un envío va en camino, lo que dijo el anterior deja de decirse", async () => {
    const { user } = await saveName("Beatriz", { kind: "saved", name: "Beatriz", attempt: 1 });
    expect(await screen.findByText("Guardado.")).toBeVisible();

    let finish: (state: NameState) => void = () => undefined;
    mocks.changeNameAction.mockReturnValue(new Promise<NameState>((resolve) => (finish = resolve)));
    await user.click(saveButton());
    expect(await screen.findByRole("button", { name: "Guardando…" })).toBeDisabled();
    expect(savedNotice()).not.toBeInTheDocument();

    // Y cuando contesta, se vuelve a decir. (Además, React no suelta las demás acciones
    // mientras una siga en camino: hay que terminarla.)
    await act(async () => {
      finish({ kind: "saved", name: "Beatriz", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    expect(saveButton()).toBeEnabled();
  });

  it("dos fallos seguidos dejan un solo aviso", async () => {
    const { user } = await saveName("Beatriz", { kind: "unavailable", name: "Beatriz", attempt: 1 });
    await screen.findByRole("alert");
    mocks.changeNameAction.mockResolvedValue({ kind: "unavailable", name: "Beatriz", attempt: 2 });
    await user.click(saveButton());
    await vi.waitFor(() => expect(mocks.changeNameAction).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByRole("alert")).toHaveLength(1);
  });

  it("guardar después de un fallo quita la alerta y anuncia que quedó", async () => {
    const { user } = await saveName("Beatriz", { kind: "unavailable", name: "Beatriz", attempt: 1 });
    await screen.findByRole("alert");
    mocks.changeNameAction.mockResolvedValue({ kind: "saved", name: "Beatriz", attempt: 2 });
    await user.click(saveButton());
    expect(await screen.findByText("Guardado.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("guardar con Intro desde el campo deja el foco en el campo, que se armó de nuevo", async () => {
    mocks.changeNameAction.mockResolvedValue({ kind: "saved", name: "Beatriz", attempt: 1 });
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} />);
    const before = nameField();
    await user.clear(before);
    await user.type(before, "Beatriz{Enter}");
    expect(await screen.findByText("Guardado.")).toBeVisible();
    expect(nameField()).not.toBe(before);
    expect(nameField()).toHaveFocus();
  });

  it("guardar desde el botón deja el foco en el botón", async () => {
    await saveName("Beatriz", { kind: "saved", name: "Beatriz", attempt: 1 });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    expect(saveButton()).toHaveFocus();
  });

  it("si el servicio no lo aceptó, el foco es del resumen de errores y nadie se lo quita", async () => {
    mocks.changeNameAction.mockResolvedValue({ kind: "invalid", name: "Beatriz", problem: "invalid", attempt: 1 });
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} />);
    await user.clear(nameField());
    await user.type(nameField(), "Beatriz{Enter}");
    expect(await screen.findByRole("alert")).toHaveFocus();
  });

  // A dónde vuelve el formulario sin JavaScript (a esta pantalla, en su bloque) no se ve
  // aquí: React solo lo escribe para una acción de servidor de verdad. Lo prueba el extremo
  // a extremo. Aquí, que el bloque tenga el ancla a la que vuelve.
  it("el bloque del nombre lleva su ancla", () => {
    render(<AccountScreen name="Ana" email={null} />);
    expect(screen.getByRole("region", { name: "Nombre" })).toHaveAttribute("id", "bloque-nombre");
  });

  it("al salir del campo, un nombre que no se puede guardar se marca; uno vacío, no", async () => {
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} />);
    await user.clear(nameField());
    await user.tab();
    expect(nameField()).not.toBeInvalid();
    await user.type(nameField(), "...");
    await user.tab();
    await vi.waitFor(() => expect(nameField()).toBeInvalid());
    expect(screen.getByText("Ese nombre tiene caracteres que no podemos guardar. Escríbelo de nuevo.")).toBeVisible();
  });
});

describe("la página de la cuenta", () => {
  it("le pide a la guarda una sesión para su propia ruta, y lee el perfil con las claims que ella dio", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.accountProfile.mockResolvedValue({ kind: "ready", name: "Ana de Prueba" });
    mocks.sessionEmail.mockResolvedValue("ana@prueba.test");
    render(await AccountPage());
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/cuenta");
    expect(mocks.accountProfile).toHaveBeenCalledExactlyOnceWith(claims);
    expect(mocks.sessionEmail).toHaveBeenCalledExactlyOnceWith(reader);
    expect(nameField()).toHaveValue("Ana de Prueba");
    expect(screen.getByText("ana@prueba.test")).toBeVisible();
  });

  it("a una cuenta suspendida no le pinta nada suyo: ve PA-35, y ni se lee el perfil", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "suspended" });
    render(await AccountPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocks.accountProfile).not.toHaveBeenCalled();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });

  it("cuando no se supo si la sesión vale, tampoco: ofrece reintentar ahí mismo", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "unavailable" });
    render(await AccountPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/cuenta");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocks.accountProfile).not.toHaveBeenCalled();
  });

  it("si el perfil no se pudo leer, no pinta un formulario vacío: ofrece reintentar", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.accountProfile.mockResolvedValue({ kind: "unavailable" });
    render(await AccountPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/cuenta");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });
});
