import { describe, expect, it } from "vitest";

import type { LegalText, PendingAccount, RegistrationCompletion } from "@/services/account/account";

import { acceptName, shownValue } from "../../consentimientos/outcomes";

import {
  boxesOf,
  checkCompleteForm,
  completeRegistrationOutcome,
  completeView,
  LEGAL_BOX,
  readCompleteForm,
  type CompleteOutcome,
} from "./outcomes";

// Qué pinta y qué hace la pantalla que completa una cuenta desde el enlace del correo
// (diseño, PA-14, variante «Completa tu cuenta»; FL-03).

const ID = {
  terms: "11111111-1111-4111-8111-111111111111",
  student_privacy_notice: "22222222-2222-4222-8222-222222222222",
  course_history_consent: "33333333-3333-4333-8333-333333333333",
  community_policy: "44444444-4444-4444-8444-444444444444",
} as const;
type DocType = keyof typeof ID;

const text = (docType: DocType, title: string, body = "Texto."): LegalText => ({
  docType,
  documentId: ID[docType],
  version: 3,
  title,
  body,
  effectiveFrom: "2026-11-12T06:00:00.000Z",
});
const texts = [
  text("terms", "Términos y condiciones"),
  text("student_privacy_notice", "Aviso de privacidad"),
  text("course_history_consent", "Tu historial de cursos", "# Tu historial\n\nPrimero.\n\nSegundo,\ncon dos renglones."),
];
const slugOf = (docType: string) =>
  ({ terms: "terminos", student_privacy_notice: "privacidad", course_history_consent: "historial-de-cursos" })[docType] ?? null;
const formatDate = (iso: string) => `fecha(${iso.slice(0, 10)})`;
const view = (list: LegalText[] = texts) => completeView({ texts: list, minimumAge: 18 }, { slugOf, formatDate });

const HISTORY_BOX = acceptName("course_history_consent");

