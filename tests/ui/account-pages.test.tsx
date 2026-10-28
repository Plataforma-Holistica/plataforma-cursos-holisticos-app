import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { a11yViolations } from "../setup/a11y";

// Las páginas de la cuenta, con la guarda y los servicios simulados: qué pinta cada una
// con cada respuesta. La tabla de la guarda (quién redirige a dónde) está en
// src/app/_lib/guard-steps.test.ts; aquí se cuida que cada página obedezca lo que no es
// una redirección, que es justo lo que los tipos no ven.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireIncompleteSession: vi.fn(),
  visitorOnly: vi.fn(),
  cookieReader: vi.fn(),
  sessionEmail: vi.fn(),
  accountFormFacts: vi.fn(),
  readNotice: vi.fn(),
  currentLegalText: vi.fn(),
  continueWatching: vi.fn(),
  accountProfile: vi.fn(),
  homeShelf: vi.fn(),
  notFound: vi.fn((): never => {
    throw new Error("no encontrado");
  }),
}));
vi.mock("@/app/_lib/guard", () => ({
  requireSession: mocks.requireSession,
  requireIncompleteSession: mocks.requireIncompleteSession,
  visitorOnly: mocks.visitorOnly,
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieReader: mocks.cookieReader }));
vi.mock("@/services/account/account", () => ({
  sessionEmail: mocks.sessionEmail,
  accountFormFacts: mocks.accountFormFacts,
  accountProfile: mocks.accountProfile,
}));
vi.mock("@/services/browse/browse", () => ({ homeShelf: mocks.homeShelf }));
vi.mock("@/services/account/notice", () => ({ readNotice: mocks.readNotice }));
vi.mock("@/services/progress/progress", () => ({ continueWatching: mocks.continueWatching }));
vi.mock("@/services/legal/texts", async () => ({
  ...(await import("@/services/legal/slugs")),
  ...(await import("@/services/legal/blocks")),
  currentLegalText: mocks.currentLegalText,
}));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), notFound: mocks.notFound }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("@/app/(cuenta)/entrar/actions", () => ({ signInAction: vi.fn() }));
vi.mock("@/app/(cuenta)/consentimientos/actions", () => ({ completeAccountAction: vi.fn() }));
vi.mock("@/app/(cuenta)/_lib/session-actions", () => ({ signOutAction: vi.fn() }));

import ConsentsPage from "@/app/(cuenta)/consentimientos/page";
import SignInPage from "@/app/(cuenta)/entrar/page";
import HomePage from "@/app/inicio/page";
import LegalPage, { generateMetadata as generateLegalMetadata } from "@/app/legal/[documento]/page";

const reader = { get: () => undefined };
const claims = { userId: "u", aal: "aal1", sessionId: null, issuedAt: 0 };
const query = (params: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieReader.mockResolvedValue(reader);
  mocks.continueWatching.mockResolvedValue({ kind: "ready", courses: [] });
});

const COURSE = {
  slug: "respirar",
  title: "Respirar para dormir",
  summary: null,
  teacherName: "Ana Robles",
  teacherSlug: "ana-robles",
  practice: { slug: "meditacion", name: "Meditación", tone: 3, position: 1 },
  level: { slug: "principiante", name: "Principiante", position: 1 },
  lessonCount: 12,
  totalSeconds: 3600,
  publishedAt: new Date(0),
  isOpen: false,
};
const shelfWith = (over: Record<string, unknown> = {}) => ({
  kind: "ready",
  shelf: {
    starters: [COURSE],
    newest: [COURSE],
    practices: [{ slug: "meditacion", name: "Meditación", tone: 3, courses: [COURSE] }],
    teachers: [{ slug: "ana-robles", name: "Ana Robles", practices: ["Meditación"], tone: 3, courseCount: 1 }],
    practiceOf: new Map([["respirar", { name: "Meditación", tone: 3 }]]),
    ...over,
  },
});

