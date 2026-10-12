import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "@/adapters/supabase/auth";
import { IdentityUnavailableError } from "@/adapters/supabase/errors";
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
  holdProfile,
  holdProfileUntilFirstGivesUp,
  keysOf,
  notedSessions,
  pairOf,
  parameter,
  profileOf,
  recoveryBuckets,
  registrationBuckets,
  seedHits,
  seedLastMail,
  seedPair,
  signInBuckets,
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
  secondFactorFor,
  sessionCount,
  verifiedFactors,
  type KnownUser,
} from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { lastMailTo, mailsTo, tokenHashIn, waitForMails } from "./helpers/mailbox";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery, testEmail } from "./helpers/users";

// Pedir y completar la recuperación de la contraseña, y completar una cuenta ya abierta
// (RF-103, RF-108, RF-109; TRD §9.2, filas «Recuperación» y «Lo que entra sin pasar por el
// formulario», y §9.9), contra la base, el Auth y el buzón locales.

const emails: string[] = [];
let texts: Awaited<ReturnType<typeof currentTextIds>>;

function newEmail(): string {
  const email = testEmail();
  emails.push(email);
  return email;
}

const password = () => `P-${randomUUID()}`;

async function claimed(options: { complete?: boolean } = {}): Promise<KnownUser> {
  const created = await claimedUser();
  emails.push(created.email);
  if (options.complete) await completeAccountAsOwner(created.id);
  return created;
}

async function sentinel(): Promise<void> {
  const email = newEmail();
  await authAdmin().auth.admin.inviteUserByEmail(email);
  await waitForMails(email, 1);
}

/** Pide la recuperación por el servicio y devuelve la huella del enlace que llegó. */
async function recoveryLink(account: { email: string }, mails = 1): Promise<string> {
  expect(await testServices().requestRecovery({ email: account.email }, freshOrigin())).toEqual({ kind: "accepted" });
  return tokenHashIn(await lastMailTo(account.email, mails), "recuperar");
}

beforeAll(async () => {
  texts = await currentTextIds();
});

beforeEach(async () => {
  await clearThrottle();
});

afterAll(async () => {
  await clearThrottle();
  await deleteTestUsersByEmail(emails);
});

