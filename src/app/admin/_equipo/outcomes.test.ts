import { describe, expect, it } from "vitest";

import { GRANT_ANSWERS, INVITE_ANSWERS, RESET_ANSWERS, RESET_VERSION, REVOKE_ANSWERS, REVOKE_INVITATION_ANSWERS } from "@/services/account/team-admin";

import {
  checkInviteForm,
  freshCodeOutcome,
  grantOutcome,
  invitationButton,
  inviteOutcome,
  readInvitationsForm,
  readInviteForm,
  readResetForm,
  readTeamForm,
  reinviteOutcome,
  resetButton,
  resetOutcome,
  revokeInvitationOutcome,
  revokeOutcome,
  shownEmail,
  teamButton,
  type TeamIntent,
} from "./outcomes";

// La tabla de la pantalla del equipo (PA-86): qué se entiende de cada envío, y qué se hace
// con cada respuesta del servicio. Cada respuesta de la base tiene su caso.

const PERSON = "b0000000-0000-4000-8000-000000000002";
const INVITATION = "d0000000-0000-4000-8000-000000000004";
const TO_PAGE = { kind: "leave", to: "/admin/equipo", notice: null };
/** La versión de la persona con que se pinta una confirmación de restablecer. */
const VERSION = "2.1";

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
const pressed = (value: string) => form([["do", value]]);

describe("a quien la guarda no dejó se le manda a su página, donde decide ella", () => {
  it.each([
    ["dar el código", freshCodeOutcome({ kind: "refused" })],
    ["invitar", inviteOutcome({ kind: "refused" })],
    ["invitar de nuevo", reinviteOutcome({ kind: "refused" })],
    ["revocar una invitación", revokeInvitationOutcome({ kind: "refused" })],
    ["dar una capacidad", grantOutcome({ kind: "refused" })],
    ["quitar una capacidad", revokeOutcome({ kind: "refused" })],
    ["restablecer", resetOutcome({ kind: "refused" })],
  ])("%s", (_what, outcome) => {
    expect(outcome).toEqual(TO_PAGE);
  });

  it.each([
    ["invitar", inviteOutcome({ kind: "answered", answer: "forbidden" })],
    ["invitar de nuevo", reinviteOutcome({ kind: "answered", answer: "forbidden" })],
    ["revocar una invitación", revokeInvitationOutcome({ kind: "answered", answer: "forbidden" })],
    ["dar una capacidad", grantOutcome({ kind: "answered", answer: "forbidden" })],
    ["quitar una capacidad", revokeOutcome({ kind: "answered", answer: "forbidden" })],
    ["restablecer", resetOutcome({ kind: "answered", answer: "forbidden" })],
  ])("y también cuando es la base la que dice que no tiene configuración: %s", (_what, outcome) => {
    expect(outcome).toEqual(TO_PAGE);
  });
});

describe("«no se supo» nunca se pinta como hecho", () => {
  it.each([
    ["no se supo quién pide, al dar el código", freshCodeOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo quién pide, al invitar", inviteOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo quién pide, al invitar de nuevo", reinviteOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo quién pide, al revocar una invitación", revokeInvitationOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo quién pide, al dar", grantOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo quién pide, al quitar", revokeOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo quién pide, al restablecer", resetOutcome({ kind: "unavailable" }), "unavailable"],
    ["no se supo si se invitó", inviteOutcome({ kind: "unknown" }), "unknown"],
    ["no se supo si se invitó de nuevo", reinviteOutcome({ kind: "unknown" }), "unknown"],
    ["no se supo si se revocó", revokeInvitationOutcome({ kind: "unknown" }), "unknown"],
    ["no se supo si se dio", grantOutcome({ kind: "unknown" }), "unknown"],
    ["no se supo si se quitó", revokeOutcome({ kind: "unknown" }), "unknown"],
    ["no se supo si se restableció", resetOutcome({ kind: "unknown" }), "unknown"],
  ])("%s", (_what, outcome, reason) => {
    expect(outcome).toEqual({ kind: "failed", reason });
  });

  it.each([
    ["invitar", inviteOutcome({ kind: "answered", answer: "needs_fresh_code" })],
    ["invitar de nuevo", reinviteOutcome({ kind: "answered", answer: "needs_fresh_code" })],
    ["revocar una invitación", revokeInvitationOutcome({ kind: "answered", answer: "needs_fresh_code" })],
    ["dar", grantOutcome({ kind: "answered", answer: "needs_fresh_code" })],
    ["quitar", revokeOutcome({ kind: "answered", answer: "needs_fresh_code" })],
    ["restablecer", resetOutcome({ kind: "answered", answer: "needs_fresh_code" })],
  ])("si el código venció entre pintar y enviar, se dice y no se repite solo: %s", (_what, outcome) => {
    expect(outcome).toEqual({ kind: "failed", reason: "needs_code" });
  });
});

