import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La pantalla del equipo (PA-86). Las acciones de servidor son la frontera con el servicio:
// aquí se cambian por lo que contestarían, para ver qué pinta cada bloque con cada respuesta
// y qué manda cada botón. Lo que hacen de verdad lo prueban sus tablas y el extremo a extremo.
const actions = vi.hoisted(() => ({
  freshCodeAction: vi.fn(),
  inviteAction: vi.fn(),
  teamAction: vi.fn(),
  invitationsAction: vi.fn(),
  resetAction: vi.fn(),
}));
vi.mock("@/app/admin/_equipo/actions", () => actions);

import type { CodeState, InvitationsState, InviteState, ResetState, TeamState } from "@/app/admin/_equipo/outcomes";
import { teamView } from "@/app/admin/_equipo/rows";
import { TeamScreen } from "@/app/admin/_equipo/screen";
import type { TeamInvitation, TeamMember, TeamRoster } from "@/services/account/account";

import { a11yViolations } from "../setup/a11y";

beforeEach(() => vi.clearAllMocks());

const ME = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const THIRD = "c0000000-0000-4000-8000-000000000003";
const INVITATION = "d0000000-0000-4000-8000-000000000004";
const CODE = "ABCD-EFGH-JKMN-PQRS";

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  profileId: OTHER,
  email: "otra@prueba.test",
  displayName: null,
  status: "active",
  capabilities: ["support"],
  factor: "bound",
  rebind: "none",
  configRemovable: false,
  isSelf: false,
  ...over,
});
const self = (over: Partial<TeamMember> = {}) => member({ profileId: ME, email: "yo@prueba.test", capabilities: ["config"], isSelf: true, ...over });
const invitation = (over: Partial<TeamInvitation> = {}): TeamInvitation => ({
  id: INVITATION,
  kind: "grant",
  email: "invitada@prueba.test",
  profileId: null,
  capabilities: ["support", "content"],
  invitedBy: ME,
  createdAt: new Date("2026-11-05T18:00:00Z"),
  expiresAt: new Date("2026-11-12T18:00:00Z"),
  expired: false,
  acceptable: true,
  ...over,
});
const rosterOf = (over: Partial<TeamRoster> = {}): TeamRoster => ({ freshCode: true, members: [self(), member()], invitations: [invitation()], ...over });

const formOf = (action: ReturnType<typeof vi.fn>, call = 0) => Object.fromEntries(action.mock.calls[call]?.[1] as FormData);
const allOf = (action: ReturnType<typeof vi.fn>, name: string, call = 0) => (action.mock.calls[call]?.[1] as FormData).getAll(name);
/** Todo lo que el documento lleva en un campo, visible u oculto. */
const fieldValues = (container: HTMLElement) => [...container.querySelectorAll("input, textarea")].map((field) => (field as HTMLInputElement).value);
/** El bloque que lleva ese título. */
const blockOf = (title: string) => {
  const block = screen.getByRole("heading", { level: 2, name: title }).closest("section");
  if (block === null) throw new Error(`Falta el bloque «${title}».`);
  return within(block);
};
const show = (roster: TeamRoster = rosterOf()) => ({ user: userEvent.setup(), ...render(<TeamScreen view={teamView(roster)} />) });

