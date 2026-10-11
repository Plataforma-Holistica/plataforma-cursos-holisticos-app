import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  closeAllSessions,
  createAuth,
  discardRedemption,
  redeemRecoveryLink,
  redeemSignupLink,
  requestPasswordRecovery,
  requestSignUp,
  setFirstPassword,
  setRecoveredPassword,
  signIn,
  type RedeemedLink,
} from "@/adapters/supabase/auth";
import { SESSION_COOKIE_MAX_LENGTH } from "@/adapters/supabase/auth-cookies";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@/domain/access/password-policy";

import {
  authAdmin,
  authVisitor,
  failingFetch,
  knownUser,
  memoryJar,
  networkDown,
  recordingFetch,
  sessionCount,
  userIdOf,
  type KnownUser,
} from "./helpers/auth";
import { lastMailTo, mailsTo, tokenHashIn, waitForMails } from "./helpers/mailbox";
import { deleteTestUsersByEmail, ownerQuery, testEmail } from "./helpers/users";

// El adaptador de Auth, contra el Auth local: registrar, canjear el enlace del correo y
// fijar la contraseña (TRD §9.2, filas «Registro», «Quién fija la contraseña»,
// «Verificación de correo» y «Recuperación»).

const emails: string[] = [];

function newEmail(): string {
  const email = testEmail();
  emails.push(email);
  return email;
}

async function user(options: { confirmed?: boolean } = {}): Promise<KnownUser> {
  const created = await knownUser(options);
  emails.push(created.email);
  return created;
}

/** Registra un correo por el adaptador y canjea el enlace que llegó al buzón. */
async function registered(): Promise<{ email: string; redeemed: RedeemedLink }> {
  const email = newEmail();
  expect(await requestSignUp(email)).toBe("accepted");
  const hash = tokenHashIn(await lastMailTo(email), "verificar");
  const result = await redeemSignupLink(hash);
  if (!result.ok) throw new Error(`El enlace de verificación no se canjeó: ${result.reason}`);
  return { email, redeemed: result.redeemed };
}

/** Pide la recuperación por el adaptador y canjea el enlace que llegó al buzón. */
async function recovering(account: KnownUser): Promise<RedeemedLink> {
  expect(await requestPasswordRecovery(account.email)).toBe("accepted");
  const hash = tokenHashIn(await lastMailTo(account.email), "recuperar");
  const result = await redeemRecoveryLink(hash);
  if (!result.ok) throw new Error(`El enlace de recuperación no se canjeó: ${result.reason}`);
  return result.redeemed;
}

/** Llega cuando ya llegó todo lo que se pidió antes: sirve para afirmar que algo no llegó. */
async function sentinel(): Promise<void> {
  const email = newEmail();
  await authVisitor().auth.signUp({ email, password: `P-${randomUUID()}` });
  await waitForMails(email, 1);
}

