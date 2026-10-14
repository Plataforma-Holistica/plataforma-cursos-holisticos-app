import { describe, expect, it } from "vitest";

import type { TeamInvitation, TeamMember, TeamRoster } from "@/services/account/account";

import { readInvitationsForm, readResetForm, readTeamForm } from "./outcomes";
import { teamView } from "./rows";

// El equipo, puesto en palabras (PA-86): qué botón se ofrece en cada fila, y qué dice su
// confirmación. Lo que cada botón manda tiene que ser algo que la acción entienda.

const ME = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const THIRD = "c0000000-0000-4000-8000-000000000003";
const INVITATION = "d0000000-0000-4000-8000-000000000004";

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
const rosterOf = (members: TeamMember[] = [self(), member()], invitations: TeamInvitation[] = [], freshCode = true): TeamRoster => ({
  freshCode,
  members,
  invitations,
});
const pressed = (value: string) => {
  const data = new FormData();
  data.append("do", value);
  return data;
};
const rowOf = (roster: TeamRoster, id: string) => {
  const row = teamView(roster).members.find((each) => each.id === id);
  if (!row) throw new Error("Falta la fila.");
  return row;
};
const capabilityOf = (roster: TeamRoster, id: string, capability: string) => {
  const row = rowOf(roster, id).capabilities.find((each) => each.capability === capability);
  if (!row) throw new Error("Falta la capacidad.");
  return row;
};

describe("la pantalla del equipo, en palabras", () => {
  it("dice si se ofrecen los cambios, y las capacidades que se pueden dar, en su orden", () => {
    expect(teamView(rosterOf()).canChange).toBe(true);
    expect(teamView(rosterOf(undefined, undefined, false)).canChange).toBe(false);
    expect(teamView(rosterOf()).capabilities).toEqual([
      { value: "content", label: "Contenido" },
      { value: "finance", label: "Finanzas" },
      { value: "moderation", label: "Moderación" },
      { value: "support", label: "Soporte" },
      { value: "config", label: "Configuración" },
    ]);
  });

  it("sin el código reciente las filas son las mismas: qué se ofrece lo decide la pantalla", () => {
    expect(teamView(rosterOf(undefined, [invitation()], false))).toEqual({ ...teamView(rosterOf(undefined, [invitation()])), canChange: false });
  });
});

describe("cada persona", () => {
  it("su correo es su identidad; su nombre, si lo escribió; y lo que tiene", () => {
    const row = rowOf(rosterOf([self(), member({ displayName: "Otra Persona", capabilities: ["content", "support"] })]), OTHER);
    expect(row).toMatchObject({ id: OTHER, email: "otra@prueba.test", name: "Otra Persona", self: false, holds: "Tiene: Contenido, Soporte.", notes: [] });
    expect(rowOf(rosterOf(), ME)).toMatchObject({ email: "yo@prueba.test", self: true, name: null });
  });

  it("una cuenta sin correo lo dice", () => {
    expect(rowOf(rosterOf([self(), member({ email: null })]), OTHER).email).toBe("Cuenta sin correo");
  });

  it.each<[Partial<TeamMember>, string[]]>([
    [{ status: "suspended" }, ["Cuenta suspendida."]],
    [{ status: "other" }, ["Cuenta inactiva."]],
    [{ factor: "lost" }, ["Su segundo factor ya no existe: no puede entrar a administración. Restablécelo."]],
    [{ factor: "none", rebind: "pending" }, ["Sin segundo factor: tiene una invitación para configurarlo de nuevo."]],
    [{ factor: "none", rebind: "expired" }, ["Sin segundo factor, y su invitación para configurarlo caducó. Restablécelo otra vez."]],
    [{ factor: "none", rebind: "unusable" }, ["Sin segundo factor, y su invitación ya no se puede aceptar. Restablécelo otra vez."]],
    [{ factor: "none", rebind: "none" }, ["Sin segundo factor y sin invitación para configurarlo. Restablécelo."]],
    // Con su factor en regla, una invitación para volver que quedara viva no dice nada.
    [{ factor: "bound", rebind: "pending" }, []],
    [{ status: "suspended", factor: "none", rebind: "none" }, ["Cuenta suspendida.", "Sin segundo factor y sin invitación para configurarlo. Restablécelo."]],
  ])("lo que hay que saber de %j", (over, notes) => {
    expect(rowOf(rosterOf([self(), member(over)]), OTHER).notes).toEqual(notes);
  });

  it("trae una fila por capacidad, en su orden, la tenga o no", () => {
    const row = rowOf(rosterOf([self(), member({ capabilities: ["support", "config"], configRemovable: true })]), OTHER);
    expect(row.capabilities.map((each) => [each.capability, each.held])).toEqual([
      ["content", false],
      ["finance", false],
      ["moderation", false],
      ["support", true],
      ["config", true],
    ]);
  });
});

