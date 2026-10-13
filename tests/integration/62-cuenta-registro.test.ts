import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@/adapters/supabase/auth";
import { IdentityUnavailableError } from "@/adapters/supabase/errors";
import { buckets } from "@/services/account/fingerprint";
import { resolveOrigin } from "@/services/account/origin";

import {
  ageLastMail,
  bucketRows,
  claimedUser,
  clearThrottle,
  consentsOf,
  currentTextIds,
  freshOrigin,
  hitsOf,
  holdLock,
  holdProfile,
  holdProfileUntilFirstGivesUp,
  notedSessions,
  parameter,
  profileOf,
  registrationBuckets,
  seedHits,
  testServices,
  throttleRows,
} from "./helpers/account";
import {
  authAdmin,
  authVisitor,
  failingFetch,
  memoryJar,
  networkDown,
  recordingFetch,
  sessionCount,
  userIdOf,
} from "./helpers/auth";
import { lastMailTo, mailsTo, tokenHashIn, waitForMails } from "./helpers/mailbox";
import { claimAccount, deleteTestUsersByEmail, ownerQuery, testEmail } from "./helpers/users";

// Pedir el registro y completarlo desde el enlace (RF-101, RF-108, RF-109; TRD §9.2, filas
// «Registro», «Quién fija la contraseña» y «Verificación de correo», y §9.9), contra la
// base, el Auth y el buzón locales. Cada caso empieza con los contadores vacíos y con su
// propia dirección.

const COOKIE = "plataforma-sesion";
const emails: string[] = [];
let texts: Awaited<ReturnType<typeof currentTextIds>>;
let accepted: string[];

function newEmail(): string {
  const email = testEmail();
  emails.push(email);
  return email;
}

const password = () => `P-${randomUUID()}`;

/** Llega cuando ya llegó todo lo que se pidió antes: sirve para afirmar que algo no llegó. */
async function sentinel(): Promise<void> {
  const email = newEmail();
  await authAdmin().auth.admin.inviteUserByEmail(email);
  await waitForMails(email, 1);
}

/** Pide el registro de un correo nuevo por el servicio y devuelve la huella de su enlace. */
async function invited(): Promise<{ email: string; hash: string; id: string }> {
  const email = newEmail();
  expect(await testServices().requestRegistration({ email }, freshOrigin())).toEqual({ kind: "accepted" });
  const hash = tokenHashIn(await lastMailTo(email), "verificar");
  return { email, hash, id: await userIdOf(email) };
}

const form = (hash: string, change: Record<string, unknown> = {}) => ({
  tokenHash: hash,
  name: "  Ana de Prueba ",
  password: password(),
  adultDeclared: true,
  accepted,
  ...change,
});

beforeAll(async () => {
  texts = await currentTextIds();
  accepted = Object.values(texts);
});

beforeEach(async () => {
  await clearThrottle();
});

afterAll(async () => {
  await clearThrottle();
  await deleteTestUsersByEmail(emails);
});