describe("pedir la recuperación", () => {
  it("contesta lo mismo y cuenta lo mismo exista o no la cuenta; solo la que existe recibe el enlace", async () => {
    const account = await claimed();
    const nobody = newEmail();

    const seen = [];
    for (const email of [account.email, nobody]) {
      const origin = freshOrigin();
      const services = testServices();
      const result = await services.requestRecovery({ email }, origin);
      const cubes = recoveryBuckets(email, origin);
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
    expect(seen[0]).toEqual({ result: { kind: "accepted" }, ip: 1, mail: 1, last: 1, reported: [], slept: [1000] });

    expect((await waitForMails(account.email, 1)).map((mail) => mail.subject)).toEqual(["Cambia tu contraseña"]);
    await sentinel();
    expect(await mailsTo(nobody)).toEqual([]);
  });

  it("el mismo correo con otras mayúsculas y con espacios gasta el mismo cupo", async () => {
    const account = await claimed();
    const origin = freshOrigin();
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(await services.requestRecovery({ email: ` ${account.email.toUpperCase()} ` }, origin)).toEqual({ kind: "accepted" });
    expect(await services.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });

    expect(spy.calls).toEqual(["/auth/v1/recover"]);
    expect(await hitsOf(recoveryBuckets(account.email, origin).mail)).toBe(1);
    expect(await waitForMails(account.email, 1)).toHaveLength(1);
  });

  it("dos peticiones a la vez para el mismo correo mandan un solo enlace, y la respuesta sale antes de preguntarle a Auth", async () => {
    const account = await claimed();
    const spy = recordingFetch();
    const later: (() => Promise<void>)[] = [];
    const services = testServices({
      auth: createAuth({ fetch: spy.fetch }),
      defer: (work) => {
        later.push(work);
        return Promise.resolve();
      },
    });

    const results = await Promise.all(
      [freshOrigin(), freshOrigin()].map((origin) => services.requestRecovery({ email: account.email }, origin)),
    );

    expect(results).toEqual([{ kind: "accepted" }, { kind: "accepted" }]);
    expect(spy.calls).toEqual([]);
    expect(later).toHaveLength(1);
    await later[0]?.();
    expect(spy.calls).toEqual(["/auth/v1/recover"]);
    expect(await waitForMails(account.email, 1)).toHaveLength(1);
  });

  it("un correo sin forma se dice, y no se cuenta ni llega a Auth", async () => {
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });
    expect(await services.requestRecovery({ email: "sin-arroba" }, freshOrigin())).toMatchObject({ kind: "invalid_email" });
    expect(spy.calls).toEqual([]);
    expect(await throttleRows()).toBe(0);
  });

  it("dentro de la espera no manda otro, y pasada la espera sí", async () => {
    const wait = await parameter("ESPERA_REENVIO");
    const account = await claimed();
    const origin = freshOrigin();
    const cubes = recoveryBuckets(account.email, origin);
    const services = testServices();

    expect(await services.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });
    await waitForMails(account.email, 1);
    expect(await services.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });
    expect(await hitsOf(cubes.mail)).toBe(1);
    expect(await hitsOf(cubes.ip)).toBe(2);

    await ageLastMail(cubes.last, wait + 5);
    // Auth lleva su propia espera por cuenta, con su propio reloj: se le atrasa igual.
    await ownerQuery("update auth.users set recovery_sent_at = now() - make_interval(secs => $2) where email = $1", [
      account.email,
      wait + 5,
    ]);
    expect(await services.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });
    expect(await waitForMails(account.email, 2)).toHaveLength(2);
    expect(services.reported).toEqual([]);
  });

  it("agotar el cupo de registro de un buzón no le quita su recuperación", async () => {
    const cap = await parameter("TOPE_ENVIOS_CORREO_HORA");
    const account = await claimed();
    const signUp = registrationBuckets(account.email, freshOrigin());
    await seedHits(signUp.mail, cap);
    await seedLastMail(signUp.last);

    expect(await testServices().requestRecovery({ email: account.email }, freshOrigin())).toEqual({ kind: "accepted" });
    expect(await waitForMails(account.email, 1)).toHaveLength(1);
  });

  it("pedir la recuperación de las variantes con + de un correo no le gasta el cupo a la cuenta de verdad", async () => {
    const tag = randomUUID();
    const real = `it-${tag}@prueba.test`;
    emails.push(real);
    const made = await authAdmin().auth.admin.createUser({ email: real, password: password(), email_confirm: true });
    expect(made.error).toBeNull();
    const cap = await parameter("TOPE_ENVIOS_CORREO_HORA");
    const services = testServices();
    for (let i = 0; i < cap + 1; i += 1) {
      expect(await services.requestRecovery({ email: `it-${tag}+${i}@prueba.test` }, freshOrigin())).toEqual({
        kind: "accepted",
      });
    }

    expect(await services.requestRecovery({ email: real }, freshOrigin())).toEqual({ kind: "accepted" });
    expect(await waitForMails(real, 1)).toHaveLength(1);
  });

  it("el tope por dirección se dice, y lo que niega no cuenta ni llega a Auth", async () => {
    const cap = await parameter("TOPE_REGISTROS_HORA");
    const account = await claimed();
    const origin = freshOrigin();
    const cubes = recoveryBuckets(account.email, origin);
    await seedHits(cubes.ip, cap);
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(await services.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "wait" });

    expect(spy.calls).toEqual([]);
    expect(await hitsOf(cubes.ip)).toBe(cap);
    expect(await hitsOf(cubes.mail)).toBe(0);
    // El tope de recuperar no es el de registrar: desde esa dirección aún se puede pedir un registro.
    expect(await services.requestRegistration({ email: newEmail() }, origin)).toEqual({ kind: "accepted" });
  });

  it("si Auth no contesta, la respuesta es la misma, se reporta, y el envío no queda anotado", async () => {
    const account = await claimed();
    const origin = freshOrigin();
    const cubes = recoveryBuckets(account.email, origin);
    const down = testServices({ auth: createAuth({ fetch: failingFetch(/\/recover/, networkDown).fetch }) });

    expect(await down.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });

    expect(down.reported).toEqual(["recovery_mail_failed"]);
    expect(await hitsOf(cubes.mail)).toBe(0);
    expect(await bucketRows(cubes.last)).toBe(0);
    expect(await hitsOf(cubes.ip)).toBe(1);
    expect(await testServices().requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });
    expect(await waitForMails(account.email, 1)).toHaveLength(1);
  });

  it("si Auth no lo manda por su propia espera, contesta igual, lo reporta y no lo deja anotado", async () => {
    // Auth lleva su espera por cuenta, y cualquiera puede gastarla pidiéndole directo un
    // correo para ese buzón. El del servicio no salió: no se da por mandado.
    const account = await claimed();
    expect((await authVisitor().auth.resetPasswordForEmail(account.email)).error).toBeNull();
    await waitForMails(account.email, 1);
    const origin = freshOrigin();
    const cubes = recoveryBuckets(account.email, origin);
    const services = testServices();

    expect(await services.requestRecovery({ email: account.email }, origin)).toEqual({ kind: "accepted" });

    expect(services.reported).toEqual(["recovery_mail_failed"]);
    expect(await hitsOf(cubes.mail)).toBe(0);
    expect(await bucketRows(cubes.last)).toBe(0);
    expect(await hitsOf(cubes.ip)).toBe(1);
    await sentinel();
    expect(await waitForMails(account.email, 1)).toHaveLength(1);
  });
});