describe("quitar una capacidad", () => {
  it("el botón pregunta; la confirmación dice todo lo que pasa y lleva lo que se confirmó", () => {
    const roster = rosterOf([self(), member({ capabilities: ["content", "support"] })]);
    const row = capabilityOf(roster, OTHER, "support");
    expect(row.button).toEqual({ label: "Quitar Soporte", detail: "a otra@prueba.test", value: `ask:revoke:${OTHER}:support` });
    expect(row.locked).toBeNull();
    expect(row.confirmation).toEqual({
      title: "¿Quitar Soporte a otra@prueba.test?",
      effects: ["Se cierran todas sus sesiones.", "Queda registrado con tu nombre."],
      value: `confirm:revoke:${OTHER}:support:`,
      button: "Sí, quitar",
    });
    // Lo que mandan los dos botones es lo que la acción entiende.
    const intent = { type: "revoke", profile: OTHER, capability: "support" };
    expect(readTeamForm(pressed(row.button?.value ?? ""))).toEqual({ step: "ask", intent });
    expect(readTeamForm(pressed(row.confirmation?.value ?? ""))).toEqual({ step: "confirm", intent, confirmed: "" });
  });

  it("su última capacidad: deja de ser del equipo, y eso viaja como confirmado", () => {
    const row = capabilityOf(rosterOf(), OTHER, "support");
    expect(row.confirmation?.effects).toEqual([
      "Se cierran todas sus sesiones.",
      "Es su última capacidad: deja de ser del equipo. Se borran su segundo factor y las invitaciones dirigidas a esa cuenta.",
      "Queda registrado con tu nombre.",
    ]);
    expect(row.confirmation?.value).toBe(`confirm:revoke:${OTHER}:support:last`);
  });

  it("a una misma: también se cierra su sesión", () => {
    const row = capabilityOf(rosterOf([self({ capabilities: ["support", "config"] }), member()]), ME, "support");
    expect(row.confirmation?.effects).toEqual([
      "Se cierran todas sus sesiones.",
      "Es tu propia cuenta: también se cierra tu sesión, y tendrás que entrar de nuevo.",
      "Queda registrado con tu nombre.",
    ]);
    expect(row.confirmation?.value).toBe(`confirm:revoke:${ME}:support:self`);
  });

  it("configuración a quien invitó: sus invitaciones se revocan", () => {
    const roster = rosterOf(
      [self(), member({ capabilities: ["support", "config"], configRemovable: true })],
      [invitation({ invitedBy: OTHER })],
    );
    const row = capabilityOf(roster, OTHER, "config");
    expect(row.confirmation?.effects).toEqual([
      "Se cierran todas sus sesiones.",
      "Se revocan las invitaciones vigentes que hizo.",
      "Queda registrado con tu nombre.",
    ]);
    expect(row.confirmation?.value).toBe(`confirm:revoke:${OTHER}:config:inviter`);
  });

  it("configuración, cuando no quedarían otras dos cuentas activas con ella: no se ofrece, y dice por qué", () => {
    const row = capabilityOf(rosterOf([self(), member({ capabilities: ["config"], configRemovable: false })]), OTHER, "config");
    expect(row).toMatchObject({
      held: true,
      button: null,
      confirmation: null,
      locked: "No se le puede quitar Configuración: tienen que quedar otras dos cuentas activas con ella.",
    });
    // Tampoco a quien mira.
    expect(capabilityOf(rosterOf(), ME, "config").button).toBeNull();
  });

  it("a una cuenta suspendida o sin segundo factor sí se le puede quitar: es la manera de darla de baja", () => {
    expect(capabilityOf(rosterOf([self(), member({ status: "suspended" })]), OTHER, "support").button?.value).toBe(`ask:revoke:${OTHER}:support`);
    expect(capabilityOf(rosterOf([self(), member({ factor: "none" })]), OTHER, "support").button?.value).toBe(`ask:revoke:${OTHER}:support`);
  });
});