describe("pedir el registro", () => {
  it("un correo nuevo recibe su enlace, y queda contado a la dirección y al buzón", async () => {
    const email = newEmail();
    const origin = freshOrigin();
    const services = testServices();

    expect(await services.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });

    expect((await waitForMails(email, 1)).map((mail) => mail.subject)).toEqual(["Confirma tu correo"]);
    const cubes = registrationBuckets(email, origin);
    expect(await hitsOf(cubes.ip)).toBe(1);
    expect(await hitsOf(cubes.mail)).toBe(1);
    expect(await bucketRows(cubes.last)).toBe(1);
    expect(services.reported).toEqual([]);
    expect(services.slept).toEqual([1000]);
  });

  it("no deja nada con qué entrar: la cuenta nace sin contraseña y sin sesión", async () => {
    const { email, id } = await invited();
    const services = testServices();
    for (const guess of ["", "cualquiera-123"]) {
      expect(await services.signIn(memoryJar(), { email, password: guess }, freshOrigin())).toEqual({
        kind: "invalid_credentials",
      });
    }
    expect(await sessionCount(id)).toBe(0);
    expect(await notedSessions(id)).toBe(0);
  });

  it("contesta lo mismo y cuenta lo mismo para un correo nuevo, uno sin confirmar y uno con cuenta", async () => {
    const fresh = newEmail();
    const pendingOne = newEmail();
    await authAdmin().auth.admin.inviteUserByEmail(pendingOne);
    await waitForMails(pendingOne, 1);
    const existing = await claimedUser();
    emails.push(existing.email);

    const seen = [];
    for (const email of [fresh, pendingOne, existing.email]) {
      const origin = freshOrigin();
      const services = testServices();
      const result = await services.requestRegistration({ email }, origin);
      const cubes = registrationBuckets(email, origin);
      seen.push({
        result,
        ip: await hitsOf(cubes.ip),
        mail: await hitsOf(cubes.mail),
        last: await bucketRows(cubes.last),
        reported: services.reported,
        slept: services.slept,
      });
    }
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[0]).toEqual({ result: { kind: "accepted" }, ip: 1, mail: 1, last: 1, reported: [], slept: [1000] });

    await sentinel();
    // El que no había confirmado recibe otro enlace; el que ya tiene cuenta, nada.
    expect(await waitForMails(pendingOne, 2)).toHaveLength(2);
    expect(await mailsTo(existing.email)).toEqual([]);
  });

  it.each([["sin-arroba"], [""], ["ana@127.0.0.1"], ["añá@prueba.test"]])(
    "un correo sin forma (%j) se dice, y no se cuenta ni llega a Auth",
    async (email) => {
      const spy = recordingFetch();
      const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
      expect(await services.requestRegistration({ email }, freshOrigin())).toMatchObject({ kind: "invalid_email" });
      expect(spy.calls).toEqual([]);
      expect(await throttleRows()).toBe(0);
    },
  );

  it("dentro de la espera no manda otro correo, pero contesta igual y sigue contando a la dirección", async () => {
    const wait = await parameter("ESPERA_REENVIO");
    const email = newEmail();
    const origin = freshOrigin();
    const cubes = registrationBuckets(email, origin);
    expect(await testServices().requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });
    await waitForMails(email, 1);

    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    await ageLastMail(cubes.last, wait - 5);
    expect(await services.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });
    expect(spy.calls).toEqual([]);
    expect(await hitsOf(cubes.ip)).toBe(2);
    expect(await hitsOf(cubes.mail)).toBe(1);

    // Pasada la espera, medida desde el último correo, sale el siguiente.
    await ageLastMail(cubes.last, 10);
    expect(await services.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });
    expect(spy.calls).toEqual(["/auth/v1/invite"]);
    expect(await waitForMails(email, 2)).toHaveLength(2);
    expect(await hitsOf(cubes.mail)).toBe(2);
    expect(await bucketRows(cubes.last)).toBe(1);
  });

  it("las variantes con + de un correo comparten el cupo del buzón", async () => {
    const tag = randomUUID();
    const first = `it-${tag}+uno@prueba.test`;
    const second = `it-${tag}+dos@prueba.test`;
    emails.push(first, second);
    const services = testServices();

    expect(await services.requestRegistration({ email: first }, freshOrigin())).toEqual({ kind: "accepted" });
    expect(await services.requestRegistration({ email: second }, freshOrigin())).toEqual({ kind: "accepted" });

    await sentinel();
    expect(await waitForMails(first, 1)).toHaveLength(1);
    expect(await mailsTo(second)).toEqual([]);
  });

  it("con el cupo de la hora del buzón lleno no manda nada, y contesta igual", async () => {
    const cap = await parameter("TOPE_ENVIOS_CORREO_HORA");
    const email = newEmail();
    const origin = freshOrigin();
    const cubes = registrationBuckets(email, origin);
    await seedHits(cubes.mail, cap);
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(await services.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });

    expect(spy.calls).toEqual([]);
    expect(await hitsOf(cubes.mail)).toBe(cap);
    expect(await hitsOf(cubes.ip)).toBe(1);
    expect(await bucketRows(cubes.last)).toBe(0);
  });

  it("el tope por dirección sí se dice, y lo que niega no cuenta ni llega a Auth", async () => {
    const cap = await parameter("TOPE_REGISTROS_HORA");
    const email = newEmail();
    const origin = freshOrigin();
    const cubes = registrationBuckets(email, origin);
    await seedHits(cubes.ip, cap - 1);
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    // El último que cabe pasa, y el siguiente ya no.
    expect(await services.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });
    expect(await services.requestRegistration({ email: newEmail() }, origin)).toEqual({ kind: "wait" });

    expect(spy.calls).toEqual(["/auth/v1/invite"]);
    expect(await hitsOf(cubes.ip)).toBe(cap);
    expect(services.slept).toEqual([1000, 1000]);
    // Otra dirección no hereda el tope.
    expect(await services.requestRegistration({ email: newEmail() }, freshOrigin())).toEqual({ kind: "accepted" });
  });

  it("el tope por dirección cuenta también lo que el buzón no dejó mandar", async () => {
    const email = newEmail();
    const origin = freshOrigin();
    const services = testServices();
    for (let i = 0; i < 3; i += 1) await services.requestRegistration({ email }, origin);
    expect(await hitsOf(registrationBuckets(email, origin).ip)).toBe(3);
    expect(await waitForMails(email, 1)).toHaveLength(1);
  });

  it("si Auth no contesta, la respuesta es la misma, se reporta, y el envío no queda anotado", async () => {
    const email = newEmail();
    const origin = freshOrigin();
    const cubes = registrationBuckets(email, origin);
    const down = testServices({ auth: createAuth({ fetch: failingFetch(/\/invite/, networkDown).fetch }) });

    expect(await down.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });

    expect(down.reported).toEqual(["registration_mail_failed"]);
    expect(await hitsOf(cubes.mail)).toBe(0);
    expect(await bucketRows(cubes.last)).toBe(0);
    // A la dirección sí se le quedó contado: ese tope no depende de lo que conteste Auth.
    expect(await hitsOf(cubes.ip)).toBe(1);
    // Y se puede volver a pedir enseguida.
    expect(await testServices().requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });
    expect(await waitForMails(email, 1)).toHaveLength(1);
  });

  it("la respuesta sale antes de preguntarle a Auth: la invitación corre detrás", async () => {
    const email = newEmail();
    const spy = recordingFetch();
    const later: (() => Promise<void>)[] = [];
    const services = testServices({
      auth: createAuth({ fetch: spy.fetch }),
      defer: (work) => {
        later.push(work);
        return Promise.resolve();
      },
    });

    expect(await services.requestRegistration({ email }, freshOrigin())).toEqual({ kind: "accepted" });
    expect(spy.calls).toEqual([]);
    expect(later).toHaveLength(1);

    await later[0]?.();
    expect(spy.calls).toEqual(["/auth/v1/invite"]);
    expect(await waitForMails(email, 1)).toHaveLength(1);
  });

  it("si los contadores no se pueden leer, no pasa nadie, se reporta, y no depende del correo", async () => {
    const origin = freshOrigin();
    const release = await holdLock(resolveOrigin(origin, true).ip);
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    try {
      expect(await services.requestRegistration({ email: newEmail() }, origin)).toEqual({ kind: "unavailable" });
    } finally {
      await release();
    }
    expect(services.reported).toEqual(["mail_limits_unavailable"]);
    expect(spy.calls).toEqual([]);
    expect(await throttleRows()).toBe(0);
  });
});

