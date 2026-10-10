import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type DocumentFacts, type GateFacts, type GateResult, resolveSessionGate } from "./session-gate";

// La guarda de sesión (TRD §9.2, flujo de la app §6.2). Corre en toda entrada con sesión,
// en este orden: cuenta activa; contraseña fijada por quien controla el buzón; textos
// legales disponibles; y lo que a la cuenta le falte. Cubre las cuentas que no pasaron por
// el formulario: las creadas directo en Auth y las confirmadas por recuperación.

const REQUIRED = ["terms", "student_privacy_notice", "course_history_consent"];

const accepted = (docType: string, version = 1): DocumentFacts => ({
  docType,
  currentVersion: version,
  reconsentFloor: version,
  latest: { version, action: "granted" },
});

const complete: GateFacts = {
  profile: {
    status: "active",
    passwordResetRequired: false,
    displayName: "Ana Pérez",
    adultDeclaredAt: new Date("2026-10-10T12:00:00Z"),
  },
  documents: REQUIRED.map((docType) => accepted(docType)),
};

const withProfile = (changes: Partial<NonNullable<GateFacts["profile"]>>): GateFacts => ({
  ...complete,
  profile: { ...(complete.profile as NonNullable<GateFacts["profile"]>), ...changes },
});

const withDocument = (docType: string, changes: Partial<DocumentFacts>): GateFacts => ({
  ...complete,
  documents: complete.documents.map((doc) => (doc.docType === docType ? { ...doc, ...changes } : doc)),
});

const gate = (facts: GateFacts) => resolveSessionGate(facts, REQUIRED);