describe("toda respuesta de la base tiene su caso", () => {
  it("invitar", () => {
    expect(INVITE_ANSWERS.map((answer) => [answer, inviteOutcome({ kind: "answered", answer })])).toEqual([
      ["forbidden", TO_PAGE],
      ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
      ["invalid", { kind: "failed", reason: "invalid" }],
      ["unavailable", { kind: "failed", reason: "not_configured" }],
      ["ineligible", { kind: "failed", reason: "ineligible" }],
      ["already_member", { kind: "failed", reason: "already_member" }],
      ["already_invited", { kind: "failed", reason: "already_invited" }],
      ["invited_new", { kind: "done", answer: "invited_new" }],
      ["invited_existing", { kind: "done", answer: "invited_existing" }],
    ]);
  });

  it("invitar de nuevo contesta lo mismo, salvo que hecho es «invitada de nuevo»", () => {
    expect(INVITE_ANSWERS.map((answer) => [answer, reinviteOutcome({ kind: "answered", answer })])).toEqual([
      ["forbidden", TO_PAGE],
      ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
      ["invalid", { kind: "failed", reason: "invalid" }],
      ["unavailable", { kind: "failed", reason: "not_configured" }],
      ["ineligible", { kind: "failed", reason: "ineligible" }],
      ["already_member", { kind: "failed", reason: "already_member" }],
      ["already_invited", { kind: "failed", reason: "already_invited" }],
      ["invited_new", { kind: "done", what: "reinvited" }],
      ["invited_existing", { kind: "done", what: "reinvited" }],
    ]);
    // La invitación ya no estaba, o no era de las que se invitan de nuevo.
    expect(reinviteOutcome({ kind: "gone" })).toEqual({ kind: "failed", reason: "gone" });
  });

  it("revocar una invitación", () => {
    expect(REVOKE_INVITATION_ANSWERS.map((answer) => [answer, revokeInvitationOutcome({ kind: "answered", answer })])).toEqual([
      ["forbidden", TO_PAGE],
      ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
      ["not_found", { kind: "failed", reason: "gone" }],
      ["revoked", { kind: "done", what: "revoked" }],
    ]);
  });

  it("dar una capacidad", () => {
    expect(GRANT_ANSWERS.map((answer) => [answer, grantOutcome({ kind: "answered", answer })])).toEqual([
      ["forbidden", TO_PAGE],
      ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
      ["invalid", { kind: "failed", reason: "invalid" }],
      ["ineligible", { kind: "failed", reason: "ineligible" }],
      ["not_member", { kind: "failed", reason: "not_member" }],
      ["already_has", { kind: "failed", reason: "already_has" }],
      ["granted", { kind: "done", what: "granted" }],
    ]);
  });

  it("quitar una capacidad", () => {
    expect(REVOKE_ANSWERS.map((answer) => [answer, revokeOutcome({ kind: "answered", answer })])).toEqual([
      ["forbidden", TO_PAGE],
      ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
      ["not_found", { kind: "failed", reason: "not_held" }],
      ["min_config", { kind: "failed", reason: "min_config" }],
      ["revoked", { kind: "done", what: "revoked" }],
    ]);
  });

  it("restablecer, cuando no restableció", () => {
    const answers = RESET_ANSWERS.filter((answer) => answer !== "reset");
    expect(answers.map((answer) => [answer, resetOutcome({ kind: "answered", answer })])).toEqual([
      ["forbidden", TO_PAGE],
      ["needs_fresh_code", { kind: "failed", reason: "needs_code" }],
      ["self", { kind: "failed", reason: "self" }],
      ["invalid", { kind: "failed", reason: "invalid" }],
      ["unavailable", { kind: "failed", reason: "not_configured" }],
      ["ineligible", { kind: "failed", reason: "ineligible" }],
      ["not_member", { kind: "failed", reason: "not_member" }],
      // El servicio ya las traduce a sus propios casos; la tabla las entiende igual.
      ["already_sent", { kind: "failed", reason: "already_sent" }],
      ["changed", { kind: "confirm_again" }],
    ]);
  });
});