describe("pedir el registro: a la vez, y sin saber de dónde viene", () => {
  it("dos peticiones a la vez para el mismo buzón, desde direcciones distintas, mandan un solo correo", async () => {
    const email = newEmail();
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    const origins = [freshOrigin(), freshOrigin()] as const;

    const results = await Promise.all(origins.map((origin) => services.requestRegistration({ email }, origin)));

    expect(results).toEqual([{ kind: "accepted" }, { kind: "accepted" }]);
    expect(spy.calls).toEqual(["/auth/v1/invite"]);
    const cubes = registrationBuckets(email, origins[0]);
    expect(await hitsOf(cubes.mail)).toBe(1);
    expect(await bucketRows(cubes.last)).toBe(1);
    expect(await waitForMails(email, 1)).toHaveLength(1);
  });

  it("sin un alojamiento de fiar delante, la cabecera no se cree: todas las peticiones comparten un tope", async () => {
    const services = testServices({ proxyTrusted: () => false });
    const first = freshOrigin();
    const second = freshOrigin();

    expect(await services.requestRegistration({ email: newEmail() }, first)).toEqual({ kind: "accepted" });
    expect(await services.requestRegistration({ email: newEmail() }, second)).toEqual({ kind: "accepted" });

    expect(await hitsOf(buckets.signUpIp(resolveOrigin(first, false).ip))).toBe(2);
    expect(resolveOrigin(first, false).ip.hex).toBe(resolveOrigin(second, false).ip.hex);
    // Nada quedó contado a las direcciones que decía la cabecera.
    expect(await hitsOf(buckets.signUpIp(resolveOrigin(first, true).ip))).toBe(0);
    expect(await hitsOf(buckets.signUpIp(resolveOrigin(second, true).ip))).toBe(0);
    // En local no saber de dónde viene es lo normal. Fuera de local se reporta.
    expect(services.reported).toEqual([]);
    const deployed = testServices({ proxyTrusted: () => false, isLocal: () => false });
    expect(await deployed.requestRegistration({ email: newEmail() }, first)).toEqual({ kind: "accepted" });
    expect(deployed.reported).toEqual(["client_ip_unknown"]);
  });

  it("el mismo correo con otras mayúsculas y con espacios es el mismo buzón", async () => {
    const email = newEmail();
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    const origin = freshOrigin();

    expect(await services.requestRegistration({ email }, origin)).toEqual({ kind: "accepted" });
    expect(await services.requestRegistration({ email: `  ${email.toUpperCase()} ` }, origin)).toEqual({ kind: "accepted" });

    expect(spy.calls).toEqual(["/auth/v1/invite"]);
    expect(await hitsOf(registrationBuckets(email, origin).mail)).toBe(1);
  });
});