const password = () => `P-${randomUUID()}`;

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("pedir el registro", () => {
  it("un correo nuevo recibe el enlace y no queda ninguna sesión", async () => {
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    await waitForMails(email, 1);
    expect(await sessionCount(await userIdOf(email))).toBe(0);
  });

  it("un correo que ya tiene cuenta contesta igual y no recibe nada", async () => {
    const existing = await user();
    expect(await requestSignUp(existing.email)).toBe("accepted");
    await sentinel();
    expect(await mailsTo(existing.email)).toEqual([]);
    // La contraseña de la cuenta no cambió por haberla registrado otra vez.
    expect((await signIn(memoryJar(), existing.email, existing.password)).ok).toBe(true);
  });

  it("pedirlo dos veces seguidas para un correo sin confirmar da el límite de correos", async () => {
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    expect(await requestSignUp(email)).toBe("mail_rate_limited");
  });

  it("la contraseña que usa no la conoce nadie: registrar no deja entrar", async () => {
    const email = newEmail();
    const seen: string[] = [];
    const spy = failingFetch(/^$/, networkDown);
    const auth = createAuth({
      fetch: (input, init) => {
        if (typeof init?.body === "string") seen.push(init.body);
        return spy.fetch(input, init);
      },
    });
    expect(await auth.requestSignUp(email)).toBe("accepted");
    const sent = JSON.parse(seen[0] ?? "{}") as { password?: string };
    // 32 bytes aleatorios en base64url: 43 caracteres, dentro del máximo de Auth.
    expect(sent.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.byteLength(sent.password ?? "")).toBeLessThanOrEqual(PASSWORD_MAX_BYTES);

    const again = createAuth({
      fetch: (input, init) => {
        if (typeof init?.body === "string") seen.push(init.body);
        return fetch(input, init);
      },
    });
    await again.requestSignUp(newEmail());
    const other = JSON.parse(seen[1] ?? "{}") as { password?: string };
    expect(other.password).not.toBe(sent.password);
  });

  it("si Auth entrega una sesión al registrar, la cierra y lo dice", async () => {
    // Solo pasa con la confirmación de correo apagada: se simula la respuesta.
    const existing = await user();
    const session = await authVisitor().auth.signInWithPassword({
      email: existing.email,
      password: existing.password,
    });
    expect(await sessionCount(existing.id)).toBe(1);
    const fake = failingFetch(/\/signup/, () => Response.json(session.data.session));
    const auth = createAuth({ fetch: fake.fetch });

    expect(await auth.requestSignUp(existing.email)).toBe("misconfigured");
    expect(fake.calls.some((path) => path.startsWith("/auth/v1/logout?scope=local"))).toBe(true);
    expect(await sessionCount(existing.id)).toBe(0);
  });

  it("sin respuesta de Auth, no se supo", async () => {
    const auth = createAuth({ fetch: failingFetch(/./, networkDown).fetch });
    expect(await auth.requestSignUp(newEmail())).toBe("unknown");
    expect(await auth.requestPasswordRecovery(newEmail())).toBe("unknown");
  });
});