describe("dar el código otra vez", () => {
  it("verificado: se redirige a la página, y no se vuelve a pintar", () => {
    expect(freshCodeOutcome({ kind: "verified" })).toEqual(TO_PAGE);
  });

  it("equivocado: se dice en el campo", () => {
    expect(freshCodeOutcome({ kind: "wrong_code" })).toEqual({ kind: "failed", reason: "wrong_code" });
  });

  it("frenado: Auth ya cerró todo, y sale a entrar con su aviso", () => {
    expect(freshCodeOutcome({ kind: "throttled" })).toEqual({ kind: "leave", to: "/entrar", notice: "second_factor_throttled" });
  });

  it("correcto y aun así ningún cambio pasaría: se dice que no lo arregla reintentar", () => {
    expect(freshCodeOutcome({ kind: "not_available" })).toEqual({ kind: "failed", reason: "not_available" });
  });
});

describe("invitar: lo que llega y lo que se revisa", () => {
  it("lee el correo y las casillas marcadas, tal como llegaron", () => {
    const data = form([
      ["email", "  Ana@Prueba.test "],
      ["capability", "support"],
      ["capability", "config"],
      ["actor", PERSON],
    ]);
    expect(readInviteForm(data)).toEqual({ email: "  Ana@Prueba.test ", capabilities: ["support", "config"] });
  });

  it.each<[string, unknown]>([
    ["lo que no es un formulario", "email=ana@prueba.test"],
    ["nada", undefined],
    ["un formulario vacío", form([])],
    ["un archivo en lugar del correo", form([["email", new Blob(["x"])]])],
    ["un correo desmedido", form([["email", "a".repeat(501)]])],
  ])("%s cuenta como vacío", (_what, value) => {
    expect(readInviteForm(value)).toEqual({ email: "", capabilities: [] });
  });

  it("una casilla que no es una palabra corta no cuenta, y demasiadas tampoco", () => {
    expect(readInviteForm(form([["capability", "support"], ["capability", "Config!"], ["capability", ""], ["capability", new Blob(["x"])]])).capabilities).toEqual([
      "support",
    ]);
    expect(readInviteForm(form(Array.from({ length: 11 }, () => ["capability", "support"] as [string, string]))).capabilities).toEqual([]);
  });

  it.each([
    [{ email: "ana@prueba.test", capabilities: ["support"] }, null],
    [{ email: "", capabilities: ["support"] }, { email: "required" }],
    [{ email: "   ", capabilities: ["support"] }, { email: "required" }],
    [{ email: "ana.prueba.test", capabilities: ["support"] }, { email: "invalid" }],
    [{ email: `${"a".repeat(250)}@prueba.test`, capabilities: ["support"] }, { email: "invalid" }],
    [{ email: "ana@prueba.test", capabilities: [] }, { capabilities: true }],
    [{ email: "", capabilities: [] }, { email: "required", capabilities: true }],
  ])("%j: %j", (input, problems) => {
    expect(checkInviteForm(input)).toEqual(problems);
  });

  it("lo que el servicio encontró sin forma se dice en su campo", () => {
    expect(inviteOutcome({ kind: "malformed", email: "empty", capabilities: false })).toEqual({ kind: "invalid", problems: { email: "required" } });
    expect(inviteOutcome({ kind: "malformed", email: "too_long", capabilities: false })).toEqual({ kind: "invalid", problems: { email: "invalid" } });
    expect(inviteOutcome({ kind: "malformed", email: "malformed", capabilities: true })).toEqual({
      kind: "invalid",
      problems: { email: "invalid", capabilities: true },
    });
    expect(inviteOutcome({ kind: "malformed", email: null, capabilities: true })).toEqual({ kind: "invalid", problems: { capabilities: true } });
  });

  it("el correo se dice como quedó guardado", () => {
    expect(shownEmail("  Ana@Prueba.TEST ")).toBe("ana@prueba.test");
    expect(shownEmail("  no es un correo ")).toBe("no es un correo");
  });
});