describe("lo que el formulario de registro necesita leer", () => {
  it("los tres textos vigentes y los valores que las pantallas citan", async () => {
    const facts = await testServices().accountFormFacts();
    if (facts.kind !== "ready") throw new Error("No se pudieron leer los datos del formulario.");
    expect(facts.texts.map((text) => text.docType)).toEqual([
      "terms",
      "student_privacy_notice",
      "course_history_consent",
    ]);
    expect(Object.fromEntries(facts.texts.map((text) => [text.docType, text.documentId]))).toEqual(texts);
    for (const text of facts.texts) expect(text.title).not.toBe("");
    // El cuerpo y la vigencia son los de la base: PA-14 pinta de ahí el bloque del historial
    // y PA-15 dice desde cuándo rige cada texto.
    const stored = await ownerQuery<{ id: string; body: string; effective: Date; version: number }>(
      "select id::text as id, body, effective_from as effective, version from public.legal_documents where id = any($1::uuid[])",
      [Object.values(texts)],
    );
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      const text = facts.texts.find((entry) => entry.documentId === row.id);
      expect(text?.body).toBe(row.body);
      expect(text?.version).toBe(row.version);
      expect(text?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(new Date(text?.effectiveFrom ?? "").getTime()).toBe(row.effective.getTime());
    }
    expect(facts.minimumAge).toBe(await parameter("EDAD_MINIMA"));
    expect(facts.linkLifetimeMinutes).toBe(await parameter("VIGENCIA_ENLACE_CONTRASENA"));
    expect(facts.resendWaitSeconds).toBe(await parameter("ESPERA_REENVIO"));
  });

  it("fuera de local, un borrador no es un texto vigente: no hay formulario, y se reporta", async () => {
    const services = testServices({ isLocal: () => false });
    // No es «no se supo»: PA-14 pinta otra cosa cuando lo que falta es el texto.
    expect(await services.accountFormFacts()).toEqual({ kind: "no_current_text" });
    expect(services.reported).toEqual(["gate_no_current_text"]);
  });
});

