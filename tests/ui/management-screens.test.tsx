import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La pantalla de la cuenta (PA-25) y su página, con la guarda, los servicios y la acción
// simulados: qué pinta con cada respuesta. Lo que la acción hace de verdad lo prueban su
// tabla (`outcomes.test.ts`), `tests/actions/` y las pruebas de extremo a extremo.

const mocks = vi.hoisted(() => ({
  changeNameAction: vi.fn(),
  closeSessionsAction: vi.fn(),
  changePasswordAction: vi.fn(),
  accountSessions: vi.fn(),
  signOutAction: vi.fn(),
  requireSession: vi.fn(),
  cookieReader: vi.fn(),
  accountProfile: vi.fn(),
  accountSecondFactor: vi.fn(),
  sessionEmail: vi.fn(),
}));
vi.mock("@/app/(cuenta)/cuenta/actions", () => ({
  changeNameAction: mocks.changeNameAction,
  closeSessionsAction: mocks.closeSessionsAction,
  changePasswordAction: mocks.changePasswordAction,
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: mocks.signOutAction }));
vi.mock("@/app/_lib/guard", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", () => ({
  accountProfile: mocks.accountProfile,
  accountSessions: mocks.accountSessions,
  accountSecondFactor: mocks.accountSecondFactor,
  sessionEmail: mocks.sessionEmail,
}));

import type { NameState, PasswordState, SessionsState } from "@/app/(cuenta)/cuenta/outcomes";
import AccountPage from "@/app/(cuenta)/cuenta/page";
import type { SessionRow } from "@/app/(cuenta)/cuenta/rows";
import { AccountScreen } from "@/app/(cuenta)/cuenta/screen";

import { a11yViolations } from "../setup/a11y";

const reader = { get: () => undefined };
const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 };

const HERE = "5e560000-0000-0000-0000-000000000001";
const PHONE = "5e560000-0000-0000-0000-000000000002";
const OTHER = "5e560000-0000-0000-0000-000000000003";
const here: SessionRow = {
  id: HERE,
  device: "Chrome en Windows",
  opened: "Se abrió el 10 de octubre de 2026.",
  lastActive: "Última actividad: 12 de octubre de 2026.",
  current: true,
  closeDetail: "la sesión de Chrome en Windows, abierta el 10 de octubre de 2026",
};
const phone: SessionRow = {
  id: PHONE,
  device: "Safari en iPhone o iPad",
  opened: "Se abrió el 11 de octubre de 2026.",
  lastActive: "Última actividad: 11 de octubre de 2026.",
  current: false,
  closeDetail: "la sesión de Safari en iPhone o iPad, abierta el 11 de octubre de 2026",
};
const other: SessionRow = {
  id: OTHER,
  device: "Navegador desconocido",
  opened: null,
  lastActive: null,
  current: false,
  closeDetail: "Navegador desconocido",
};
/** Solo la sesión con la que se mira la pantalla: lo que ve casi todo el mundo. */
const ALONE = [here];

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
  const view = render(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" sessions={ALONE} />);
  await user.clear(nameField());
  if (typed !== "") await user.type(nameField(), typed);
  await user.click(saveButton());
  return { user, ...view };
}

