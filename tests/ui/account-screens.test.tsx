import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor son la frontera con el servicio: aquí se cambian por lo que
// contestarían, para ver qué pinta cada pantalla con cada respuesta. Lo que hacen de verdad
// lo prueban sus tablas (`outcomes.test.ts`) y las pruebas de extremo a extremo.
const actions = vi.hoisted(() => ({
  signInAction: vi.fn(),
  completeAccountAction: vi.fn(),
  signOutAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/entrar/actions", () => ({ signInAction: actions.signInAction }));
vi.mock("@/app/(cuenta)/consentimientos/actions", () => ({ completeAccountAction: actions.completeAccountAction }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: actions.signOutAction }));

import { NoCurrentTextScreen, SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import type { ConsentsState, ConsentsView } from "@/app/(cuenta)/consentimientos/outcomes";
import { ConsentsScreen } from "@/app/(cuenta)/consentimientos/screen";
import type { SignInState } from "@/app/(cuenta)/entrar/outcomes";
import { SignInScreen } from "@/app/(cuenta)/entrar/screen";

import { a11yViolations } from "../setup/a11y";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

const answers = <State,>(action: ReturnType<typeof vi.fn>, state: State) => action.mockResolvedValue(state);

async function submitSignIn(state: SignInState) {
  answers(actions.signInAction, state);
  const user = userEvent.setup();
  const view = render(<SignInScreen returnTo="/inicio?x=1" notice="Tu cuenta está lista. Entra con tu contraseña." />);
  await user.type(screen.getByLabelText("Correo"), "ana@prueba.test");
  await user.type(screen.getByLabelText("Contraseña"), "secreta-123");
  await user.click(screen.getByRole("button", { name: "Entrar" }));
  return { user, ...view };
}

describe("la pantalla de entrar (PA-11)", () => {
  it("en reposo: un título, los dos campos, el aviso con que se llegó y los dos enlaces", async () => {
    const { container } = render(<SignInScreen returnTo="/inicio?x=1" notice="Tu cuenta está lista. Entra con tu contraseña." />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Inicia sesión");
    expect(screen.getByLabelText("Correo")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByText("Tu cuenta está lista. Entra con tu contraseña.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Olvidé mi contraseña" })).toHaveAttribute("href", "/recuperar");
    expect(screen.getByRole("link", { name: "Crear cuenta" })).toHaveAttribute("href", "/registro");
    // El destino guardado viaja con el formulario, tal como llegó: lo valida la acción.
    expect(container.querySelector('input[type="hidden"][name="volver"]')).toHaveValue("/inicio?x=1");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("manda a la acción el correo, la contraseña y el destino, y nada más", async () => {
    await submitSignIn({ kind: "failed", email: "ana@prueba.test", reason: "invalid_credentials", attempt: 1 });
    expect(actions.signInAction).toHaveBeenCalledOnce();
    const form = actions.signInAction.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(form)).toEqual({ email: "ana@prueba.test", password: "secreta-123", volver: "/inicio?x=1" });
  });

  it.each([
    ["invalid_credentials", "El correo o la contraseña no coinciden."],
    ["capped", "Demasiados intentos. Vuelve a probar más tarde."],
    ["unavailable", "No pudimos hacerlo. Intenta de nuevo en un momento."],
  ] as const)("%s: lo dice en una alerta, conserva el correo y deja de mostrar el aviso de llegada", async (reason, message) => {
    const { container } = await submitSignIn({ kind: "failed", email: "ana@prueba.test", reason, attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("Correo")).toHaveValue("ana@prueba.test");
    expect(screen.getByLabelText("Contraseña")).toHaveValue("");
    expect(screen.queryByText("Tu cuenta está lista. Entra con tu contraseña.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("datos por corregir: cada campo marcado, con un resumen que enlaza a cada uno", async () => {
    await submitSignIn({ kind: "invalid", email: "", fields: { email: "required", password: "required" }, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Hay 2 datos por corregir");
    expect(within(summary).getByRole("link", { name: "Escribe tu correo." })).toHaveAttribute("href", "#entrar-correo");
    expect(within(summary).getByRole("link", { name: "Escribe tu contraseña." })).toHaveAttribute("href", "#entrar-contrasena");
    expect(screen.getByLabelText("Correo")).toBeInvalid();
    expect(screen.getByLabelText("Contraseña")).toBeInvalid();
  });

  it("frenado: dice la hora en la zona de quien lee y deshabilita el botón, con su razón", async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await submitSignIn({ kind: "throttled", email: "ana@prueba.test", retryAt, attempt: 1 });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Error: Demasiados intentos\. Podrás probar de nuevo a las \d{1,2}:\d{2}[^,]*\.$/);
    expect(alert).not.toHaveTextContent("hora del centro de México");
    const button = screen.getByRole("button", { name: "Entrar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Podrás intentarlo de nuevo cuando pase la espera.");
  });

  it("cumplida la espera, el botón vuelve a servir sin recargar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    await submitSignIn({ kind: "throttled", email: "ana@prueba.test", retryAt, attempt: 1 });
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });

  it("cuenta suspendida: la pantalla es PA-35, sin formulario y sin sesión que cerrar", async () => {
    const { container } = await submitSignIn({ kind: "suspended" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByLabelText("Correo")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir al inicio" })).toHaveAttribute("href", "/");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al salir del campo, un correo sin forma se marca; uno vacío, no", async () => {
    const user = userEvent.setup();
    render(<SignInScreen returnTo="" notice={null} />);
    await user.click(screen.getByLabelText("Correo"));
    await user.tab();
    expect(screen.getByLabelText("Correo")).not.toBeInvalid();
    await user.type(screen.getByLabelText("Correo"), "esto no es un correo");
    await user.tab();
    expect(screen.getByLabelText("Correo")).toBeInvalid();
    expect(screen.getByText("Ese correo no tiene forma de correo. Revísalo.")).toBeVisible();
    await user.clear(screen.getByLabelText("Correo"));
    await user.type(screen.getByLabelText("Correo"), "ana@prueba.test");
    await user.tab();
    expect(screen.getByLabelText("Correo")).not.toBeInvalid();
    expect(actions.signInAction).not.toHaveBeenCalled();
  });
});

describe("la hora del freno, cuando la pinta el servidor", () => {
  it("va en la hora del centro de México, y lo dice", async () => {
    // Lo que el servidor manda cuando el formulario se envió sin JavaScript: no sabe en qué
    // zona está la persona. 18:30 UTC son las 12:30 en el centro de México.
    const { ThrottledAlert } = await import("@/app/(cuenta)/entrar/screen");
    const html = renderToString(<ThrottledAlert retryAt="2026-10-11T18:30:00.000Z" />);
    expect(html).toContain("Podrás probar de nuevo a las 12:30");
    expect(html).toContain("hora del centro de México");
  });
});

const ID = {
  terms: "11111111-1111-4111-8111-111111111111",
  student_privacy_notice: "22222222-2222-4222-8222-222222222222",
  course_history_consent: "33333333-3333-4333-8333-333333333333",
};
const item = (docType: keyof typeof ID, title: string, extra: Partial<ConsentsView["items"][number]> = {}) => ({
  docType,
  documentId: ID[docType],
  title,
  version: 2,
  effectiveDate: "12 de noviembre de 2026",
  href: `/legal/${docType}`,
  explanation: null,
  ...extra,
});
const complete: ConsentsView = {
  variant: "complete_account",
  askName: true,
  askAdult: true,
  minimumAge: 18,
  items: [
    item("terms", "Términos y condiciones"),
    item("student_privacy_notice", "Aviso de privacidad"),
    item("course_history_consent", "Tu historial de cursos", { href: null, explanation: ["Primer párrafo.", "Segundo párrafo."] }),
  ],
  signature: Object.values(ID).join(","),
};
const updated: ConsentsView = {
  variant: "updated_texts",
  askName: false,
  askAdult: false,
  minimumAge: 18,
  items: [item("terms", "Términos y condiciones")],
  signature: ID.terms,
};
const HISTORY = "Doy mi permiso para que La Plataforma guarde mi historial de cursos con esos fines.";

describe("la pantalla que pide lo que le falta a la cuenta (PA-15)", () => {
  it("«Completa tu cuenta»: nombre, edad, una casilla por texto y el historial en su bloque, nada marcado", async () => {
    const { container } = render(<ConsentsScreen view={complete} returnTo="/inicio" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Completa tu cuenta");
    expect(screen.getByLabelText("Nombre")).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText("Tengo 18 años cumplidos o más.")).not.toBeChecked();
    const terms = screen.getByRole("checkbox", { name: /Leí y acepto: Términos y condiciones\. Versión 2, vigente desde el 12 de noviembre de 2026\./ });
    expect(terms).not.toBeChecked();
    const history = screen.getByRole("group", { name: "Tu historial de cursos" });
    expect(history).toHaveTextContent("Primer párrafo.");
    expect(within(history).getByLabelText(HISTORY)).not.toBeChecked();
    // El texto completo se lee en otra pestaña, para no perder lo escrito.
    const links = screen.getAllByRole("link", { name: /Leer el texto/ });
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/legal/terms", "/legal/student_privacy_notice"]);
    for (const link of links) expect(link).toHaveAttribute("target", "_blank");
    // Lo que se pintó viaja oculto: es lo que la persona acepta al marcar.
    expect([...container.querySelectorAll('input[name="shown"]')].map((input) => input.getAttribute("value"))).toEqual([
      `terms=${ID.terms}`,
      `student_privacy_notice=${ID.student_privacy_notice}`,
      `course_history_consent=${ID.course_history_consent}`,
    ]);
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("«Actualizamos nuestros textos»: solo los textos que cambiaron, sin nombre ni edad", async () => {
    const { container } = render(<ConsentsScreen view={updated} returnTo="" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Actualizamos nuestros textos");
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("lo que falta se dice antes de enviar: no se llama a la acción y lo marcado se queda", async () => {
    const user = userEvent.setup();
    const { container } = render(<ConsentsScreen view={complete} returnTo="/inicio" />);
    await user.click(screen.getByLabelText("Tengo 18 años cumplidos o más."));
    await user.click(screen.getByRole("button", { name: "Aceptar y seguir" }));

    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Hay 4 datos por corregir");
    expect(within(summary).getByRole("link", { name: "Escribe tu nombre." })).toHaveAttribute("href", "#cuenta-nombre");
    expect(within(summary).getByRole("link", { name: "Falta aceptar: Términos y condiciones." })).toHaveAttribute("href", "#cuenta-texto-terms");
    expect(within(summary).queryByRole("link", { name: "Falta que declares tu edad." })).not.toBeInTheDocument();
    expect(actions.completeAccountAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Tengo 18 años cumplidos o más.")).toBeChecked();
    expect(within(screen.getByRole("group", { name: "Tu historial de cursos" })).getByLabelText(HISTORY)).toBeInvalid();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("completo, manda a la acción el nombre, la edad, el destino y cada casilla con el texto que se pintó", async () => {
    answers<ConsentsState>(actions.completeAccountAction, { kind: "unavailable", name: "Ana", attempt: 1 });
    const user = userEvent.setup();
    render(<ConsentsScreen view={complete} returnTo="/inicio" />);
    await user.type(screen.getByLabelText("Nombre"), "Ana");
    for (const box of screen.getAllByRole("checkbox")) await user.click(box);
    await user.click(screen.getByRole("button", { name: "Aceptar y seguir" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(actions.completeAccountAction).toHaveBeenCalledOnce();
    const form = actions.completeAccountAction.mock.calls[0]?.[1] as FormData;
    expect(form.get("name")).toBe("Ana");
    expect(form.get("adult")).toBe("on");
    expect(form.get("volver")).toBe("/inicio");
    expect(form.getAll("shown")).toHaveLength(3);
    for (const docType of Object.keys(ID)) expect(form.get(`accept:${docType}`)).toBe("on");
    // El nombre vuelve; las casillas, no: ninguna viene marcada nunca.
    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana");
  });

  it("el texto cambió mientras se llenaba: lo avisa, sin ser un error", async () => {
    answers<ConsentsState>(actions.completeAccountAction, { kind: "repainted", reason: "texts_changed", name: "Ana", attempt: 1 });
    const user = userEvent.setup();
    render(<ConsentsScreen view={updated} returnTo="" />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Aceptar y seguir" }));
    const notice = await screen.findByText("Actualizamos un texto mientras llenabas el formulario. Léelo y marca de nuevo.");
    // Un aviso, no una alerta: espera su turno, no interrumpe.
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("el servidor dice qué falta: se marca cada cosa", async () => {
    answers<ConsentsState>(actions.completeAccountAction, {
      kind: "invalid",
      name: "Ana",
      fields: { texts: ["terms"] },
      attempt: 1,
    });
    const user = userEvent.setup();
    render(<ConsentsScreen view={updated} returnTo="" />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Aceptar y seguir" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Falta aceptar: Términos y condiciones.");
    expect(screen.getByRole("checkbox")).toBeInvalid();
  });

  it("la cuenta se suspendió entre tanto: la pantalla es PA-35, con «Cerrar sesión»", async () => {
    answers<ConsentsState>(actions.completeAccountAction, { kind: "suspended" });
    const user = userEvent.setup();
    render(<ConsentsScreen view={updated} returnTo="" />);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Aceptar y seguir" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
  });
});

describe("los estados que sustituyen a una pantalla de la cuenta", () => {
  it("PA-35 con sesión: «Cerrar sesión». No dice el motivo ni promete lo que todavía no pasa", async () => {
    const { container } = render(<SuspendedScreen withSession />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(container).not.toHaveTextContent(/renovación|cobro/i);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("no se supo: ofrece reintentar en la misma ruta, y cerrar sesión solo si hay sesión", async () => {
    const { container, rerender } = render(<UnavailableScreen retryHref="/inicio" withSession />);
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/inicio");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
    rerender(<UnavailableScreen retryHref="/legal/terminos" withSession={false} />);
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
  });

  it("falta un texto obligatorio: dice que la cuenta no se puede completar", async () => {
    const { container } = render(<NoCurrentTextScreen withSession />);
    expect(screen.getByText("Por ahora no podemos completar tu cuenta.")).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
  });
});