describe("completar el registro desde el enlace", () => {
  it("fija la contraseña, guarda el nombre, la edad y los tres consentimientos, y deja a la persona dentro", async () => {
    const { email, hash, id } = await invited();
    const origin = freshOrigin();
    const services = testServices();
    const jar = memoryJar();
    const chosen = password();

    expect(await services.completeRegistration(jar, form(hash, { password: chosen }), origin)).toEqual({
      kind: "entered",
      pending: null,
    });

    expect(jar.get(COOKIE)).toBeDefined();
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: id } });
    expect(await profileOf(id)).toEqual({ display_name: "Ana de Prueba", adult: true, pending: false, status: "active" });
    const address = resolveOrigin(origin, true).address;
    expect(await consentsOf(id)).toEqual(
      ["course_history_consent", "student_privacy_notice", "terms"].map((doc_type) => ({
        doc_type,
        action: "granted",
        origin: "signup",
        ip: address,
        user_agent: "Pruebas de integración",
      })),
    );
    // Una sola sesión, la que la aplicación abrió y anotó: la del canje ya no existe.
    expect(await sessionCount(id)).toBe(1);
    expect(await notedSessions(id)).toBe(1);
    // Y queda dicho desde qué navegador se abrió, como al entrar: es la que verá en su lista.
    expect(await ownerQuery("select user_agent from private.app_sessions where profile_id = $1", [id])).toEqual([
      { user_agent: "Pruebas de integración" },
    ]);
    expect(services.reported).toEqual([]);

    // La contraseña elegida entra, y a quien apenas se registra no le llega «tu contraseña cambió».
    expect(await services.signIn(memoryJar(), { email, password: chosen }, freshOrigin())).toMatchObject({
      kind: "entered",
    });
    await sentinel();
    expect((await mailsTo(email)).map((mail) => mail.subject)).toEqual(["Confirma tu correo"]);
  });

  it("datos que no pasan la revisión no gastan el enlace", async () => {
    const { hash, id } = await invited();
    const services = testServices();
    const spy = recordingFetch();
    const watched = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(
      await watched.completeRegistration(memoryJar(), form(hash, { password: "corta", name: " ", adultDeclared: false }), freshOrigin()),
    ).toEqual({ kind: "invalid", fields: { name: "empty", password: "too_short", adult: "required" } });
    expect(spy.calls).toEqual([]);

    // Falta marcar un texto: tampoco.
    expect(
      await watched.completeRegistration(memoryJar(), form(hash, { accepted: [texts.terms] }), freshOrigin()),
    ).toEqual({ kind: "invalid", fields: { texts: "required" } });
    expect(spy.calls).toEqual([]);
    expect(await profileOf(id)).toMatchObject({ pending: true, display_name: null });

    expect(await services.completeRegistration(memoryJar(), form(hash), freshOrigin())).toMatchObject({ kind: "entered" });
  });

  it("si lo que aceptó ya no es lo vigente, se le dice que los textos cambiaron y el enlace no se gasta", async () => {
    const { hash } = await invited();
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    const stale = [texts.terms, texts.student_privacy_notice, randomUUID()];

    expect(await services.completeRegistration(memoryJar(), form(hash, { accepted: stale }), freshOrigin())).toEqual({
      kind: "texts_changed",
    });
    expect(spy.calls).toEqual([]);
    expect(await testServices().completeRegistration(memoryJar(), form(hash), freshOrigin())).toMatchObject({
      kind: "entered",
    });
  });

  it("fuera de local, con puros borradores no hay texto que aceptar: se reporta y el enlace no se gasta", async () => {
    const { hash } = await invited();
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }), isLocal: () => false });
    expect(await services.completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({
      kind: "texts_unavailable",
    });
    expect(services.reported).toEqual(["gate_no_current_text"]);
    expect(spy.calls).toEqual([]);
  });

  it("el mismo enlace, enviado dos veces: uno completa y el otro ya no sirve", async () => {
    const { hash, id } = await invited();
    const services = testServices();
    const results = await Promise.all([
      services.completeRegistration(memoryJar(), form(hash), freshOrigin()),
      services.completeRegistration(memoryJar(), form(hash), freshOrigin()),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["entered", "link_dead"]);
    expect(await sessionCount(id)).toBe(1);
    expect(await consentsOf(id)).toHaveLength(3);
  });

  it("una huella que no existe, o sin forma, es un enlace que no sirve", async () => {
    const services = testServices();
    expect(await services.completeRegistration(memoryJar(), form("a".repeat(56)), freshOrigin())).toEqual({ kind: "link_dead" });
    expect(await services.completeRegistration(memoryJar(), form("abc/def"), freshOrigin())).toEqual({ kind: "link_dead" });
  });

  it("si Auth no contesta al canjear, no se supo y el enlace sigue sirviendo", async () => {
    const { hash } = await invited();
    const down = testServices({ auth: createAuth({ fetch: failingFetch(/\/verify/, networkDown).fetch }) });
    expect(await down.completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({ kind: "unavailable" });
    expect(await testServices().completeRegistration(memoryJar(), form(hash), freshOrigin())).toMatchObject({ kind: "entered" });
  });

  it("si el enlace se gastó pero su sesión no se pudo usar, manda a recuperar: no dice que el enlace siga sirviendo", async () => {
    const { hash, id } = await invited();
    const blind = testServices({
      auth: createAuth({ inspectToken: () => Promise.reject(new IdentityUnavailableError()) }),
    });

    expect(await blind.completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({ kind: "recover_instead" });

    expect(blind.reported).toEqual(["registration_incomplete"]);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: true, display_name: null });
  });

  it("si la contraseña no se pudo fijar, manda a recuperar, no deja sesión y la marca sigue prendida", async () => {
    const { hash, id } = await invited();
    const jar = memoryJar();
    const broken = testServices({ auth: createAuth({ fetch: failingFetch(/\/admin\/users/, networkDown).fetch }) });

    expect(await broken.completeRegistration(jar, form(hash), freshOrigin())).toEqual({ kind: "recover_instead" });

    expect(jar.writes).toEqual([]);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: true, display_name: null, adult: false });
    expect(await consentsOf(id)).toEqual([]);
    expect(broken.reported).toEqual(["registration_incomplete"]);
    // El enlace ya se gastó: reintentar con él no sirve.
    expect(await testServices().completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({ kind: "link_dead" });
  });

  it("si guardar falla una vez, el segundo intento lo logra", async () => {
    const { hash, id } = await invited();
    // La fila se suelta cuando el primer intento se rinde: si no hubo primero, la prueba falla.
    const { released } = await holdProfileUntilFirstGivesUp(id);
    const services = testServices();
    try {
      expect(await services.completeRegistration(memoryJar(), form(hash), freshOrigin())).toMatchObject({ kind: "entered" });
    } finally {
      await released;
    }
    expect(services.reported).toEqual([]);
    expect(await profileOf(id)).toMatchObject({ pending: false, display_name: "Ana de Prueba", adult: true });
    expect(await consentsOf(id)).toHaveLength(3);
  }, 30_000);

  it("si guardar falla las dos veces, manda a recuperar: sin sesión, sin datos a medias, y la contraseña quedó", async () => {
    const { email, hash, id } = await invited();
    const release = await holdProfile(id);
    const services = testServices();
    const jar = memoryJar();
    const chosen = password();
    try {
      expect(await services.completeRegistration(jar, form(hash, { password: chosen }), freshOrigin())).toEqual({
        kind: "recover_instead",
      });
    } finally {
      await release();
    }
    expect(services.reported).toEqual(["registration_incomplete"]);
    expect(jar.writes).toEqual([]);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: true, display_name: null, adult: false });
    expect(await consentsOf(id)).toEqual([]);
    // La contraseña quedó fijada, pero con la marca prendida no abre nada: toca recuperar.
    expect(await testServices().signIn(memoryJar(), { email, password: chosen }, freshOrigin())).toEqual({
      kind: "must_recover",
    });
  }, 30_000);

  it("si la entrada del final falla, la cuenta quedó lista: se le pide entrar con su contraseña", async () => {
    const { email, hash, id } = await invited();
    const jar = memoryJar();
    const chosen = password();
    const flaky = testServices({ auth: createAuth({ fetch: failingFetch(/\/token\?grant_type=password/, networkDown).fetch }) });

    expect(await flaky.completeRegistration(jar, form(hash, { password: chosen }), freshOrigin())).toEqual({
      kind: "ready_sign_in",
    });

    // La cuenta quedó reclamada: el resguardo del buzón sí se queda. La sesión, no.
    expect(jar.writes.map((write) => write.name)).toEqual(["plataforma-resguardo"]);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: false, display_name: "Ana de Prueba", adult: true });
    expect(await testServices().signIn(memoryJar(), { email, password: chosen }, freshOrigin())).toEqual({
      kind: "entered",
      pending: null,
    });
  });

  it("si la cookie no se puede escribir, nadie queda dentro: la cuenta quedó lista y la sesión se cierra", async () => {
    const { email, hash, id } = await invited();
    const chosen = password();
    const services = testServices();
    const sealed = {
      get: () => undefined,
      set: () => {
        throw new Error("aquí no se escriben cookies");
      },
    };

    expect(await services.completeRegistration(sealed, form(hash, { password: chosen }), freshOrigin())).toEqual({
      kind: "ready_sign_in",
    });

    // Ese tarro no deja escribir nada: tampoco el resguardo del buzón, y las dos cosas quedan dichas.
    expect(services.reported).toEqual(["mailbox_ticket_not_kept", "session_cookie_not_written"]);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: false, display_name: "Ana de Prueba" });
    expect(await testServices().signIn(memoryJar(), { email, password: chosen }, freshOrigin())).toMatchObject({
      kind: "entered",
    });
  });

  it("al entrar cierra la sesión que el navegador traía", async () => {
    const other = await claimedUser();
    emails.push(other.email);
    const jar = memoryJar();
    const services = testServices();
    expect(await services.signIn(jar, other, freshOrigin())).toMatchObject({ kind: "entered" });
    expect(await sessionCount(other.id)).toBe(1);

    const { hash, id } = await invited();
    expect(await services.completeRegistration(jar, form(hash), freshOrigin())).toMatchObject({ kind: "entered" });

    expect(await sessionCount(other.id)).toBe(0);
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: id } });
  });

  it("si Auth todavía canjea el enlace de una cuenta ya reclamada, el servicio no cambia nada y cierra solo ese canje", async () => {
    // Auth mata el enlace de invitación cuando la cuenta se confirma por otro camino. Aquí
    // se arma a mano el caso en que no lo hiciera: confirmada y reclamada, con su enlace vivo.
    const { hash, id } = await invited();
    await ownerQuery("update auth.users set email_confirmed_at = now() where id = $1", [id]);
    await claimAccount(id);

    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    expect(await services.completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({ kind: "link_dead" });

    // Auth sí lo canjeó: lo que detuvo el registro fue la marca apagada, no un enlace muerto.
    expect(spy.calls.filter((path) => path.startsWith("/auth/v1/verify"))).toHaveLength(1);
    expect(spy.calls.filter((path) => path.startsWith("/auth/v1/logout"))).toEqual(["/auth/v1/logout?scope=local"]);
    // No se fijó ninguna contraseña ni se guardó nada del formulario, y no quedó sesión.
    expect(spy.calls.some((path) => path.includes("/admin/"))).toBe(false);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: false, display_name: null, adult: false });
    expect(await consentsOf(id)).toEqual([]);
    expect(services.reported).toEqual([]);
  });

  it("deja la marca de que su enlace ya se usó, y con esa marca puesta otro canje no sigue", async () => {
    const done = await invited();
    expect(await testServices().completeRegistration(memoryJar(), form(done.hash), freshOrigin())).toMatchObject({
      kind: "entered",
    });
    expect(await bucketRows(buckets.signUpRedeemed(done.id))).toBe(1);

    // Otra cuenta, con la marca ya puesta: es lo que ve el segundo de dos canjes simultáneos.
    const { hash, id } = await invited();
    await ownerQuery(
      "insert into private.rate_limit_counters (bucket, window_start, hits) values ($1, 'epoch', 1)",
      [buckets.signUpRedeemed(id)],
    );
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(await services.completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({ kind: "link_dead" });

    expect(spy.calls.some((path) => path.includes("/admin/"))).toBe(false);
    expect(spy.calls.filter((path) => path.startsWith("/auth/v1/logout"))).toEqual(["/auth/v1/logout?scope=local"]);
    expect(await sessionCount(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: true, display_name: null });
  });

  it("si al final la guarda no deja entrar, la cuenta quedó lista pero no hay cookie ni sesión", async () => {
    const { hash, id } = await invited();
    // Los textos dejan de valer justo cuando se pide la entrada: la guarda ya no puede decidir.
    let local = true;
    const auth = createAuth({
      fetch: (input, init) => {
        if (String(input instanceof Request ? input.url : input).includes("grant_type=password")) local = false;
        return fetch(input, init);
      },
    });
    const services = testServices({ auth, isLocal: () => local });
    const jar = memoryJar();

    expect(await services.completeRegistration(jar, form(hash), freshOrigin())).toEqual({ kind: "ready_sign_in" });

    expect(services.reported).toEqual(["gate_no_current_text"]);
    // La cuenta quedó reclamada: el resguardo del buzón sí se queda. La sesión, no.
    expect(jar.writes.map((write) => write.name)).toEqual(["plataforma-resguardo"]);
    expect(await sessionCount(id)).toBe(0);
    expect(await notedSessions(id)).toBe(0);
    expect(await profileOf(id)).toMatchObject({ pending: false, display_name: "Ana de Prueba" });
  });

  it("de una dirección que no se conoce, el consentimiento queda sin dirección: no se inventa una", async () => {
    const { hash, id } = await invited();
    const services = testServices();
    expect(
      await services.completeRegistration(memoryJar(), form(hash), { realIp: "no-es-una-direccion", userAgent: null }),
    ).toMatchObject({ kind: "entered" });
    const consents = await consentsOf(id);
    expect(consents).toHaveLength(3);
    for (const consent of consents) expect(consent).toMatchObject({ ip: null, user_agent: null });
  });

  it("el enlace de una cuenta que ya se reclamó no cambia nada", async () => {
    // La cuenta se invitó, y antes de abrir ese enlace se recuperó la contraseña.
    const { email, hash, id } = await invited();
    const services = testServices();
    expect(await services.requestRecovery({ email }, freshOrigin())).toEqual({ kind: "accepted" });
    const recovery = tokenHashIn(await lastMailTo(email, 2), "recuperar");
    const chosen = password();
    expect(await services.completeRecovery({ tokenHash: recovery, password: chosen }, freshOrigin())).toEqual({ kind: "done" });
    expect(await profileOf(id)).toMatchObject({ pending: false });
    const live = authVisitor();
    await live.auth.signInWithPassword({ email, password: chosen });
    expect(await sessionCount(id)).toBe(1);

    expect(await services.completeRegistration(memoryJar(), form(hash), freshOrigin())).toEqual({ kind: "link_dead" });

    // Ni la contraseña ni las sesiones de la cuenta se tocaron.
    expect(await sessionCount(id)).toBe(1);
    expect((await authVisitor().auth.signInWithPassword({ email, password: chosen })).error).toBeNull();
    expect(await profileOf(id)).toMatchObject({ display_name: null });
  });
});