describe("el equipo: qué botón se pulsó", () => {
  const revoke: TeamIntent = { type: "revoke", profile: PERSON, capability: "support" };
  const grant: TeamIntent = { type: "grant", profile: PERSON, capability: "config" };

  it("preguntar lleva a quién y qué, y todavía no hace nada", () => {
    expect(readTeamForm(pressed(teamButton.ask(revoke)))).toEqual({ step: "ask", intent: revoke });
    expect(readTeamForm(pressed(teamButton.ask(grant)))).toEqual({ step: "ask", intent: grant });
  });

  it("confirmar lleva además lo que se confirmó", () => {
    expect(readTeamForm(pressed(teamButton.confirm(revoke, "self+last")))).toEqual({ step: "confirm", intent: revoke, confirmed: "self+last" });
    expect(readTeamForm(pressed(teamButton.confirm(revoke)))).toEqual({ step: "confirm", intent: revoke, confirmed: "" });
    expect(readTeamForm(pressed(teamButton.confirm(grant)))).toEqual({ step: "confirm", intent: grant, confirmed: "" });
  });

  it("«Cancelar» es no pedir nada", () => {
    expect(readTeamForm(pressed(teamButton.cancel))).toEqual({ step: "none" });
  });

  it.each<[string, unknown]>([
    ["lo que no es un formulario", "do=cancel"],
    ["un formulario sin botón", form([["profile", PERSON]])],
    ["más de una intención", form([["do", teamButton.ask(revoke)], ["do", teamButton.confirm(grant)]])],
    ["la misma intención dos veces", form([["do", teamButton.ask(revoke)], ["do", teamButton.ask(revoke)]])],
    ["un archivo en lugar del botón", form([["do", new Blob(["x"])]])],
    ["un botón vacío", pressed("")],
    ["un botón desmedido", pressed(`ask:revoke:${PERSON}:${"a".repeat(200)}`)],
    ["un paso que no existe", pressed(`do:revoke:${PERSON}:support`)],
    ["un cambio que no existe", pressed(`ask:reset:${PERSON}:support`)],
    ["una persona sin forma", pressed("ask:revoke:ana:support")],
    ["una persona en mayúsculas", pressed(`ask:revoke:${PERSON.toUpperCase()}:support`)],
    ["una capacidad que no es una palabra", pressed(`ask:revoke:${PERSON}:Sup port`)],
    ["sin capacidad", pressed(`ask:revoke:${PERSON}`)],
    ["preguntar con algo de más", pressed(`ask:revoke:${PERSON}:support:last`)],
    ["confirmar sin el último campo", pressed(`confirm:revoke:${PERSON}:support`)],
    ["confirmar con algo de más", pressed(`confirm:revoke:${PERSON}:support:last:otro`)],
    ["confirmar con efectos sin forma", pressed(`confirm:revoke:${PERSON}:support:LAST`)],
    ["confirmar con efectos mal unidos", pressed(`confirm:revoke:${PERSON}:support:self+`)],
  ])("%s cuenta como vacío", (_what, value) => {
    expect(readTeamForm(value)).toEqual({ step: "none" });
  });

  it("quitársela a una misma: la base cerró todo, y sale a entrar con su aviso", () => {
    expect(revokeOutcome({ kind: "revoked_self" })).toEqual({ kind: "leave", to: "/entrar", notice: "capability_removed" });
  });

  it("si lo confirmado ya no es lo que pasaría, se confirma otra vez", () => {
    expect(revokeOutcome({ kind: "changed" })).toEqual({ kind: "confirm_again" });
  });

  it("lo que el servicio encontró sin forma no dice nada: la pantalla no lo manda", () => {
    expect(grantOutcome({ kind: "malformed" })).toEqual({ kind: "idle" });
    expect(revokeOutcome({ kind: "malformed" })).toEqual({ kind: "idle" });
  });
});

describe("las invitaciones: qué botón se pulsó", () => {
  it("preguntar, revocar e invitar de nuevo llevan cuál invitación", () => {
    expect(readInvitationsForm(pressed(invitationButton.ask(INVITATION)))).toEqual({ step: "ask", id: INVITATION });
    expect(readInvitationsForm(pressed(invitationButton.revoke(INVITATION)))).toEqual({ step: "revoke", id: INVITATION });
    expect(readInvitationsForm(pressed(invitationButton.reinvite(INVITATION)))).toEqual({ step: "reinvite", id: INVITATION });
  });

  it.each<[string, unknown]>([
    ["«Cancelar»", pressed(invitationButton.cancel)],
    ["lo que no es un formulario", null],
    ["más de una intención", form([["do", invitationButton.ask(INVITATION)], ["do", invitationButton.revoke(INVITATION)]])],
    ["una invitación sin forma", pressed("confirm:revoke:la-de-ana")],
    ["preguntar por invitar de nuevo", pressed(`ask:reinvite:${INVITATION}`)],
    ["un cambio que no existe", pressed(`confirm:accept:${INVITATION}`)],
    ["algo de más", pressed(`confirm:revoke:${INVITATION}:otro`)],
    ["un botón del bloque del equipo", pressed(teamButton.ask({ type: "revoke", profile: PERSON, capability: "support" }))],
  ])("%s cuenta como vacío", (_what, value) => {
    expect(readInvitationsForm(value)).toEqual({ step: "none" });
  });

  it("lo que el servicio encontró sin forma no dice nada", () => {
    expect(revokeInvitationOutcome({ kind: "malformed" })).toEqual({ kind: "idle" });
    expect(reinviteOutcome({ kind: "malformed" })).toEqual({ kind: "idle" });
  });
});