describe("completar la recuperación", () => {
  it("guarda la contraseña, cierra todas las sesiones, deja este dispositivo de confianza y manda el aviso", async () => {
    const account = await claimed({ complete: true });
    const services = testServices();
    const jar = memoryJar();
    expect(await services.signIn(jar, account, freshOrigin())).toMatchObject({ kind: "entered" });
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    expect(await sessionCount(account.id)).toBe(2);
    expect(await notedSessions(account.id)).toBe(1);
    await clearThrottle();

    // Otro dispositivo, de confianza y con fallos, y la cuenta de la hora de la cuenta.
    const origin = freshOrigin();
    const here = keysOf(account.email, origin);
    const elsewhere = keysOf(account.email, freshOrigin());
    const trusted = new Date(Date.now() - 86_400_000);
    await seedPair(elsewhere, { failed_count: 3, last_failed_at: trusted, last_success_at: trusted });
    await seedPair(here, { failed_count: 4, last_failed_at: trusted, locked_until: new Date(Date.now() + 600_000) });
    await seedHits(signInBuckets(here).account, 7);
    const stranger = keysOf(testEmail(), origin);
    await seedPair(stranger, { failed_count: 2, last_success_at: trusted });
    const farStranger = keysOf(testEmail(), freshOrigin());
    await seedPair(farStranger, { failed_count: 1, last_success_at: trusted });

    const hash = await recoveryLink(account);
    const chosen = password();
    expect(await services.completeRecovery({ tokenHash: hash, password: chosen }, origin)).toEqual({ kind: "done" });

    expect(services.reported).toEqual([]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await notedSessions(account.id)).toBe(0);
    expect(await services.checkSession(jar)).toMatchObject({ kind: "must_sign_out" });
    expect((await lastMailTo(account.email, 2)).subject).toBe("Tu contraseña cambió");

    // Este dispositivo: sin fallos, sin espera y de confianza.
    expect(await pairOf(here)).toMatchObject({ failed_count: 0, locked_until: null, last_failed_at: null });
    expect((await pairOf(here))?.last_success_at).not.toBeNull();
    // Los demás pierden la confianza y conservan sus fallos. Los de otra cuenta, intactos.
    expect(await pairOf(elsewhere)).toMatchObject({ failed_count: 3, last_success_at: null });
    expect((await pairOf(elsewhere))?.last_failed_at).not.toBeNull();
    expect(await pairOf(stranger)).toMatchObject({ failed_count: 2 });
    expect((await pairOf(stranger))?.last_success_at).not.toBeNull();
    expect((await pairOf(farStranger))?.last_success_at).not.toBeNull();
    expect(await bucketRows(signInBuckets(here).account)).toBe(0);

    expect(await services.signIn(memoryJar(), account, freshOrigin())).toEqual({ kind: "invalid_credentials" });
    expect(await services.signIn(memoryJar(), { email: account.email, password: chosen }, origin)).toEqual({
      kind: "entered",
      pending: null,
    });
  });

  it("el enlace sirve una sola vez", async () => {
    const account = await claimed();
    const hash = await recoveryLink(account);
    const services = testServices();
    expect(await services.completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({ kind: "done" });
    expect(await services.completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({
      kind: "link_dead",
    });
  });

  it.each([
    ["corta", "corta", "too_short"],
    ["de más de 72 bytes", "ñ".repeat(37), "too_long"],
  ])("una contraseña %s se dice y no gasta el enlace", async (_name, bad, reason) => {
    const account = await claimed();
    const hash = await recoveryLink(account);
    const spy = recordingFetch();
    const services = testServices({ auth: createAuth({ fetch: spy.fetch }) });

    expect(await services.completeRecovery({ tokenHash: hash, password: bad }, freshOrigin())).toEqual({
      kind: "invalid",
      reason,
    });
    expect(spy.calls).toEqual([]);
    expect(await testServices().completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({
      kind: "done",
    });
  });

  it("una huella que no existe es un enlace que no sirve; sin respuesta de Auth, no se supo", async () => {
    expect(await testServices().completeRecovery({ tokenHash: "a".repeat(56), password: password() }, freshOrigin())).toEqual({
      kind: "link_dead",
    });
    const account = await claimed();
    const hash = await recoveryLink(account);
    const down = testServices({ auth: createAuth({ fetch: failingFetch(/\/verify/, networkDown).fetch }) });
    expect(await down.completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({
      kind: "unavailable",
    });
    expect(await testServices().completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({
      kind: "done",
    });
  });

  it("si el enlace se gastó pero su sesión no se pudo usar, pide otro enlace: no dice que este siga sirviendo", async () => {
    const account = await claimed();
    const hash = await recoveryLink(account);
    const blind = testServices({
      auth: createAuth({ inspectToken: () => Promise.reject(new IdentityUnavailableError()) }),
    });

    expect(await blind.completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({
      kind: "request_new_link",
    });

    expect(blind.reported).toEqual(["recovery_incomplete"]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await testServices().signIn(memoryJar(), account, freshOrigin())).toMatchObject({ kind: "entered" });
  });

  // Con segundo factor, el camino de administración no es una falla: es el único que hay.
  // Pero tampoco pasa en silencio: a esa cuenta no le sale el aviso de cambio de contraseña,
  // y que alguien con su buzón le cambió la contraseña es algo que una persona debe saber.
  it("una cuenta con segundo factor recupera su contraseña con el buzón, y queda dicho con su propio reporte", async () => {
    const account = await claimed();
    const factor = await secondFactorFor(account);
    const hash = await recoveryLink(account);
    const services = testServices();
    const chosen = password();

    expect(await services.completeRecovery({ tokenHash: hash, password: chosen }, freshOrigin())).toEqual({ kind: "done" });

    expect(services.reported).toEqual(["recovery_with_second_factor"]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await services.signIn(memoryJar(), account, freshOrigin())).toEqual({ kind: "invalid_credentials" });
    expect(await services.signIn(memoryJar(), { email: account.email, password: chosen }, freshOrigin())).toMatchObject({
      kind: "entered",
    });
    // Recuperar la contraseña no quita ni cambia el segundo factor.
    expect(await verifiedFactors(account.id)).toEqual([factor.factorId]);
  });

  it("con la contraseña que ya tenía también cierra todo; el aviso no sale, y se reporta", async () => {
    const account = await claimed();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const hash = await recoveryLink(account);
    const services = testServices();

    expect(await services.completeRecovery({ tokenHash: hash, password: account.password }, freshOrigin())).toEqual({
      kind: "done",
    });

    expect(services.reported).toEqual(["recovery_notice_not_sent"]);
    expect(await sessionCount(account.id)).toBe(0);
    await sentinel();
    expect((await mailsTo(account.email)).map((mail) => mail.subject)).toEqual(["Cambia tu contraseña"]);
  });

  it("si alguien cierra la sesión del canje antes de guardar, la contraseña se fija igual", async () => {
    const account = await claimed();
    const intruder = authVisitor();
    await intruder.auth.signInWithPassword({ email: account.email, password: account.password });
    const hash = await recoveryLink(account);
    // Justo antes de que el servicio guarde, el intruso cierra todas las sesiones.
    const racing = createAuth({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/auth/v1/user" && init?.method === "PUT") await intruder.auth.signOut({ scope: "global" });
        return fetch(input, init);
      },
    });
    const services = testServices({ auth: racing });
    const chosen = password();

    expect(await services.completeRecovery({ tokenHash: hash, password: chosen }, freshOrigin())).toEqual({ kind: "done" });

    expect(services.reported).toEqual(["recovery_notice_not_sent"]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await services.signIn(memoryJar(), account, freshOrigin())).toEqual({ kind: "invalid_credentials" });
    expect(await services.signIn(memoryJar(), { email: account.email, password: chosen }, freshOrigin())).toMatchObject({
      kind: "entered",
    });
  });

  it("recuperar una cuenta que nunca completó su registro la deja reclamada: al entrar se le pide completarla", async () => {
    const email = newEmail();
    expect(await testServices().requestRegistration({ email }, freshOrigin())).toEqual({ kind: "accepted" });
    await waitForMails(email, 1);
    const hash = await recoveryLink({ email }, 2);
    const services = testServices();
    const chosen = password();

    expect(await services.completeRecovery({ tokenHash: hash, password: chosen }, freshOrigin())).toEqual({ kind: "done" });

    const entered = await services.signIn(memoryJar(), { email, password: chosen }, freshOrigin());
    expect(entered).toMatchObject({
      kind: "entered",
      pending: { variant: "complete_account", missing: { name: true, adultDeclaration: true } },
    });
  });

  it("si Auth no guarda la contraseña, hay que pedir otro enlace; no queda ninguna sesión y la de antes sigue valiendo", async () => {
    const account = await claimed();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const hash = await recoveryLink(account);
    const broken = testServices({
      auth: createAuth({ fetch: failingFetch(/\/auth\/v1\/user$/, networkDown).fetch }),
    });

    expect(await broken.completeRecovery({ tokenHash: hash, password: password() }, freshOrigin())).toEqual({
      kind: "request_new_link",
    });

    expect(broken.reported).toEqual(["recovery_incomplete"]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await testServices().signIn(memoryJar(), account, freshOrigin())).toMatchObject({ kind: "entered" });
  });

  it("si la base falla a la mitad, igual cierra todas las sesiones y pide otro enlace", async () => {
    const account = await claimed();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const hash = await recoveryLink(account);
    const origin = freshOrigin();
    const release = await holdProfile(account.id);
    const services = testServices();
    try {
      expect(await services.completeRecovery({ tokenHash: hash, password: password() }, origin)).toEqual({
        kind: "request_new_link",
      });
    } finally {
      await release();
    }
    expect(services.reported).toEqual(["recovery_incomplete"]);
    expect(await sessionCount(account.id)).toBe(0);
    expect(await pairOf(keysOf(account.email, origin))).toBeNull();
  }, 30_000);

  it("de una dirección que no se conoce no queda ningún dispositivo de confianza, y los demás la pierden igual", async () => {
    const account = await claimed();
    const hash = await recoveryLink(account);
    await clearThrottle();
    const unknown = { realIp: null, userAgent: null };
    const elsewhere = keysOf(account.email, freshOrigin());
    const trusted = new Date(Date.now() - 86_400_000);
    await seedPair(elsewhere, { failed_count: 2, last_failed_at: trusted, last_success_at: trusted });
    await seedHits(signInBuckets(elsewhere).account, 4);
    await seedHits(signInBuckets(elsewhere).ip, 6);
    const services = testServices();

    expect(await services.completeRecovery({ tokenHash: hash, password: password() }, unknown)).toEqual({ kind: "done" });

    // Ni el cubo compartido de las desconocidas ni ningún otro par de la cuenta queda de confianza.
    const shared = { account: elsewhere.account, ip: resolveOrigin(unknown, true).ip };
    expect(await pairOf(shared)).toBeNull();
    expect(await pairOf(elsewhere)).toMatchObject({ failed_count: 2, last_success_at: null });
    expect(await bucketRows(signInBuckets(elsewhere).account)).toBe(0);
    // La cuenta de la hora de una dirección no es de la cuenta: se queda.
    expect(await hitsOf(signInBuckets(elsewhere).ip)).toBe(6);
  });

  it("si Auth no guarda la contraseña de una cuenta sin reclamar, la marca sigue prendida", async () => {
    // La marca solo se apaga con la contraseña fijada de verdad.
    const email = newEmail();
    expect(await testServices().requestRegistration({ email }, freshOrigin())).toEqual({ kind: "accepted" });
    await waitForMails(email, 1);
    const hash = await recoveryLink({ email }, 2);
    const id = (await ownerQuery<{ id: string }>("select id::text as id from auth.users where email = $1", [email]))[0]?.id ?? "";
    const origin = freshOrigin();
    const broken = testServices({ auth: createAuth({ fetch: failingFetch(/\/auth\/v1\/user$/, networkDown).fetch }) });
    const chosen = password();

    expect(await broken.completeRecovery({ tokenHash: hash, password: chosen }, origin)).toEqual({ kind: "request_new_link" });

    expect(await profileOf(id)).toMatchObject({ pending: true });
    expect(await pairOf(keysOf(email, origin))).toBeNull();
    expect(await sessionCount(id)).toBe(0);
    expect(await testServices().signIn(memoryJar(), { email, password: chosen }, freshOrigin())).toEqual({
      kind: "invalid_credentials",
    });
  });

  it("si la base falla una vez al reclamar, el segundo intento lo logra", async () => {
    const account = await claimed();
    const hash = await recoveryLink(account);
    const origin = freshOrigin();
    const { released } = await holdProfileUntilFirstGivesUp(account.id);
    const services = testServices();

    try {
      expect(await services.completeRecovery({ tokenHash: hash, password: password() }, origin)).toEqual({ kind: "done" });
    } finally {
      await released;
    }

    expect(services.reported).toEqual([]);
    expect((await pairOf(keysOf(account.email, origin)))?.last_success_at).not.toBeNull();
  }, 30_000);

  it("si las sesiones no se pueden cerrar, la contraseña quedó guardada y alguien tiene que saberlo", async () => {
    const account = await claimed();
    const hash = await recoveryLink(account);
    const stuck = testServices({ auth: createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch }) });
    const chosen = password();
    expect(await stuck.completeRecovery({ tokenHash: hash, password: chosen }, freshOrigin())).toEqual({ kind: "done" });
    expect(stuck.reported).toEqual(["session_not_closed"]);
    expect(await testServices().signIn(memoryJar(), { email: account.email, password: chosen }, freshOrigin())).toMatchObject({
      kind: "entered",
    });
  });
});

describe("completar una cuenta ya abierta", () => {
  /** Una cuenta reclamada a la que le falta todo, con su sesión abierta por el servicio. */
  async function pendingSession() {
    const account = await claimed();
    const services = testServices();
    const jar = memoryJar();
    expect(await services.signIn(jar, account, freshOrigin())).toMatchObject({
      kind: "entered",
      pending: { variant: "complete_account" },
    });
    return { account, services, jar };
  }

  it("guarda exactamente lo que la guarda pide, con el origen de la pantalla que lo pidió, y la cuenta pasa", async () => {
    const { account, services, jar } = await pendingSession();
    const origin = freshOrigin();

    expect(
      await services.completeAccount(jar, { name: " Ana ", adultDeclared: true, accepted: Object.values(texts) }, origin),
    ).toEqual({ kind: "complete" });

    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass" });
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ana", adult: true });
    const consents = await consentsOf(account.id);
    expect(consents.map((consent) => consent.doc_type)).toEqual(["course_history_consent", "student_privacy_notice", "terms"]);
    for (const consent of consents) {
      expect(consent).toMatchObject({ action: "granted", origin: "login_prompt", ip: resolveOrigin(origin, true).address });
    }
  });

  it("lo que falta se dice campo por campo, y no se guarda nada a medias", async () => {
    const { account, services, jar } = await pendingSession();

    expect(await services.completeAccount(jar, { name: "", accepted: Object.values(texts) }, freshOrigin())).toEqual({
      kind: "invalid",
      fields: { name: "empty", adult: "required" },
    });
    expect(
      await services.completeAccount(jar, { name: "Ana", adultDeclared: true, accepted: [texts.terms] }, freshOrigin()),
    ).toEqual({ kind: "invalid", fields: { texts: "required" } });
    expect(
      await services.completeAccount(
        jar,
        { name: "Ana", adultDeclared: true, accepted: [...Object.values(texts), randomUUID()] },
        freshOrigin(),
      ),
    ).toEqual({ kind: "texts_changed" });

    expect(await profileOf(account.id)).toMatchObject({ display_name: null, adult: false });
    expect(await consentsOf(account.id)).toEqual([]);
  });

  it("solo escribe lo que falta: no pisa el nombre que ya tenía ni repite un consentimiento", async () => {
    const account = await claimed({ complete: true });
    const services = testServices();
    const jar = memoryJar();
    expect(await services.signIn(jar, account, freshOrigin())).toEqual({ kind: "entered", pending: null });

    expect(
      await services.completeAccount(jar, { name: "Otro nombre", adultDeclared: true, accepted: Object.values(texts) }, freshOrigin()),
    ).toEqual({ kind: "complete" });

    expect(await profileOf(account.id)).toMatchObject({ display_name: "Persona de prueba" });
    expect(await consentsOf(account.id)).toHaveLength(3);
  });

  it("a quien solo le falta un texto, solo ese se le pide y solo ese se guarda", async () => {
    const account = await claimed();
    // Como dueño: nombre, edad y los tres consentimientos.
    await completeAccountAsOwner(account.id, "Ya tenía nombre");
    const services = testServices();
    const jar = memoryJar();
    expect(await services.signIn(jar, account, freshOrigin())).toEqual({ kind: "entered", pending: null });
    // Retira uno: ahora le falta ese.
    await withdraw(account.id, texts.course_history_consent);
    expect(await services.checkSession(jar)).toMatchObject({
      kind: "incomplete",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "course_history_consent", why: "withdrawn" }] },
    });

    expect(await services.completeAccount(jar, { accepted: [] }, freshOrigin())).toEqual({
      kind: "invalid",
      fields: { texts: "required" },
    });
    // Marca los tres: los dos que ya tenía dados no se anotan otra vez.
    expect(await services.completeAccount(jar, { accepted: Object.values(texts) }, freshOrigin())).toEqual({
      kind: "complete",
    });
    expect(await consentsOf(account.id)).toHaveLength(5);
    const history = (await consentsOf(account.id)).filter((consent) => consent.doc_type === "course_history_consent");
    expect(history.map((consent) => [consent.action, consent.origin])).toEqual([
      ["granted", "signup"],
      ["withdrawn", "account_settings"],
      ["granted", "login_prompt"],
    ]);
    expect(await profileOf(account.id)).toMatchObject({ display_name: "Ya tenía nombre" });
  });

  it("sin sesión, o con una que no vale, no guarda nada y devuelve lo que dijo la guarda", async () => {
    const services = testServices();
    expect(await services.completeAccount(memoryJar(), { accepted: Object.values(texts) }, freshOrigin())).toEqual({
      kind: "session",
      check: { kind: "anonymous" },
    });

    // Una sesión abierta directo en Auth: la aplicación no la reconoce.
    const account = await claimed();
    const direct = createAuth();
    const jar = memoryJar();
    expect((await direct.signIn(jar, account.email, account.password)).ok).toBe(true);
    expect(
      await services.completeAccount(jar, { name: "Ana", adultDeclared: true, accepted: Object.values(texts) }, freshOrigin()),
    ).toEqual({ kind: "session", check: { kind: "must_sign_out", then: "sign_in" } });
    expect(await profileOf(account.id)).toMatchObject({ display_name: null });
    expect(await consentsOf(account.id)).toEqual([]);
  });

  it("si guardar falla, no se supo, se reporta y no queda nada a medias", async () => {
    const { account, services, jar } = await pendingSession();
    const release = await holdProfile(account.id);
    try {
      expect(
        await services.completeAccount(jar, { name: "Ana", adultDeclared: true, accepted: Object.values(texts) }, freshOrigin()),
      ).toEqual({ kind: "unavailable" });
    } finally {
      await release();
    }
    expect(services.reported).toEqual(["gate_unavailable"]);
    expect(await consentsOf(account.id)).toEqual([]);
  }, 30_000);
});

/** Retira un consentimiento como la propia persona, que es la única que puede. */
async function withdraw(userId: string, documentId: string): Promise<void> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  try {
    await owner.query("begin");
    await owner.query("select set_config('app.actor_id', $1, true)", [userId]);
    await owner.query(
      "insert into public.consents (profile_id, legal_document_id, action, origin) values ($1, $2, 'withdrawn', 'account_settings')",
      [userId, documentId],
    );
    await owner.query("commit");
  } finally {
    await owner.end();
  }
}
