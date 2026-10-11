import { describe, expect, it } from "vitest";

import type { AccountCompletion, LegalText, PendingAccount } from "@/services/account/account";

import {
  acceptName,
  checkConsentsForm,
  completeAccountOutcome,
  consentsView,
  readConsentsForm,
  shownValue,
  type ConsentsView,
} from "./outcomes";

// Qué pinta y qué hace la pantalla que pide lo que le falta a una cuenta (diseño, PA-15;
// FL-05, paso 4).

const ID = {
  terms: "11111111-1111-4111-8111-111111111111",
  student_privacy_notice: "22222222-2222-4222-8222-222222222222",
  course_history_consent: "33333333-3333-4333-8333-333333333333",
} as const;

const text = (docType: keyof typeof ID, title: string, body = "Texto."): LegalText => ({
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
const facts = { texts, minimumAge: 18 };
const slugOf = (docType: string) =>
  ({ terms: "terminos", student_privacy_notice: "privacidad", course_history_consent: "historial-de-cursos" })[docType] ?? null;
const formatDate = (iso: string) => `fecha(${iso.slice(0, 10)})`;

const pendingAll: PendingAccount = {
  variant: "complete_account",
  missing: {
    name: true,
    adultDeclaration: true,
    documents: [
      { docType: "terms", why: "never_given" },
      { docType: "student_privacy_notice", why: "never_given" },
      { docType: "course_history_consent", why: "never_given" },
    ],
  },
};

const view = (pending: PendingAccount): ConsentsView => consentsView(pending, facts, { slugOf, formatDate });

describe("lo que la pantalla pide", () => {
  it("a una cuenta sin completar le pide todo, y el historial va en su bloque explicado", () => {
    expect(view(pendingAll)).toEqual({
      variant: "complete_account",
      askName: true,
      askAdult: true,
      minimumAge: 18,
      items: [
        { docType: "terms", documentId: ID.terms, title: "Términos y condiciones", version: 3, effectiveDate: "fecha(2026-11-12)", href: "/legal/terminos?v=3", explanation: null },
        { docType: "student_privacy_notice", documentId: ID.student_privacy_notice, title: "Aviso de privacidad", version: 3, effectiveDate: "fecha(2026-11-12)", href: "/legal/privacidad?v=3", explanation: null },
        {
          docType: "course_history_consent",
          documentId: ID.course_history_consent,
          title: "Tu historial de cursos",
          version: 3,
          effectiveDate: "fecha(2026-11-12)",
          // También el que se pinta junto a su casilla se puede leer completo en su página.
          href: "/legal/historial-de-cursos?v=3",
          // El título del cuerpo no se repite: el bloque ya lleva el del texto.
          explanation: ["Primero.", "Segundo, con dos renglones."],
        },
      ],
      signature: `${ID.terms},${ID.student_privacy_notice},${ID.course_history_consent}`,
    });
  });

  it("pide solo lo que falta, en el orden de los textos", () => {
    const some = view({
      variant: "complete_account",
      missing: { name: false, adultDeclaration: true, documents: [{ docType: "course_history_consent", why: "withdrawn" }] },
    });
    expect(some).toMatchObject({ askName: false, askAdult: true });
    expect(some.items.map((item) => item.docType)).toEqual(["course_history_consent"]);
    expect(some.signature).toBe(ID.course_history_consent);
  });

  it("cuando solo cambió una versión, cada texto va con su versión, su fecha y su enlace, sin bloque", () => {
    const updated = view({
      variant: "updated_texts",
      missing: {
        name: false,
        adultDeclaration: false,
        documents: [
          { docType: "course_history_consent", why: "new_version" },
          { docType: "terms", why: "new_version" },
        ],
      },
    });
    expect(updated.variant).toBe("updated_texts");
    expect(updated.items).toEqual([
      // El enlace lleva la versión que la casilla anuncia: la página no enseña una anterior.
      { docType: "terms", documentId: ID.terms, title: "Términos y condiciones", version: 3, effectiveDate: "fecha(2026-11-12)", href: "/legal/terminos?v=3", explanation: null },
      {
        docType: "course_history_consent",
        documentId: ID.course_history_consent,
        title: "Tu historial de cursos",
        version: 3,
        effectiveDate: "fecha(2026-11-12)",
        href: "/legal/historial-de-cursos?v=3",
        explanation: null,
      },
    ]);
  });

  it("un texto sin página propia no lleva enlace", () => {
    const noPages = consentsView(pendingAll, facts, { slugOf: () => null, formatDate });
    expect(noPages.items.map((item) => item.href)).toEqual([null, null, null]);
  });

  it("un tipo que falta y no tiene texto vigente no se pinta: no hay qué aceptar", () => {
    const missingText = consentsView(pendingAll, { texts: texts.slice(0, 2), minimumAge: 18 }, { slugOf, formatDate });
    expect(missingText.items.map((item) => item.docType)).toEqual(["terms", "student_privacy_notice"]);
  });
});

describe("lo que llega del formulario", () => {
  function form(entries: [string, string | Blob][]): FormData {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return data;
  }

  it("cada casilla marcada se convierte en el texto que la persona tuvo a la vista", () => {
    const read = readConsentsForm(
      form([
        ["name", "  Ana  "],
        ["adult", "on"],
        ["volver", "/inicio"],
        ["shown", `terms=${ID.terms}`],
        ["shown", `student_privacy_notice=${ID.student_privacy_notice}`],
        ["shown", `course_history_consent=${ID.course_history_consent}`],
        ["accept:terms", "on"],
        ["accept:course_history_consent", "on"],
        ["accept:student_privacy_notice", "off"],
      ]),
    );
    expect(read).toEqual({
      name: "  Ana  ",
      adult: true,
      returnTo: "/inicio",
      accepted: [ID.terms, ID.course_history_consent],
      acceptedTypes: ["terms", "course_history_consent"],
      unchecked: ["student_privacy_notice"],
    });
  });

  it("lo que el formulario manda es lo que aquí se lee", () => {
    const item = { docType: "terms", documentId: ID.terms };
    const read = readConsentsForm(form([["shown", shownValue(item)], [acceptName(item.docType), "on"]]));
    expect(read.accepted).toEqual([ID.terms]);
  });

  it("marcar un texto que no se pintó no acepta nada", () => {
    const read = readConsentsForm(form([["accept:terms", "on"], [`accept:${ID.terms}`, "on"]]));
    expect(read.accepted).toEqual([]);
    expect(read.unchecked).toEqual([]);
  });

  it.each([
    "terms",
    `terms=${ID.terms}=x`,
    "terms=no-es-un-identificador",
    `=${ID.terms}`,
    `Terms=${ID.terms}`,
    `terms =${ID.terms}`,
    `${"a".repeat(65)}=${ID.terms}`,
  ])("un texto pintado mal escrito no cuenta: %s", (shown) => {
    const read = readConsentsForm(form([["shown", shown], ["accept:terms", "on"]]));
    expect(read.accepted).toEqual([]);
  });

  it("lo que no es texto, o viene desmedido, cuenta como vacío", () => {
    const read = readConsentsForm(
      form([
        ["name", new Blob(["x"])],
        ["adult", "si"],
        ["volver", "x".repeat(3_000)],
        ["shown", `terms=${ID.terms}`],
        ["accept:terms", new Blob(["on"])],
      ]),
    );
    expect(read).toEqual({ name: "", adult: false, returnTo: "", accepted: [], acceptedTypes: [], unchecked: ["terms"] });
    expect(readConsentsForm(form([["name", "x".repeat(2_000)]])).name).toBe("");
  });

  it.each([null, undefined, "name=Ana", 42, {}, new URLSearchParams("name=Ana")])(
    "lo que no es un formulario cuenta como un formulario vacío: %j",
    (notAForm) => {
      expect(readConsentsForm(notAForm)).toEqual({
        name: "",
        adult: false,
        returnTo: "",
        accepted: [],
        acceptedTypes: [],
        unchecked: [],
      });
    },
  );

  it("no acepta una lista sin fin de textos", () => {
    const many = Array.from({ length: 40 }, (_, index): [string, string] => ["shown", `t${"a".repeat(index)}=${ID.terms}`]);
    const read = readConsentsForm(form([...many, ...many.map(([, value]): [string, string] => [`accept:${value.split("=")[0] ?? ""}`, "on"])]));
    expect(read.accepted.length).toBeLessThanOrEqual(20);
  });
});

describe("lo que se revisa antes de enviar", () => {
  const all = view(pendingAll);

  it("con todo lo que se pide, nada que corregir", () => {
    expect(
      checkConsentsForm(all, { name: "Ana", adult: true, acceptedTypes: ["terms", "student_privacy_notice", "course_history_consent"] }),
    ).toBeNull();
  });

  it("dice cada cosa que falta", () => {
    expect(checkConsentsForm(all, { name: "  ", adult: false, acceptedTypes: ["terms"] })).toEqual({
      name: "empty",
      adult: true,
      texts: ["student_privacy_notice", "course_history_consent"],
    });
    expect(checkConsentsForm(all, { name: "x".repeat(121), adult: true, acceptedTypes: [] })).toMatchObject({ name: "too_long" });
    expect(checkConsentsForm(all, { name: "---", adult: true, acceptedTypes: [] })).toMatchObject({ name: "invalid" });
  });

  it("no revisa lo que no se pide", () => {
    const onlyText = view({
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    });
    expect(checkConsentsForm(onlyText, { name: "", adult: false, acceptedTypes: ["terms"] })).toBeNull();
    expect(checkConsentsForm(onlyText, { name: "", adult: false, acceptedTypes: [] })).toEqual({ texts: ["terms"] });
  });
});

describe("lo que contesta el servicio", () => {
  const outcome = (result: AccountCompletion, unchecked: string[] = []) => completeAccountOutcome(result, "/inicio?x=1", unchecked);

  it("completa: va a donde iba", () => {
    expect(outcome({ kind: "complete" })).toEqual({ kind: "redirect", to: "/inicio?x=1", notice: null, closeSession: false });
    expect(completeAccountOutcome({ kind: "complete" }, "//otro.example", [])).toMatchObject({ to: "/inicio" });
  });

  it("se guardó y todavía falta algo, o el texto cambió: la pantalla se vuelve a pintar", () => {
    expect(outcome({ kind: "incomplete", ...pendingAll })).toEqual({ kind: "repaint", reason: "incomplete" });
    expect(outcome({ kind: "texts_changed" })).toEqual({ kind: "repaint", reason: "texts_changed" });
  });

  it("datos por corregir: dice cuál casilla falta", () => {
    expect(outcome({ kind: "invalid", fields: { name: "empty", adult: "required", texts: "required" } }, ["terms"])).toEqual({
      kind: "invalid",
      fields: { name: "empty", adult: true, texts: ["terms"] },
    });
    expect(outcome({ kind: "invalid", fields: { name: "too_long" } }, ["terms"])).toEqual({
      kind: "invalid",
      fields: { name: "too_long" },
    });
  });

  it("si el servicio dice que falta un texto y el formulario no sabe cuál, el formulario no es el que se pintó", () => {
    expect(outcome({ kind: "invalid", fields: { texts: "required" } }, [])).toEqual({ kind: "repaint", reason: "texts_changed" });
  });

  it("no se supo", () => {
    expect(outcome({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(outcome({ kind: "session", check: { kind: "unavailable" } })).toEqual({ kind: "unavailable" });
  });

  it("la sesión ya no llega hasta aquí: se obedece a la guarda", () => {
    expect(outcome({ kind: "session", check: { kind: "anonymous" } })).toEqual({
      kind: "redirect",
      to: "/entrar?volver=%2Finicio%3Fx%3D1",
      notice: null,
      closeSession: false,
    });
    expect(outcome({ kind: "session", check: { kind: "suspended" } })).toEqual({ kind: "suspended" });
    expect(outcome({ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } })).toEqual({
      kind: "redirect",
      to: "/entrar",
      notice: null,
      closeSession: true,
    });
    expect(outcome({ kind: "session", check: { kind: "must_sign_out", then: "recover" } })).toEqual({
      kind: "redirect",
      to: "/recuperar",
      notice: "choose_password",
      closeSession: true,
    });
  });

  it("solo se cierra la sesión cuando la guarda lo dijo", () => {
    const results: AccountCompletion[] = [
      { kind: "complete" },
      { kind: "incomplete", ...pendingAll },
      { kind: "invalid", fields: {} },
      { kind: "texts_changed" },
      { kind: "unavailable" },
      { kind: "session", check: { kind: "anonymous" } },
      { kind: "session", check: { kind: "suspended" } },
      { kind: "session", check: { kind: "unavailable" } },
    ];
    for (const result of results) {
      const got = outcome(result);
      expect(got.kind === "redirect" && got.closeSession).toBe(false);
    }
  });
});