describe("restablecer: qué botón se pulsó", () => {
  it("elegir lleva a quién; confirmar, además lo que se confirmó y la versión de la persona", () => {
    expect(readResetForm(pressed(resetButton.choose(PERSON)))).toEqual({ step: "choose", profile: PERSON });
    expect(readResetForm(pressed(resetButton.confirm(PERSON, "alone+again", VERSION)))).toEqual({
      step: "confirm",
      profile: PERSON,
      confirmed: "alone+again",
      version: VERSION,
    });
    expect(readResetForm(pressed(resetButton.confirm(PERSON, "", "0.0")))).toEqual({
      step: "confirm",
      profile: PERSON,
      confirmed: "",
      version: "0.0",
    });
    expect(readResetForm(pressed(resetButton.cancel))).toEqual({ step: "cancel" });
  });

  it("el botón de confirmar lleva a quién, qué y la versión, en ese orden", () => {
    expect(resetButton.confirm(PERSON, "alone", VERSION)).toBe(`confirm:${PERSON}:alone:${VERSION}`);
  });

  // La tabla viaja al navegador y no puede importar la regla del servicio: tienen que decir lo mismo.
  it.each(["0.0", "1.0", "12.3", "999999999.999999999", "", "1", "1.", ".0", "01.0", "1.00", "1.0.0", "a.b", "-1.0", "1234567890.0", " 1.0"])(
    "la versión %j se entiende igual aquí que en el servicio",
    (version) => {
      const read = readResetForm(pressed(`confirm:${PERSON}::${version}`));
      expect(read.step === "confirm").toBe(RESET_VERSION.test(version));
    },
  );

  it.each<[string, unknown]>([
    ["lo que no es un formulario", 7],
    ["más de una intención", form([["do", resetButton.choose(PERSON)], ["do", resetButton.confirm(PERSON, "", VERSION)]])],
    ["elegir sin persona", pressed("choose")],
    ["elegir a una persona sin forma", pressed("choose:ana")],
    ["elegir con algo de más", pressed(`choose:${PERSON}:alone`)],
    ["confirmar sin lo confirmado ni la versión", pressed(`confirm:${PERSON}`)],
    ["confirmar sin la versión", pressed(`confirm:${PERSON}:alone`)],
    ["confirmar con la versión vacía", pressed(`confirm:${PERSON}:alone:`)],
    ["confirmar con una versión sin forma", pressed(`confirm:${PERSON}:alone:uno`)],
    ["confirmar con efectos sin forma", pressed(`confirm:${PERSON}:Alone:${VERSION}`)],
    ["confirmar con algo de más", pressed(`confirm:${PERSON}:alone:${VERSION}:otro`)],
    ["cancelar con algo de más", pressed("cancel:todo")],
    ["un paso que no existe", pressed(`reset:${PERSON}`)],
  ])("%s cuenta como vacío", (_what, value) => {
    expect(readResetForm(value)).toEqual({ step: "none" });
  });

  it("a quien la pantalla no ofrece (sin forma) no se le dice nada", () => {
    expect(resetOutcome({ kind: "malformed" })).toEqual({ kind: "idle" });
  });

  it("restablecida: sale el código, una vez", () => {
    expect(resetOutcome({ kind: "reset", code: "ABCD-EFGH-JKMN-PQRS" })).toEqual({ kind: "code", code: "ABCD-EFGH-JKMN-PQRS" });
  });

  it("un envío repetido no toca nada, y lo dice", () => {
    expect(resetOutcome({ kind: "already_sent" })).toEqual({ kind: "failed", reason: "already_sent" });
  });

  it("si lo confirmado ya no es lo que pasaría, se confirma otra vez", () => {
    expect(resetOutcome({ kind: "changed" })).toEqual({ kind: "confirm_again" });
  });

  it("ninguna respuesta que no sea «restablecida» trae un código", () => {
    for (const answer of RESET_ANSWERS.filter((each) => each !== "reset")) {
      expect(resetOutcome({ kind: "answered", answer })).not.toHaveProperty("code");
    }
  });
});
