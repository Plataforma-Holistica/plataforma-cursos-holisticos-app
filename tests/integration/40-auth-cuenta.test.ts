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
import { IdentityUnavailableError } from "@/adapters/supabase/errors";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@/domain/access/password-policy";

import {
  authAdmin,
  authVisitor,
  failingFetch,
  knownUser,
  memoryJar,
  networkDown,
  recordingFetch,
  secondFactorFor,
  sessionCount,
  userIdOf,
  verifiedFactors,
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
  await authAdmin().auth.admin.inviteUserByEmail(email);
  await waitForMails(email, 1);
}

/** Cómo quedó guardada la cuenta de un correo en Auth. */
async function stored(email: string) {
  const rows = await ownerQuery<{ has_password: boolean; confirmed: boolean; meta: Record<string, unknown> }>(
    `select coalesce(encrypted_password, '') <> '' as has_password, email_confirmed_at is not null as confirmed,
            raw_user_meta_data as meta
     from auth.users where email = $1`,
    [email],
  );
  return rows[0];
}

const password = () => `P-${randomUUID()}`;

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("pedir el registro", () => {
  it("un correo nuevo recibe el enlace, y la cuenta nace sin contraseña, sin confirmar y sin sesión", async () => {
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    expect((await waitForMails(email, 1)).map((mail) => mail.subject)).toEqual(["Confirma tu correo"]);
    expect(await stored(email)).toEqual({ has_password: false, confirmed: false, meta: {} });
    expect(await sessionCount(await userIdOf(email))).toBe(0);
  });

  it("sin contraseña no hay con qué entrar: ni vacía ni inventada", async () => {
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    for (const guess of ["", "cualquiera-123"]) {
      const tried = await authVisitor().auth.signInWithPassword({ email, password: guess });
      expect(tried.data.session).toBeNull();
    }
    expect(await sessionCount(await userIdOf(email))).toBe(0);
  });

  it("un correo que ya tiene cuenta lo dice aparte, no recibe nada y su cuenta no cambia", async () => {
    const existing = await user();
    expect(await requestSignUp(existing.email)).toBe("existing_account");
    await sentinel();
    expect(await mailsTo(existing.email)).toEqual([]);
    // La contraseña de la cuenta no cambió por haberla registrado otra vez.
    expect((await signIn(memoryJar(), existing.email, existing.password)).ok).toBe(true);
  });

  it("pedirlo otra vez para un correo sin confirmar manda otro enlace, y el anterior deja de servir", async () => {
    // Auth no pone espera entre dos invitaciones: la espera es del servicio (TRD §9.9).
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    const first = tokenHashIn(await lastMailTo(email), "verificar");
    expect(await requestSignUp(email)).toBe("accepted");
    const second = tokenHashIn(await lastMailTo(email, 2), "verificar");

    expect(second).not.toBe(first);
    expect(await redeemSignupLink(first)).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect((await redeemSignupLink(second)).ok).toBe(true);
  });

  it("a Auth solo le manda el correo, por la puerta de las invitaciones: ni contraseña ni datos", async () => {
    const email = newEmail();
    const seen: { path: string; body: string }[] = [];
    const auth = createAuth({
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        seen.push({ path: url.pathname, body: typeof init?.body === "string" ? init.body : "" });
        return fetch(input, init);
      },
    });
    expect(await auth.requestSignUp(email)).toBe("accepted");
    expect(seen.map((call) => call.path)).toEqual(["/auth/v1/invite"]);
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ email });
  });

  it("el límite de correos de Auth sale como tal", async () => {
    const limited = failingFetch(/\/invite/, () =>
      Response.json(
        { code: "over_email_send_rate_limit", message: "x" },
        { status: 429, headers: { "x-supabase-api-version": "2024-01-01" } },
      ),
    );
    expect(await createAuth({ fetch: limited.fetch }).requestSignUp(newEmail())).toBe("mail_rate_limited");
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

  it("sin las claves públicas a la mano no gasta el enlace", async () => {
    const email = newEmail();
    await requestSignUp(email);
    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    const spy = recordingFetch();
    const blind = createAuth({
      fetch: spy.fetch,
      keysReady: () => Promise.reject(new IdentityUnavailableError()),
    });

    expect(await blind.redeemSignupLink(hash)).toEqual({ ok: false, reason: "unknown" });
    expect(spy.calls).toEqual([]);
    // El enlace sigue sirviendo cuando las claves vuelven.
    expect((await redeemSignupLink(hash)).ok).toBe(true);
  });

  it("si la sesión del canje no se puede verificar, no se usa y se cierra", async () => {
    const email = newEmail();
    await requestSignUp(email);
    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    const blind = createAuth({ inspectToken: () => Promise.reject(new IdentityUnavailableError()) });

    // El enlace ya se gastó, y quien llama lo tiene que saber: reintentar con él no sirve.
    expect(await blind.redeemSignupLink(hash)).toEqual({ ok: false, reason: "spent" });
    expect(await sessionCount(await userIdOf(email))).toBe(0);
    expect(await redeemSignupLink(hash)).toEqual({ ok: false, reason: "invalid_or_expired" });
  });

  it("si algo falla después de que Auth canjeó, el enlace se da por gastado y su sesión se cierra", async () => {
    // Un error cualquiera al revisar la sesión, que no es «no hay claves».
    const first = newEmail();
    await requestSignUp(first);
    const broken = createAuth({ inspectToken: () => Promise.reject(new Error("falla inesperada")) });
    expect(await broken.redeemSignupLink(tokenHashIn(await lastMailTo(first), "verificar"))).toEqual({
      ok: false,
      reason: "spent",
    });
    expect(await sessionCount(await userIdOf(first))).toBe(0);

    // Unos metadatos que no dejan usar la sesión, y que no se pudieron borrar.
    const second = newEmail();
    await requestSignUp(second);
    const hash = tokenHashIn(await lastMailTo(second), "verificar");
    await authAdmin().auth.admin.updateUserById(await userIdOf(second), { user_metadata: { relleno: "x".repeat(6_000) } });
    const down = failingFetch(/\/admin\//, networkDown);
    const stuck = createAuth({ fetch: down.fetch });
    expect(await stuck.redeemSignupLink(hash)).toEqual({ ok: false, reason: "spent" });
    // Esa sesión no se alcanza a cerrar: su token es tan largo que ni llega a Auth en una
    // cabecera. Nadie tiene sus tokens, y la borra la recuperación, que es la salida.
    expect(down.calls.some((path) => path.startsWith("/auth/v1/logout?scope=local"))).toBe(true);

    // Un canje que contesta con sesión pero sin decir de quién es.
    const account = await user();
    const real = await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const session = real.data.session;
    if (!session) throw new Error("La persona de prueba no entró.");
    const nameless = failingFetch(/\/verify/, () => Response.json({ ...session, user: null }));
    expect(await createAuth({ fetch: nameless.fetch }).redeemSignupLink("a".repeat(56))).toEqual({
      ok: false,
      reason: "spent",
    });
    expect(nameless.calls.some((path) => path.startsWith("/auth/v1/logout?scope=local"))).toBe(true);
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("si la sesión que devuelve el canje no es de la cuenta que dice, no se usa y se cierra", async () => {
    const account = await user();
    const real = await authVisitor().auth.signInWithPassword({
      email: account.email,
      password: account.password,
    });
    const session = real.data.session;
    if (!session) throw new Error("La persona de prueba no entró.");
    // Auth no contesta así: se simula un canje cuyo usuario no es el del token.
    const mismatched = failingFetch(/\/verify/, () =>
      Response.json({ ...session, user: { ...session.user, id: "a0000000-0000-4000-8000-000000000001" } }),
    );
    const auth = createAuth({ fetch: mismatched.fetch });

    expect(await auth.redeemSignupLink("a".repeat(56))).toEqual({ ok: false, reason: "spent" });
    expect(mismatched.calls.some((path) => path.startsWith("/auth/v1/logout?scope=local"))).toBe(true);
    expect(await sessionCount(account.id)).toBe(0);
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
    // Los tipos ya lo rechazan: hay que forzarlos para llegar a probarlo al correr.
    const forged = { flow: "signup", claims: redeemed.claims, email: redeemed.email } as unknown as RedeemedLink;
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

  it("borra los metadatos que la cuenta traiga colgados, y la sesión cabe", async () => {
    // Desde fuera ya no se puede dar de alta un correo, pero una cuenta que venga de antes
    // puede traer lo que sea: se le cuelga por administración, que es como se ve en la base.
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    const planted = await authAdmin().auth.admin.updateUserById(await userIdOf(email), {
      user_metadata: { relleno: "x".repeat(6_000), otro: { anidado: true } },
    });
    expect(planted.error).toBeNull();

    const result = await redeemSignupLink(hash);
    if (!result.ok) throw new Error("El enlace no se canjeó.");
    const chosen = password();
    expect(await setFirstPassword(result.redeemed, chosen)).toBe("ok");

    expect((await stored(email))?.meta).toEqual({});

    const jar = memoryJar();
    expect((await signIn(jar, email, chosen)).ok).toBe(true);
    expect(jar.writes).toHaveLength(1);
    expect(jar.writes[0]?.value.length).toBeLessThan(SESSION_COOKIE_MAX_LENGTH / 2);
  });

  it("borra también unos metadatos pequeños, que no estorbaban", async () => {
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    const hash = tokenHashIn(await lastMailTo(email), "verificar");
    await authAdmin().auth.admin.updateUserById(await userIdOf(email), { user_metadata: { apodo: "x".repeat(200) } });
    const result = await redeemSignupLink(hash);
    if (!result.ok) throw new Error("El enlace no se canjeó.");
    expect(await setFirstPassword(result.redeemed, password())).toBe("ok");
    expect((await stored(email))?.meta).toEqual({});
  });

  it("la contraseña temporal que Auth pone al canjear una invitación no sobrevive", async () => {
    // Al canjear, Auth le pone a la cuenta invitada una contraseña al azar que nadie ve.
    const { email, redeemed } = await registered();
    expect((await stored(email))?.has_password).toBe(true);
    const before = await ownerQuery<{ hash: string }>("select encrypted_password as hash from auth.users where email = $1", [email]);
    expect(await setFirstPassword(redeemed, password())).toBe("ok");
    const after = await ownerQuery<{ hash: string }>("select encrypted_password as hash from auth.users where email = $1", [email]);
    expect(after[0]?.hash).not.toBe(before[0]?.hash);
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
    expect(await setRecoveredPassword(redeemed, chosen)).toEqual({ result: "ok", via: "session" });
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

  it("con la contraseña que ya tenía, la fija por administración: no queda ninguna sesión y el aviso no sale", async () => {
    // Por su sesión Auth contesta «es la misma» y no cierra nada: las sesiones de antes
    // seguirían vivas. Por administración la vuelve a guardar y las borra todas.
    const account = await user();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const redeemed = await recovering(account);
    expect(await sessionCount(account.id)).toBe(2);

    expect(await setRecoveredPassword(redeemed, account.password)).toEqual({ result: "ok", via: "administration" });

    expect(await sessionCount(account.id)).toBe(0);
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(true);
    await sentinel();
    expect((await mailsTo(account.email)).map((mail) => mail.subject)).toEqual(["Cambia tu contraseña"]);
    expect(await closeAllSessions(redeemed)).toBe("closed");
  });

  it("con segundo factor, la sesión del canje no alcanza: la fija por administración, y el factor sigue", async () => {
    // Con un factor verificado Auth exige una sesión de segundo nivel para cambiar la
    // contraseña, y la de un enlace es de primer nivel. Quien abrió el enlace controla el buzón.
    const account = await user();
    const factor = await secondFactorFor(account);
    const redeemed = await recovering(account);
    expect(redeemed.claims.aal).toBe("aal1");

    const chosen = password();
    expect(await setRecoveredPassword(redeemed, chosen)).toEqual({ result: "ok", via: "administration", secondFactor: true });

    expect(await sessionCount(account.id)).toBe(0);
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(false);
    expect((await signIn(memoryJar(), account.email, chosen)).ok).toBe(true);
    // La contraseña cambió; el segundo factor, no.
    expect(await verifiedFactors(account.id)).toEqual([factor.factorId]);
  });

  it("si alguien cerró la sesión del canje antes de guardar, la fija por administración", async () => {
    // Quien tiene una sesión de la cuenta puede cerrarlas todas en bucle, y con ellas la
    // del canje: sin este camino, la dueña del buzón no podría recuperar nunca.
    const account = await user();
    const intruder = authVisitor();
    await intruder.auth.signInWithPassword({ email: account.email, password: account.password });
    const redeemed = await recovering(account);
    expect((await intruder.auth.signOut({ scope: "global" })).error).toBeNull();
    expect(await sessionCount(account.id)).toBe(0);

    const chosen = password();
    expect(await setRecoveredPassword(redeemed, chosen)).toEqual({ result: "ok", via: "administration" });

    expect(await sessionCount(account.id)).toBe(0);
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(false);
    expect((await signIn(memoryJar(), account.email, chosen)).ok).toBe(true);
  });

  it("por administración no pasa una contraseña que Auth rechaza, ni se intenta si el rechazo fue otro", async () => {
    // Débil: Auth lo dice por la sesión, y ahí se queda.
    const weak = await recovering(await user());
    const spy = recordingFetch();
    expect(await createAuth({ fetch: spy.fetch }).setRecoveredPassword(weak, "a".repeat(PASSWORD_MIN_LENGTH - 1))).toEqual({
      result: "weak_password",
      via: "session",
    });
    expect(spy.calls.some((path) => path.includes("/admin/"))).toBe(false);

    // Sesión cerrada y contraseña débil: el segundo camino la rechaza igual.
    const account = await user();
    const intruder = authVisitor();
    await intruder.auth.signInWithPassword({ email: account.email, password: account.password });
    const redeemed = await recovering(account);
    await intruder.auth.signOut({ scope: "global" });
    expect(await setRecoveredPassword(redeemed, "a".repeat(PASSWORD_MIN_LENGTH - 1))).toEqual({
      result: "weak_password",
      via: "administration",
    });
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(true);
  });

  it("si el segundo camino no contesta, no se supo", async () => {
    const account = await user();
    const redeemed = await recovering(account);
    const down = createAuth({ fetch: failingFetch(/\/admin\//, networkDown).fetch });
    expect(await down.setRecoveredPassword(redeemed, account.password)).toEqual({
      result: "unknown",
      via: "administration",
    });
  });

  it("no acepta un canje de verificación, y un canje alcanza para un solo intento", async () => {
    const { redeemed: fromSignup } = await registered();
    expect(await setRecoveredPassword(fromSignup, password())).toEqual({ result: "rejected", via: "session" });

    const redeemed = await recovering(await user());
    expect(await setRecoveredPassword(redeemed, password())).toEqual({ result: "ok", via: "session" });
    const spy = recordingFetch();
    expect(await createAuth({ fetch: spy.fetch }).setRecoveredPassword(redeemed, password())).toEqual({
      result: "rejected",
      via: "session",
    });
    expect(spy.calls).toEqual([]);
  });

  it("un canje ya cerrado no fija ninguna contraseña, por ningún camino", async () => {
    const account = await user();
    const redeemed = await recovering(account);
    expect(await closeAllSessions(redeemed)).toBe("closed");
    // Ni siquiera se le pregunta a Auth.
    const spy = recordingFetch();
    expect(await createAuth({ fetch: spy.fetch }).setRecoveredPassword(redeemed, password())).toEqual({
      result: "rejected",
      via: "session",
    });
    expect(spy.calls).toEqual([]);
    expect((await signIn(memoryJar(), account.email, account.password)).ok).toBe(true);
  });

  it("recuperar confirma el correo de una cuenta invitada que no abrió su enlace, y borra sus metadatos", async () => {
    const email = newEmail();
    expect(await requestSignUp(email)).toBe("accepted");
    await waitForMails(email, 1);
    await authAdmin().auth.admin.updateUserById(await userIdOf(email), {
      user_metadata: { relleno: "x".repeat(6_000) },
    });

    expect(await requestPasswordRecovery(email)).toBe("accepted");
    const hash = tokenHashIn(await lastMailTo(email, 2), "recuperar");
    const result = await redeemRecoveryLink(hash);
    if (!result.ok) throw new Error("El enlace no se canjeó.");
    const chosen = password();
    expect(await setRecoveredPassword(result.redeemed, chosen)).toEqual({ result: "ok", via: "session" });

    expect(await stored(email)).toEqual({ has_password: true, meta: {}, confirmed: true });
    await closeAllSessions(result.redeemed);
    expect((await signIn(memoryJar(), email, chosen)).ok).toBe(true);
  });

  it("al recuperar borra también unos metadatos pequeños, por los dos caminos", async () => {
    const account = await user();
    await authAdmin().auth.admin.updateUserById(account.id, { user_metadata: { apodo: "x".repeat(200) } });
    const redeemed = await recovering(account);
    expect(await setRecoveredPassword(redeemed, password())).toEqual({ result: "ok", via: "session" });
    expect((await stored(account.email))?.meta).toEqual({});

    const other = await user();
    await authAdmin().auth.admin.updateUserById(other.id, { user_metadata: { apodo: "x".repeat(200) } });
    const again = await recovering(other);
    expect(await setRecoveredPassword(again, other.password)).toEqual({ result: "ok", via: "administration" });
    expect((await stored(other.email))?.meta).toEqual({});
  });

  it("descartar el canje cierra solo su sesión", async () => {
    const account = await user();
    await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
    const redeemed = await recovering(account);
    expect(await sessionCount(account.id)).toBe(2);

    expect(await discardRedemption(redeemed)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(1);
    // Y ya no sirve para cambiar nada.
    expect(await setRecoveredPassword(redeemed, password())).toEqual({ result: "rejected", via: "session" });
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