describe("resolveSessionGate", () => {
  it("una cuenta completa pasa", () => {
    expect(gate(complete)).toEqual({ outcome: "pass" });
  });

  it("una sesión sin perfil cuenta como bloqueada", () => {
    expect(gate({ ...complete, profile: null })).toEqual({ outcome: "blocked", reason: "no_profile" });
  });

  it.each(["suspended", "deleted"] as const)("una cuenta %s no entra", (status) => {
    expect(gate(withProfile({ status }))).toEqual({ outcome: "blocked", reason: status });
  });

  it("con la marca de contraseña prendida no entra, aunque todo lo demás esté", () => {
    expect(gate(withProfile({ passwordResetRequired: true }))).toEqual({ outcome: "password_reset_required" });
  });

  it("la cuenta bloqueada va antes que la marca, y la marca antes que lo que falte", () => {
    const everythingWrong: GateFacts = {
      profile: { status: "suspended", passwordResetRequired: true, displayName: null, adultDeclaredAt: null },
      documents: [],
    };
    expect(gate(everythingWrong)).toEqual({ outcome: "blocked", reason: "suspended" });
    expect(gate({ ...everythingWrong, profile: { ...everythingWrong.profile!, status: "active" } })).toEqual({
      outcome: "password_reset_required",
    });
  });

  it("recién confirmada por recuperación: le falta todo, y se le pide completar la cuenta", () => {
    const facts: GateFacts = {
      profile: { status: "active", passwordResetRequired: false, displayName: null, adultDeclaredAt: null },
      documents: REQUIRED.map((docType) => ({ docType, currentVersion: 1, reconsentFloor: 1, latest: null })),
    };
    expect(gate(facts)).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: {
        name: true,
        adultDeclaration: true,
        documents: REQUIRED.map((docType) => ({ docType, why: "never_given" })),
      },
    });
  });

  it.each([
    ["sin nombre", { displayName: null }],
    ["con un nombre de puros espacios", { displayName: "   " }],
    ["con un nombre que no tiene letras ni números", { displayName: "..." }],
  ])("a una cuenta %s le falta el nombre", (_name, changes) => {
    expect(gate(withProfile(changes))).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: { name: true, adultDeclaration: false, documents: [] },
    });
  });

  it("a una cuenta sin edad declarada le falta la declaración", () => {
    expect(gate(withProfile({ adultDeclaredAt: null }))).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: { name: false, adultDeclaration: true, documents: [] },
    });
  });

  it("un texto que nunca aceptó se le pide como parte de completar la cuenta", () => {
    expect(gate(withDocument("course_history_consent", { latest: null }))).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "course_history_consent", why: "never_given" }] },
    });
  });

  it("un consentimiento retirado cuenta como faltante, y no se presenta como un texto actualizado", () => {
    expect(gate(withDocument("course_history_consent", { latest: { version: 1, action: "withdrawn" } }))).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "course_history_consent", why: "withdrawn" }] },
    });
  });

  it("un retiro junto con una versión nueva es completar la cuenta, no textos actualizados", () => {
    const facts: GateFacts = {
      ...complete,
      documents: [
        { docType: "terms", currentVersion: 2, reconsentFloor: 2, latest: { version: 1, action: "granted" } },
        accepted("student_privacy_notice"),
        { docType: "course_history_consent", currentVersion: 1, reconsentFloor: 1, latest: { version: 1, action: "withdrawn" } },
      ],
    };
    expect(gate(facts)).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: {
        name: false,
        adultDeclaration: false,
        documents: [
          { docType: "terms", why: "new_version" },
          { docType: "course_history_consent", why: "withdrawn" },
        ],
      },
    });
  });

  it("dos textos con versión nueva siguen siendo textos actualizados", () => {
    const outdated = (docType: string): DocumentFacts => ({
      docType,
      currentVersion: 2,
      reconsentFloor: 2,
      latest: { version: 1, action: "granted" },
    });
    const facts: GateFacts = {
      ...complete,
      documents: [outdated("terms"), outdated("student_privacy_notice"), accepted("course_history_consent")],
    };
    expect(gate(facts)).toMatchObject({ outcome: "incomplete", variant: "updated_texts" });
  });

  it("una versión nueva que pide volver a aceptar se le presenta como texto actualizado", () => {
    const facts = withDocument("terms", { currentVersion: 2, reconsentFloor: 2, latest: { version: 1, action: "granted" } });
    expect(gate(facts)).toEqual({
      outcome: "incomplete",
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    });
  });

  it("una versión nueva que no pide volver a aceptar no detiene a nadie", () => {
    const facts = withDocument("terms", { currentVersion: 2, reconsentFloor: 1, latest: { version: 1, action: "granted" } });
    expect(gate(facts)).toEqual({ outcome: "pass" });
  });

  it("si ninguna versión pide volver a aceptar, basta haber aceptado alguna", () => {
    const facts = withDocument("terms", { currentVersion: 3, reconsentFloor: null, latest: { version: 1, action: "granted" } });
    expect(gate(facts)).toEqual({ outcome: "pass" });
  });

  // El caso que una regla por «versión vigente» dejaba pasar: la 2 pedía volver a aceptar,
  // la 3 no. Quien aceptó la 1 nunca aceptó el cambio de la 2.
  it("una versión intermedia que pedía volver a aceptar no se salta", () => {
    const facts = withDocument("terms", { currentVersion: 3, reconsentFloor: 2, latest: { version: 1, action: "granted" } });
    expect(gate(facts)).toMatchObject({
      outcome: "incomplete",
      variant: "updated_texts",
      missing: { documents: [{ docType: "terms", why: "new_version" }] },
    });
  });

  it("si falta algo que nunca se dio y además cambió un texto, es completar la cuenta", () => {
    const facts: GateFacts = {
      ...withDocument("terms", { currentVersion: 2, reconsentFloor: 2, latest: { version: 1, action: "granted" } }),
      profile: { ...complete.profile!, adultDeclaredAt: null },
    };
    expect(gate(facts)).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: { name: false, adultDeclaration: true, documents: [{ docType: "terms", why: "new_version" }] },
    });
  });

  it("sin texto vigente de un tipo obligatorio, nadie entra", () => {
    expect(gate(withDocument("terms", { currentVersion: null }))).toEqual({
      outcome: "unavailable",
      reason: "no_current_text",
      docTypes: ["terms"],
    });
  });

  it.each<[string, GateFacts]>([
    ["falta un tipo obligatorio", { ...complete, documents: complete.documents.slice(1) }],
    ["un tipo obligatorio viene repetido", { ...complete, documents: [...complete.documents, accepted("terms")] }],
    ["la lista de textos viene vacía", { ...complete, documents: [] }],
  ])("si en los hechos %s, la guarda no deja pasar", (_name, facts) => {
    expect(gate(facts)).toMatchObject({ outcome: "unavailable", reason: "facts_incomplete" });
  });

  it("dice cuáles tipos faltan o vienen repetidos", () => {
    expect(gate({ ...complete, documents: [accepted("terms"), accepted("terms")] })).toEqual({
      outcome: "unavailable",
      reason: "facts_incomplete",
      docTypes: ["terms", "student_privacy_notice", "course_history_consent"],
    });
  });

  it("un retiro manda aunque además haya una versión nueva de ese mismo texto", () => {
    const facts = withDocument("terms", { currentVersion: 2, reconsentFloor: 2, latest: { version: 1, action: "withdrawn" } });
    expect(gate(facts)).toEqual({
      outcome: "incomplete",
      variant: "complete_account",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "withdrawn" }] },
    });
  });

  it("sin texto vigente y sin ninguna versión que pida volver a aceptar, tampoco entra nadie", () => {
    expect(gate(withDocument("terms", { currentVersion: null, reconsentFloor: null }))).toEqual({
      outcome: "unavailable",
      reason: "no_current_text",
      docTypes: ["terms"],
    });
  });

  // La base no puede producir estos hechos. La guarda no se apoya en eso: un número que no
  // es un número haría falsas todas las comparaciones, y ahí «falso» significa «cumplido».
  it.each<[string, Partial<DocumentFacts>]>([
    ["la versión aceptada no es un número", { latest: { version: Number.NaN, action: "granted" } }],
    ["la versión aceptada no es entera", { latest: { version: 0.5, action: "granted" } }],
    ["la versión aceptada es negativa", { reconsentFloor: null, latest: { version: -1, action: "granted" } }],
    ["la versión aceptada va por delante de la vigente", { currentVersion: 3, reconsentFloor: 3, latest: { version: 99, action: "granted" } }],
    ["la versión que pide volver a aceptar no es un número", { reconsentFloor: Number.NaN }],
    ["la versión que pide volver a aceptar va por delante de la vigente", { currentVersion: 1, reconsentFloor: 2 }],
    ["la versión vigente no es un número", { currentVersion: Number.NaN }],
    ["la versión vigente es negativa", { currentVersion: -1, reconsentFloor: null, latest: null }],
    ["no hay texto vigente y la versión que pide volver a aceptar no es un número", { currentVersion: null, reconsentFloor: Number.NaN }],
  ])("si %s, la guarda no deja pasar", (_name, changes) => {
    expect(gate(withDocument("terms", changes))).toEqual({
      outcome: "unavailable",
      reason: "facts_incomplete",
      docTypes: ["terms"],
    });
  });

  it("un consentimiento con una acción que la guarda no conoce no vale como otorgado", () => {
    const facts = withDocument("terms", { latest: { version: 1, action: "pending" as never } });
    expect(gate(facts)).toMatchObject({ outcome: "incomplete", missing: { documents: [{ docType: "terms", why: "withdrawn" }] } });
  });

  it("si el dato de la marca no llegó, se da por prendida", () => {
    expect(gate(withProfile({ passwordResetRequired: undefined as never }))).toEqual({ outcome: "password_reset_required" });
    expect(gate(withProfile({ passwordResetRequired: null as never }))).toEqual({ outcome: "password_reset_required" });
  });

  it("un estado de cuenta que la guarda no conoce no es una cuenta activa", () => {
    expect(gate(withProfile({ status: "locked" as never }))).toEqual({ outcome: "blocked", reason: "no_profile" });
  });

  it.each<[string, unknown]>([
    ["no llegó", undefined],
    ["es una fecha inválida", new Date(Number.NaN)],
    ["es un texto y no una fecha", "2026-10-10"],
  ])("si la declaración de edad %s, cuenta como faltante", (_name, value) => {
    expect(gate(withProfile({ adultDeclaredAt: value as never }))).toMatchObject({
      outcome: "incomplete",
      missing: { adultDeclaration: true },
    });
  });

  it("un tipo obligatorio nombrado dos veces se pide una sola vez", () => {
    const facts = withDocument("terms", { latest: null });
    expect(resolveSessionGate(facts, ["terms", "terms", ...REQUIRED])).toMatchObject({
      outcome: "incomplete",
      missing: { documents: [{ docType: "terms", why: "never_given" }] },
    });
  });

  it("sin tipos obligatorios declarados, la guarda no deja pasar: no se salta los textos por omisión", () => {
    expect(resolveSessionGate(complete, [])).toEqual({ outcome: "unavailable", reason: "facts_incomplete", docTypes: [] });
  });

  it("un texto que no es obligatorio no cuenta, ni a favor ni en contra", () => {
    const extra: DocumentFacts = { docType: "refund_policy", currentVersion: null, reconsentFloor: null, latest: null };
    expect(gate({ ...complete, documents: [...complete.documents, extra] })).toEqual({ outcome: "pass" });
  });

  // Los generadores cargan la mano hacia las cuentas que llegan al último paso de la
  // guarda: si casi todas se detuvieran antes, las propiedades de abajo no probarían nada.
  // Hechos como los que la base puede dar: ni el piso ni lo aceptado van por delante de la
  // versión vigente. Los que no tienen sentido tienen su propia tabla, arriba.
  const anyDocument = (docType: string) =>
    fc.integer({ min: 0, max: 5 }).chain((current) =>
      fc.record({
        docType: fc.constant(docType),
        currentVersion: fc.option(fc.constant(current), { nil: null, freq: 20 }),
        reconsentFloor: fc.option(fc.integer({ min: 0, max: current }), { nil: null }),
        latest: fc.option(
          fc.record({
            version: fc.integer({ min: 0, max: current }),
            action: fc.constantFrom("granted" as const, "granted" as const, "withdrawn" as const),
          }),
          { nil: null, freq: 4 },
        ),
      }),
    );

  const anyFacts: fc.Arbitrary<GateFacts> = fc.record({
    profile: fc.option(
      fc.record({
        status: fc.constantFrom("active" as const, "active" as const, "active" as const, "suspended" as const, "deleted" as const),
        passwordResetRequired: fc.constantFrom(false, false, false, true),
        displayName: fc.option(fc.constantFrom("Ana", "Ana", "Ana", "  ", "", "..."), { nil: null, freq: 6 }),
        adultDeclaredAt: fc.option(fc.constant(new Date("2026-10-10T12:00:00Z")), { nil: null, freq: 4 }),
      }),
      { nil: null, freq: 10 },
    ),
    // Casi siempre los tres tipos; a veces falta alguno, que es un error de quien llama.
    documents: fc
      .tuple(...REQUIRED.map(anyDocument))
      .chain((docs) => fc.oneof({ weight: 9, arbitrary: fc.constant(docs) }, { weight: 1, arbitrary: fc.subarray(docs) }))
      .map((kept) => [...kept]),
  });

  it("los generadores sí llegan a cada resultado de la guarda", () => {
    const seen = new Set(fc.sample(anyFacts, 2000).map((facts) => gate(facts).outcome));
    expect([...seen].sort()).toEqual(["blocked", "incomplete", "pass", "password_reset_required", "unavailable"]);
    const variants = new Set(
      fc
        .sample(anyFacts, 2000)
        .map((facts) => gate(facts))
        .flatMap((result) => (result.outcome === "incomplete" ? [result.variant] : [])),
    );
    expect([...variants].sort()).toEqual(["complete_account", "updated_texts"]);
  });

  it("con la marca prendida, sin perfil o con la cuenta bloqueada, nunca hay pase", () => {
    fc.assert(
      fc.property(anyFacts, (facts) => {
        const result = gate(facts);
        const profile = facts.profile;
        if (profile === null || profile.status !== "active" || profile.passwordResetRequired) {
          expect(result.outcome).not.toBe("pass");
          expect(result.outcome).not.toBe("incomplete");
        }
      }),
    );
  });

  it("el pase exige nombre, edad y cada texto obligatorio aceptado", () => {
    fc.assert(
      fc.property(anyFacts, (facts) => {
        if (gate(facts).outcome !== "pass") return;
        expect(facts.profile?.displayName).toBe("Ana");
        expect(facts.profile?.adultDeclaredAt).not.toBeNull();
        for (const docType of REQUIRED) {
          const matches = facts.documents.filter((doc) => doc.docType === docType);
          expect(matches).toHaveLength(1);
          expect(matches[0]?.currentVersion).not.toBeNull();
          expect(matches[0]?.latest?.action).toBe("granted");
        }
      }),
    );
  });

  it("quitarle un consentimiento a una cuenta nunca la acerca al pase", () => {
    fc.assert(
      fc.property(anyFacts, fc.constantFrom(...REQUIRED), (facts, docType) => {
        fc.pre(gate(facts).outcome !== "pass");
        const without: GateFacts = {
          ...facts,
          documents: facts.documents.map((doc) => (doc.docType === docType ? { ...doc, latest: null } : doc)),
        };
        expect(gate(without).outcome).not.toBe("pass");
      }),
    );
  });

  // Cumplir lo que la guarda pide es lo que hace PA-15. Si después de cumplirlo la guarda
  // no diera el pase, la persona quedaría dando vueltas.
  it("dar exactamente lo que la guarda pide lleva al pase", () => {
    const fulfil = (facts: GateFacts, result: Extract<GateResult, { outcome: "incomplete" }>): GateFacts => ({
      profile: {
        ...(facts.profile as NonNullable<GateFacts["profile"]>),
        displayName: result.missing.name ? "Ana" : (facts.profile?.displayName ?? null),
        adultDeclaredAt: result.missing.adultDeclaration
          ? new Date("2026-10-10T12:00:00Z")
          : (facts.profile?.adultDeclaredAt ?? null),
      },
      documents: facts.documents.map((doc) =>
        result.missing.documents.some((missing) => missing.docType === doc.docType)
          ? { ...doc, latest: { version: doc.currentVersion ?? 0, action: "granted" as const } }
          : doc,
      ),
    });
    fc.assert(
      fc.property(anyFacts, (facts) => {
        const result = gate(facts);
        if (result.outcome !== "incomplete") return;
        // Un texto vigente anterior al que exige volver a aceptar no puede existir: la
        // base publica versiones crecientes, y el piso sale de las que ya rigen.
        fc.pre(facts.documents.every((doc) => doc.reconsentFloor === null || (doc.currentVersion ?? 0) >= doc.reconsentFloor));
        expect(gate(fulfil(facts, result))).toEqual({ outcome: "pass" });
      }),
    );
  });

  // El oráculo sale de los hechos, no de la salida de la guarda: «textos actualizados» solo
  // cuando la persona ya tiene nombre y edad, nunca dejó de aceptar nada, y lo único que
  // pasa es que alguno de los textos que aceptó quedó atrás.
  it("la variante de textos actualizados solo sale cuando todo lo que falta es una versión nueva", () => {
    fc.assert(
      fc.property(anyFacts, (facts) => {
        const result = gate(facts);
        if (result.outcome !== "incomplete") return;
        const profile = facts.profile;
        const everythingWasGiven =
          profile?.displayName === "Ana" &&
          profile.adultDeclaredAt !== null &&
          facts.documents.every((doc) => doc.latest?.action === "granted");
        expect(result.variant).toBe(everythingWasGiven ? "updated_texts" : "complete_account");
      }),
    );
  });
});