describe("el inicio del alumno (PA-20; T-210)", () => {
  beforeEach(() => {
    mocks.accountProfile.mockResolvedValue({ kind: "ready", name: "Ana" });
    mocks.homeShelf.mockResolvedValue(shelfWith());
  });

  it("le pide a la guarda una sesión para su propia ruta, saluda y dice con qué correo se entró", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.sessionEmail.mockResolvedValue("ana@prueba.test");
    render(await HomePage());
    expect(mocks.requireSession).toHaveBeenCalledExactlyOnceWith("/inicio");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hola, Ana");
    expect(screen.getByText("Entraste como ana@prueba.test.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Salir" })).toBeVisible();
    // La barra del alumno: el inicio es la página actual, y la cuenta ocupa el lugar de Perfil.
    const nav = screen.getByRole("navigation", { name: "Principal" });
    expect(within(nav).getByRole("link", { name: "Inicio" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Cuenta" })).toHaveAttribute("href", "/cuenta");
  });

  it("si no se supo el nombre, saluda sin él", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.accountProfile.mockResolvedValue({ kind: "unavailable" });
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Hola$/);
  });

  it("a una cuenta suspendida no le pinta el inicio: ve PA-35, con «Cerrar sesión»", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "suspended" });
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.queryByText(/Entraste como/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salir" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Principal" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
    expect(mocks.continueWatching).not.toHaveBeenCalled();
    expect(mocks.homeShelf).not.toHaveBeenCalled();
  });

  it("cuando no se supo si la sesión vale, tampoco: ofrece reintentar ahí mismo", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "unavailable" });
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Algo falló de nuestro lado");
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/inicio");
    expect(screen.queryByText(/Entraste como/)).not.toBeInTheDocument();
    expect(mocks.sessionEmail).not.toHaveBeenCalled();
  });

  it("«Continuar viendo» va primero, con la lección sugerida, y entonces no hay «Para empezar»", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.sessionEmail.mockResolvedValue("ana@prueba.test");
    mocks.continueWatching.mockResolvedValue({
      kind: "ready",
      courses: [
        {
          courseSlug: "respirar",
          courseTitle: "Respirar para dormir",
          teacherName: "Ana Robles",
          completed: 3,
          total: 12,
          lesson: { id: "b0000000-0000-4000-8000-000000000002", title: "Alargar la salida", number: 4 },
        },
        // Un curso sin dirección que sirva no se pinta.
        { courseSlug: "Sin Forma", courseTitle: "Roto", teacherName: "Ana", completed: 0, total: 1, lesson: { id: "x", title: "y", number: 1 } },
      ],
    });
    const { container } = render(await HomePage());
    expect(mocks.continueWatching).toHaveBeenCalledExactlyOnceWith(claims);
    const list = screen.getByRole("list", { name: "Continuar viendo" });
    const link = within(list).getByRole("link", { name: "Respirar para dormir, con Ana Robles: lección 4 de 12" });
    expect(link).toHaveAttribute("href", "/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("Roto")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Para empezar" })).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin cursos empezados: «Para empezar», «Nuevos», una fila por práctica y «Por maestro»", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    const { container } = render(await HomePage());
    expect(screen.queryByRole("heading", { name: "Continuar viendo" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Para empezar",
      "Nuevos",
      "Meditación",
      "Por maestro",
    ]);
    const starters = screen.getByRole("list", { name: "Para empezar" });
    expect(within(starters).getByRole("link", { name: "Respirar para dormir, con Ana Robles" })).toHaveAttribute("href", "/cursos/respirar");
    const teachers = screen.getByRole("list", { name: "Por maestro" });
    expect(within(teachers).getByRole("link", { name: "Ana Robles, maestro de Meditación" })).toHaveAttribute("href", "/maestros/ana-robles");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("si no se supo «continuar viendo», el inicio sigue con lo demás", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.continueWatching.mockResolvedValue({ kind: "unavailable" });
    render(await HomePage());
    expect(screen.getByRole("heading", { name: "Nuevos" })).toBeVisible();
  });

  it("con el catálogo vacío, el estado vacío en lugar de las filas", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.homeShelf.mockResolvedValue(shelfWith({ starters: [], newest: [], practices: [], teachers: [] }));
    render(await HomePage());
    expect(screen.getByText("Estamos preparando los primeros cursos.")).toBeVisible();
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  });

  it("si no se pudieron leer los cursos, lo dice y ofrece reintentar", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.homeShelf.mockResolvedValue({ kind: "unavailable" });
    render(await HomePage());
    expect(screen.getByText("No pudimos cargar los cursos. Inténtalo de nuevo en un momento.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/inicio");
    expect(screen.queryByText("Estamos preparando los primeros cursos.")).toBeNull();
  });

  it("si el token no trae correo, no inventa uno", async () => {
    mocks.requireSession.mockResolvedValue({ kind: "render", claims });
    mocks.sessionEmail.mockResolvedValue(null);
    render(await HomePage());
    expect(screen.queryByText(/Entraste como/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salir" })).toBeVisible();
  });
});