describe("la pantalla del equipo, en reposo", () => {
  it("con el código reciente: los cuatro bloques con sus cambios, y sin pedir el código", async () => {
    const { container } = show();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Equipo de administración");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Invitar",
      "El equipo",
      "Invitaciones pendientes",
      "Restablecer un segundo factor",
    ]);
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    expect(blockOf("Invitar").getByRole("button", { name: "Invitar" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Ir al inicio de administración" })).toHaveAttribute("href", "/admin");
    // Sin tabla ni diálogo (decisión del 2026-10-13).
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("sin el código reciente: arriba se pide, la lista se ve y ningún cambio se ofrece", async () => {
    const { container } = show(rosterOf({ freshCode: false }));
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveTextContent("Tu código");
    expect(screen.getByLabelText("Código")).toHaveAttribute("autocomplete", "one-time-code");
    // El único botón de la pantalla es el del código.
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Comprobar" })]);
    // La lista se sigue viendo.
    expect(blockOf("El equipo").getByText("otra@prueba.test")).toBeVisible();
    expect(blockOf("Invitaciones pendientes").getByText("invitada@prueba.test")).toBeVisible();
    expect(screen.getAllByText("Escribe tu código, al inicio de esta página, para poder hacer cambios.")).toHaveLength(3);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("cada fila dice de quién es, qué tiene y lo que hay que saber", () => {
    show(
      rosterOf({
        members: [
          self(),
          member({ displayName: "Otra Persona", capabilities: ["content", "support"], factor: "none", rebind: "expired" }),
          member({ profileId: THIRD, email: "tercera@prueba.test", status: "suspended" }),
        ],
      }),
    );
    const rows = blockOf("El equipo").getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const [mine, other, third] = rows.map((row) => within(row));
    expect(mine?.getByText("yo@prueba.test")).toBeVisible();
    expect(mine?.getByText("Tú")).toBeVisible();
    expect(mine?.getByText("Tiene: Configuración.")).toBeVisible();
    // A quien mira no se le puede quitar configuración con solo dos personas: se dice por qué.
    expect(mine?.queryByRole("button", { name: /Quitar Configuración/ })).not.toBeInTheDocument();
    expect(mine?.getByText("No se le puede quitar Configuración: tienen que quedar otras dos cuentas activas con ella.")).toBeVisible();
    expect(other?.getByText("Otra Persona")).toBeVisible();
    expect(other?.getByText("Tiene: Contenido, Soporte.")).toBeVisible();
    expect(other?.getByText("Sin segundo factor, y su invitación para configurarlo caducó. Restablécelo otra vez.")).toBeVisible();
    // Sin su segundo factor: quitar sí, dar no.
    expect(other?.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Quitar Contenido a otra@prueba.test",
      "Quitar Soporte a otra@prueba.test",
    ]);
    expect(other?.getByText("Mientras no tenga su segundo factor no se le pueden dar capacidades.")).toBeVisible();
    expect(third?.getByText("Cuenta suspendida.")).toBeVisible();
    expect(third?.getAllByRole("button").map((button) => button.textContent)).toEqual(["Quitar Soporte a tercera@prueba.test"]);
  });

  it("sin invitaciones lo dice, y sin nadie más a quien restablecer, también", () => {
    show(rosterOf({ members: [self()], invitations: [] }));
    expect(blockOf("Invitaciones pendientes").getByText("No hay invitaciones pendientes.")).toBeVisible();
    expect(blockOf("Restablecer un segundo factor").getByText("No hay nadie más en el equipo a quien restablecer.")).toBeVisible();
  });
});

describe("el bloque «Tu código»", () => {
  async function submitCode(state: CodeState, typed = "123 456") {
    actions.freshCodeAction.mockResolvedValue(state);
    const view = show(rosterOf({ freshCode: false }));
    await view.user.type(screen.getByLabelText("Código"), typed);
    await view.user.click(screen.getByRole("button", { name: "Comprobar" }));
    return view;
  }

  it("manda a la acción el código, y nada más", async () => {
    await submitCode({ kind: "failed", reason: "wrong_code", attempt: 1 });
    expect(formOf(actions.freshCodeAction)).toEqual({ code: "123 456" });
  });

  it("el código no coincide: el campo queda marcado y vacío, con un resumen que enlaza a él", async () => {
    const { container } = await submitCode({ kind: "failed", reason: "wrong_code", attempt: 1 });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Ese código no coincide. Revisa que sea el más reciente." })).toHaveAttribute("href", "#equipo-codigo");
    expect(screen.getByLabelText("Código")).toBeInvalid();
    expect(screen.getByLabelText("Código")).toHaveValue("");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it.each<[CodeState, string]>([
    [{ kind: "failed", reason: "unavailable", attempt: 1 }, "No pudimos hacerlo. Intenta de nuevo en un momento."],
    [
      { kind: "failed", reason: "not_available", attempt: 1 },
      "Tu código es correcto, pero por ahora no se puede cambiar el equipo. Avisa a quien opera la base de datos.",
    ],
  ])("%j se dice en el bloque, y el código no vuelve", async (state, message) => {
    const { container } = await submitCode(state);
    expect(await screen.findByText(message)).toBeVisible();
    expect(fieldValues(container)).not.toContain("123 456");
  });
});

describe("el bloque «Invitar»", () => {
  async function invite(state: InviteState) {
    actions.inviteAction.mockResolvedValue(state);
    const view = show();
    const block = blockOf("Invitar");
    await view.user.type(block.getByLabelText("Correo de la persona"), "ana@prueba.test");
    await view.user.click(block.getByLabelText("Soporte"));
    await view.user.click(block.getByLabelText("Configuración"));
    await view.user.click(block.getByRole("button", { name: "Invitar" }));
    return view;
  }

  it("ofrece una casilla por capacidad, y dice que no se manda ningún correo", () => {
    show();
    const block = blockOf("Invitar");
    expect(block.getByText("La invitación no manda ningún correo: tú le avisas a la persona qué tiene que hacer.")).toBeVisible();
    expect(within(block.getByRole("group", { name: "Capacidades que recibirá" })).getAllByRole("checkbox")).toHaveLength(5);
  });

  it("manda a la acción el correo y las casillas marcadas, y nada más", async () => {
    await invite({ kind: "done", answer: "invited_new", email: "ana@prueba.test", attempt: 1 });
    expect(formOf(actions.inviteAction).email).toBe("ana@prueba.test");
    expect(allOf(actions.inviteAction, "capability")).toEqual(["support", "config"]);
    expect([...(actions.inviteAction.mock.calls[0]?.[1] as FormData).keys()].sort()).toEqual(["capability", "capability", "email"]);
  });

  it("invitada, sin cuenta: le dice a quien invita qué avisarle, y el formulario queda limpio", async () => {
    await invite({ kind: "done", answer: "invited_new", email: "ana@prueba.test", attempt: 1 });
    expect(
      await screen.findByText(
        "Invitación creada para ana@prueba.test. Todavía no tiene cuenta: dile que la cree con ese correo en la página de registro (/registro). Al terminar se le pedirá configurar su segundo factor.",
      ),
    ).toBeVisible();
    const block = blockOf("Invitar");
    expect(block.getByLabelText("Correo de la persona")).toHaveValue("");
    expect(block.getByLabelText("Soporte")).not.toBeChecked();
  });

  it("invitada, con cuenta: que recupere su contraseña en el navegador con el que va a entrar", async () => {
    await invite({ kind: "done", answer: "invited_existing", email: "ana@prueba.test", attempt: 1 });
    expect(
      await screen.findByText(
        "Invitación creada para ana@prueba.test. Ya tiene cuenta: dile que recupere su contraseña desde su correo (/recuperar), en el navegador con el que va a entrar a administración, y que después entre. Se le pedirá configurar su segundo factor.",
      ),
    ).toBeVisible();
  });

  it.each<[InviteState & { kind: "failed" }, string]>([
    [
      { kind: "failed", reason: "already_invited", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "Ese correo ya tiene una invitación vigente. Está en la lista de invitaciones pendientes.",
    ],
    [
      { kind: "failed", reason: "already_member", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "Esa cuenta ya es del equipo. Dale la capacidad en su fila, o restablece su segundo factor si no puede entrar.",
    ],
    [
      { kind: "failed", reason: "ineligible", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "La cuenta de ese correo no está activa: no se le puede invitar.",
    ],
    [
      { kind: "failed", reason: "not_configured", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "Por ahora no se puede: falta un dato de configuración. Avisa a quien opera la base de datos.",
    ],
    [
      { kind: "failed", reason: "needs_code", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio.",
    ],
    [
      { kind: "failed", reason: "unknown", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "No supimos si el cambio se hizo. Revisa la lista antes de intentarlo otra vez.",
    ],
    [{ kind: "failed", reason: "unavailable", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 }, "No pudimos hacerlo. Intenta de nuevo en un momento."],
    [
      { kind: "failed", reason: "invalid", email: "ana@prueba.test", capabilities: ["support"], attempt: 1 },
      "No pudimos hacerlo con esos datos. Revisa la lista e intenta de nuevo.",
    ],
  ])("$reason: lo dice, y lo escrito no se pierde", async (state, message) => {
    await invite(state);
    expect(await screen.findByText(message)).toBeVisible();
    const block = blockOf("Invitar");
    expect(block.getByLabelText("Correo de la persona")).toHaveValue("ana@prueba.test");
    expect(block.getByLabelText("Soporte")).toBeChecked();
    expect(block.getByLabelText("Configuración")).not.toBeChecked();
  });

  it("con algo por corregir: un resumen que enlaza a cada campo, y los campos marcados", async () => {
    const { container } = await invite({
      kind: "invalid",
      email: "ana.prueba",
      capabilities: [],
      problems: { email: "invalid", capabilities: true },
      attempt: 1,
    });
    const summary = await screen.findByRole("alert");
    expect(within(summary).getByRole("link", { name: "Ese correo no tiene forma de correo. Revísalo." })).toHaveAttribute("href", "#equipo-invitar-correo");
    expect(within(summary).getByRole("link", { name: "Elige al menos una capacidad." })).toHaveAttribute("href", "#equipo-invitar-capacidades");
    const block = blockOf("Invitar");
    expect(block.getByLabelText("Correo de la persona")).toBeInvalid();
    expect(block.getByLabelText("Correo de la persona")).toHaveValue("ana.prueba");
    expect(block.getByRole("group", { name: "Capacidades que recibirá" })).toHaveAccessibleDescription("Elige al menos una capacidad.");
    expect(await a11yViolations(container)).toEqual([]);
  });
});

describe("el bloque «El equipo»", () => {
  const roster = () => rosterOf({ members: [self(), member({ capabilities: ["content", "support"] })] });
  const asked: TeamState = { kind: "confirm", intent: { type: "revoke", profile: OTHER, capability: "support" }, changed: false, attempt: 1 };

  it("quitar pregunta primero: el botón manda a quién y qué, y nada más", async () => {
    actions.teamAction.mockResolvedValue(asked);
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Quitar Soporte a otra@prueba.test" }));
    expect(formOf(actions.teamAction)).toEqual({ do: `ask:revoke:${OTHER}:support` });
  });

  it("la confirmación dice todo lo que va a pasar, toma el foco y sustituye a los botones de esa fila", async () => {
    actions.teamAction.mockResolvedValue(asked);
    const { user, container } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Quitar Soporte a otra@prueba.test" }));
    const panel = (await screen.findByText("¿Quitar Soporte a otra@prueba.test?")).parentElement as HTMLElement;
    expect(panel).toHaveFocus();
    expect(within(panel).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Se cierran todas sus sesiones.",
      "Queda registrado con tu nombre.",
    ]);
    expect(within(panel).getByRole("button", { name: "Sí, quitar" })).toHaveValue(`confirm:revoke:${OTHER}:support:`);
    expect(within(panel).getByRole("button", { name: "Cancelar" })).toHaveValue("cancel");
    // Los botones de esa fila ya no están; los de las demás, sí.
    expect(screen.queryByRole("button", { name: "Quitar Contenido a otra@prueba.test" })).not.toBeInTheDocument();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("«Sí, quitar» manda lo que se confirmó; hecho, lo dice y el foco va al resultado", async () => {
    actions.teamAction.mockResolvedValueOnce(asked).mockResolvedValueOnce({ kind: "done", what: "revoked", attempt: 2 } satisfies TeamState);
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Quitar Soporte a otra@prueba.test" }));
    await user.click(await screen.findByRole("button", { name: "Sí, quitar" }));
    expect(formOf(actions.teamAction, 1)).toEqual({ do: `confirm:revoke:${OTHER}:support:` });
    const done = await screen.findByText("Capacidad quitada. Se cerraron las sesiones de esa cuenta.");
    expect(done.closest("[tabindex]")).toHaveFocus();
    expect(screen.queryByText("¿Quitar Soporte a otra@prueba.test?")).not.toBeInTheDocument();
  });

  it("«Cancelar» manda eso, quita la confirmación y devuelve el foco al bloque", async () => {
    actions.teamAction.mockResolvedValueOnce(asked).mockResolvedValueOnce({ kind: "idle" } satisfies TeamState);
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Quitar Soporte a otra@prueba.test" }));
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(formOf(actions.teamAction, 1)).toEqual({ do: "cancel" });
    expect(await screen.findByRole("button", { name: "Quitar Soporte a otra@prueba.test" })).toBeEnabled();
    expect(screen.queryByText("¿Quitar Soporte a otra@prueba.test?")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "El equipo" }).closest("section")).toHaveFocus();
  });

  it("dar una capacidad que no es configuración no pregunta: el botón ya lo hace", async () => {
    actions.teamAction.mockResolvedValue({ kind: "done", what: "granted", attempt: 1 } satisfies TeamState);
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Dar Finanzas a otra@prueba.test" }));
    expect(formOf(actions.teamAction)).toEqual({ do: `confirm:grant:${OTHER}:finance:` });
    expect(await screen.findByText("Capacidad dada.")).toBeVisible();
  });

  it("dar configuración sí pregunta, y dice qué podrá hacer", async () => {
    const grant: TeamState = { kind: "confirm", intent: { type: "grant", profile: OTHER, capability: "config" }, changed: false, attempt: 1 };
    actions.teamAction.mockResolvedValue(grant);
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Dar Configuración a otra@prueba.test" }));
    expect(formOf(actions.teamAction)).toEqual({ do: `ask:grant:${OTHER}:config` });
    expect(await screen.findByText("¿Dar Configuración a otra@prueba.test?")).toBeVisible();
    expect(screen.getByText(/Podrá invitar, dar y quitar capacidades y restablecer segundos factores/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Sí, dar" })).toHaveValue(`confirm:grant:${OTHER}:config:`);
  });

  it("si la lista cambió mientras se confirmaba, lo dice arriba de lo que pasaría ahora", async () => {
    actions.teamAction.mockResolvedValue({ ...asked, changed: true });
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Quitar Soporte a otra@prueba.test" }));
    expect(await screen.findByText("La lista cambió mientras confirmabas. Revisa de nuevo lo que va a pasar.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sí, quitar" })).toBeEnabled();
  });

  it("si lo que se iba a confirmar ya no está en la lista, no hay nada que confirmar: se dice", async () => {
    actions.teamAction.mockResolvedValue({ kind: "confirm", intent: { type: "revoke", profile: OTHER, capability: "finance" }, changed: true, attempt: 1 });
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Quitar Soporte a otra@prueba.test" }));
    expect(await screen.findByText("La lista cambió mientras confirmabas. Revisa de nuevo lo que va a pasar.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sí, quitar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quitar Soporte a otra@prueba.test" })).toBeEnabled();
  });

  it.each<[TeamState & { kind: "failed" }, string]>([
    [{ kind: "failed", reason: "already_has", attempt: 1 }, "Esa cuenta ya tenía esa capacidad."],
    [{ kind: "failed", reason: "not_held", attempt: 1 }, "Esa cuenta ya no tenía esa capacidad."],
    [{ kind: "failed", reason: "min_config", attempt: 1 }, "No se quitó: tienen que quedar otras dos cuentas activas con esa capacidad."],
    [{ kind: "failed", reason: "not_member", attempt: 1 }, "Esa cuenta no tiene su segundo factor atado: no se le pueden dar capacidades."],
    [{ kind: "failed", reason: "ineligible", attempt: 1 }, "Esa cuenta no está activa: no se le pueden dar capacidades."],
    [{ kind: "failed", reason: "needs_code", attempt: 1 }, "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio."],
    [{ kind: "failed", reason: "unknown", attempt: 1 }, "No supimos si el cambio se hizo. Revisa la lista antes de intentarlo otra vez."],
    [{ kind: "failed", reason: "unavailable", attempt: 1 }, "No pudimos hacerlo. Intenta de nuevo en un momento."],
    [{ kind: "failed", reason: "invalid", attempt: 1 }, "No pudimos hacerlo con esos datos. Revisa la lista e intenta de nuevo."],
  ])("$reason: lo dice en el bloque", async (state, message) => {
    actions.teamAction.mockResolvedValue(state);
    const { user } = show(roster());
    await user.click(blockOf("El equipo").getByRole("button", { name: "Dar Finanzas a otra@prueba.test" }));
    expect(await blockOf("El equipo").findByText(message)).toBeVisible();
  });
});

describe("el bloque «Invitaciones pendientes»", () => {
  it("cada invitación dice a quién, qué da, quién la hizo y cuándo caduca", () => {
    show();
    const block = blockOf("Invitaciones pendientes");
    expect(block.getByText("invitada@prueba.test")).toBeVisible();
    expect(block.getByText("Da: Soporte, Contenido.")).toBeVisible();
    expect(block.getByText("La hizo yo@prueba.test.")).toBeVisible();
    expect(block.getByText("Caduca el 12 de noviembre de 2026.")).toBeVisible();
    expect(block.getAllByRole("button").map((button) => button.textContent)).toEqual(["Revocar la invitación de invitada@prueba.test"]);
  });

  it("revocar pregunta primero, y la confirmación manda cuál", async () => {
    actions.invitationsAction
      .mockResolvedValueOnce({ kind: "confirm", id: INVITATION, attempt: 1 } satisfies InvitationsState)
      .mockResolvedValueOnce({ kind: "done", what: "revoked", attempt: 2 } satisfies InvitationsState);
    const { user } = show();
    await user.click(blockOf("Invitaciones pendientes").getByRole("button", { name: "Revocar la invitación de invitada@prueba.test" }));
    expect(formOf(actions.invitationsAction)).toEqual({ do: `ask:revoke:${INVITATION}` });
    expect(await screen.findByText("¿Revocar la invitación de invitada@prueba.test?")).toBeVisible();
    expect(screen.getByText("Ya no podrá aceptarla. Puedes invitar de nuevo después.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sí, revocar" }));
    expect(formOf(actions.invitationsAction, 1)).toEqual({ do: `confirm:revoke:${INVITATION}` });
    expect(await screen.findByText("Invitación revocada.")).toBeVisible();
  });

  it("una que caducó ofrece invitar de nuevo, y eso manda solo cuál", async () => {
    actions.invitationsAction.mockResolvedValue({ kind: "done", what: "reinvited", attempt: 1 } satisfies InvitationsState);
    const { user } = show(rosterOf({ invitations: [invitation({ expired: true, acceptable: false })] }));
    const block = blockOf("Invitaciones pendientes");
    expect(block.getByText("Caducó.")).toBeVisible();
    await user.click(block.getByRole("button", { name: "Invitar de nuevo a invitada@prueba.test" }));
    expect(formOf(actions.invitationsAction)).toEqual({ do: `confirm:reinvite:${INVITATION}` });
    expect(await screen.findByText("Invitación creada de nuevo. Avísale a la persona.")).toBeVisible();
  });

  it("si la que se iba a revocar ya no está en la lista, se dice", async () => {
    actions.invitationsAction.mockResolvedValue({ kind: "confirm", id: THIRD, attempt: 1 } satisfies InvitationsState);
    const { user } = show();
    await user.click(blockOf("Invitaciones pendientes").getByRole("button", { name: "Revocar la invitación de invitada@prueba.test" }));
    expect(await screen.findByText("Esa invitación ya no estaba vigente.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sí, revocar" })).not.toBeInTheDocument();
  });

  it.each<[InvitationsState & { kind: "failed" }, string]>([
    [{ kind: "failed", reason: "gone", attempt: 1 }, "Esa invitación ya no estaba vigente."],
    [{ kind: "failed", reason: "needs_code", attempt: 1 }, "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio."],
    [{ kind: "failed", reason: "unknown", attempt: 1 }, "No supimos si el cambio se hizo. Revisa la lista antes de intentarlo otra vez."],
    [{ kind: "failed", reason: "already_member", attempt: 1 }, "Esa cuenta ya es del equipo. Dale la capacidad en su fila, o restablece su segundo factor si no puede entrar."],
  ])("$reason: lo dice en el bloque", async (state, message) => {
    actions.invitationsAction.mockResolvedValue(state);
    const { user } = show();
    await user.click(blockOf("Invitaciones pendientes").getByRole("button", { name: "Revocar la invitación de invitada@prueba.test" }));
    expect(await blockOf("Invitaciones pendientes").findByText(message)).toBeVisible();
  });
});

describe("el bloque «Restablecer un segundo factor»", () => {
  const asked: ResetState = { kind: "confirm", profile: OTHER, changed: false, attempt: 1 };
  const shown: ResetState = { kind: "code", code: CODE, attempt: 2 };
  const choose = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(blockOf("Restablecer un segundo factor").getByRole("button", { name: "Restablecer el segundo factor de otra@prueba.test" }));

  it("ofrece a quien se puede restablecer: a quien mira, no", () => {
    show();
    expect(blockOf("Restablecer un segundo factor").getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Restablecer el segundo factor de otra@prueba.test",
    ]);
  });

  it("elegir pregunta primero: manda a quién, y la confirmación dice todo lo que pasa", async () => {
    actions.resetAction.mockResolvedValue(asked);
    const { user, container } = show();
    await choose(user);
    expect(formOf(actions.resetAction)).toEqual({ do: `choose:${OTHER}` });
    const panel = (await screen.findByText("¿Restablecer el segundo factor de otra@prueba.test?")).parentElement as HTMLElement;
    expect(panel).toHaveFocus();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    expect(within(panel).getByRole("button", { name: "Sí, restablecer" })).toHaveValue(`confirm:${OTHER}:`);
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("restablecida: el código se pinta una vez, con qué hacer con él, y no va en ningún campo", async () => {
    actions.resetAction.mockResolvedValueOnce(asked).mockResolvedValueOnce(shown);
    const { user, container } = show();
    await choose(user);
    await user.click(await screen.findByRole("button", { name: "Sí, restablecer" }));
    expect(formOf(actions.resetAction, 1)).toEqual({ do: `confirm:${OTHER}:` });
    expect(await screen.findByText(CODE)).toBeVisible();
    expect(screen.getAllByText(CODE)).toHaveLength(1);
    expect(screen.getByText("Díctaselo por teléfono o en persona, no por correo. Se muestra una sola vez: si se pierde, restablece de nuevo.")).toBeVisible();
    expect(screen.getByText("No recargues esta página: el código no se vuelve a mostrar.")).toBeVisible();
    for (const value of fieldValues(container)) expect(value).not.toContain("ABCD");
    expect(container.querySelector(`[value*="ABCD"]`)).toBeNull();
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("mientras el código está a la vista, el bloque no pinta ningún formulario: viajaría dentro de él", async () => {
    actions.resetAction.mockResolvedValueOnce(asked).mockResolvedValueOnce(shown);
    const { user } = show();
    await choose(user);
    await user.click(await screen.findByRole("button", { name: "Sí, restablecer" }));
    await screen.findByText(CODE);
    const block = screen.getByRole("heading", { level: 2, name: "Restablecer un segundo factor" }).closest("section") as HTMLElement;
    expect(block.querySelector("form")).toBeNull();
    expect(within(block).queryByRole("button")).not.toBeInTheDocument();
    // «Ya lo dicté» es un enlace de carga completa a la misma página: es lo que suelta ese estado.
    const done = within(block).getByRole("link", { name: "Ya lo dicté" });
    expect(done).toHaveAttribute("href", "/admin/equipo");
    expect(done.tagName).toBe("A");
  });

  it("al salir de la página el código deja de pintarse, y sigue sin haber formulario", async () => {
    actions.resetAction.mockResolvedValueOnce(asked).mockResolvedValueOnce(shown);
    const { user } = show();
    await choose(user);
    await user.click(await screen.findByRole("button", { name: "Sí, restablecer" }));
    await screen.findByText(CODE);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
    expect(screen.getByText("El código ya no se muestra. Si no alcanzaste a dictarlo, restablece de nuevo.")).toBeVisible();
    const block = blockOf("Restablecer un segundo factor");
    expect(block.getByRole("link", { name: "Volver a la lista" })).toHaveAttribute("href", "/admin/equipo");
    expect(block.queryByRole("button")).not.toBeInTheDocument();
  });

  it("el siguiente envío de cualquier otro bloque también lo esconde", async () => {
    actions.resetAction.mockResolvedValueOnce(asked).mockResolvedValueOnce(shown);
    actions.teamAction.mockResolvedValue({ kind: "done", what: "granted", attempt: 1 } satisfies TeamState);
    const { user } = show();
    await choose(user);
    await user.click(await screen.findByRole("button", { name: "Sí, restablecer" }));
    await screen.findByText(CODE);
    await user.click(blockOf("El equipo").getByRole("button", { name: "Dar Finanzas a otra@prueba.test" }));
    expect(await screen.findByText("Capacidad dada.")).toBeVisible();
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
    // Y el código no viajó con ese envío.
    expect(JSON.stringify([...(actions.teamAction.mock.calls[0]?.[1] as FormData).entries()])).not.toContain("ABCD");
  });

  it("si la lista cambió mientras se confirmaba, lo dice y vuelve a preguntar", async () => {
    actions.resetAction.mockResolvedValue({ ...asked, changed: true });
    const { user } = show();
    await choose(user);
    expect(await screen.findByText("La lista cambió mientras confirmabas. Revisa de nuevo lo que va a pasar.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sí, restablecer" })).toBeEnabled();
  });

  it("si esa persona ya no se puede restablecer, no hay nada que confirmar: se dice", async () => {
    actions.resetAction.mockResolvedValue({ kind: "confirm", profile: THIRD, changed: true, attempt: 1 } satisfies ResetState);
    const { user } = show();
    await choose(user);
    expect(await screen.findByText("La lista cambió mientras confirmabas. Revisa de nuevo lo que va a pasar.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sí, restablecer" })).not.toBeInTheDocument();
  });

  it.each<[ResetState & { kind: "failed" }, string]>([
    [
      { kind: "failed", reason: "already_sent", attempt: 1 },
      "Ese restablecimiento ya se envió, o su confirmación caducó. Revisa la lista: si la persona aparece sin segundo factor y no tienes su código, restablece de nuevo.",
    ],
    [{ kind: "failed", reason: "self", attempt: 1 }, "No puedes restablecer tu propio segundo factor. Pídeselo a otra persona con esa capacidad."],
    [
      { kind: "failed", reason: "ineligible", attempt: 1 },
      "No se pudo restablecer: la cuenta no está activa, o su correo ya no es el que tenía al entrar al equipo. Eso lo arregla quien opera la base de datos.",
    ],
    [{ kind: "failed", reason: "not_member", attempt: 1 }, "Esa cuenta ya no es del equipo."],
    [
      { kind: "failed", reason: "unknown", attempt: 1 },
      "No supimos si se restableció. Revisa la lista: si la persona aparece sin segundo factor, restablece de nuevo, porque nadie conoce ese código.",
    ],
    [{ kind: "failed", reason: "needs_code", attempt: 1 }, "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio."],
    [{ kind: "failed", reason: "not_configured", attempt: 1 }, "Por ahora no se puede: falta un dato de configuración. Avisa a quien opera la base de datos."],
    [{ kind: "failed", reason: "unavailable", attempt: 1 }, "No pudimos hacerlo. Intenta de nuevo en un momento."],
    [{ kind: "failed", reason: "invalid", attempt: 1 }, "No pudimos hacerlo con esos datos. Revisa la lista e intenta de nuevo."],
  ])("$reason: lo dice en el bloque, sin código", async (state, message) => {
    actions.resetAction.mockResolvedValue(state);
    const { user } = show();
    await choose(user);
    expect(await blockOf("Restablecer un segundo factor").findByText(message)).toBeVisible();
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
  });
});