describe("dar una capacidad", () => {
  it("una que no es configuración se da sin preguntar", () => {
    const row = capabilityOf(rosterOf(), OTHER, "content");
    expect(row).toEqual({
      capability: "content",
      label: "Contenido",
      held: false,
      button: { label: "Dar Contenido", detail: "a otra@prueba.test", value: `confirm:grant:${OTHER}:content:` },
      locked: null,
      confirmation: null,
    });
    expect(readTeamForm(pressed(row.button?.value ?? ""))).toEqual({
      step: "confirm",
      intent: { type: "grant", profile: OTHER, capability: "content" },
      confirmed: "",
    });
  });

  it("configuración se pregunta: deshacerlo cierra las sesiones de esa persona", () => {
    const row = capabilityOf(rosterOf(), OTHER, "config");
    expect(row.button?.value).toBe(`ask:grant:${OTHER}:config`);
    expect(row.confirmation).toEqual({
      title: "¿Dar Configuración a otra@prueba.test?",
      effects: [
        "Podrá invitar, dar y quitar capacidades y restablecer segundos factores. Quitársela después cierra todas sus sesiones.",
        "Queda registrado con tu nombre.",
      ],
      value: `confirm:grant:${OTHER}:config:`,
      button: "Sí, dar",
    });
  });

  it("a quien no tiene su segundo factor atado no se le ofrece, y se dice por qué", () => {
    const row = capabilityOf(rosterOf([self(), member({ factor: "none" })]), OTHER, "content");
    expect(row).toMatchObject({ button: null, confirmation: null, locked: "Mientras no tenga su segundo factor no se le pueden dar capacidades." });
  });

  it("a quien lo tiene atado aunque Auth lo haya perdido sí: la base lo deja", () => {
    expect(capabilityOf(rosterOf([self(), member({ factor: "lost" })]), OTHER, "content").button).not.toBeNull();
  });

  it.each(["suspended", "other"] as const)("a una cuenta que no está activa (%s) no se le ofrece dar nada", (status) => {
    const row = capabilityOf(rosterOf([self(), member({ status })]), OTHER, "content");
    expect(row).toMatchObject({ button: null, confirmation: null, locked: null });
  });
});

describe("cada invitación", () => {
  const rowsOf = (roster: TeamRoster) => teamView(roster).invitations;

  it("a quién, qué da, quién la hizo y cuándo caduca, en la zona del producto", () => {
    expect(rowsOf(rosterOf(undefined, [invitation()]))).toEqual([
      {
        id: INVITATION,
        email: "invitada@prueba.test",
        what: "Da: Soporte, Contenido.",
        by: "La hizo yo@prueba.test.",
        expires: "Caduca el 12 de noviembre de 2026.",
        notes: [],
        revoke: {
          label: "Revocar",
          detail: "la invitación de invitada@prueba.test",
          value: `ask:revoke:${INVITATION}`,
          confirmation: {
            title: "¿Revocar la invitación de invitada@prueba.test?",
            effects: ["Ya no podrá aceptarla. Puedes invitar de nuevo después.", "Queda registrado con tu nombre."],
            value: `confirm:revoke:${INVITATION}`,
            button: "Sí, revocar",
          },
        },
        reinvite: null,
      },
    ]);
  });

  it("lo que mandan sus botones es lo que la acción entiende", () => {
    const [row] = rowsOf(rosterOf(undefined, [invitation({ expired: true, acceptable: false })]));
    expect(readInvitationsForm(pressed(row?.revoke.value ?? ""))).toEqual({ step: "ask", id: INVITATION });
    expect(readInvitationsForm(pressed(row?.revoke.confirmation.value ?? ""))).toEqual({ step: "revoke", id: INVITATION });
    expect(readInvitationsForm(pressed(row?.reinvite?.value ?? ""))).toEqual({ step: "reinvite", id: INVITATION });
  });

  it.each<[string, Partial<TeamInvitation>, string]>([
    ["la del dueño de la base", { invitedBy: null }, "La puso quien opera la base de datos."],
    ["la de alguien que ya no está en la lista", { invitedBy: THIRD }, "La hizo alguien que ya no está en el equipo."],
    ["la de otra persona del equipo", { invitedBy: OTHER }, "La hizo otra@prueba.test."],
  ])("quién la hizo: %s", (_what, over, by) => {
    expect(rowsOf(rosterOf(undefined, [invitation(over)]))[0]?.by).toBe(by);
  });

  it("una que dio capacidades y caducó: lo dice, sin fecha, y ofrece invitar de nuevo", () => {
    const [row] = rowsOf(rosterOf(undefined, [invitation({ expired: true, acceptable: false })]));
    expect(row).toMatchObject({
      expires: null,
      notes: ["Caducó."],
      reinvite: { label: "Invitar de nuevo", detail: "a invitada@prueba.test", value: `confirm:reinvite:${INVITATION}` },
    });
  });

  it("una vigente que ya no se puede aceptar: revocarla e invitar de nuevo", () => {
    const [row] = rowsOf(rosterOf(undefined, [invitation({ acceptable: false })]));
    expect(row?.notes).toEqual(["Ya no se puede aceptar: quien la hizo ya no puede invitar, o la cuenta invitada cambió. Revócala e invita de nuevo."]);
    expect(row?.reinvite).toBeNull();
    expect(row?.expires).toBe("Caduca el 12 de noviembre de 2026.");
  });

  it("una de restablecimiento: no da nada, y revocarla deja a la persona sin con qué volver", () => {
    const rebind = invitation({ kind: "rebind", capabilities: [], profileId: OTHER, email: "otra@prueba.test" });
    const [row] = rowsOf(rosterOf(undefined, [rebind]));
    expect(row).toMatchObject({ what: "Para configurar de nuevo su segundo factor. No da capacidades.", notes: [], reinvite: null });
    expect(row?.revoke.confirmation.effects).toEqual([
      "Esa persona se queda sin con qué configurar su segundo factor: tendrás que restablecerlo otra vez.",
      "Queda registrado con tu nombre.",
    ]);
  });

  it.each<[string, Partial<TeamInvitation>, string[]]>([
    ["caducó", { expired: true, acceptable: false }, ["Caducó.", "Ya no se puede aceptar. Restablece otra vez a esa persona, más abajo."]],
    ["ya no se puede aceptar", { acceptable: false }, ["Ya no se puede aceptar. Restablece otra vez a esa persona, más abajo."]],
  ])("una de restablecimiento que %s no se invita de nuevo: se restablece otra vez", (_what, over, notes) => {
    const [row] = rowsOf(rosterOf(undefined, [invitation({ kind: "rebind", capabilities: [], profileId: OTHER, ...over })]));
    expect(row?.notes).toEqual(notes);
    expect(row?.reinvite).toBeNull();
  });

  it("una fecha que no se entiende no se pinta", () => {
    expect(rowsOf(rosterOf(undefined, [invitation({ expiresAt: new Date("no es una fecha") })]))[0]?.expires).toBeNull();
  });
});

