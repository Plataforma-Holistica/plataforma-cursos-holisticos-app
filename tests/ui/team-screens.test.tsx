import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Las dos pantallas del segundo factor (PA-12). Las acciones de servidor son la frontera con
// el servicio: aquí se cambian por lo que contestarían, para ver qué pinta cada pantalla con
// cada respuesta. Lo que hacen de verdad lo prueban sus tablas y el extremo a extremo.
const actions = vi.hoisted(() => ({
  giveCodeAction: vi.fn(),
  startSecondFactorAction: vi.fn(),
  confirmSecondFactorAction: vi.fn(),
  signOutAction: vi.fn(),
}));
vi.mock("@/app/(cuenta)/entrar/segundo-factor/actions", () => ({ giveCodeAction: actions.giveCodeAction }));
vi.mock("@/app/(cuenta)/entrar/segundo-factor/configurar/actions", () => ({
  startSecondFactorAction: actions.startSecondFactorAction,
  confirmSecondFactorAction: actions.confirmSecondFactorAction,
}));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: actions.signOutAction }));

import type { FactorSetupView } from "@/app/_lib/guard-steps";
import type { ConfirmState, StartState } from "@/app/(cuenta)/entrar/segundo-factor/configurar/outcomes";
import { FactorSetupScreen } from "@/app/(cuenta)/entrar/segundo-factor/configurar/screen";
import type { GiveCodeState } from "@/app/(cuenta)/entrar/segundo-factor/outcomes";
import { SecondFactorScreen, SecondFactorUnboundScreen } from "@/app/(cuenta)/entrar/segundo-factor/screen";

import { a11yViolations } from "../setup/a11y";

beforeEach(() => vi.clearAllMocks());