function form(entries: [string, string | Blob][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
const shown = (...docTypes: DocType[]): [string, string][] =>
  docTypes.map((docType) => ["shown", shownValue({ docType, documentId: ID[docType] })]);
const all = shown("terms", "student_privacy_notice", "course_history_consent");

describe("lo que la pantalla pide", () => {
  it("los tres textos: Términos y Aviso en una casilla, el historial en su bloque explicado", () => {
    const item = (docType: DocType, title: string, slug: string) => ({
      docType,
      documentId: ID[docType],
      title,
      version: 3,
      effectiveDate: "fecha(2026-11-12)",
      href: `/legal/${slug}?v=3`,
      explanation: null,
    });
    const terms = item("terms", "Términos y condiciones", "terminos");
    const privacy = item("student_privacy_notice", "Aviso de privacidad", "privacidad");
    const history = {
      ...item("course_history_consent", "Tu historial de cursos", "historial-de-cursos"),
      explanation: ["Primero.", "Segundo, con dos renglones."],
    };
    expect(view()).toEqual({
      minimumAge: 18,
      boxes: [
        { name: LEGAL_BOX, kind: "legal", items: [terms, privacy] },
        { name: HISTORY_BOX, kind: "history", items: [history] },
      ],
      items: [terms, privacy, history],
      signature: `${ID.terms},${ID.student_privacy_notice},${ID.course_history_consent}`,
    });
  });

  it("el enlace a cada texto lleva la versión que la casilla anuncia", () => {
    const newer = view([{ ...text("terms", "Términos"), version: 7 }]);
    expect(newer.items[0]?.href).toBe("/legal/terminos?v=7");
  });

  it("un texto obligatorio que no es ninguno de esos tres lleva su propia casilla, y no se esconde", () => {
    const withExtra = view([...texts, text("community_policy", "Política de la comunidad")]);
    expect(withExtra.boxes.map((box) => [box.name, box.kind, box.items.map((item) => item.docType)])).toEqual([
      [LEGAL_BOX, "legal", ["terms", "student_privacy_notice"]],
      [HISTORY_BOX, "history", ["course_history_consent"]],
      [acceptName("community_policy"), "other", ["community_policy"]],
    ]);
    // Sin página propia, no hay enlace.
    expect(withExtra.items[3]?.href).toBeNull();
  });

  it("con uno solo de los dos textos de la casilla doble no hay casilla doble: su frase nombra a los dos", () => {
    expect(view([text("student_privacy_notice", "Aviso")]).boxes).toMatchObject([
      { name: acceptName("student_privacy_notice"), kind: "other" },
    ]);
    expect(view([text("terms", "Términos"), text("course_history_consent", "Historial")]).boxes).toMatchObject([
      { name: acceptName("terms"), kind: "other" },
      { name: HISTORY_BOX, kind: "history" },
    ]);
  });

  it("la firma cambia cuando cambia un texto", () => {
    const changed = view([{ ...text("terms", "Términos"), documentId: ID.community_policy }, ...texts.slice(1)]);
    expect(changed.signature).not.toBe(view().signature);
  });

  it("la casilla de cada tipo", () => {
    expect([...boxesOf(["terms", "student_privacy_notice", "course_history_consent", "community_policy"])]).toEqual([
      ["terms", LEGAL_BOX],
      ["student_privacy_notice", LEGAL_BOX],
      ["course_history_consent", HISTORY_BOX],
      ["community_policy", "accept:community_policy"],
    ]);
    expect([...boxesOf(["terms", "course_history_consent"])]).toEqual([
      ["terms", "accept:terms"],
      ["course_history_consent", HISTORY_BOX],
    ]);
    expect([...boxesOf([])]).toEqual([]);
  });
});

describe("lo que llega del formulario", () => {
  it("todo marcado: se aceptan los textos que se pintaron", () => {
    expect(
      readCompleteForm(
        form([
          ["token", "abcdefgh12345678"],
          ["name", " Ana Prueba "],
          ["password", " una clave larga "],
          ["adult", "on"],
          ...all,
          [LEGAL_BOX, "on"],
          [HISTORY_BOX, "on"],
        ]),
      ),
    ).toEqual({
      token: "abcdefgh12345678",
      name: " Ana Prueba ",
      password: " una clave larga ",
      adult: true,
      accepted: [ID.terms, ID.student_privacy_notice, ID.course_history_consent],
      marked: [LEGAL_BOX, HISTORY_BOX],
      unchecked: [],
    });
  });

  it("la casilla doble acepta sus dos textos, y solo esos", () => {
    const read = readCompleteForm(form([...all, [LEGAL_BOX, "on"]]));
    expect(read.accepted).toEqual([ID.terms, ID.student_privacy_notice]);
    expect(read.marked).toEqual([LEGAL_BOX]);
    expect(read.unchecked).toEqual([HISTORY_BOX]);
  });

  it("la del historial acepta solo el historial", () => {
    const read = readCompleteForm(form([...all, [HISTORY_BOX, "on"]]));
    expect(read.accepted).toEqual([ID.course_history_consent]);
    expect(read.unchecked).toEqual([LEGAL_BOX]);
  });

  it("nada marcado: nada aceptado, y faltan las dos casillas", () => {
    const read = readCompleteForm(form(all));
    expect(read).toMatchObject({ adult: false, accepted: [], marked: [], unchecked: [LEGAL_BOX, HISTORY_BOX] });
  });

  it("marcar la casilla de un texto que no se pintó no acepta nada", () => {
    const read = readCompleteForm(
      form([...shown("terms", "student_privacy_notice"), [LEGAL_BOX, "on"], [HISTORY_BOX, "on"], ["accept:community_policy", "on"]]),
    );
    expect(read.accepted).toEqual([ID.terms, ID.student_privacy_notice]);
    expect(read.marked).toEqual([LEGAL_BOX]);
    expect(read.unchecked).toEqual([]);
  });

  it("la casilla doble no acepta nada cuando solo se pintó uno de sus dos textos", () => {
    const read = readCompleteForm(form([...shown("terms"), [LEGAL_BOX, "on"]]));
    expect(read).toMatchObject({ accepted: [], marked: [], unchecked: ["accept:terms"] });
    expect(readCompleteForm(form([...shown("terms"), ["accept:terms", "on"]])).accepted).toEqual([ID.terms]);
  });

  it("una casilla solo cuenta con el valor que manda un navegador", () => {
    const read = readCompleteForm(form([...all, [LEGAL_BOX, "true"], [HISTORY_BOX, "1"], ["adult", "yes"]]));
    expect(read).toMatchObject({ adult: false, accepted: [], unchecked: [LEGAL_BOX, HISTORY_BOX] });
  });

  it("un texto pintado que no tiene forma de texto pintado no cuenta", () => {
    const read = readCompleteForm(
      form([
        ["shown", "terms=no-es-un-identificador"],
        ["shown", `TERMS=${ID.terms}`],
        ["shown", `terms=${ID.terms} `],
        ["shown", ID.terms],
        [LEGAL_BOX, "on"],
      ]),
    );
    expect(read).toMatchObject({ accepted: [], marked: [], unchecked: [] });
  });

  it("lo que falta, lo que no es texto y lo desmedido cuentan como vacío", () => {
    expect(readCompleteForm(form([]))).toEqual({ token: "", name: "", password: "", adult: false, accepted: [], marked: [], unchecked: [] });
    const blob = new Blob(["x"]);
    expect(readCompleteForm(form([["token", blob], ["name", blob], ["password", blob]]))).toMatchObject({ token: "", name: "", password: "" });
    const big = readCompleteForm(form([["token", "t".repeat(257)], ["name", "n".repeat(501)], ["password", "p".repeat(1_025)]]));
    expect(big).toMatchObject({ token: "", name: "", password: "" });
    const fits = readCompleteForm(form([["token", "t".repeat(256)], ["name", "n".repeat(500)], ["password", "p".repeat(1_024)]]));
    expect([fits.token.length, fits.name.length, fits.password.length]).toEqual([256, 500, 1_024]);
  });

  it.each([null, undefined, "token=abc", 42, {}, new URLSearchParams("name=Ana")])(
    "lo que no es un formulario cuenta como un formulario vacío: %j",
    (notAForm) => {
      expect(readCompleteForm(notAForm)).toEqual({ token: "", name: "", password: "", adult: false, accepted: [], marked: [], unchecked: [] });
    },
  );

  it("la contraseña llega tal cual, sin recortar", () => {
    expect(readCompleteForm(form([["password", "  con espacios  "]])).password).toBe("  con espacios  ");
  });
});

describe("lo que se revisa antes de enviar", () => {
  const good = { name: "Ana Prueba", password: "una clave larga", adult: true, marked: [LEGAL_BOX, HISTORY_BOX] };

  it("con todo en orden no hay nada que corregir", () => {
    expect(checkCompleteForm(view(), good)).toBeNull();
  });

  it.each([
    [{ name: "" }, { name: "empty" }],
    [{ name: "   " }, { name: "empty" }],
    [{ name: "x".repeat(121) }, { name: "too_long" }],
    [{ password: "" }, { password: "too_short" }],
    [{ password: "1234567" }, { password: "too_short" }],
    [{ password: "x".repeat(73) }, { password: "too_long" }],
    [{ password: "con\u0000nulo" }, { password: "malformed" }],
    [{ adult: false }, { adult: true }],
    [{ marked: [HISTORY_BOX] }, { boxes: [LEGAL_BOX] }],
    [{ marked: [LEGAL_BOX] }, { boxes: [HISTORY_BOX] }],
    [{ marked: [] }, { boxes: [LEGAL_BOX, HISTORY_BOX] }],
    [{ marked: ["accept:otra"] }, { boxes: [LEGAL_BOX, HISTORY_BOX] }],
  ])("%j: %j", (change, expected) => {
    expect(checkCompleteForm(view(), { ...good, ...change })).toEqual(expected);
  });

  it("todo lo que falta sale junto", () => {
    expect(checkCompleteForm(view(), { name: "", password: "corta", adult: false, marked: [] })).toEqual({
      name: "empty",
      password: "too_short",
      adult: true,
      boxes: [LEGAL_BOX, HISTORY_BOX],
    });
  });

  it("es la misma revisión que hace el servidor con lo que leyó del formulario", () => {
    const read = readCompleteForm(form([["name", "Ana"], ["password", "una clave larga"], ["adult", "on"], ...all, [LEGAL_BOX, "on"]]));
    expect(checkCompleteForm(view(), read)).toEqual({ boxes: [HISTORY_BOX] });
  });
});

describe("lo que contesta el servicio", () => {
  const pending: PendingAccount = {
    variant: "updated_texts",
    missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
  };

  it.each<[RegistrationCompletion, CompleteOutcome]>([
    [{ kind: "entered", pending: null }, { kind: "redirect", to: "/inicio", notice: null }],
    [{ kind: "entered", pending }, { kind: "redirect", to: "/consentimientos", notice: null }],
    [{ kind: "ready_sign_in" }, { kind: "redirect", to: "/entrar", notice: "account_ready" }],
    [{ kind: "texts_changed" }, { kind: "repaint" }],
    [{ kind: "texts_unavailable" }, { kind: "texts_unavailable" }],
    [{ kind: "link_dead" }, { kind: "link_dead" }],
    [{ kind: "recover_instead" }, { kind: "recover_instead" }],
    [{ kind: "unavailable" }, { kind: "unavailable" }],
  ])("%j", (result, expected) => {
    expect(completeRegistrationOutcome(result, [])).toEqual(expected);
  });

  it("un dato inválido se dice en su campo", () => {
    expect(completeRegistrationOutcome({ kind: "invalid", fields: { name: "too_long", password: "too_short", adult: "required" } }, [])).toEqual({
      kind: "invalid",
      fields: { name: "too_long", password: "too_short", adult: true },
    });
  });

  it("cuando falta un texto, la pantalla dice cuál casilla", () => {
    expect(completeRegistrationOutcome({ kind: "invalid", fields: { texts: "required" } }, [HISTORY_BOX])).toEqual({
      kind: "invalid",
      fields: { boxes: [HISTORY_BOX] },
    });
  });

  it("las casillas sin marcar salen junto con los datos inválidos, aunque el servicio todavía no llegara a ellas", () => {
    expect(completeRegistrationOutcome({ kind: "invalid", fields: { name: "empty" } }, [LEGAL_BOX, HISTORY_BOX])).toEqual({
      kind: "invalid",
      fields: { name: "empty", boxes: [LEGAL_BOX, HISTORY_BOX] },
    });
  });

  it("si falta un texto y todas las casillas pintadas venían marcadas, el formulario no es el vigente: se vuelve a pintar", () => {
    expect(completeRegistrationOutcome({ kind: "invalid", fields: { texts: "required" } }, [])).toEqual({ kind: "repaint" });
    expect(completeRegistrationOutcome({ kind: "invalid", fields: { name: "empty", texts: "required" } }, [])).toEqual({ kind: "repaint" });
  });

  it("solo quedar dentro o con la cuenta lista saca de la pantalla", () => {
    const results: RegistrationCompletion[] = [
      { kind: "invalid", fields: { name: "empty" } },
      { kind: "texts_changed" },
      { kind: "texts_unavailable" },
      { kind: "link_dead" },
      { kind: "recover_instead" },
      { kind: "unavailable" },
    ];
    for (const result of results) expect(completeRegistrationOutcome(result, [LEGAL_BOX]).kind).not.toBe("redirect");
  });
});