describe("a quién se le puede restablecer", () => {
  const optionsOf = (roster: TeamRoster) => teamView(roster).resettable;

  it("a quien mira no, ni a una cuenta que no está activa", () => {
    const roster = rosterOf([self(), member(), member({ profileId: THIRD, email: "tercera@prueba.test", status: "suspended" })]);
    expect(optionsOf(roster).map((option) => option.id)).toEqual([OTHER]);
    expect(optionsOf(rosterOf([self()]))).toEqual([]);
  });

  it("el primer botón elige; la confirmación dice todo lo que pasa y lleva lo que se confirmó", () => {
    const [option] = optionsOf(rosterOf());
    expect(option).toEqual({
      id: OTHER,
      email: "otra@prueba.test",
      choose: { label: "Restablecer", detail: "el segundo factor de otra@prueba.test", value: `choose:${OTHER}` },
      confirmation: {
        title: "¿Restablecer el segundo factor de otra@prueba.test?",
        effects: [
          "Se borran su segundo factor y todas sus sesiones. Antes de volver a entrar, a cualquier parte del sitio, tendrá que recuperar su contraseña desde su correo.",
          "Se revocan las invitaciones vigentes dirigidas a esa cuenta.",
          "Te mostraremos un código una sola vez. Su invitación para volver caduca en unos días, y se revoca si escribe mal el código varias veces.",
          "Queda registrado con tu nombre.",
        ],
        value: `confirm:${OTHER}:`,
        button: "Sí, restablecer",
      },
    });
    expect(readResetForm(pressed(option?.choose.value ?? ""))).toEqual({ step: "choose", profile: OTHER });
    expect(readResetForm(pressed(option?.confirmation.value ?? ""))).toEqual({ step: "confirm", profile: OTHER, confirmed: "" });
  });

  it("la única otra persona con configuración, que invitó y ya estaba restablecida: se dice todo, en ese orden", () => {
    const roster = rosterOf([self(), member({ capabilities: ["config"], factor: "none", rebind: "pending" })], [invitation({ invitedBy: OTHER })]);
    const [option] = optionsOf(roster);
    expect(option?.confirmation.effects).toEqual([
      "Se borran su segundo factor y todas sus sesiones. Antes de volver a entrar, a cualquier parte del sitio, tendrá que recuperar su contraseña desde su correo.",
      "Se revocan las invitaciones vigentes dirigidas a esa cuenta.",
      "Se revocan también las invitaciones vigentes que hizo.",
      "Es la única otra persona que puede cambiar el equipo: mientras no vuelva, quedarás como la única.",
      "Ya estaba restablecida: el código que le hayas dictado antes deja de servir.",
      "Te mostraremos un código una sola vez. Su invitación para volver caduca en unos días, y se revoca si escribe mal el código varias veces.",
      "Queda registrado con tu nombre.",
    ]);
    expect(option?.confirmation.value).toBe(`confirm:${OTHER}:alone+inviter+again`);
  });
});