const FACTOR = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/Plataforma:ana%40prueba.test?secret=${SECRET}&issuer=Plataforma`;
const QR = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";

const formOf = (action: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries(action.mock.calls[call]?.[1] as FormData);
/** Todo lo que el documento lleva en un campo, visible u oculto. */
const fieldValues = (container: HTMLElement) => [...container.querySelectorAll("input, textarea")].map((field) => (field as HTMLInputElement).value);

describe("la pantalla de dar el código (PA-12, pedir)", () => {
  async function submitCode(state: GiveCodeState, typed = "123 456") {
    actions.giveCodeAction.mockResolvedValue(state);
    const user = userEvent.setup();
    const view = render(<SecondFactorScreen returnTo="/admin/equipo" />);
    await user.type(screen.getByLabelText("Código"), typed);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    return { user, ...view };
  }

  it("en reposo: el título, el campo del código que se puede pegar y llenar solo, y sus dos salidas", async () => {
    const { container } = render(<SecondFactorScreen returnTo="/admin/equipo" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Escribe tu código");
    expect(screen.getByText("Ábrelo en tu aplicación de códigos.")).toBeVisible();
    const code = screen.getByLabelText("Código");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    // Sin tope de largo: pegar «123 456» no se corta.
    expect(code).not.toHaveAttribute("maxlength");
    expect(code).toHaveValue("");
    // El destino guardado viaja con el formulario, tal como llegó: lo valida la acción.
    expect(container.querySelector('input[type="hidden"][name="volver"]')).toHaveValue("/admin/equipo");
    expect(screen.getByRole("link", { name: "Ir a mi inicio" })).toHaveAttribute("href", "/inicio");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
    // No hay códigos de respaldo que ofrecer.
    expect(screen.queryByText(/respaldo/i)).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("manda a la acción el código y el destino, y nada más", async () => {
    await submitCode({ kind: "failed", reason: "wrong_code", attempt: 1 });
    expect(actions.giveCodeAction).toHaveBeenCalledOnce();
    expect(formOf(actions.giveCodeAction)).toEqual({ code: "123 456", volver: "/admin/equipo" });
  });

  it("el código no coincide: el campo queda marcado y vacío, con un resumen que enlaza a él", async () => {
    const { container } = await submitCode({ kind: "failed", reason: "wrong_code", attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Ese código no coincide. Revisa que sea el más reciente." })).toHaveAttribute(
      "href",
      "#segundo-factor-codigo",
    );
    expect(screen.getByLabelText("Código")).toBeInvalid();
    // El código nunca vuelve: el campo se arma de nuevo, vacío.
    expect(screen.getByLabelText("Código")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each([
    ["required", "Escribe tu código."],
    ["invalid", "El código son seis dígitos. Revísalo."],
  ] as const)("revisado en el servidor y sin forma (%s): lo dice en el campo", async (problem, message) => {
    await submitCode({ kind: "invalid", problem, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: message })).toHaveAttribute("href", "#segundo-factor-codigo");
    expect(screen.getByLabelText("Código")).toBeInvalid();
  });

  it("no se supo: lo dice en una alerta, sin marcar el campo", async () => {
    await submitCode({ kind: "failed", reason: "unavailable", attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(screen.getByLabelText("Código")).not.toBeInvalid();
  });

  it("un segundo fallo igual se vuelve a anunciar, y no deja dos avisos en pantalla", async () => {
    const { user } = await submitCode({ kind: "failed", reason: "unavailable", attempt: 1 });
    await screen.findByRole("alert");
    actions.giveCodeAction.mockResolvedValue({ kind: "failed", reason: "unavailable", attempt: 2 });
    await user.type(screen.getByLabelText("Código"), "654321");
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    await vi.waitFor(() => expect(actions.giveCodeAction).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByRole("alert")).toHaveLength(1);
  });

  it("cuenta suspendida: la pantalla es PA-35, sin formulario y con «Cerrar sesión»", async () => {
    const { container } = await submitCode({ kind: "suspended" });
    expect(await screen.findByRole("heading", { level: 1, name: "Tu cuenta está suspendida" })).toBeVisible();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("al salir del campo, un código sin forma se marca; uno vacío, o con espacios de más, no", async () => {
    const user = userEvent.setup();
    render(<SecondFactorScreen returnTo="" />);
    await user.click(screen.getByLabelText("Código"));
    await user.tab();
    expect(screen.getByLabelText("Código")).not.toBeInvalid();
    await user.type(screen.getByLabelText("Código"), "12a456");
    await user.tab();
    expect(await screen.findByText("El código son seis dígitos. Revísalo.")).toBeVisible();
    expect(screen.getByLabelText("Código")).toBeInvalid();
    await user.clear(screen.getByLabelText("Código"));
    await user.type(screen.getByLabelText("Código"), " 123 456 ");
    await user.tab();
    await vi.waitFor(() => expect(screen.getByLabelText("Código")).not.toBeInvalid());
    expect(actions.giveCodeAction).not.toHaveBeenCalled();
  });

  it("«Cerrar sesión» es su propio formulario: no envía el código", async () => {
    const user = userEvent.setup();
    render(<SecondFactorScreen returnTo="/admin" />);
    await user.type(screen.getByLabelText("Código"), "123456");
    await user.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(actions.signOutAction).toHaveBeenCalledOnce();
    expect(actions.giveCodeAction).not.toHaveBeenCalled();
  });
});

describe("quien perdió su atadura y no tiene invitación (PA-12)", () => {
  it("le dice qué pasó y a quién pedírselo, con sus dos salidas y sin campo de código", async () => {
    const { container } = render(<SecondFactorUnboundScreen />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu segundo factor ya no está");
    expect(screen.getByText(/Pide a alguien del equipo con configuración que te mande otra\./)).toBeVisible();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a mi inicio" })).toHaveAttribute("href", "/inicio");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("la pantalla de configurar el segundo factor (PA-12, configurar)", () => {
  const START: FactorSetupView = { view: "start", handoff: false };
  const STARTED: StartState = { kind: "started", factorId: FACTOR, secret: SECRET, uri: URI, qr: QR, attempt: 1 };

  /** Pinta la pantalla y pulsa «Empezar», que contesta lo que se le diga. */
  async function begin(state: StartState = STARTED, view: FactorSetupView = START) {
    actions.startSecondFactorAction.mockResolvedValue(state);
    const user = userEvent.setup();
    const rendered = render(<FactorSetupScreen view={view} />);
    await user.click(screen.getByRole("button", { name: "Empezar" }));
    return { user, ...rendered };
  }

  /** Empieza y envía un código, que contesta lo que se le diga. */
  async function confirm(state: ConfirmState, view: FactorSetupView = START) {
    actions.confirmSecondFactorAction.mockResolvedValue(state);
    const started = await begin(STARTED, view);
    await started.user.type(await screen.findByLabelText("Código"), "123456");
    await started.user.click(screen.getByRole("button", { name: "Continuar" }));
    await vi.waitFor(() => expect(actions.confirmSecondFactorAction).toHaveBeenCalledOnce());
    return started;
  }

  it("sin el buzón probado: le pide abrir el enlace de su correo en este navegador, y no ofrece empezar", async () => {
    const { container } = render(<FactorSetupScreen view={{ view: "prove_mailbox" }} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Primero abre el enlace de tu correo");
    expect(screen.getByText(/abre el enlace en este mismo navegador\. Si cierras sesión aquí, tendrás que repetirlo\./)).toBeVisible();
    expect(screen.getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
    expect(screen.getByRole("link", { name: "Ir a mi inicio" })).toHaveAttribute("href", "/inicio");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Empezar" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("antes de empezar: dice qué va a pasar con la clave, y no pide ningún código todavía", async () => {
    const { container } = render(<FactorSetupScreen view={START} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Configura tu segundo factor");
    expect(screen.getByText(/Si recargas la página o empiezas de nuevo, la clave cambia y la anterior deja de servir\./)).toBeVisible();
    expect(screen.getByRole("button", { name: "Empezar" })).toBeEnabled();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a mi inicio" })).toHaveAttribute("href", "/inicio");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("«Empezar» no manda nada del formulario", async () => {
    await begin();
    expect(actions.startSecondFactorAction).toHaveBeenCalledOnce();
    expect(formOf(actions.startSecondFactorAction)).toEqual({});
  });

  it("empezado: pinta el código QR como imagen, la clave en texto y el enlace a la aplicación, y pide el código", async () => {
    const { container } = await begin();
    const qr = await screen.findByRole("img", { name: "Código QR con la clave de tu segundo factor" });
    // Como imagen, con una dirección de datos: lo que Auth mande nunca se incrusta como marcado.
    expect(qr.tagName).toBe("IMG");
    expect(qr).toHaveAttribute("src", QR);
    expect(container.querySelector("svg rect, main svg[xmlns]")).toBeNull();
    expect(screen.getByText(SECRET)).toBeVisible();
    expect(screen.getByRole("link", { name: "Abrir en mi aplicación de códigos" })).toHaveAttribute("href", URI);
    expect(screen.getByLabelText("Código")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la clave no viaja en ningún campo: solo el factor que se pintó, para compararlo", async () => {
    const { container } = await begin();
    await screen.findByText(SECRET);
    for (const value of fieldValues(container)) {
      expect(value).not.toContain(SECRET);
      expect(value).not.toContain("otpauth");
    }
    expect(container.querySelector('input[type="hidden"][name="painted"]')).toHaveValue(FACTOR);
  });

  it("con la clave a la vista no queda ningún formulario de «Empezar»: «Empezar de nuevo» es un enlace que vuelve a pedir la página", async () => {
    await begin();
    await screen.findByText(SECRET);
    expect(screen.queryByRole("button", { name: "Empezar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Empezar de nuevo" })).not.toBeInTheDocument();
    const again = screen.getByRole("link", { name: "Empezar de nuevo" });
    expect(again).toHaveAttribute("href", "/entrar/segundo-factor/configurar");
    expect(again.closest("form")).toBeNull();
  });

  it("si Auth no mandó una imagen que se entienda, la clave en texto basta", async () => {
    await begin({ ...STARTED, qr: null });
    expect(await screen.findByText(SECRET)).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Código")).toBeInTheDocument();
  });

  it("manda a confirmar el código y el factor pintado, y nada más", async () => {
    await confirm({ kind: "invalid", fields: { code: "wrong" }, attempt: 1 });
    expect(formOf(actions.confirmSecondFactorAction)).toEqual({ code: "123456", painted: FACTOR });
  });

  it("enviado el código, la clave deja de pintarse, salga bien o mal", async () => {
    const { container } = await confirm({ kind: "invalid", fields: { code: "wrong" }, attempt: 1 });
    await vi.waitFor(() => expect(screen.queryByText(SECRET)).not.toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Abrir en mi aplicación de códigos" })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(SECRET);
    // Sigue pudiendo dar su código, y empezar de nuevo si ya no tiene la clave.
    expect(screen.getByText(/Ya empezaste a configurarlo en este navegador\./)).toBeVisible();
    expect(screen.getByLabelText("Código")).toHaveValue("");
    expect(screen.getByRole("link", { name: "Empezar de nuevo" })).toHaveAttribute("href", "/entrar/segundo-factor/configurar");
  });

  it("al salir de la página la clave deja de pintarse: volver con «atrás» no la enseña", async () => {
    const { container } = await begin();
    await screen.findByText(SECRET);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(container.querySelector('input[type="hidden"][name="painted"]')).toHaveValue(FACTOR);
  });

  it("el código no coincide: el campo queda marcado y vacío, con un resumen que enlaza a él", async () => {
    const { container } = await confirm({ kind: "invalid", fields: { code: "wrong" }, attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Ese código no coincide. Revisa que sea el más reciente." })).toHaveAttribute(
      "href",
      "#configurar-codigo",
    );
    expect(screen.getByLabelText("Código")).toBeInvalid();
    expect(screen.getByLabelText("Código")).toHaveValue("");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("la clave ya no es la vigente: lo avisa, deja de pedir el código y ofrece empezar de nuevo", async () => {
    await confirm({ kind: "start_again", attempt: 1 });
    expect(await screen.findByText("Esa clave ya no es la vigente. Empieza de nuevo para ver una nueva.")).toBeVisible();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Empezar de nuevo" })).toHaveAttribute("href", "/entrar/segundo-factor/configurar");
  });

  it("no se supo al confirmar: lo dice en una alerta y deja reintentar", async () => {
    await confirm({ kind: "unavailable", attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(screen.getByLabelText("Código")).not.toBeInvalid();
    expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
  });

  it("no se supo al empezar: lo dice, y «Empezar» sigue ahí", async () => {
    await begin({ kind: "unavailable", attempt: 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos hacerlo. Intenta de nuevo en un momento.");
    expect(screen.getByRole("button", { name: "Empezar" })).toBeEnabled();
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
  });

  it.each([
    ["al empezar", () => begin({ kind: "needs_mailbox_proof" })],
    ["al confirmar", () => confirm({ kind: "needs_mailbox_proof" })],
  ])("el buzón dejó de estar probado %s: pasa a pedirlo, sin la clave en pantalla", async (_when, run) => {
    const { container } = await run();
    expect(await screen.findByRole("heading", { level: 1, name: "Primero abre el enlace de tu correo" })).toBeVisible();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
  });

  it("la cuenta ya tiene un factor que nadie ató: le dice que recupere su contraseña en este navegador", async () => {
    await begin({ kind: "needs_second_level" });
    expect(await screen.findByText(/Tu cuenta ya tiene un segundo factor que no quedó ligado a tu invitación\./)).toBeVisible();
    expect(screen.getByRole("link", { name: "Recuperar mi contraseña" })).toHaveAttribute("href", "/recuperar");
    expect(screen.queryByRole("button", { name: "Empezar" })).not.toBeInTheDocument();
  });

  it.each([
    ["al empezar", () => begin({ kind: "suspended" })],
    ["al confirmar", () => confirm({ kind: "suspended" })],
  ])("cuenta suspendida %s: la pantalla es PA-35, sin la clave", async (_when, run) => {
    const { container } = await run();
    expect(await screen.findByRole("heading", { level: 1, name: "Tu cuenta está suspendida" })).toBeVisible();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeEnabled();
  });

  describe("un restablecimiento, que pide además el código dictado", () => {
    const REBIND: FactorSetupView = { view: "start", handoff: true };

    it("pinta su campo junto al del código, y los dos viajan a confirmar", async () => {
      actions.confirmSecondFactorAction.mockResolvedValue({ kind: "invalid", fields: { handoff: "wrong" }, attempt: 1 });
      const { user, container } = await begin(STARTED, REBIND);
      const handoff = await screen.findByLabelText("Código que te dictaron");
      expect(handoff).toHaveAttribute("autocomplete", "off");
      expect(screen.getByText("Te lo dicta quien restableció tu segundo factor.")).toBeVisible();
      expect(await a11yViolations(container)).toEqual([]);

      await user.type(handoff, "ab12-cd34");
      await user.type(screen.getByLabelText("Código"), "123456");
      await user.click(screen.getByRole("button", { name: "Continuar" }));
      await vi.waitFor(() => expect(actions.confirmSecondFactorAction).toHaveBeenCalledOnce());
      expect(formOf(actions.confirmSecondFactorAction)).toEqual({ code: "123456", handoff: "ab12-cd34", painted: FACTOR });
    });

    it.each([
      ["required", "Escribe el código que te dictaron."],
      ["wrong", "Ese código no coincide con el que te dictaron. Pídelo de nuevo."],
    ] as const)("el código dictado %s: su campo queda marcado, y el resumen enlaza a él", async (problem, message) => {
      await confirm({ kind: "invalid", fields: { handoff: problem }, attempt: 1 }, REBIND);
      const summary = await screen.findByRole("alert");
      expect(within(summary).getByRole("link", { name: message })).toHaveAttribute("href", "#configurar-codigo-dictado");
      expect(screen.getByLabelText("Código que te dictaron")).toBeInvalid();
      expect(screen.getByLabelText("Código")).not.toBeInvalid();
    });

    it("sin restablecimiento no se pide", async () => {
      await begin();
      await screen.findByLabelText("Código");
      expect(screen.queryByLabelText("Código que te dictaron")).not.toBeInTheDocument();
    });
  });

  describe("con un factor ya empezado en ese navegador", () => {
    const RESUME: FactorSetupView = { view: "resume", painted: OTHER, handoff: false };

    it("pide el código sin volver a pintar la clave, y manda de vuelta el factor que traía el navegador", async () => {
      actions.confirmSecondFactorAction.mockResolvedValue({ kind: "invalid", fields: { code: "wrong" }, attempt: 1 });
      const user = userEvent.setup();
      const { container } = render(<FactorSetupScreen view={RESUME} />);
      expect(screen.getByText(/Ya empezaste a configurarlo en este navegador\./)).toBeVisible();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Empezar" })).not.toBeInTheDocument();
      expect(await a11yViolations(container)).toEqual([]);

      await user.type(screen.getByLabelText("Código"), "123456");
      await user.click(screen.getByRole("button", { name: "Continuar" }));
      await vi.waitFor(() => expect(actions.confirmSecondFactorAction).toHaveBeenCalledOnce());
      expect(formOf(actions.confirmSecondFactorAction)).toEqual({ code: "123456", painted: OTHER });
    });

    it("«Empezar de nuevo» sí es un formulario: aquí el estado de «Empezar» no trae ninguna clave", async () => {
      actions.startSecondFactorAction.mockResolvedValue(STARTED);
      const user = userEvent.setup();
      const { container } = render(<FactorSetupScreen view={RESUME} />);
      await user.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
      // La clave nueva se pinta, y lo pintado pasa a ser el factor nuevo.
      expect(await screen.findByText(SECRET)).toBeVisible();
      expect(container.querySelector('input[type="hidden"][name="painted"]')).toHaveValue(FACTOR);
      expect(screen.queryByRole("button", { name: "Empezar de nuevo" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Empezar de nuevo" })).toBeVisible();
    });

    it("una clave nueva se pinta aunque antes se haya enviado un código con la anterior", async () => {
      actions.confirmSecondFactorAction.mockResolvedValue({ kind: "invalid", fields: { code: "wrong" }, attempt: 1 });
      actions.startSecondFactorAction.mockResolvedValue(STARTED);
      const user = userEvent.setup();
      render(<FactorSetupScreen view={RESUME} />);
      await user.type(screen.getByLabelText("Código"), "123456");
      await user.click(screen.getByRole("button", { name: "Continuar" }));
      await vi.waitFor(() => expect(actions.confirmSecondFactorAction).toHaveBeenCalledOnce());
      await user.click(await screen.findByRole("button", { name: "Empezar de nuevo" }));
      expect(await screen.findByText(SECRET)).toBeVisible();
    });

    it("si esa clave ya no es la vigente, deja de pedir el código y «Empezar de nuevo» da una nueva", async () => {
      actions.confirmSecondFactorAction.mockResolvedValue({ kind: "start_again", attempt: 1 });
      actions.startSecondFactorAction.mockResolvedValue(STARTED);
      const user = userEvent.setup();
      render(<FactorSetupScreen view={RESUME} />);
      await user.type(screen.getByLabelText("Código"), "123456");
      await user.click(screen.getByRole("button", { name: "Continuar" }));
      expect(await screen.findByText("Esa clave ya no es la vigente. Empieza de nuevo para ver una nueva.")).toBeVisible();
      expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
      await vi.waitFor(() => expect(actions.startSecondFactorAction).toHaveBeenCalledOnce());
    });
  });
});
