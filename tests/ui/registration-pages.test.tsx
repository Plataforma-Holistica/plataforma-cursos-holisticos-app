import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Las páginas de registro, verificación y recuperación, con la guarda y los servicios
// simulados: qué pinta cada una con cada respuesta, y qué no le pregunta a nadie.

const mocks = vi.hoisted(() => ({
  visitorOnly: vi.fn(),
  cookieReader: vi.fn(),
  accountFormFacts: vi.fn(),
  readNotice: vi.fn(),
  readRegistration: vi.fn(),
  rememberRegistration: vi.fn(),
  forgetRegistration: vi.fn(),
  connection: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/app/_lib/guard", () => ({ visitorOnly: mocks.visitorOnly }));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", async () => ({
  accountFormFacts: mocks.accountFormFacts,
  isLinkToken: (await import("@/adapters/supabase/tokens")).isLinkToken,
}));
vi.mock("@/services/account/notice", () => ({ readNotice: mocks.readNotice }));
vi.mock("@/services/account/pending-registration", () => ({
  readRegistration: mocks.readRegistration,
  rememberRegistration: mocks.rememberRegistration,
  forgetRegistration: mocks.forgetRegistration,
}));
vi.mock("@/services/legal/texts", async () => ({ ...(await import("@/services/legal/slugs")) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: mocks.connection }));
vi.mock("@/app/(cuenta)/registro/actions", () => ({ requestRegistrationAction: vi.fn() }));
vi.mock("@/app/(cuenta)/verificar/actions", () => ({ resendAction: vi.fn(), notMyEmailAction: vi.fn() }));
vi.mock("@/app/(cuenta)/verificar/[token]/actions", () => ({ completeRegistrationAction: vi.fn() }));
vi.mock("@/app/(cuenta)/recuperar/actions", () => ({ requestRecoveryAction: vi.fn() }));
vi.mock("@/app/(cuenta)/recuperar/[token]/actions", () => ({ completeRecoveryAction: vi.fn() }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import { forgetFormFacts } from "@/app/(cuenta)/_lib/link-facts";
import ChangePasswordPage from "@/app/(cuenta)/recuperar/[token]/page";
import RecoverPage from "@/app/(cuenta)/recuperar/page";
import SignUpPage from "@/app/(cuenta)/registro/page";
import CompletePage from "@/app/(cuenta)/verificar/[token]/page";
import CheckMailPage from "@/app/(cuenta)/verificar/page";

const reader = { get: () => undefined };
const TOKEN = "abcdefgh12345678";
const at = (token: string) => ({ params: Promise.resolve({ token }) });

let texts = 0;
const text = (docType: string, title: string) => ({
  docType,
  // Cada texto con su identificador, como en la base: dos tipos pueden medir lo mismo.
  documentId: `${(texts += 1).toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
  version: 2,
  title,
  body: "Texto.",
  effectiveFrom: "2026-11-12T06:00:00.000Z",
});
const facts = {
  kind: "ready",
  texts: [text("terms", "Términos"), text("student_privacy_notice", "Aviso"), text("course_history_consent", "Historial")],
  minimumAge: 18,
  linkLifetimeMinutes: 60,
  resendWaitSeconds: 60,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  // Lo que las páginas recuerdan de la base no pasa de un caso al siguiente.
  forgetFormFacts();
  mocks.cookieReader.mockResolvedValue(reader);
  mocks.readNotice.mockReturnValue(null);
  mocks.readRegistration.mockReturnValue(null);
});

describe("la página de registro (PA-10)", () => {
  it("es de visitante: pasa por su guarda antes de pintar, y enlaza a los dos textos legales", async () => {
    render(await SignUpPage());
    expect(mocks.visitorOnly).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Crea tu cuenta");
    expect(screen.getByRole("link", { name: /Términos/ })).toHaveAttribute("href", "/legal/terminos");
    expect(screen.getByRole("link", { name: /Aviso de privacidad/ })).toHaveAttribute("href", "/legal/privacidad");
    // No lee nada de la base.
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
  });

  it("si la guarda redirige, no pinta nada", async () => {
    mocks.visitorOnly.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(SignUpPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("la página de «Revisa tu correo» (PA-14)", () => {
  it("sin correo anotado: el texto genérico, y no lee nada de la base", async () => {
    render(await CheckMailPage());
    expect(mocks.readRegistration).toHaveBeenCalledExactlyOnceWith(reader);
    expect(screen.getByText("Te mandamos un enlace al correo que escribiste. Ábrelo para completar tu cuenta.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Escribir mi correo otra vez" })).toHaveAttribute("href", "/registro");
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
    // No pasa por la guarda de visitante: se pinta haya o no sesión.
    expect(mocks.visitorOnly).not.toHaveBeenCalled();
  });

  it("con un envío reciente: dice el correo y lo que dura el enlace, y «Reenviar» espera", async () => {
    mocks.readRegistration.mockReturnValue({ email: "ana@prueba.test", sentAt: Date.now() - 5_000 });
    mocks.accountFormFacts.mockResolvedValue(facts);
    render(await CheckMailPage());
    expect(screen.getByText("Te mandamos un enlace a ana@prueba.test. Ábrelo para completar tu cuenta.")).toBeVisible();
    expect(screen.getByText("Dura 1 hora.")).toBeVisible();
    const button = screen.getByRole("button", { name: "Reenviar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Podrás reenviarlo en 1 minuto.");
  });

  it("con un registro anotado tampoco lee la base en cada visita", async () => {
    mocks.readRegistration.mockReturnValue({ email: "ana@prueba.test", sentAt: Date.now() - 5_000 });
    mocks.accountFormFacts.mockResolvedValue(facts);
    for (let visit = 0; visit < 3; visit += 1) {
      const { unmount } = render(await CheckMailPage());
      expect(screen.getByText("Dura 1 hora.")).toBeVisible();
      unmount();
    }
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });

  it("con un envío de hace más que la espera: «Reenviar» ya sirve", async () => {
    mocks.readRegistration.mockReturnValue({ email: "ana@prueba.test", sentAt: Date.now() - 61_000 });
    mocks.accountFormFacts.mockResolvedValue(facts);
    render(await CheckMailPage());
    expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
  });

  it.each([{ kind: "unavailable" }, { kind: "no_current_text" }])(
    "si no se supo cuánto dura ni cuánto se espera (%j), lo calla y deja reenviar",
    async (answer) => {
      mocks.readRegistration.mockReturnValue({ email: "ana@prueba.test", sentAt: Date.now() });
      mocks.accountFormFacts.mockResolvedValue(answer);
      render(await CheckMailPage());
      expect(screen.getByText("Te mandamos un enlace a ana@prueba.test. Ábrelo para completar tu cuenta.")).toBeVisible();
      expect(screen.queryByText(/^Dura /)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reenviar" })).toBeEnabled();
    },
  );
});

describe("la página de «Completa tu cuenta» (PA-14)", () => {
  it("con un enlace con forma: pinta el formulario con los textos vigentes y la huella oculta", async () => {
    mocks.accountFormFacts.mockResolvedValue(facts);
    const { container } = render(await CompletePage(at(TOKEN)));
    expect(mocks.connection).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Completa tu cuenta");
    expect(container.querySelector('input[type="hidden"][name="token"]')).toHaveValue(TOKEN);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/legal/terminos?v=2",
      "/legal/privacidad?v=2",
      "/legal/historial-de-cursos?v=2",
    ]);
    expect(screen.getByText(/Versión 2, vigente desde el 12 de noviembre de 2026\./)).toBeVisible();
    // Se pinta haya o no sesión.
    expect(mocks.visitorOnly).not.toHaveBeenCalled();
  });

  it("es pública y no lee la base en cada visita: lo leído se recuerda unos segundos, sea cual sea la huella", async () => {
    mocks.accountFormFacts.mockResolvedValue(facts);
    for (const token of [TOKEN, "otra-huella-distinta", TOKEN]) {
      const { unmount } = render(await CompletePage(at(token)));
      expect(screen.getAllByRole("checkbox")).toHaveLength(3);
      unmount();
    }
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });

  it("tampoco cuando la base no contesta: el fallo se recuerda igual", async () => {
    mocks.accountFormFacts.mockResolvedValue({ kind: "unavailable" });
    for (let visit = 0; visit < 3; visit += 1) {
      const { unmount } = render(await CompletePage(at(TOKEN)));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Algo falló de nuestro lado");
      unmount();
    }
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });

  it.each(["corto", "con espacio dentro", "con/diagonal", "x".repeat(257), "ñandú-ñandú"])(
    "un enlace con forma imposible (%j) pinta «Ese enlace ya no sirve» sin preguntarle a la base",
    async (token) => {
      render(await CompletePage(at(token)));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ese enlace ya no sirve");
      expect(screen.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/registro");
      expect(mocks.accountFormFacts).not.toHaveBeenCalled();
    },
  );

  it("sin texto vigente de un documento obligatorio: no hay formulario ni sesión que cerrar", async () => {
    mocks.accountFormFacts.mockResolvedValue({ kind: "no_current_text" });
    render(await CompletePage(at(TOKEN)));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("No podemos completar tu cuenta");
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
  });

  it("cuando no se supo: ofrece reintentar en el mismo enlace, que sigue sin gastarse", async () => {
    mocks.accountFormFacts.mockResolvedValue({ kind: "unavailable" });
    render(await CompletePage(at(TOKEN)));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Algo falló de nuestro lado");
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", `/verificar/${TOKEN}`);
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
  });
});

describe("la página de recuperar, «pedir» (PA-13)", () => {
  it("sin aviso: el formulario, sin leer la base y sin pasar por la guarda de visitante", async () => {
    render(await RecoverPage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Recupera tu contraseña");
    expect(screen.queryByText(/hay que elegir su contraseña/)).not.toBeInTheDocument();
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
    expect(mocks.visitorOnly).not.toHaveBeenCalled();
  });

  it("pinta el aviso de quien llega de entrar con la marca de contraseña prendida", async () => {
    mocks.readNotice.mockReturnValue("choose_password");
    render(await RecoverPage());
    expect(mocks.readNotice).toHaveBeenCalledExactlyOnceWith(reader);
    expect(screen.getByText("Para entrar a esta cuenta hay que elegir su contraseña desde tu correo.")).toBeVisible();
  });

  it.each(["password_changed", "account_ready"])("un aviso que es de otra pantalla (%s) no dice nada aquí", async (notice) => {
    mocks.readNotice.mockReturnValue(notice);
    render(await RecoverPage());
    expect(screen.queryByText(/Tu contraseña se cambió/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tu cuenta está lista/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hay que elegir su contraseña/)).not.toBeInTheDocument();
  });
});

describe("la página de recuperar, «cambiar» (PA-13)", () => {
  it("con un enlace con forma: pinta el formulario, con la huella oculta, sin leer la base", async () => {
    const { container } = render(await ChangePasswordPage(at(TOKEN)));
    expect(mocks.connection).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Elige tu contraseña nueva");
    expect(container.querySelector('input[type="hidden"][name="token"]')).toHaveValue(TOKEN);
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
    expect(mocks.visitorOnly).not.toHaveBeenCalled();
  });

  it.each(["corto", "con espacio dentro", "x".repeat(257)])(
    "un enlace con forma imposible (%j) pinta «Ese enlace ya no sirve»",
    async (token) => {
      render(await ChangePasswordPage(at(token)));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ese enlace ya no sirve");
      expect(screen.getByRole("link", { name: "Pedir otro" })).toHaveAttribute("href", "/recuperar");
      expect(screen.queryByLabelText("Contraseña nueva")).not.toBeInTheDocument();
    },
  );
});