describe("canjear el enlace de verificación", () => {
  it("devuelve la cuenta, su correo y unas claims que sirven", async () => {
    const { email, redeemed } = await registered();
    expect(redeemed.flow).toBe("signup");
    expect(redeemed.email).toBe(email);
    expect(redeemed.claims.userId).toBe(await userIdOf(email));
    expect(redeemed.claims.aal).toBe("aal1");
    expect(Object.isFrozen(redeemed)).toBe(true);
  });

  it("sirve una sola vez", async () => {
    const email = newEmail();
    await requestSignUp(email);
    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    expect((await redeemSignupLink(hash)).ok).toBe(true);
    expect(await redeemSignupLink(hash)).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  it.each([
    ["vacía", ""],
    ["con un carácter ajeno", "abc/def?x=1"],
    ["demasiado corta", "abc"],
    ["demasiado larga", "a".repeat(300)],
  ])("una huella %s no llega a Auth", async (_name, hash) => {
    const spy = recordingFetch();
    const auth = createAuth({ fetch: spy.fetch });
    expect(await auth.redeemSignupLink(hash)).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(await auth.redeemRecoveryLink(hash)).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(spy.calls).toEqual([]);
  });

  it("una huella con forma, pero que no existe, no sirve", async () => {
    expect(await redeemSignupLink("a".repeat(56))).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  it("no canjea un enlace de recuperación, y ese enlace sigue sirviendo para recuperar", async () => {
    const account = await user();
    await requestPasswordRecovery(account.email);
    const hash = tokenHashIn(await lastMailTo(account.email), "recuperar");
    expect(await redeemSignupLink(hash)).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect((await redeemRecoveryLink(hash)).ok).toBe(true);
  });

  it("y el de verificación no se canjea como recuperación", async () => {
    const email = newEmail();
    await requestSignUp(email);
    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    expect(await redeemRecoveryLink(hash)).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect((await redeemSignupLink(hash)).ok).toBe(true);
  });

  it("sin respuesta de Auth, no se supo", async () => {
    const auth = createAuth({ fetch: failingFetch(/\/verify/, networkDown).fetch });
    expect(await auth.redeemSignupLink("a".repeat(56))).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("fijar la primera contraseña", () => {
  it("deja entrar con ella, no manda el aviso y borra la sesión del canje", async () => {
    const { email, redeemed } = await registered();
    const chosen = password();
    expect(await sessionCount(redeemed.claims.userId)).toBe(1);

    expect(await setFirstPassword(redeemed, chosen)).toBe("ok");

    expect(await sessionCount(redeemed.claims.userId)).toBe(0);
    const jar = memoryJar();
    const entered = await signIn(jar, email, chosen);
    expect(entered).toMatchObject({ ok: true, claims: { userId: redeemed.claims.userId } });
    await sentinel();
    // El de verificación y ninguno más: quien apenas se registra no recibe CO-26.
    expect((await mailsTo(email)).map((mail) => mail.subject)).toEqual(["Confirma tu correo"]);
    // Cerrar lo que ya no existe es haberlo cerrado.
    expect(await closeAllSessions(redeemed)).toBe("closed");
  });

  it("un canje alcanza para un solo intento", async () => {
    const { redeemed } = await registered();
    expect(await setFirstPassword(redeemed, password())).toBe("ok");
    expect(await setFirstPassword(redeemed, password())).toBe("rejected");
  });

  it("no acepta un canje de recuperación", async () => {
    const account = await user();
    const redeemed = await recovering(account);
    expect(await setFirstPassword(redeemed, password())).toBe("rejected");
    // Y no cambió nada: la contraseña de antes sigue entrando.
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(true);
  });

  it("no acepta un objeto con la forma de un canje, armado en otro lado", async () => {
    const { redeemed } = await registered();
    const forged: RedeemedLink = { flow: "signup", claims: redeemed.claims, email: redeemed.email };
    expect(await setFirstPassword(forged, password())).toBe("rejected");
    expect(await closeAllSessions(forged)).toBe("unknown");
    expect(await discardRedemption(forged)).toBe("unknown");
  });

  it("una contraseña más corta que el mínimo es débil, y la del mínimo pasa", async () => {
    const short = await registered();
    expect(await setFirstPassword(short.redeemed, "a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe("weak_password");
    const enough = await registered();
    expect(await setFirstPassword(enough.redeemed, "a".repeat(PASSWORD_MIN_LENGTH))).toBe("ok");
  });

  it("una contraseña de más de 72 bytes se rechaza", async () => {
    const { redeemed } = await registered();
    expect(await setFirstPassword(redeemed, "a".repeat(PASSWORD_MAX_BYTES + 1))).toBe("rejected");
  });

  it("sin respuesta de Auth, no se supo", async () => {
    const { redeemed } = await registered();
    const auth = createAuth({ fetch: failingFetch(/\/admin\//, networkDown).fetch });
    expect(await auth.setFirstPassword(redeemed, password())).toBe("unknown");
  });

  it("borra los metadatos que alguien haya escrito al dar de alta el correo, y la sesión cabe", async () => {
    // Quien da de alta un correo ajeno directo en Auth puede colgarle lo que quiera.
    const email = newEmail();
    const planted = await authVisitor().auth.signUp({
      email,
      password: password(),
      options: { data: { relleno: "x".repeat(6_000), otro: { anidado: true } } },
    });
    expect(planted.error).toBeNull();

    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    const result = await redeemSignupLink(hash);
    if (!result.ok) throw new Error("El enlace no se canjeó.");
    const chosen = password();
    expect(await setFirstPassword(result.redeemed, chosen)).toBe("ok");

    const stored = await ownerQuery<{ meta: Record<string, unknown> }>(
      "select raw_user_meta_data as meta from auth.users where email = $1",
      [email],
    );
    expect(stored[0]?.meta).toEqual({});

    const jar = memoryJar();
    expect((await signIn(jar, email, chosen)).ok).toBe(true);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]?.value.length).toBeLessThan(SESSION_COOKIE_MAX_LENGTH / 2);
  });

  it("sin ese borrado, la sesión de esa cuenta no cabría en la cookie", async () => {
    // La otra mitad de la prueba de arriba: que el relleno sí es de los que estorban.
    const account = await user();
    await authAdmin().auth.admin.updateUserById(account.id, {
      user_metadata: { relleno: "x".repeat(3_000) },
    });
    const jar = memoryJar();
    expect(await signIn(jar, account.email, account.password)).toEqual({
      ok: false,
      reason: "oversized_session",
    });
    expect(jar.writes).toEqual([]);
    // La sesión que Auth alcanzó a crear quedó cerrada.
    expect(await sessionCount(account.id)).toBe(0);
  });
});

describe("recuperar la contraseña", () => {
  it("un correo sin cuenta contesta igual y no recibe nada", async () => {
    const nobody = newEmail();
    expect(await requestPasswordRecovery(nobody)).toBe("accepted");
    await sentinel();
    expect(await mailsTo(nobody)).toEqual([]);
  });

  it("guarda la contraseña, manda el aviso y cierra las otras sesiones; cerrar todo no deja ninguna", async () => {
    const account = await user();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    expect(await sessionCount(account.id)).toBe(1);

    const redeemed = await recovering(account);
    expect(redeemed).toMatchObject({ flow: "recovery", email: account.email });
    expect(redeemed.claims.userId).toBe(account.id);
    expect(await sessionCount(account.id)).toBe(2);

    const chosen = password();
    expect(await setRecoveredPassword(redeemed, chosen)).toBe("ok");
    // Auth cerró la otra y dejó la del canje.
    expect(await sessionCount(account.id)).toBe(1);
    expect((await lastMailTo(account.email, 2)).subject).toBe("Tu contraseña cambió");

    expect(await closeAllSessions(redeemed)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(0);
    // Se puede volver a pedir: cerrar lo cerrado es haberlo cerrado.
    expect(await closeAllSessions(redeemed)).toBe("closed");

    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(false);
    expect((await signIn(memoryJar(), account.email, chosen)).ok).toBe(true);
  });

  it("con la contraseña que ya tenía, Auth no cierra nada: lo cierra closeAllSessions", async () => {
    const account = await user();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const redeemed = await recovering(account);

    expect(await setRecoveredPassword(redeemed, account.password)).toBe("same_password");
    expect(await sessionCount(account.id)).toBe(2);
    expect(await closeAllSessions(redeemed)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("no acepta un canje de verificación, y un canje alcanza para un solo intento", async () => {
    const { redeemed: fromSignup } = await registered();
    expect(await setRecoveredPassword(fromSignup, password())).toBe("rejected");

    const redeemed = await recovering(await user());
    expect(await setRecoveredPassword(redeemed, password())).toBe("ok");
    expect(await setRecoveredPassword(redeemed, password())).toBe("rejected");
  });

  it("un canje ya cerrado no fija ninguna contraseña", async () => {
    const account = await user();
    const redeemed = await recovering(account);
    expect(await closeAllSessions(redeemed)).toBe("closed");
    expect(await setRecoveredPassword(redeemed, password())).toBe("rejected");
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(true);
  });

  it("recuperar confirma el correo de una cuenta que no lo había confirmado, y borra sus metadatos", async () => {
    const email = newEmail();
    await authVisitor().auth.signUp({
      email,
      password: password(),
      options: { data: { relleno: "x".repeat(6_000) } },
    });
    await waitForMails(email, 1);

    expect(await requestPasswordRecovery(email)).toBe("accepted");
    const hash = tokenHashIn(await lastMailTo(email, 2), "recuperar");
    const result = await redeemRecoveryLink(hash);
    if (!result.ok) throw new Error("El enlace no se canjeó.");
    const chosen = password();
    expect(await setRecoveredPassword(result.redeemed, chosen)).toBe("ok");

    const stored = await ownerQuery<{ meta: Record<string, unknown>; confirmed: boolean }>(
      "select raw_user_meta_data as meta, email_confirmed_at is not null as confirmed from auth.users where email = $1",
      [email],
    );
    expect(stored[0]).toEqual({ meta: {}, confirmed: true });
    await closeAllSessions(result.redeemed);
    expect((await signIn(memoryJar(), email, chosen)).ok).toBe(true);
  });

  it("descartar el canje cierra solo su sesión", async () => {
    const account = await user();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const redeemed = await recovering(account);
    expect(await sessionCount(account.id)).toBe(2);

    expect(await discardRedemption(redeemed)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(1);
    // Y ya no sirve para cambiar nada.
    expect(await setRecoveredPassword(redeemed, password())).toBe("rejected");
  });

  it("sin respuesta de Auth, no se supo y no se cerró", async () => {
    const account = await user();
    const redeemed = await recovering(account);
    const down = createAuth({ fetch: failingFetch(/\/(user|logout)/, networkDown).fetch });
    expect(await down.closeAllSessions(redeemed)).toBe("unknown");
    expect(await sessionCount(account.id)).toBe(1);
    // Cuando Auth vuelve, se puede cerrar.
    expect(await closeAllSessions(redeemed)).toBe("closed");
  });
});