// ---------------------------------------------------------------------------------------
// El resguardo del buzón (TRD §9.2, fila «Invitaciones»): abrir un enlace del correo y
// fijar la contraseña deja un secreto en ese navegador y su huella en la base.

const TICKET_COOKIE = "plataforma-resguardo";
const printOf = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Lo que la base guardó de la prueba del buzón de una cuenta. */
const proofOf = (userId: string) =>
  ownerQuery<{ print: string | null; email: string | null; dated: boolean | null }>(
    `select mailbox_ticket as print, mailbox_proven_email as email, mailbox_proven_at = password_changed_at as dated
     from private.account_security where profile_id = $1`,
    [userId],
  );

/** Cuánto dice la base que dura, en segundos. */
async function proofSeconds(): Promise<number> {
  const [row] = await ownerQuery<{ seconds: number }>("select private.mailbox_proof_seconds()::integer as seconds");
  if (!row) throw new Error("La base no dijo cuánto dura la prueba del buzón.");
  return row.seconds;
}

describe("el resguardo del buzón al completar el registro", () => {
  it("se queda en el navegador que abrió el enlace, y a la base solo llega su huella", async () => {
    const { email, hash, id } = await invited();
    const jar = memoryJar();
    expect(await testServices().completeRegistration(jar, form(hash), freshOrigin())).toMatchObject({ kind: "entered" });

    const kept = jar.writes.filter((write) => write.name === TICKET_COOKIE);
    expect(kept).toHaveLength(1);
    const secret = kept[0]?.value ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kept[0]?.options).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: await proofSeconds() });
    expect(await proofOf(id)).toEqual([{ print: printOf(secret), email, dated: true }]);
    // El secreto no es la huella, ni viaja en la cookie de la sesión.
    expect(secret).not.toBe(printOf(secret));
    expect(jar.get(COOKIE)).not.toContain(secret);
  });

  it("cada registro lleva el suyo", async () => {
    const first = await invited();
    const second = await invited();
    const jars = [memoryJar(), memoryJar()];
    await testServices().completeRegistration(jars[0] as ReturnType<typeof memoryJar>, form(first.hash), freshOrigin());
    await testServices().completeRegistration(jars[1] as ReturnType<typeof memoryJar>, form(second.hash), freshOrigin());
    const secrets = jars.map((jar) => jar.get(TICKET_COOKIE));
    expect(secrets[0]).toBeDefined();
    expect(secrets[1]).toBeDefined();
    expect(secrets[0]).not.toBe(secrets[1]);
  });

  it("un registro que no termina no deja resguardo", async () => {
    const { hash } = await invited();
    const jar = memoryJar();
    expect(await testServices().completeRegistration(jar, form(hash, { name: "" }), freshOrigin())).toMatchObject({ kind: "invalid" });
    expect(jar.get(TICKET_COOKIE)).toBeUndefined();
  });
});