const text = (docType: string, title: string) => ({
  docType,
  documentId: `${docType.length.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
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
};
const pending = {
  variant: "updated_texts",
  missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
};

describe("la pantalla que pide lo que le falta a la cuenta", () => {
  it("le pasa a la guarda el destino tal como llegó, y pinta solo lo que falta", async () => {
    mocks.requireIncompleteSession.mockResolvedValue({ kind: "render", claims, pending });
    mocks.accountFormFacts.mockResolvedValue(facts);
    const { container } = render(await ConsentsPage(query({ volver: "/inicio?pestana=2" })));
    expect(mocks.requireIncompleteSession).toHaveBeenCalledExactlyOnceWith("/inicio?pestana=2");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Actualizamos nuestros textos");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox")).toHaveAccessibleName(/Leí y acepto: Términos\. Versión 2, vigente desde el 12 de noviembre de 2026\./);
    expect(screen.getByRole("link", { name: /Leer el texto/ })).toHaveAttribute("href", "/legal/terminos?v=2");
    // El destino viaja con el formulario: después de aceptar se va a donde se iba.
    expect(container.querySelector('input[type="hidden"][name="volver"]')).toHaveValue("/inicio?pestana=2");
  });

  it.each([{}, { volver: ["/inicio", "//otro.example"] }])("sin destino, o con el destino repetido, no hay destino: %j", async (params) => {
    mocks.requireIncompleteSession.mockResolvedValue({ kind: "render", claims, pending });
    mocks.accountFormFacts.mockResolvedValue(facts);
    const { container } = render(await ConsentsPage(query(params)));
    expect(mocks.requireIncompleteSession).toHaveBeenCalledExactlyOnceWith("");
    expect(container.querySelector('input[type="hidden"][name="volver"]')).toHaveValue("");
  });

  it("cuenta suspendida: PA-35, y ni se leen los textos", async () => {
    mocks.requireIncompleteSession.mockResolvedValue({ kind: "suspended" });
    render(await ConsentsPage(query({})));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu cuenta está suspendida");
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
  });

  it("no se supo si la sesión vale: reintentar en esta misma pantalla", async () => {
    mocks.requireIncompleteSession.mockResolvedValue({ kind: "unavailable" });
    render(await ConsentsPage(query({})));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/consentimientos");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
  });

  it("falta el texto vigente de un tipo obligatorio: lo dice, en lugar del formulario", async () => {
    mocks.requireIncompleteSession.mockResolvedValue({ kind: "render", claims, pending });
    mocks.accountFormFacts.mockResolvedValue({ kind: "no_current_text" });
    render(await ConsentsPage(query({})));
    expect(screen.getByText("Por ahora no podemos completar tu cuenta.")).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reintentar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
  });

  it("no se pudieron leer los textos: reintentar, que no es lo mismo que «no hay texto»", async () => {
    mocks.requireIncompleteSession.mockResolvedValue({ kind: "render", claims, pending });
    mocks.accountFormFacts.mockResolvedValue({ kind: "unavailable" });
    render(await ConsentsPage(query({})));
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/consentimientos");
    expect(screen.queryByText("Por ahora no podemos completar tu cuenta.")).not.toBeInTheDocument();
  });
});

describe("la página de entrar", () => {
  it.each([
    ["password_changed", "Tu contraseña se cambió y cerramos todas tus sesiones. Entra con la nueva.", "Listo:"],
    ["account_ready", "Tu cuenta está lista. Entra con tu contraseña.", "Listo:"],
    // El cambio desde la cuenta se quedó sin respuesta: eso no se dice como algo que salió bien.
    [
      "password_unconfirmed",
      "No pudimos confirmar si tu contraseña cambió, y cerramos todas tus sesiones. Entra con la nueva; si no funciona, usa la de antes.",
      "Aviso:",
    ],
    // Aceptó su invitación: su sesión se cerró, y entra de nuevo dando su código.
    ["second_factor_ready", "Tu segundo factor quedó configurado. Entra con tu contraseña y escribe el código de tu aplicación.", "Listo:"],
    // Que el freno le cerró las sesiones, o que la sesión se cerró en otro lado, no son buenas noticias.
    [
      "second_factor_throttled",
      "Hubo demasiados códigos equivocados y cerramos tus sesiones. Espera unos minutos y entra de nuevo. Si no fuiste tú, recupera tu contraseña desde tu correo.",
      "Aviso:",
    ],
    ["session_ended", "Tu sesión se cerró. Entra de nuevo para continuar.", "Aviso:"],
  ])("el aviso %s se pinta con su texto y con su tono", async (notice, message, tone) => {
    mocks.readNotice.mockReturnValue(notice);
    render(await SignInPage(query({})));
    expect(mocks.visitorOnly).toHaveBeenCalledOnce();
    expect(mocks.readNotice).toHaveBeenCalledExactlyOnceWith(reader);
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.getByText(message).parentElement).toHaveTextContent(`${tone} ${message}`);
  });

  it.each([null, "choose_password"])("un aviso que no es de esta pantalla (%j) no pinta nada", async (notice) => {
    mocks.readNotice.mockReturnValue(notice);
    render(await SignInPage(query({})));
    expect(screen.queryByText(/Tu contraseña se cambió|Tu cuenta está lista|elegir su contraseña|No pudimos confirmar/)).not.toBeInTheDocument();
  });

  it("el destino viaja tal como llegó, y repetido en la dirección no es un destino", async () => {
    mocks.readNotice.mockReturnValue(null);
    const one = render(await SignInPage(query({ volver: "/inicio?x=1" })));
    expect(one.container.querySelector('input[name="volver"]')).toHaveValue("/inicio?x=1");
    one.unmount();
    const many = render(await SignInPage(query({ volver: ["/inicio", "//otro.example"] })));
    expect(many.container.querySelector('input[name="volver"]')).toHaveValue("");
  });
});

const legalText = { docType: "terms", documentId: "d", version: 3, title: "Términos y condiciones", body: "", effectiveFrom: "2026-11-12T06:00:00.000Z" };
const legalProps = (documento: string, search: Record<string, string | string[] | undefined> = {}) => ({
  params: Promise.resolve({ documento }),
  searchParams: Promise.resolve(search),
});
const legalPage = (documento: string, search: Record<string, string | string[] | undefined> = {}) =>
  LegalPage(legalProps(documento, search));

describe("la página de un texto legal", () => {
  it("pinta el título, la versión, la fecha y el cuerpo, sin repetir el título", async () => {
    mocks.currentLegalText.mockResolvedValue({
      kind: "found",
      text: { ...legalText, body: "# Términos y condiciones\n\nPrimer párrafo.\n\n## Pagos\n\nSegundo párrafo." },
    });
    render(await legalPage("terminos"));
    expect(mocks.currentLegalText).toHaveBeenCalledExactlyOnceWith("terms", undefined);
    expect(screen.getAllByRole("heading").map((heading) => `${heading.tagName} ${heading.textContent}`)).toEqual([
      "H1 Términos y condiciones",
      "H3 Pagos",
    ]);
    expect(screen.getByText("Versión 3 · vigente desde el 12 de noviembre de 2026")).toBeVisible();
    expect(screen.getByText("Primer párrafo.")).toBeVisible();
    // Una versión publicada no lleva el aviso de borrador.
    expect(screen.queryByText(/Borrador sin validez legal/)).not.toBeInTheDocument();
  });

  it("un título distinto dentro del cuerpo sí se pinta, un nivel abajo del de la página", async () => {
    mocks.currentLegalText.mockResolvedValue({ kind: "found", text: { ...legalText, body: "# Otro título\n\nTexto." } });
    render(await legalPage("terminos"));
    expect(screen.getAllByRole("heading").map((heading) => `${heading.tagName} ${heading.textContent}`)).toEqual([
      "H1 Términos y condiciones",
      "H2 Otro título",
    ]);
  });

  it("un borrador lo dice", async () => {
    mocks.currentLegalText.mockResolvedValue({ kind: "found", text: { ...legalText, version: 0, body: "Texto." } });
    render(await legalPage("terminos"));
    expect(screen.getByText("Borrador sin validez legal. Solo existe en una base de desarrollo.")).toBeVisible();
  });

  it("lo que parece marcado en el cuerpo se pinta como texto", async () => {
    mocks.currentLegalText.mockResolvedValue({
      kind: "found",
      text: { ...legalText, body: '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">' },
    });
    const { container } = render(await legalPage("terminos"));
    expect(container.querySelector("script, img")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeVisible();
  });

  it("una dirección que no es de ningún texto no se encuentra, y ni se pregunta por ella", async () => {
    await expect(legalPage("no-existe")).rejects.toThrow("no encontrado");
    await expect(legalPage("terms")).rejects.toThrow("no encontrado");
    expect(mocks.currentLegalText).not.toHaveBeenCalled();
  });

  it("un texto sin versión vigente no se encuentra", async () => {
    mocks.currentLegalText.mockResolvedValue({ kind: "not_found" });
    await expect(legalPage("privacidad")).rejects.toThrow("no encontrado");
    expect(mocks.currentLegalText).toHaveBeenCalledWith("student_privacy_notice", undefined);
  });

  it("la versión que anuncia el formulario llega al servicio, y lo que no es un número no llega", async () => {
    mocks.currentLegalText.mockResolvedValue({ kind: "found", text: { ...legalText, body: "Texto." } });
    render(await legalPage("terminos", { v: "3" }));
    expect(mocks.currentLegalText).toHaveBeenLastCalledWith("terms", 3);

    for (const v of ["", "abc", "-1", "3.5", "1e3", " 3", "9999999", ["3", "4"], undefined]) {
      mocks.currentLegalText.mockClear();
      render(await legalPage("terminos", { v }));
      expect(mocks.currentLegalText, JSON.stringify(v)).toHaveBeenLastCalledWith("terms", undefined);
    }
  });

  it("el título de la pestaña es el del texto, y sin texto no hay título propio", async () => {
    mocks.currentLegalText.mockResolvedValue({ kind: "found", text: { ...legalText, body: "Texto." } });
    expect(await generateLegalMetadata(legalProps("terminos", { v: "3" }))).toEqual({ title: "Términos y condiciones" });
    expect(mocks.currentLegalText).toHaveBeenLastCalledWith("terms", 3);

    mocks.currentLegalText.mockResolvedValue({ kind: "not_found" });
    expect(await generateLegalMetadata(legalProps("terminos"))).toEqual({});
    mocks.currentLegalText.mockResolvedValue({ kind: "unavailable" });
    expect(await generateLegalMetadata(legalProps("terminos"))).toEqual({});
    expect(await generateLegalMetadata(legalProps("no-existe"))).toEqual({});
  });

  it("cuando no se pudo leer, no es «no encontrado»: ofrece reintentar en esa misma dirección", async () => {
    mocks.currentLegalText.mockResolvedValue({ kind: "unavailable" });
    render(await legalPage("historial-de-cursos"));
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Reintentar" })).toHaveAttribute("href", "/legal/historial-de-cursos");
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
  });
});