describe("la pantalla de la cuenta (PA-25)", () => {
  it("en reposo: el nombre guardado en su campo, el correo a la vista y sin nada que anunciar", async () => {
    const { container } = render(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" sessions={ALONE} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cuenta");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Nombre",
      "Correo",
      "Contraseña",
      "Sesiones abiertas",
    ]);
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
    render(<AccountScreen name="Ana" email="ana@prueba.test" sessions={ALONE} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("sin correo en el token no inventa uno, y la nota sigue", () => {
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    expect(screen.getByText("Por ahora no se puede cambiar desde aquí.")).toBeVisible();
  });

  it("sin JavaScript se pinta entera: el formulario es un formulario, con su campo lleno", () => {
    const html = renderToString(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" sessions={ALONE} />);
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
    // Y el campo no se puede escribir: lo tecleado ahora se perdería al llegar la respuesta.
    expect(nameField()).toHaveAttribute("readonly");

    // Y cuando contesta, se vuelve a decir. (Además, React no suelta las demás acciones
    // mientras una siga en camino: hay que terminarla.)
    await act(async () => {
      finish({ kind: "saved", name: "Beatriz", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    expect(saveButton()).toBeEnabled();
    expect(nameField()).not.toHaveAttribute("readonly");
  });

  it("un envío nuevo tapa lo que el servicio había rechazado, aunque su respuesta no haya llegado", async () => {
    const { user } = await saveName("Beatriz", { kind: "invalid", name: "Beatriz", problem: "invalid", attempt: 1 });
    await screen.findByRole("alert");
    expect(nameField()).toBeInvalid();

    let finish: (state: NameState) => void = () => undefined;
    mocks.changeNameAction.mockReturnValue(new Promise<NameState>((resolve) => (finish = resolve)));
    await user.click(saveButton());
    expect(await screen.findByRole("button", { name: "Guardando…" })).toBeDisabled();
    // Manda lo último que pasó: el navegador revisó y envió, y el rechazo viejo ya no se pinta.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(nameField()).not.toBeInvalid();

    await act(async () => {
      finish({ kind: "saved", name: "Beatriz", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText("Guardado.")).toBeVisible();
  });

  // Lo escrito puede cambiar sin que esta pantalla se entere: antes de que React tome el
  // formulario, o porque lo llenó el navegador. Entonces lo que detiene el envío es la
  // revisión, y con algo por corregir «Guardado» tampoco se dice.
  it("con algo por corregir no se dice «Guardado», aunque el cambio no haya avisado", async () => {
    const { user } = await saveName("Beatriz", { kind: "saved", name: "Beatriz", attempt: 1 });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    (nameField() as HTMLInputElement).value = "";
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Escribe tu nombre.");
    expect(savedNotice()).not.toBeInTheDocument();
    expect(mocks.changeNameAction).toHaveBeenCalledOnce();
  });

  it("lo que dijo el último envío deja de decirse en cuanto lo escrito ya es otra cosa", async () => {
    const { user } = await saveName("Beatriz", { kind: "saved", name: "Beatriz", attempt: 1 });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    await user.type(nameField(), " de Prueba");
    expect(savedNotice()).not.toBeInTheDocument();

    // Al guardar de nuevo se vuelve a decir.
    mocks.changeNameAction.mockResolvedValue({ kind: "saved", name: "Beatriz de Prueba", attempt: 2 });
    await user.click(saveButton());
    expect(await screen.findByText("Guardado.")).toBeVisible();

    // Lo mismo con «no se supo».
    mocks.changeNameAction.mockResolvedValue({ kind: "unavailable", name: "Beatriz de Prueba", attempt: 3 });
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo.");
    await user.type(nameField(), "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
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
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    await user.clear(nameField());
    await user.type(nameField(), "Beatriz{Enter}");
    expect(await screen.findByRole("alert")).toHaveFocus();
  });

  // A dónde vuelve el formulario sin JavaScript (a esta pantalla, en su bloque) no se ve
  // aquí: React solo lo escribe para una acción de servidor de verdad. Lo prueba el extremo
  // a extremo. Aquí, que el bloque tenga el ancla a la que vuelve.
  it("el bloque del nombre lleva su ancla", () => {
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    expect(screen.getByRole("region", { name: "Nombre" })).toHaveAttribute("id", "bloque-nombre");
  });

  it("al salir del campo, un nombre que no se puede guardar se marca; uno vacío, no", async () => {
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    await user.clear(nameField());
    await user.tab();
    expect(nameField()).not.toBeInvalid();
    await user.type(nameField(), "...");
    await user.tab();
    await vi.waitFor(() => expect(nameField()).toBeInvalid());
    expect(screen.getByText("Ese nombre tiene caracteres que no podemos guardar. Escríbelo de nuevo.")).toBeVisible();
  });
});

const sessionsBlock = () => screen.getByRole("region", { name: "Sesiones abiertas" });
const closeOthers = () => within(sessionsBlock()).getByRole("button", { name: "Cerrar todas las demás" });
const closeButtonOf = (row: SessionRow) => within(sessionsBlock()).getByRole("button", { name: `Cerrar ${row.closeDetail}` });

/** Pinta la pantalla con esas sesiones, pulsa ese botón y espera, con la acción contestando `state`. */
async function closeWith(sessions: SessionRow[], press: () => HTMLElement, state: SessionsState) {
  mocks.closeSessionsAction.mockResolvedValue(state);
  const user = userEvent.setup();
  const view = render(<AccountScreen name="Ana" email={null} sessions={sessions} />);
  await user.click(press());
  return { user, ...view };
}

describe("el bloque de sesiones abiertas (PA-25)", () => {
  it("con solo esta sesión: la dice, sin botón para cerrarla, y dice que no hay otras", async () => {
    const { container } = render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    const rows = within(sessionsBlock()).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Chrome en Windows");
    expect(rows[0]).toHaveTextContent("Esta sesión");
    expect(within(sessionsBlock()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(sessionsBlock()).getByText("No tienes otras sesiones abiertas.")).toBeVisible();
    expect(sessionsBlock()).toHaveAttribute("id", "bloque-sesiones");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("con varias: cada una con lo suyo, un botón por cada una que no es esta, y «Cerrar todas las demás»", async () => {
    const { container } = render(<AccountScreen name="Ana" email={null} sessions={[here, phone, other]} />);
    const rows = within(sessionsBlock()).getAllByRole("listitem");
    expect(rows.map((row) => within(row).queryAllByRole("button").length)).toEqual([0, 1, 1]);
    expect(rows[1]).toHaveTextContent("Safari en iPhone o iPad");
    expect(rows[1]).toHaveTextContent("Se abrió el 11 de octubre de 2026.");
    // Cada botón dice cuál sesión cierra, también a quien no ve la fila.
    expect(closeButtonOf(phone)).toHaveAttribute("value", PHONE);
    expect(closeButtonOf(other)).toHaveAttribute("value", OTHER);
    expect(closeOthers()).toHaveAttribute("value", "others");
    expect(within(sessionsBlock()).queryByText("No tienes otras sesiones abiertas.")).not.toBeInTheDocument();
    // De una sesión de la que no se sabe la fecha no se inventa ninguna.
    expect(rows[2]).not.toHaveTextContent("Se abrió");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin JavaScript se pinta entero: un solo formulario, y cada botón lleva lo que cierra", () => {
    const html = renderToString(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    const painted = new DOMParser().parseFromString(html, "text/html");
    const buttons = [...painted.querySelectorAll<HTMLButtonElement>('button[type="submit"][name="close"]')];
    expect(buttons.map((button) => button.value)).toEqual([PHONE, "others"]);
    // Todos en el mismo formulario, que es el del bloque.
    expect(new Set(buttons.map((button) => button.form)).size).toBe(1);
    expect(buttons[0]?.form?.closest("section")?.id).toBe("bloque-sesiones");
    expect(html).not.toContain(`value="${HERE}"`);
  });

  it("cerrar una: manda a la acción el identificador de esa sesión y nada más", async () => {
    await closeWith([here, phone, other], () => closeButtonOf(phone), { kind: "closed", what: "one", attempt: 1 });
    expect(mocks.closeSessionsAction).toHaveBeenCalledOnce();
    const form = mocks.closeSessionsAction.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(form)).toEqual({ close: PHONE });
  });

  it("cerrar las demás: manda eso, y ningún identificador", async () => {
    await closeWith([here, phone, other], closeOthers, { kind: "closed", what: "others", attempt: 1 });
    const form = mocks.closeSessionsAction.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(form)).toEqual({ close: "others" });
  });

  it.each([
    ["one", "Cerramos esa sesión."],
    ["others", "Cerramos tus demás sesiones."],
    ["gone", "Esa sesión ya estaba cerrada."],
  ] as const)("cerrada (%s): lo dice en el bloque, y el aviso toma el foco", async (what, message) => {
    await closeWith([here, phone], () => closeButtonOf(phone), { kind: "closed", what, attempt: 1 });
    const notice = await within(sessionsBlock()).findByText(message);
    expect(notice.closest('[tabindex="-1"]')).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // El bloque del nombre no dice nada de esto.
    expect(savedNotice()).not.toBeInTheDocument();
  });

  it("no se supo: lo dice en el bloque, con el foco, y la lista sigue como estaba", async () => {
    await closeWith([here, phone], () => closeButtonOf(phone), { kind: "unavailable", attempt: 1 });
    const notice = await within(sessionsBlock()).findByText("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(notice.closest('[tabindex="-1"]')).toHaveFocus();
    expect(within(sessionsBlock()).getAllByRole("listitem")).toHaveLength(2);
    expect(closeButtonOf(phone)).toBeEnabled();
  });

  it("cuenta suspendida: la pantalla entera pasa a PA-35", async () => {
    await closeWith([here, phone], closeOthers, { kind: "suspended" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("mientras un cierre va en camino: lo dice, los botones no aceptan otro clic, y lo de antes deja de decirse", async () => {
    const { user } = await closeWith([here, phone, other], () => closeButtonOf(phone), { kind: "closed", what: "one", attempt: 1 });
    expect(await within(sessionsBlock()).findByText("Cerramos esa sesión.")).toBeVisible();

    let finish: (state: SessionsState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (finish = resolve)));
    await user.click(closeButtonOf(other));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    expect(within(sessionsBlock()).getByText("Cerrando…")).toHaveAttribute("role", "status");
    expect(within(sessionsBlock()).queryByText("Cerramos esa sesión.")).not.toBeInTheDocument();
    for (const button of within(sessionsBlock()).getAllByRole("button")) expect(button).toBeDisabled();

    // Una acción sin terminar dejaría colgadas las de las pruebas siguientes.
    await act(async () => {
      finish({ kind: "closed", what: "one", attempt: 2 });
      await Promise.resolve();
    });
    expect(await within(sessionsBlock()).findByText("Cerramos esa sesión.")).toBeVisible();
    expect(within(sessionsBlock()).queryByText("Cerrando…")).not.toBeInTheDocument();
    expect(closeOthers()).toBeEnabled();
  });

  it("cuando la fila del botón pulsado ya no está, el foco no cae al documento: lo toma el aviso", async () => {
    let finish: (state: SessionsState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    const { rerender } = render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    // La página se volvió a pedir y la lista ya no trae esa sesión: su botón, que tenía el foco, se fue.
    rerender(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    expect(document.body).toHaveFocus();

    await act(async () => {
      finish({ kind: "closed", what: "one", attempt: 1 });
      await Promise.resolve();
    });
    const notice = await within(sessionsBlock()).findByText("Cerramos esa sesión.");
    expect(notice.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("el aviso no le quita el foco a quien ya se fue a escribir a otro bloque", async () => {
    let finish: (state: SessionsState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    // Mientras el cierre va en camino, la persona se pone a escribir su nombre.
    await user.click(nameField());
    await user.type(nameField(), " María");

    await act(async () => {
      finish({ kind: "closed", what: "one", attempt: 1 });
      await Promise.resolve();
    });
    const [notice, voice] = await within(sessionsBlock()).findAllByText("Cerramos esa sesión.");
    expect(notice).toBeVisible();
    // El resultado se le dice por la región viva que ya existía, sin moverle el foco.
    expect(voice).toHaveAttribute("role", "status");
    expect(nameField()).toHaveFocus();
    await user.type(nameField(), " Pérez");
    expect(nameField()).toHaveValue("Ana María Pérez");
  });

  // Las dos respuestas llegan juntas. El campo del nombre se arma de nuevo y el foco cae al
  // documento justo cuando el aviso de las sesiones decide: si mirara dónde está el foco,
  // se lo llevaría. Lo que cuenta es que la persona se había ido a escribir su nombre.
  it("quien guardó su nombre mientras el cierre venía en camino se queda en su campo", async () => {
    let closed: (state: SessionsState) => void = () => undefined;
    let saved: (state: NameState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (closed = resolve)));
    mocks.changeNameAction.mockReturnValue(new Promise<NameState>((resolve) => (saved = resolve)));
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    await user.click(nameField());
    await user.type(nameField(), " María{Enter}");
    await vi.waitFor(() => expect(mocks.changeNameAction).toHaveBeenCalledOnce());

    await act(async () => {
      closed({ kind: "closed", what: "one", attempt: 1 });
      saved({ kind: "saved", name: "Ana María", attempt: 1 });
      await Promise.resolve();
    });
    expect(await screen.findByText("Guardado.")).toBeVisible();
    expect(nameField()).toHaveValue("Ana María");
    expect(nameField()).toHaveFocus();
    // Y el cierre se le dice sin moverle el foco.
    const [, voice] = await within(sessionsBlock()).findAllByText("Cerramos esa sesión.");
    expect(voice).toHaveAttribute("role", "status");
  });

  it("haberse ido en un cierre no cuenta para el siguiente: cada espera empieza de cero", async () => {
    let finish: (state: SessionsState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone, other]} />);
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    await user.click(nameField());
    await act(async () => {
      finish({ kind: "closed", what: "one", attempt: 1 });
      await Promise.resolve();
    });
    expect(nameField()).toHaveFocus();

    // El segundo cierre, sin irse a ningún lado: ahora el aviso sí toma el foco.
    mocks.closeSessionsAction.mockResolvedValue({ kind: "closed", what: "one", attempt: 2 });
    await user.click(closeButtonOf(other));
    await vi.waitFor(() => expect(mocks.closeSessionsAction).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(within(sessionsBlock()).getByText("Cerramos esa sesión.").closest('[tabindex="-1"]')).toHaveFocus());
  });

  it("volver a la pantalla antes de que llegue la respuesta ya no es haberse ido", async () => {
    let finish: (state: SessionsState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    await user.click(nameField());
    // Y después un clic en una zona vacía de la pantalla: lo último que hizo ya no fue irse.
    screen.getByRole("main").focus();

    await act(async () => {
      finish({ kind: "closed", what: "one", attempt: 1 });
      await Promise.resolve();
    });
    const notice = await within(sessionsBlock()).findByText("Cerramos esa sesión.");
    expect(notice.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("si el foco está en la pantalla y en nada en particular, el aviso lo toma", async () => {
    let finish: (state: SessionsState) => void = () => undefined;
    mocks.closeSessionsAction.mockReturnValue(new Promise<SessionsState>((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerrando…")).toBeVisible();
    // Un clic en una zona que no es ningún control deja el foco en el contenedor de la pantalla.
    screen.getByRole("main").focus();
    expect(screen.getByRole("main")).toHaveFocus();

    await act(async () => {
      finish({ kind: "closed", what: "one", attempt: 1 });
      await Promise.resolve();
    });
    const notice = await within(sessionsBlock()).findByText("Cerramos esa sesión.");
    expect(notice.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("el botón de cada fila tiene el alto de los controles del alumno, no el de administración", () => {
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    expect(closeButtonOf(phone)).toHaveClass("h-control");
    expect(closeButtonOf(phone)).not.toHaveClass("h-control-sm");
  });

  it("cerrar sesiones no toca el bloque del nombre: lo escrito ahí sigue", async () => {
    mocks.closeSessionsAction.mockResolvedValue({ kind: "closed", what: "one", attempt: 1 });
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={[here, phone]} />);
    await user.type(nameField(), " María");
    await user.click(closeButtonOf(phone));
    expect(await within(sessionsBlock()).findByText("Cerramos esa sesión.")).toBeVisible();
    expect(nameField()).toHaveValue("Ana María");
    expect(mocks.changeNameAction).not.toHaveBeenCalled();
  });
});

describe("la página de la cuenta", () => {
  const openSessions = {
    kind: "ready",
    sessions: [
      {
        id: HERE,
        openedAt: "2026-10-10T18:00:00.000Z",
        lastActiveAt: "2026-10-12T06:30:00.000Z",
        device: { browser: "chrome", system: "windows" },
        current: true,
      },
      { id: PHONE, openedAt: "2026-10-11T18:00:00.000Z", lastActiveAt: null, device: { browser: null, system: "ios" }, current: false },
    ],
  };

  it("le pide a la guarda una sesión para su propia ruta, y lee el perfil y las sesiones con las claims que ella dio", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.accountProfile.mockResolvedValue({ kind: "ready", name: "Ana de Prueba" });
    mocks.accountSessions.mockResolvedValue(openSessions);
    mocks.accountSecondFactor.mockResolvedValue({ kind: "ready", verified: false });
    mocks.sessionEmail.mockResolvedValue("ana@prueba.test");
    render(await AccountPage());
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/cuenta");
    expect(mocks.accountProfile).toHaveBeenCalledExactlyOnceWith(claims);
    expect(mocks.accountSessions).toHaveBeenCalledExactlyOnceWith(claims);
    expect(mocks.accountSecondFactor).toHaveBeenCalledExactlyOnceWith(claims);
    // Sin segundo factor, la contraseña se cambia aquí.
    expect(screen.getByLabelText("Contraseña actual")).toBeVisible();
    expect(mocks.sessionEmail).toHaveBeenCalledExactlyOnceWith(reader);
    expect(nameField()).toHaveValue("Ana de Prueba");
    expect(screen.getByText("ana@prueba.test")).toBeVisible();
    // Las sesiones, ya en palabras: el navegador, y las fechas en la zona del producto.
    const rows = within(sessionsBlock()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Chrome en Windows");
    expect(rows[0]).toHaveTextContent("Se abrió el 10 de octubre de 2026.");
    expect(rows[0]).toHaveTextContent("Última actividad: 12 de octubre de 2026.");
    expect(rows[0]).toHaveTextContent("Esta sesión");
    expect(rows[1]).toHaveTextContent("Navegador desconocido en iPhone o iPad");
    expect(rows[1]).not.toHaveTextContent("Última actividad");
  });

  it("si las sesiones no se pudieron leer, no pinta la cuenta a medias: ofrece reintentar", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.accountProfile.mockResolvedValue({ kind: "ready", name: "Ana de Prueba" });
    mocks.accountSessions.mockResolvedValue({ kind: "unavailable" });
    render(await AccountPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/cuenta");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });

  it("a una cuenta suspendida no le pinta nada suyo: ve PA-35, y ni se lee el perfil", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "suspended" });
    render(await AccountPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mocks.accountProfile).not.toHaveBeenCalled();
    expect(mocks.accountSessions).not.toHaveBeenCalled();
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
    expect(mocks.accountSessions).not.toHaveBeenCalled();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });
});

describe("el bloque de la contraseña (PA-25)", () => {
  const OLD = "la-de-antes-123";
  const NEW = "la-de-ahora-456";
  const CHANGED = "Tu contraseña cambió. Cerramos tus demás sesiones.";

  const currentField = () => screen.getByLabelText("Contraseña actual");
  const newField = () => screen.getByLabelText("Contraseña nueva");
  const changeButton = () => screen.getByRole("button", { name: "Cambiar contraseña" });
  const block = () => screen.getByRole("region", { name: "Contraseña" });
  const changedNotice = () => screen.queryByText(CHANGED);

  /** Pinta la pantalla, escribe esas dos contraseñas y envía, con la acción contestando `state`. */
  async function change(state: PasswordState, typed: { current?: string; next?: string } = {}) {
    mocks.changePasswordAction.mockResolvedValue(state);
    const user = userEvent.setup();
    const view = render(<AccountScreen name="Ana de Prueba" email="ana@prueba.test" sessions={ALONE} />);
    const current = typed.current ?? OLD;
    const next = typed.next ?? NEW;
    if (current !== "") await user.type(currentField(), current);
    if (next !== "") await user.type(newField(), next);
    await user.click(changeButton());
    return { user, ...view };
  }

  it("en reposo: dos campos vacíos, la regla de la nueva a la vista y un enlace para quien no recuerda la actual", async () => {
    const { container } = render(<AccountScreen name="Ana" email="ana@prueba.test" sessions={ALONE} />);
    expect(block()).toHaveAttribute("id", "bloque-contrasena");
    expect(currentField()).toHaveValue("");
    expect(currentField()).toHaveAttribute("type", "password");
    expect(currentField()).toHaveAttribute("name", "current");
    expect(currentField()).toHaveAttribute("autocomplete", "current-password");
    expect(newField()).toHaveValue("");
    expect(newField()).toHaveAttribute("name", "password");
    expect(newField()).toHaveAttribute("autocomplete", "new-password");
    expect(within(block()).getByText("8 caracteres o más")).toBeVisible();
    expect(within(block()).getByRole("link", { name: "No recuerdo mi contraseña actual" })).toHaveAttribute("href", "/recuperar");
    expect(within(block()).queryByRole("alert")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin JavaScript se pinta entero: un formulario con sus dos campos, sin ninguna contraseña escrita", () => {
    const html = renderToString(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    const page = new DOMParser().parseFromString(html, "text/html");
    const fields = [...page.querySelectorAll<HTMLInputElement>("#bloque-contrasena form input")];
    expect(fields.map((field) => [field.name, field.type, field.getAttribute("value")])).toEqual([
      ["current", "password", null],
      ["password", "password", null],
    ]);
  });

  it("manda a la acción las dos contraseñas y nada más", async () => {
    await change({ kind: "changed", attempt: 1 });
    expect(mocks.changePasswordAction).toHaveBeenCalledOnce();
    const form = mocks.changePasswordAction.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(form)).toEqual({ current: OLD, password: NEW });
    expect(mocks.changeNameAction).not.toHaveBeenCalled();
  });

  it("cambió: lo anuncia en su bloque, y los dos campos quedan vacíos", async () => {
    const { container } = await change({ kind: "changed", attempt: 1 });
    const notice = await screen.findByText(CHANGED);
    // Un aviso, no una alerta: espera su turno, no interrumpe.
    expect(notice.closest('[role="status"]')).toHaveTextContent(`Listo: ${CHANGED}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(currentField()).toHaveValue("");
    expect(newField()).toHaveValue("");
    expect(changeButton()).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    [{ current: "mismatch" }, "Esa no es tu contraseña actual.", "#cuenta-contrasena-actual"],
    [{ current: "required" }, "Escribe tu contraseña actual.", "#cuenta-contrasena-actual"],
    [{ next: "same" }, "Esa es la contraseña que ya tienes. Elige otra.", "#cuenta-contrasena-nueva"],
    [{ next: "weak" }, "Esa contraseña es fácil de adivinar. Elige otra.", "#cuenta-contrasena-nueva"],
    [{ next: "too_long" }, "Esa contraseña es demasiado larga. Elige una más corta.", "#cuenta-contrasena-nueva"],
  ] as const)("el servicio no lo aceptó (%j): el campo marcado, los dos vacíos y un resumen que enlaza al campo", async (fields, message, href) => {
    await change({ kind: "invalid", fields, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: message })).toHaveAttribute("href", href);
    const marked = "current" in fields ? currentField() : newField();
    const other = "current" in fields ? newField() : currentField();
    expect(marked).toBeInvalid();
    expect(marked).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(other).not.toBeInvalid();
    // Una contraseña nunca vuelve en la respuesta: los campos se arman de nuevo, vacíos.
    expect(currentField()).toHaveValue("");
    expect(newField()).toHaveValue("");
    expect(changedNotice()).not.toBeInTheDocument();
  });

  it("los dos campos mal: el resumen los trae en el orden de la pantalla", async () => {
    await change({ kind: "invalid", fields: { current: "mismatch", next: "weak" }, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "#cuenta-contrasena-actual",
      "#cuenta-contrasena-nueva",
    ]);
  });

  it.each([
    ["sin la actual", { current: "", next: NEW }, "Escribe tu contraseña actual."],
    ["con la nueva corta", { current: OLD, next: "corta-7" }, "Tu contraseña necesita 8 caracteres o más."],
    ["con la nueva igual a la actual", { current: OLD, next: OLD }, "Esa es la contraseña que ya tienes. Elige otra."],
  ])("%s no se envía: se marca antes, lo escrito se queda, y el servicio ni se entera", async (_case, typed, message) => {
    await change({ kind: "changed", attempt: 1 }, typed);
    expect(mocks.changePasswordAction).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(currentField()).toHaveValue(typed.current);
    expect(newField()).toHaveValue(typed.next);
  });

  it("frenado: dice hasta qué hora, y el botón no acepta otro intento mientras tanto", async () => {
    const later = new Date(Date.now() + 5 * 60_000).toISOString();
    await change({ kind: "throttled", retryAt: later, attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Error: Demasiados intentos\. Podrás probar de nuevo a las \d/);
    const button = changeButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Podrás intentarlo de nuevo cuando pase la espera.");
  });

  it("cumplida la espera, el botón vuelve a servir sin recargar", async () => {
    // La espera es de diez minutos y se mira con uno de margen a cada lado: lo que tarde
    // de verdad en escribir y enviar no cambia el resultado.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await change({ kind: "throttled", retryAt: new Date(Date.now() + 600_000).toISOString(), attempt: 1 });
      await screen.findByRole("alert");
      expect(changeButton()).toBeDisabled();
      await act(() => vi.advanceTimersByTimeAsync(540_000));
      expect(changeButton()).toBeDisabled();
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(changeButton()).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pasada la espera, un intento nuevo en camino deja de decir que hay que esperar", async () => {
    const { user } = await change({ kind: "throttled", retryAt: new Date(Date.now() - 1_000).toISOString(), attempt: 1 });
    await screen.findByRole("alert");
    await vi.waitFor(() => expect(changeButton()).toBeEnabled());

    let finish: (state: PasswordState) => void = () => undefined;
    mocks.changePasswordAction.mockReturnValue(new Promise<PasswordState>((resolve) => (finish = resolve)));
    await user.type(currentField(), OLD);
    await user.type(newField(), NEW);
    await user.click(changeButton());
    expect(await screen.findByRole("button", { name: "Cambiando…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      finish({ kind: "changed", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText(CHANGED)).toBeVisible();
  });

  it.each([
    ["capped", "Demasiados intentos. Vuelve a probar más tarde."],
    ["unavailable", "No pudimos hacerlo. Intenta de nuevo en un momento."],
  ] as const)("no se pudo (%s): lo dice en una alerta, sin marcar ningún campo", async (reason, message) => {
    await change({ kind: "failed", reason, attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(currentField()).not.toBeInvalid();
    expect(newField()).not.toBeInvalid();
    expect(changeButton()).toBeEnabled();
  });

  it("cuenta suspendida: la pantalla entera pasa a PA-35", async () => {
    await change({ kind: "suspended" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
  });

  it("mientras el cambio va en camino: lo dice, los campos no se escriben y lo de antes deja de decirse", async () => {
    const { user } = await change({ kind: "changed", attempt: 1 });
    expect(await screen.findByText(CHANGED)).toBeVisible();

    let finish: (state: PasswordState) => void = () => undefined;
    mocks.changePasswordAction.mockReturnValue(new Promise<PasswordState>((resolve) => (finish = resolve)));
    await user.type(currentField(), NEW);
    await user.type(newField(), "otra-mas-789");
    await user.click(changeButton());
    expect(await screen.findByRole("button", { name: "Cambiando…" })).toBeDisabled();
    expect(changedNotice()).not.toBeInTheDocument();
    // Lo tecleado ahora se perdería al llegar la respuesta.
    expect(currentField()).toHaveAttribute("readonly");
    expect(newField()).toHaveAttribute("readonly");

    await act(async () => {
      finish({ kind: "changed", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText(CHANGED)).toBeVisible();
    expect(currentField()).not.toHaveAttribute("readonly");
    expect(newField()).not.toHaveAttribute("readonly");
  });

  it("lo que dijo el último envío deja de decirse en cuanto se vuelve a escribir", async () => {
    const { user } = await change({ kind: "changed", attempt: 1 });
    expect(await screen.findByText(CHANGED)).toBeVisible();
    await user.type(currentField(), "x");
    expect(changedNotice()).not.toBeInTheDocument();
  });

  // Los campos pueden llenarse sin que esta pantalla se entere: los llena el navegador, o
  // un gestor de contraseñas. Entonces lo que quita el aviso viejo no es haber escrito.
  it("con algo por corregir no se dice «cambió», aunque nadie haya escrito", async () => {
    const { user } = await change({ kind: "changed", attempt: 1 });
    expect(await screen.findByText(CHANGED)).toBeVisible();
    // Los dos campos quedaron vacíos: enviar así lo detiene la revisión.
    await user.click(changeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Escribe tu contraseña actual.");
    expect(changedNotice()).not.toBeInTheDocument();
    expect(mocks.changePasswordAction).toHaveBeenCalledOnce();
  });

  it("con otro envío en camino no se dice «cambió», aunque los campos se hayan llenado sin avisar", async () => {
    const { user } = await change({ kind: "changed", attempt: 1 });
    expect(await screen.findByText(CHANGED)).toBeVisible();

    let finish: (state: PasswordState) => void = () => undefined;
    mocks.changePasswordAction.mockReturnValue(new Promise<PasswordState>((resolve) => (finish = resolve)));
    (currentField() as HTMLInputElement).value = NEW;
    (newField() as HTMLInputElement).value = "otra-mas-789";
    await user.click(changeButton());
    expect(await screen.findByRole("button", { name: "Cambiando…" })).toBeDisabled();
    expect(changedNotice()).not.toBeInTheDocument();

    await act(async () => {
      finish({ kind: "changed", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText(CHANGED)).toBeVisible();
  });

  it("un envío nuevo tapa lo que el servicio había rechazado, aunque su respuesta no haya llegado", async () => {
    const { user } = await change({ kind: "invalid", fields: { current: "mismatch" }, attempt: 1 });
    await screen.findByRole("alert");

    let finish: (state: PasswordState) => void = () => undefined;
    mocks.changePasswordAction.mockReturnValue(new Promise<PasswordState>((resolve) => (finish = resolve)));
    await user.type(currentField(), OLD);
    await user.type(newField(), NEW);
    await user.click(changeButton());
    expect(await screen.findByRole("button", { name: "Cambiando…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(currentField()).not.toBeInvalid();

    await act(async () => {
      finish({ kind: "changed", attempt: 2 });
      await Promise.resolve();
    });
    expect(await screen.findByText(CHANGED)).toBeVisible();
  });

  it("enviar con Intro desde la contraseña nueva deja el foco en ese campo, que se armó de nuevo", async () => {
    mocks.changePasswordAction.mockResolvedValue({ kind: "changed", attempt: 1 });
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    await user.type(currentField(), OLD);
    const before = newField();
    await user.type(before, `${NEW}{Enter}`);
    expect(await screen.findByText(CHANGED)).toBeVisible();
    expect(newField()).not.toBe(before);
    expect(newField()).toHaveFocus();
  });

  it("si el servicio no lo aceptó, el foco es del resumen de errores", async () => {
    mocks.changePasswordAction.mockResolvedValue({ kind: "invalid", fields: { current: "mismatch" }, attempt: 1 });
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    await user.type(currentField(), OLD);
    await user.type(newField(), `${NEW}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveFocus();
  });

  it("al salir de la contraseña nueva, una que no cumple la regla se marca; la actual no se revisa al salir", async () => {
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    await user.type(currentField(), "x");
    await user.type(newField(), "corta-7");
    // Dos saltos: el primero cae en «Mostrar», que es parte del campo, y eso no es salir.
    await user.tab();
    expect(newField()).not.toBeInvalid();
    await user.tab();
    await vi.waitFor(() => expect(newField()).toBeInvalid());
    expect(newField()).toHaveAccessibleDescription(expect.stringContaining("Tu contraseña necesita 8 caracteres o más."));
    expect(currentField()).not.toBeInvalid();
  });

  describe("en una cuenta con segundo factor", () => {
    const NOTE = "Tu cuenta tiene segundo factor. Para cambiar tu contraseña, recupérala desde tu correo.";

    it("no hay formulario: dice cómo cambiarla y enlaza a recuperarla", async () => {
      const { container } = render(<AccountScreen name="Ana" email="ana@prueba.test" sessions={ALONE} secondFactor />);
      expect(block()).toHaveAttribute("id", "bloque-contrasena");
      expect(within(block()).getByText(NOTE)).toBeVisible();
      expect(within(block()).getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
      expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cambiar contraseña" })).not.toBeInTheDocument();
      // Los demás bloques siguen como siempre.
      expect(nameField()).toHaveValue("Ana");
      expect(await a11yViolations(container)).toEqual([]);
    });

    it("si la cuenta ganó su segundo factor con la pantalla ya abierta, el envío lo descubre y el bloque cambia", async () => {
      await change({ kind: "recover_only" });
      expect(await within(block()).findByText(NOTE)).toBeVisible();
      expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("cambiar la contraseña no toca el bloque del nombre: lo escrito ahí sigue", async () => {
    mocks.changePasswordAction.mockResolvedValue({ kind: "changed", attempt: 1 });
    const user = userEvent.setup();
    render(<AccountScreen name="Ana" email={null} sessions={ALONE} />);
    await user.type(nameField(), " de Prueba");
    await user.type(currentField(), OLD);
    await user.type(newField(), NEW);
    await user.click(changeButton());
    expect(await screen.findByText(CHANGED)).toBeVisible();
    expect(nameField()).toHaveValue("Ana de Prueba");
    expect(savedNotice()).not.toBeInTheDocument();
  });
});

describe("la página de la cuenta, con segundo factor", () => {
  const sessions = {
    kind: "ready",
    sessions: [{ id: HERE, openedAt: "2026-10-10T18:00:00.000Z", lastActiveAt: null, device: { browser: "chrome", system: "windows" }, current: true }],
  };

  beforeEach(() => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.accountProfile.mockResolvedValue({ kind: "ready", name: "Ana de Prueba" });
    mocks.accountSessions.mockResolvedValue(sessions);
    mocks.sessionEmail.mockResolvedValue("ana@prueba.test");
  });

  it("a una cuenta con un factor verificado le pinta la nota y no el formulario", async () => {
    mocks.accountSecondFactor.mockResolvedValue({ kind: "ready", verified: true });
    render(await AccountPage());
    expect(screen.getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
    expect(screen.queryByLabelText("Contraseña actual")).not.toBeInTheDocument();
  });

  it("si no se supo, no pinta la cuenta a medias: ofrece reintentar", async () => {
    mocks.accountSecondFactor.mockResolvedValue({ kind: "unavailable" });
    render(await AccountPage());
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/cuenta");
    expect(screen.queryByRole("textbox", { name: "Nombre" })).not.toBeInTheDocument();
  });
});
