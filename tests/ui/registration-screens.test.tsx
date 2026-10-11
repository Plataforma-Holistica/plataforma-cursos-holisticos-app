import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Las pantallas de registro, verificación y recuperación (diseño, PA-10, PA-13 y PA-14).
// Las acciones de servidor se cambian por lo que contestarían, para ver qué pinta cada
// pantalla con cada respuesta. Lo que hacen de verdad lo prueban sus tablas y las pruebas de
// extremo a extremo.
const actions = vi.hoisted(() => ({
  requestRegistrationAction: vi.fn(),
  resendAction: vi.fn(),
  notMyEmailAction: vi.fn(),
  completeRegistrationAction: vi.fn(),
  requestRecoveryAction: vi.fn(),
  completeRecoveryAction: vi.fn(),
  signOutAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/registro/actions", () => ({ requestRegistrationAction: actions.requestRegistrationAction }));
vi.mock("@/app/(cuenta)/verificar/actions", () => ({ resendAction: actions.resendAction, notMyEmailAction: actions.notMyEmailAction }));
vi.mock("@/app/(cuenta)/verificar/[token]/actions", () => ({ completeRegistrationAction: actions.completeRegistrationAction }));
vi.mock("@/app/(cuenta)/recuperar/actions", () => ({ requestRecoveryAction: actions.requestRecoveryAction }));
vi.mock("@/app/(cuenta)/recuperar/[token]/actions", () => ({ completeRecoveryAction: actions.completeRecoveryAction }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: actions.signOutAction }));

import type { MailRequestState } from "@/app/(cuenta)/_lib/mail-request";
import {
  RecoveryLinkDeadScreen,
  RecoveryUnfinishedScreen,
  RegistrationLinkDeadScreen,
  RegistrationUnfinishedScreen,
} from "@/app/(cuenta)/_lib/states";
import type { ChangePasswordState } from "@/app/(cuenta)/recuperar/[token]/outcomes";
import { ChangePasswordScreen } from "@/app/(cuenta)/recuperar/[token]/screen";
import { RecoverScreen } from "@/app/(cuenta)/recuperar/screen";
import { SignUpScreen } from "@/app/(cuenta)/registro/screen";
import { completeView, LEGAL_BOX, type CompleteState } from "@/app/(cuenta)/verificar/[token]/outcomes";
import { CompleteScreen } from "@/app/(cuenta)/verificar/[token]/screen";
import type { ResendState } from "@/app/(cuenta)/verificar/outcomes";
import { CheckMailScreen } from "@/app/(cuenta)/verificar/screen";

import { a11yViolations } from "../setup/a11y";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

const answers = <State,>(action: ReturnType<typeof vi.fn>, state: State) => action.mockResolvedValue(state);
const formOf = (action: ReturnType<typeof vi.fn>) => Object.fromEntries(action.mock.calls[0]?.[1] as FormData);
const allOf = (action: ReturnType<typeof vi.fn>, name: string) => (action.mock.calls[0]?.[1] as FormData).getAll(name);

const signUp = <SignUpScreen termsHref="/legal/terminos" privacyHref="/legal/privacidad" />;

async function submitSignUp(state: MailRequestState, email = "ana@prueba.test") {
  answers(actions.requestRegistrationAction, state);
  const user = userEvent.setup();
  const view = render(signUp);
  await user.type(screen.getByLabelText("Correo"), email);
  await user.click(screen.getByRole("button", { name: "Crear mi cuenta" }));
  return { user, ...view };
}

describe("la pantalla de registro (PA-10)", () => {
  it("en reposo: un título, un solo campo con su frase, el deslinde, los textos legales y «Ya tengo cuenta»", async () => {
    const { container } = render(signUp);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Crea tu cuenta");
    const email = screen.getByLabelText("Correo");
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toHaveAccessibleDescription("Te mandamos un enlace para confirmar tu correo. Al abrirlo eliges tu contraseña.");
    // Aquí no se pide contraseña ni se acepta nada.
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const terms = screen.getByRole("link", { name: /Términos/ });
    const privacy = screen.getByRole("link", { name: /Aviso de privacidad/ });
    expect(terms).toHaveAttribute("href", "/legal/terminos");
    expect(privacy).toHaveAttribute("href", "/legal/privacidad");
    // En otra pestaña: no se pierde lo escrito.
    for (const link of [terms, privacy]) expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Ya tengo cuenta" })).toHaveAttribute("href", "/entrar");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("un texto legal que todavía no tiene página se nombra sin enlace", () => {
    render(<SignUpScreen termsHref={null} privacyHref={null} />);
    expect(screen.queryByRole("link", { name: /Términos/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Antes de terminar vas a leer y aceptar los Términos y el Aviso de privacidad\./)).toBeVisible();
  });

  it("manda a la acción el correo y nada más", async () => {
    await submitSignUp({ kind: "failed", email: "ana@prueba.test", reason: "unavailable", attempt: 1 });
    expect(actions.requestRegistrationAction).toHaveBeenCalledOnce();
    expect(formOf(actions.requestRegistrationAction)).toEqual({ email: "ana@prueba.test" });
  });

  it.each([
    ["wait", "Espera un momento antes de intentarlo de nuevo."],
    ["unavailable", "No pudimos hacerlo. Intenta de nuevo en un momento."],
  ] as const)("%s: lo dice en una alerta y conserva el correo", async (reason, message) => {
    const { container } = await submitSignUp({ kind: "failed", email: "ana@prueba.test", reason, attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("Correo")).toHaveValue("ana@prueba.test");
    expect(screen.getByRole("button", { name: "Crear mi cuenta" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    ["required", "Escribe tu correo."],
    ["invalid", "Ese correo no tiene forma de correo. Revísalo."],
  ] as const)("correo por corregir (%s): el campo marcado y un resumen que enlaza a él", async (field, message) => {
    await submitSignUp({ kind: "invalid", email: "ana", field, attempt: 1 }, "ana");
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: message })).toHaveAttribute("href", "#registro-correo");
    expect(screen.getByLabelText("Correo")).toBeInvalid();
    expect(screen.getByLabelText("Correo")).toHaveValue("ana");
  });

  it("al salir del campo, un correo sin forma se marca; uno vacío, no", async () => {
    const user = userEvent.setup();
    render(signUp);
    await user.click(screen.getByLabelText("Correo"));
    await user.tab();
    expect(screen.getByLabelText("Correo")).not.toBeInvalid();
    await user.type(screen.getByLabelText("Correo"), "ana");
    await user.tab();
    expect(screen.getByLabelText("Correo")).toBeInvalid();
    expect(screen.getByText("Ese correo no tiene forma de correo. Revísalo.")).toBeVisible();
    await user.type(screen.getByLabelText("Correo"), "@prueba.test");
    await user.tab();
    expect(screen.getByLabelText("Correo")).not.toBeInvalid();
    expect(actions.requestRegistrationAction).not.toHaveBeenCalled();
  });
});

const inAMinute = () => ({ until: new Date(Date.now() + 60_000).toISOString(), seconds: 60 });

describe("«Revisa tu correo» (PA-14)", () => {
  it("con el correo anotado: dice a dónde se mandó y cuánto dura, y deja reenviar o corregir el correo", async () => {
    const { container } = render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={null} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Revisa tu correo");
    expect(screen.getByText("Te mandamos un enlace a ana@prueba.test. Ábrelo para completar tu cuenta.")).toBeVisible();
    expect(screen.getByText("Dura 1 hora.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ese no es mi correo" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Escribir mi correo otra vez" })).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la línea para quien ya tenía cuenta va siempre, con sus dos salidas", () => {
    for (const email of ["ana@prueba.test", null]) {
      const { unmount } = render(<CheckMailScreen email={email} lifetimeSeconds={null} wait={null} />);
      expect(screen.getByText(/¿Ya tenías cuenta\?/)).toBeVisible();
      expect(screen.getByRole("link", { name: "Entra" })).toHaveAttribute("href", "/entrar");
      expect(screen.getByRole("link", { name: "recupera tu contraseña" })).toHaveAttribute("href", "/recuperar");
      unmount();
    }
  });

  it("sin correo anotado: el texto genérico, sin a quién reenviar, y la salida es escribirlo otra vez", async () => {
    const { container } = render(<CheckMailScreen email={null} lifetimeSeconds={null} wait={null} />);
    expect(screen.getByText("Te mandamos un enlace al correo que escribiste. Ábrelo para completar tu cuenta.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Escribir mi correo otra vez" })).toHaveAttribute("href", "/registro");
    expect(screen.queryByRole("button", { name: "Reenviar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ese no es mi correo" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Dura /)).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("si no se supo cuánto dura el enlace, no lo inventa", () => {
    render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={null} wait={null} />);
    expect(screen.queryByText(/^Dura /)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
  });

  it("durante la espera, «Reenviar» queda deshabilitado con su razón escrita", async () => {
    const { container } = render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={inAMinute()} />);
    const button = screen.getByRole("button", { name: "Reenviar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Podrás reenviarlo en 1 minuto.");
    // «Ese no es mi correo» no espera a nada.
    expect(screen.getByRole("button", { name: "Ese no es mi correo" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("cumplida la espera, el botón vuelve a servir sin recargar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const wait = { until: new Date(Date.now() + 600_000).toISOString(), seconds: 600 };
    render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={wait} />);
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(540_000));
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
  });

  it("tras reenviar: lo dice, y el botón queda en la espera que contestó la acción", async () => {
    answers<ResendState>(actions.resendAction, { kind: "sent", wait: inAMinute(), attempt: 1 });
    const user = userEvent.setup();
    const { container } = render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={null} />);
    await user.click(screen.getByRole("button", { name: "Reenviar" }));
    expect(await screen.findByText("Listo, lo mandamos otra vez.")).toBeVisible();
    expect(actions.resendAction).toHaveBeenCalledOnce();
    const button = screen.getByRole("button", { name: "Reenviar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Podrás reenviarlo en 1 minuto.");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("tras reenviar sin saber la espera, el botón sigue sirviendo", async () => {
    answers<ResendState>(actions.resendAction, { kind: "sent", wait: null, attempt: 1 });
    render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={inAMinute()} />);
    // Sin JavaScript el botón no se podría pulsar; aquí se manda la acción directo.
    await act(async () => {
      (screen.getByRole("button", { name: "Reenviar" }).closest("form") as HTMLFormElement).requestSubmit();
      await Promise.resolve();
    });
    expect(await screen.findByText("Listo, lo mandamos otra vez.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
  });

  it.each([
    ["wait", "Espera un momento antes de intentarlo de nuevo."],
    ["unavailable", "No pudimos hacerlo. Intenta de nuevo en un momento."],
  ] as const)("reenvío que no sale (%s): lo dice, y no dice que se mandó", async (reason, message) => {
    answers<ResendState>(actions.resendAction, { kind: "failed", reason, attempt: 1 });
    const user = userEvent.setup();
    render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={null} />);
    await user.click(screen.getByRole("button", { name: "Reenviar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("Listo, lo mandamos otra vez.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
  });

  it("«Ese no es mi correo» es un envío, no un enlace: llama a su acción", async () => {
    const user = userEvent.setup();
    render(<CheckMailScreen email="ana@prueba.test" lifetimeSeconds={3_600} wait={null} />);
    const button = screen.getByRole("button", { name: "Ese no es mi correo" });
    expect(button).toHaveAttribute("type", "submit");
    await user.click(button);
    expect(actions.notMyEmailAction).toHaveBeenCalledOnce();
    expect(actions.resendAction).not.toHaveBeenCalled();
  });
});

const ID = {
  terms: "11111111-1111-4111-8111-111111111111",
  student_privacy_notice: "22222222-2222-4222-8222-222222222222",
  course_history_consent: "33333333-3333-4333-8333-333333333333",
} as const;
const legalText = (docType: keyof typeof ID, title: string, body = "Texto.") => ({
  docType,
  documentId: ID[docType],
  version: 2,
  title,
  body,
  effectiveFrom: "2026-11-12T06:00:00.000Z",
});
const view = completeView(
  {
    texts: [
      legalText("terms", "Términos y condiciones"),
      legalText("student_privacy_notice", "Aviso de privacidad"),
      legalText("course_history_consent", "Tu historial de cursos", "Guardamos qué cursos ves.\n\nSirve para retomar donde te quedaste."),
    ],
    minimumAge: 18,
  },
  { slugOf: (docType) => docType, formatDate: () => "12 de noviembre de 2026" },
);
const TOKEN = "abcdefgh12345678";
const ADULT = "Tengo 18 años cumplidos o más.";
const LEGAL = /^Acepto los Términos.*y el Aviso de privacidad.*\.$/;
const HISTORY = /Doy mi permiso para que .* guarde mi historial de cursos con esos fines\./;
const complete = <CompleteScreen token={TOKEN} view={view} />;

async function fillComplete(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Nombre"), "Ana Prueba");
  await user.type(screen.getByLabelText("Contraseña"), "una clave larga");
  for (const box of screen.getAllByRole("checkbox")) await user.click(box);
}

async function submitComplete(state: CompleteState) {
  answers(actions.completeRegistrationAction, state);
  const user = userEvent.setup();
  const rendered = render(complete);
  await fillComplete(user);
  await user.click(screen.getByRole("button", { name: "Confirmar mi correo" }));
  return { user, ...rendered };
}

describe("«Completa tu cuenta» (PA-14)", () => {
  it("en reposo: nombre, contraseña con su regla, y las tres casillas en su orden, ninguna marcada", async () => {
    const { container } = render(complete);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Completa tu cuenta");
    expect(screen.getByLabelText("Nombre")).toHaveAttribute("autocomplete", "name");
    const password = screen.getByLabelText("Contraseña");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAccessibleDescription("8 caracteres o más");
    // El correo no se vuelve a pedir.
    expect(screen.queryByLabelText("Correo")).not.toBeInTheDocument();

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(boxes[0]).toHaveAccessibleName(ADULT);
    expect(boxes[1]).toHaveAccessibleName(LEGAL);
    expect(boxes[2]).toHaveAccessibleName(HISTORY);
    expect(boxes[1]).toHaveAttribute("name", LEGAL_BOX);
    expect(boxes[2]).toHaveAttribute("name", "accept:course_history_consent");

    // El historial va en su bloque explicado, pintado desde el texto de la base.
    const history = screen.getByRole("group", { name: "Tu historial de cursos" });
    expect(history).toHaveTextContent("Guardamos qué cursos ves.");
    expect(history).toHaveTextContent("Sirve para retomar donde te quedaste.");
    expect(history).toHaveTextContent("Versión 2, vigente desde el 12 de noviembre de 2026.");

    // Cada texto se lee en otra pestaña, con la versión que la casilla anuncia.
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/legal/terms?v=2",
      "/legal/student_privacy_notice?v=2",
      "/legal/course_history_consent?v=2",
    ]);
    for (const link of links) expect(link).toHaveAttribute("target", "_blank");

    // La huella del enlace y lo que se pintó viajan ocultos.
    expect(container.querySelector('input[type="hidden"][name="token"]')).toHaveValue(TOKEN);
    expect([...container.querySelectorAll('input[name="shown"]')].map((input) => input.getAttribute("value"))).toEqual([
      `terms=${ID.terms}`,
      `student_privacy_notice=${ID.student_privacy_notice}`,
      `course_history_consent=${ID.course_history_consent}`,
    ]);
    // Sin sesión: aquí no hay «Cerrar sesión».
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("lo que falta se dice antes de enviar: no se llama a la acción, y lo escrito y lo marcado se quedan", async () => {
    const user = userEvent.setup();
    const { container } = render(complete);
    await user.type(screen.getByLabelText("Nombre"), "Ana");
    await user.type(screen.getByLabelText("Contraseña"), "corta");
    await user.click(screen.getByLabelText(ADULT));
    await user.click(screen.getByRole("button", { name: "Confirmar mi correo" }));

    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Hay 3 datos por corregir");
    expect(within(summary).getByRole("link", { name: "Tu contraseña necesita 8 caracteres o más." })).toHaveAttribute(
      "href",
      "#completar-contrasena",
    );
    expect(within(summary).getByRole("link", { name: "Falta aceptar los Términos y el Aviso de privacidad." })).toHaveAttribute(
      "href",
      "#completar-accept-legal",
    );
    expect(within(summary).getByRole("link", { name: "Falta tu permiso para guardar tu historial de cursos." })).toHaveAttribute(
      "href",
      "#completar-accept-course_history_consent",
    );
    expect(container.querySelector("#completar-accept-legal")).toBeInvalid();
    expect(container.querySelector("#completar-accept-course_history_consent")).toBeInvalid();
    expect(actions.completeRegistrationAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana");
    expect(screen.getByLabelText("Contraseña")).toHaveValue("corta");
    expect(screen.getByLabelText(ADULT)).toBeChecked();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin nada escrito, el resumen enlaza a los cinco datos", async () => {
    const user = userEvent.setup();
    render(complete);
    await user.click(screen.getByRole("button", { name: "Confirmar mi correo" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Hay 5 datos por corregir");
    expect(within(summary).getByRole("link", { name: "Escribe tu nombre." })).toHaveAttribute("href", "#completar-nombre");
    expect(within(summary).getByRole("link", { name: "Falta que declares tu edad." })).toHaveAttribute("href", "#completar-edad");
    expect(actions.completeRegistrationAction).not.toHaveBeenCalled();
  });

  it("completo, manda a la acción la huella, el nombre, la contraseña, la edad y cada casilla con los textos que se pintaron", async () => {
    await submitComplete({ kind: "unavailable", name: "Ana Prueba", attempt: 1 });
    expect(actions.completeRegistrationAction).toHaveBeenCalledOnce();
    const sent = formOf(actions.completeRegistrationAction);
    expect(sent).toMatchObject({
      token: TOKEN,
      name: "Ana Prueba",
      password: "una clave larga",
      adult: "on",
      [LEGAL_BOX]: "on",
      "accept:course_history_consent": "on",
    });
    expect(Object.keys(sent).sort()).toEqual(
      ["accept:course_history_consent", LEGAL_BOX, "adult", "name", "password", "shown", "token"].sort(),
    );
    expect(allOf(actions.completeRegistrationAction, "shown")).toHaveLength(3);
  });

  it("no se supo: lo dice, conserva el nombre y no devuelve la contraseña ni las casillas", async () => {
    const { container } = await submitComplete({ kind: "unavailable", name: "Ana Prueba", attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana Prueba");
    expect(screen.getByLabelText("Contraseña")).toHaveValue("");
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Confirmar mi correo" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("un texto cambió mientras se llenaba: su aviso, y las casillas sin marcar", async () => {
    await submitComplete({ kind: "repainted", name: "Ana Prueba", attempt: 1 });
    expect(await screen.findByText("Actualizamos un texto mientras llenabas el formulario. Léelo y marca de nuevo.")).toBeVisible();
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(screen.getByLabelText("Nombre")).toHaveValue("Ana Prueba");
  });

  it("lo que el servidor encuentra por corregir se dice en su campo y en el resumen", async () => {
    await submitComplete({
      kind: "invalid",
      name: "Ana Prueba",
      fields: { name: "invalid", password: "too_long", adult: true, boxes: [LEGAL_BOX] },
      attempt: 1,
    });
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Hay 4 datos por corregir");
    expect(within(summary).getByRole("link", { name: /Ese nombre tiene caracteres/ })).toBeVisible();
    expect(within(summary).getByRole("link", { name: "Esa contraseña es demasiado larga. Elige una más corta." })).toBeVisible();
    expect(within(summary).getByRole("link", { name: "Falta que declares tu edad." })).toBeVisible();
    expect(within(summary).getByRole("link", { name: "Falta aceptar los Términos y el Aviso de privacidad." })).toBeVisible();
    expect(screen.getByLabelText("Nombre")).toBeInvalid();
    expect(screen.getByLabelText("Contraseña")).toBeInvalid();
    expect(screen.getByLabelText(ADULT)).toBeInvalid();
  });

  it("enlace caducado o usado: «Ese enlace ya no sirve», con sus tres salidas y sin formulario", async () => {
    const { container } = await submitComplete({ kind: "link_dead" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Ese enlace ya no sirve");
    expect(screen.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/registro");
    expect(screen.getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("enlace gastado sin cuenta lista: manda a recuperar la contraseña, y a ningún otro lado", async () => {
    const { container } = await submitComplete({ kind: "recover_instead" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("No pudimos terminar tu registro");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin texto vigente de un documento obligatorio: no hay formulario ni sesión que cerrar", async () => {
    await submitComplete({ kind: "texts_unavailable" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("No podemos completar tu cuenta");
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir al inicio" })).toHaveAttribute("href", "/");
  });

  it("la regla de la contraseña se marca al cumplirse y se desmarca si deja de cumplirse", async () => {
    const user = userEvent.setup();
    render(complete);
    const password = screen.getByLabelText("Contraseña");
    await user.type(password, "1234567");
    expect(password).toHaveAccessibleDescription("8 caracteres o más");
    await user.type(password, "8");
    expect(password).toHaveAccessibleDescription("Cumplida: 8 caracteres o más");
    await user.type(password, "{Backspace}");
    expect(password).toHaveAccessibleDescription("8 caracteres o más");
  });

  it("al salir del campo, una contraseña corta se marca; una vacía, no", async () => {
    const user = userEvent.setup();
    render(complete);
    const password = screen.getByLabelText("Contraseña");
    await user.click(password);
    await user.tab();
    expect(password).not.toBeInvalid();
    await user.type(password, "corta");
    await user.click(screen.getByLabelText("Nombre"));
    expect(password).toBeInvalid();
    expect(screen.getByText("Tu contraseña necesita 8 caracteres o más.")).toBeVisible();
    await user.type(password, " pero ya no");
    await user.click(screen.getByLabelText("Nombre"));
    expect(password).not.toBeInvalid();
    expect(actions.completeRegistrationAction).not.toHaveBeenCalled();
  });

  it("al salir del campo, un nombre demasiado largo se marca", async () => {
    const user = userEvent.setup();
    render(complete);
    await user.click(screen.getByLabelText("Nombre"));
    await user.paste("x".repeat(121));
    await user.tab();
    expect(screen.getByLabelText("Nombre")).toBeInvalid();
    expect(screen.getByText("Ese nombre es demasiado largo. Escribe uno más corto.")).toBeVisible();
  });
});

async function submitRecover(state: MailRequestState, email = "ana@prueba.test") {
  answers(actions.requestRecoveryAction, state);
  const user = userEvent.setup();
  const rendered = render(<RecoverScreen notice="Para entrar a esta cuenta hay que elegir su contraseña desde tu correo." />);
  await user.type(screen.getByLabelText("Correo"), email);
  await user.click(screen.getByRole("button", { name: "Mandarme el enlace" }));
  return { user, ...rendered };
}

describe("recuperar la contraseña, «pedir» (PA-13)", () => {
  it("en reposo: un título, una frase, un campo, el botón y la salida a entrar", async () => {
    const { container } = render(<RecoverScreen notice={null} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Recupera tu contraseña");
    expect(screen.getByText("Escribe tu correo y te mandamos un enlace para elegir una contraseña nueva.")).toBeVisible();
    expect(screen.getByLabelText("Correo")).toHaveAttribute("type", "email");
    expect(container.querySelectorAll("input")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Volver a entrar" })).toHaveAttribute("href", "/entrar");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("pinta el aviso con el que se llegó, y lo quita con la primera respuesta", async () => {
    const notice = "Para entrar a esta cuenta hay que elegir su contraseña desde tu correo.";
    const { unmount, container } = render(<RecoverScreen notice={notice} />);
    expect(screen.getByText(notice)).toBeVisible();
    expect(await a11yViolations(container)).toEqual([]);
    unmount();
    await submitRecover({ kind: "sent", lifetimeSeconds: 3_600, attempt: 1 });
    expect(await screen.findByText(/Si ese correo tiene cuenta/)).toBeVisible();
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it("manda a la acción el correo y nada más", async () => {
    await submitRecover({ kind: "sent", lifetimeSeconds: 3_600, attempt: 1 });
    expect(actions.requestRecoveryAction).toHaveBeenCalledOnce();
    expect(formOf(actions.requestRecoveryAction)).toEqual({ email: "ana@prueba.test" });
  });

  it("enviado: el mensaje único, con lo que dura el enlace, y el correo no se repite", async () => {
    const { container } = await submitRecover({ kind: "sent", lifetimeSeconds: 3_600, attempt: 1 });
    expect(await screen.findByText("Si ese correo tiene cuenta, te mandamos un enlace. Dura 1 hora.")).toBeVisible();
    expect(screen.getByLabelText("Correo")).toHaveValue("");
    expect(container).not.toHaveTextContent("ana@prueba.test");
    expect(screen.getByRole("button", { name: "Mandarme el enlace" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("enviado sin saber cuánto dura el enlace: el mismo mensaje, sin la cifra", async () => {
    await submitRecover({ kind: "sent", lifetimeSeconds: null, attempt: 1 });
    expect(await screen.findByText("Si ese correo tiene cuenta, te mandamos un enlace.")).toBeVisible();
    expect(screen.queryByText(/Dura/)).not.toBeInTheDocument();
  });

  it.each([
    ["wait", "Espera un momento antes de intentarlo de nuevo."],
    ["unavailable", "No pudimos hacerlo. Intenta de nuevo en un momento."],
  ] as const)("%s: lo dice en una alerta y conserva el correo", async (reason, message) => {
    await submitRecover({ kind: "failed", email: "ana@prueba.test", reason, attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("Correo")).toHaveValue("ana@prueba.test");
    expect(screen.queryByText(/Si ese correo tiene cuenta/)).not.toBeInTheDocument();
  });

  it("correo por corregir: el campo marcado y un resumen que enlaza a él", async () => {
    await submitRecover({ kind: "invalid", email: "ana", field: "invalid", attempt: 1 }, "ana");
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Ese correo no tiene forma de correo. Revísalo." })).toHaveAttribute(
      "href",
      "#recuperar-correo",
    );
    expect(screen.getByLabelText("Correo")).toBeInvalid();
  });
});

async function submitChange(state: ChangePasswordState, password = "una clave larga") {
  answers(actions.completeRecoveryAction, state);
  const user = userEvent.setup();
  const rendered = render(<ChangePasswordScreen token={TOKEN} />);
  await user.type(screen.getByLabelText("Contraseña nueva"), password);
  await user.click(screen.getByRole("button", { name: "Guardar contraseña" }));
  return { user, ...rendered };
}

describe("recuperar la contraseña, «cambiar» (PA-13)", () => {
  it("en reposo: la contraseña nueva con su regla, y la huella del enlace oculta", async () => {
    const { container } = render(<ChangePasswordScreen token={TOKEN} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Elige tu contraseña nueva");
    const password = screen.getByLabelText("Contraseña nueva");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAccessibleDescription("8 caracteres o más");
    expect(container.querySelector('input[type="hidden"][name="token"]')).toHaveValue(TOKEN);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("una contraseña que no cumple la regla no se envía: no le gasta el enlace a nadie", async () => {
    const { container } = await submitChange({ kind: "link_dead" }, "corta");
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Tu contraseña necesita 8 caracteres o más." })).toHaveAttribute(
      "href",
      "#recuperar-contrasena",
    );
    expect(actions.completeRecoveryAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Contraseña nueva")).toHaveValue("corta");
    expect(screen.getByLabelText("Contraseña nueva")).toBeInvalid();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("vacía tampoco se envía", async () => {
    const user = userEvent.setup();
    render(<ChangePasswordScreen token={TOKEN} />);
    await user.click(screen.getByRole("button", { name: "Guardar contraseña" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tu contraseña necesita 8 caracteres o más.");
    expect(actions.completeRecoveryAction).not.toHaveBeenCalled();
  });

  it("corregida, se envía: manda la huella y la contraseña, y nada más", async () => {
    answers<ChangePasswordState>(actions.completeRecoveryAction, { kind: "unavailable", attempt: 1 });
    const user = userEvent.setup();
    render(<ChangePasswordScreen token={TOKEN} />);
    await user.type(screen.getByLabelText("Contraseña nueva"), "corta");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña" }));
    expect(actions.completeRecoveryAction).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Contraseña nueva"), " pero ya no");
    await user.click(screen.getByRole("button", { name: "Guardar contraseña" }));
    expect(actions.completeRecoveryAction).toHaveBeenCalledOnce();
    expect(formOf(actions.completeRecoveryAction)).toEqual({ token: TOKEN, password: "corta pero ya no" });
  });

  it("no se supo: lo dice, y el campo vuelve vacío", async () => {
    await submitChange({ kind: "unavailable", attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(screen.getByLabelText("Contraseña nueva")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Guardar contraseña" })).toBeEnabled();
  });

  it.each([
    ["too_short", "Tu contraseña necesita 8 caracteres o más."],
    ["too_long", "Esa contraseña es demasiado larga. Elige una más corta."],
    ["malformed", "Esa contraseña tiene caracteres que no podemos guardar. Elige otra."],
  ] as const)("contraseña que el servidor rechaza (%s): el error en su campo", async (problem, message) => {
    await submitChange({ kind: "invalid", problem, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: message })).toHaveAttribute("href", "#recuperar-contrasena");
    expect(screen.getByLabelText("Contraseña nueva")).toBeInvalid();
  });

  it("enlace caducado o usado: «Ese enlace ya no sirve» y «Pedir otro»", async () => {
    const { container } = await submitChange({ kind: "link_dead" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Ese enlace ya no sirve");
    expect(screen.getByRole("link", { name: "Pedir otro" })).toHaveAttribute("href", "/recuperar");
    expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("enlace gastado sin cambio hecho: «No pudimos terminar el cambio» y «Pedir otro»", async () => {
    const { container } = await submitChange({ kind: "request_new_link" });
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("No pudimos terminar el cambio");
    expect(screen.getByRole("link", { name: "Pedir otro" })).toHaveAttribute("href", "/recuperar");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("las pantallas de un enlace que ya no sirve", () => {
  it.each([
    ["el de registro, caducado", <RegistrationLinkDeadScreen key="a" />, "Ese enlace ya no sirve"],
    ["el de registro, gastado", <RegistrationUnfinishedScreen key="b" />, "No pudimos terminar tu registro"],
    ["el de recuperación, caducado", <RecoveryLinkDeadScreen key="c" />, "Ese enlace ya no sirve"],
    ["el de recuperación, gastado", <RecoveryUnfinishedScreen key="d" />, "No pudimos terminar el cambio"],
  ])("%s: un título que toma el foco, una salida principal y ninguna falta de accesibilidad", async (_name, element, title) => {
    const { container } = render(element);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(title);
    expect(heading).toHaveFocus();
    expect(screen.getAllByRole("link").length).toBeGreaterThanOrEqual(1);
    expect(await a11yViolations(container)).toEqual([]);
  });
});
