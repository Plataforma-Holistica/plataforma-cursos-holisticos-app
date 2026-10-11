import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { parseEmail } from "@/domain/access/email";
import { PASSWORD_MIN_LENGTH } from "@/domain/access/password-policy";
import { terms } from "@/messages/es/terms";

import { lastMailTo, linksIn, mailsTo, tokenHashIn, waitForMails } from "./helpers/mailbox";
import {
  createTestUser,
  deleteTestUsers,
  deleteTestUsersByEmail,
  ownerQuery,
  testEmail,
  type TestUser,
} from "./helpers/users";

// La configuración del Auth local (`supabase/config.toml`) y sus plantillas, comprobadas
// por lo que Auth hace y no por lo que dice el archivo: una clave mal escrita se ignora
// sin error, y una plantilla con la ruta equivocada deja salir la de fábrica.
//
// Aquí se habla con Auth directo, con el SDK: lo que se prueba es su configuración, no el
// adaptador de la aplicación.

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} para las pruebas de integración.`);
  return value;
};

const SITE = env("NEXT_PUBLIC_SITE_URL");
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

/** Un cliente nuevo cada vez: guarda en memoria la sesión de quien entra con él. */
const visitor = (): SupabaseClient =>
  createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), noSession);
const admin = (): SupabaseClient =>
  createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), noSession);

const users: TestUser[] = [];
const emails: string[] = [];

async function confirmedUser(): Promise<TestUser> {
  const user = await createTestUser();
  users.push(user);
  return user;
}

function newEmail(): string {
  const email = testEmail();
  emails.push(email);
  return email;
}

async function parameter(key: string): Promise<number> {
  const rows = await ownerQuery<{ value: number }>("select private.parameter_value($1) as value", [key]);
  const value = rows[0]?.value;
  if (typeof value !== "number") throw new Error(`El parámetro ${key} no es un número.`);
  return value;
}

/** Atrasa la hora en que se mandó el último correo de verificación de una cuenta. */
async function backdateConfirmation(email: string, seconds: number): Promise<void> {
  await ownerQuery(
    "update auth.users set confirmation_sent_at = now() - make_interval(secs => $2) where email = $1",
    [email, seconds],
  );
}

/** Una llamada directa a Auth, como la haría cualquiera con la llave que se le dé. */
async function post(path: string, body: unknown, key: string): Promise<{ status: number; code: unknown }> {
  const response = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as { error_code?: unknown; code?: unknown } | null;
  return { status: response.status, code: answer?.error_code ?? answer?.code ?? null };
}

async function accountsOf(addresses: readonly string[]): Promise<number> {
  const rows = await ownerQuery<{ count: string }>(
    "select count(*)::text as count from auth.users where email = any($1::text[])",
    [addresses],
  );
  return Number(rows[0]?.count);
}

/** Atrasa la hora en que se mandó el último correo de recuperación de una cuenta. */
async function backdateRecovery(email: string, seconds: number): Promise<void> {
  await ownerQuery(
    "update auth.users set recovery_sent_at = now() - make_interval(secs => $2) where email = $1",
    [email, seconds],
  );
}

/** Lo que una plantilla nunca debe traer: algo con lo que entrar sin pasar por la Plataforma. */
function expectNoWayIn(html: string): void {
  expect(html).not.toMatch(/\/auth\/v1\/verify/);
  expect(html).not.toMatch(/token=/);
  // El código numérico equivalente al enlace mide 10 dígitos.
  expect(html).not.toMatch(/\b\d{10}\b/);
  // Ni la huella, que escrita en el correo se podría canjear directo en Auth.
  expect(html).not.toMatch(/[0-9a-f]{56}/);
}

afterAll(async () => {
  await deleteTestUsers(users);
  await deleteTestUsersByEmail(emails);
});

describe("lo que el Auth local tiene configurado", () => {
  it("exige confirmar el correo, y también el teléfono aunque no se use", async () => {
    const response = await fetch(`${env("NEXT_PUBLIC_SUPABASE_URL")}/auth/v1/settings`, {
      headers: { apikey: env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") },
    });
    const settings = (await response.json()) as Record<string, unknown>;
    // Con una sola apagada, registrar un correo ya confirmado contesta «ya existe».
    expect(settings.mailer_autoconfirm).toBe(false);
    expect(settings.phone_autoconfirm).toBe(false);
    // Y no acepta altas: una cuenta solo nace de una invitación del servidor.
    expect(settings.disable_signup).toBe(true);
  });

  it("desde fuera no se crea una cuenta por ninguna puerta, ni con la llave secreta en la del registro", async () => {
    // Si se pudiera, cualquiera plantaría una contraseña en el correo de otra persona.
    const publishable = env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const tried = [newEmail(), newEmail(), newEmail(), newEmail(), newEmail()];
    const [signUpEmail, otpEmail, magicEmail, rawOtpEmail, secretEmail] = tried as [string, string, string, string, string];

    const signedUp = await visitor().auth.signUp({ email: signUpEmail, password: `P-${randomUUID()}` });
    expect(signedUp.error?.code).toBe("signup_disabled");
    expect(signedUp.data.session).toBeNull();

    const byCode = await visitor().auth.signInWithOtp({ email: otpEmail, options: { shouldCreateUser: true } });
    expect(byCode.error?.code).toBe("signup_disabled");

    expect(await post("/magiclink", { email: magicEmail }, publishable)).toEqual({ status: 422, code: "signup_disabled" });
    expect(await post("/otp", { email: rawOtpEmail, create_user: true }, publishable)).toEqual({
      status: 422,
      code: "signup_disabled",
    });
    expect(
      await post("/signup", { email: secretEmail, password: `P-${randomUUID()}` }, env("SUPABASE_SECRET_KEY")),
    ).toEqual({ status: 422, code: "signup_disabled" });

    const anonymous = await visitor().auth.signInAnonymously();
    expect(anonymous.error?.code).toBe("anonymous_provider_disabled");
    expect(anonymous.data.session).toBeNull();

    expect(await accountsOf(tried)).toBe(0);
    // Un correo centinela, pedido después: cuando llega, los otros ya habrían llegado.
    const sentinel = newEmail();
    await admin().auth.admin.inviteUserByEmail(sentinel);
    await waitForMails(sentinel, 1);
    for (const address of tried) expect(await mailsTo(address)).toEqual([]);
  });

  it("la invitación da de alta la cuenta sin contraseña y sin confirmar", async () => {
    const email = newEmail();
    const invited = await admin().auth.admin.inviteUserByEmail(email);
    expect(invited.error).toBeNull();
    const rows = await ownerQuery<{ has_password: boolean; confirmed: boolean }>(
      "select coalesce(encrypted_password, '') <> '' as has_password, email_confirmed_at is not null as confirmed from auth.users where email = $1",
      [email],
    );
    expect(rows).toEqual([{ has_password: false, confirmed: false }]);
  });

  it("invitar un correo que ya tiene cuenta dice que existe, y no le manda nada", async () => {
    const user = await confirmedUser();
    const again = await admin().auth.admin.inviteUserByEmail(user.email);
    expect(again.error?.code).toBe("email_exists");

    const sentinel = newEmail();
    await admin().auth.admin.inviteUserByEmail(sentinel);
    await waitForMails(sentinel, 1);
    expect(await mailsTo(user.email)).toEqual([]);
  });

  it("el token de acceso dura 15 minutos", async () => {
    const user = await confirmedUser();
    const password = `P-${randomUUID()}`;
    await admin().auth.admin.updateUserById(user.id, { password });
    const signedIn = await visitor().auth.signInWithPassword({ email: user.email, password });
    expect(signedIn.data.session?.expires_in).toBe(900);
  });

  it("su mínimo de contraseña es el de la política del dominio", async () => {
    const short = await admin().auth.admin.createUser({
      email: newEmail(),
      password: "a".repeat(PASSWORD_MIN_LENGTH - 1),
      email_confirm: true,
    });
    expect(short.error?.code).toBe("weak_password");

    const enough = await admin().auth.admin.createUser({
      email: newEmail(),
      password: "a".repeat(PASSWORD_MIN_LENGTH),
      email_confirm: true,
    });
    expect(enough.error).toBeNull();
  });

  it("el código numérico equivalente al enlace mide 10 dígitos", async () => {
    const user = await confirmedUser();
    const link = await admin().auth.admin.generateLink({ type: "recovery", email: user.email });
    expect(link.data.properties?.email_otp).toMatch(/^\d{10}$/);
  });

  it("un enlace vale hasta VIGENCIA_ENLACE_CONTRASENA y no después", async () => {
    const lifetime = (await parameter("VIGENCIA_ENLACE_CONTRASENA")) * 60;

    const early = await confirmedUser();
    await visitor().auth.resetPasswordForEmail(early.email);
    const earlyHash = tokenHashIn(await lastMailTo(early.email), "recuperar");
    await backdateRecovery(early.email, lifetime - 30);
    const stillGood = await visitor().auth.verifyOtp({ token_hash: earlyHash, type: "recovery" });
    expect(stillGood.error).toBeNull();
    expect(stillGood.data.session).not.toBeNull();

    const late = await confirmedUser();
    await visitor().auth.resetPasswordForEmail(late.email);
    const lateHash = tokenHashIn(await lastMailTo(late.email), "recuperar");
    await backdateRecovery(late.email, lifetime + 30);
    const expired = await visitor().auth.verifyOtp({ token_hash: lateHash, type: "recovery" });
    expect(expired.error?.code).toBe("otp_expired");
    expect(expired.data.session).toBeNull();
  });

  it("entre dos correos a la misma cuenta pide esperar ESPERA_REENVIO", async () => {
    const wait = await parameter("ESPERA_REENVIO");
    const user = await confirmedUser();

    expect((await visitor().auth.resetPasswordForEmail(user.email)).error).toBeNull();
    await waitForMails(user.email, 1);

    const tooSoon = await visitor().auth.resetPasswordForEmail(user.email);
    expect(tooSoon.error?.code).toBe("over_email_send_rate_limit");

    await backdateRecovery(user.email, wait - 5);
    const stillSoon = await visitor().auth.resetPasswordForEmail(user.email);
    expect(stillSoon.error?.code).toBe("over_email_send_rate_limit");

    await backdateRecovery(user.email, wait + 5);
    expect((await visitor().auth.resetPasswordForEmail(user.email)).error).toBeNull();
    await waitForMails(user.email, 2);
  });

  it("pedirle directo un enlace de acceso gasta la espera de la recuperación de esa cuenta", async () => {
    // Lo puede hacer cualquiera con la llave publicable. Por eso el servicio no da por
    // mandado un correo de recuperación que Auth rechazó por su espera.
    const user = await confirmedUser();
    const asked = await visitor().auth.signInWithOtp({ email: user.email, options: { shouldCreateUser: false } });
    expect(asked.error).toBeNull();
    await waitForMails(user.email, 1);

    const recovery = await visitor().auth.resetPasswordForEmail(user.email);
    expect(recovery.error?.code).toBe("over_email_send_rate_limit");
  });

  it("cambiar la contraseña con una sesión de más de un día pide volver a identificarse", async () => {
    const user = await confirmedUser();
    const password = `P-${randomUUID()}`;
    await admin().auth.admin.updateUserById(user.id, { password });
    const client = visitor();
    await client.auth.signInWithPassword({ email: user.email, password });
    await ownerQuery("update auth.sessions set created_at = now() - interval '25 hours' where user_id = $1", [
      user.id,
    ]);

    const changed = await client.auth.updateUser({ password: `P-${randomUUID()}` });
    expect(changed.error?.code).toBe("reauthentication_needed");
  });

  it("guarda el correo igual que lo normaliza el dominio", async () => {
    const typed = `It-${randomUUID().toUpperCase()}@Prueba.TEST`;
    const parsed = parseEmail(typed);
    if (!parsed.ok) throw new Error("El correo de prueba no pasó por el dominio.");
    emails.push(parsed.email);

    const created = await admin().auth.admin.createUser({
      email: typed,
      password: `P-${randomUUID()}`,
      email_confirm: true,
    });
    expect(created.error).toBeNull();

    const stored = await ownerQuery<{ email: string }>("select email from auth.users where id = $1", [
      created.data.user?.id,
    ]);
    expect(stored[0]?.email).toBe(parsed.email);
  });
});

describe("los correos que manda el Auth local", () => {
  it("CO-01: invitar un correo nuevo manda el enlace a /verificar, sin sesión, y el perfil nace con la marca", async () => {
    const lifetime = await parameter("VIGENCIA_ENLACE_CONTRASENA");
    const email = newEmail();

    const invited = await admin().auth.admin.inviteUserByEmail(email);
    expect(invited.error).toBeNull();
    const sessions = await ownerQuery<{ count: string }>(
      "select count(*)::text as count from auth.sessions s join auth.users u on u.id = s.user_id where u.email = $1",
      [email],
    );
    expect(sessions[0]?.count).toBe("0");

    const mail = await lastMailTo(email);
    expect(mail.subject).toBe("Confirma tu correo");
    expect(tokenHashIn(mail, "verificar")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Todo enlace del correo lleva al sitio propio: ninguno pasa por Auth.
    for (const link of linksIn(mail)) expect(link.startsWith(`${SITE}/`)).toBe(true);
    expectNoWayIn(mail.html.replaceAll(tokenHashIn(mail, "verificar"), ""));
    expect(mail.html).toContain(terms.Plataforma);
    // La vigencia que dice el correo es la del parámetro. Si cambia, cambia la plantilla.
    expect(lifetime).toBe(60);
    expect(mail.html).toContain("El enlace dura 1 hora y sirve una vez.");

    const profile = await ownerQuery<{ password_reset_required: boolean }>(
      "select p.password_reset_required from public.profiles p join auth.users u on u.id = p.id where u.email = $1",
      [email],
    );
    expect(profile).toEqual([{ password_reset_required: true }]);
  });

  it("CO-01, si alguien pide el reenvío directo en Auth: sale el mismo correo, y su enlace se canjea igual", async () => {
    // Auth sigue atendiendo el reenvío de una cuenta invitada que no ha confirmado, y ahí
    // usa la plantilla de confirmación, no la de invitación: las dos son el mismo correo.
    const email = newEmail();
    await admin().auth.admin.inviteUserByEmail(email);
    const first = await lastMailTo(email);
    await backdateConfirmation(email, (await parameter("ESPERA_REENVIO")) + 5);

    expect((await visitor().auth.resend({ type: "signup", email })).error).toBeNull();
    const again = await lastMailTo(email, 2);

    expect(again.subject).toBe("Confirma tu correo");
    const strip = (html: string, hash: string) => html.replaceAll(hash, "");
    expect(strip(again.html, tokenHashIn(again, "verificar"))).toBe(strip(first.html, tokenHashIn(first, "verificar")));
    for (const link of linksIn(again)) expect(link.startsWith(`${SITE}/`)).toBe(true);
    expectNoWayIn(strip(again.html, tokenHashIn(again, "verificar")));

    const redeemed = await visitor().auth.verifyOtp({ token_hash: tokenHashIn(again, "verificar"), type: "invite" });
    expect(redeemed.error).toBeNull();
    expect(redeemed.data.session).not.toBeNull();
  });

  it("CO-07: pedir la recuperación manda el enlace a /recuperar", async () => {
    const user = await confirmedUser();
    expect((await visitor().auth.resetPasswordForEmail(user.email)).error).toBeNull();

    const mail = await lastMailTo(user.email);
    expect(mail.subject).toBe("Cambia tu contraseña");
    expect(tokenHashIn(mail, "recuperar")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    for (const link of linksIn(mail)) expect(link.startsWith(`${SITE}/`)).toBe(true);
    expectNoWayIn(mail.html.replaceAll(tokenHashIn(mail, "recuperar"), ""));
    expect(mail.html).toContain("El enlace dura 1 hora y sirve una vez.");
  });

  it("CO-26: cambiar la contraseña con la sesión de la persona manda el aviso, sin enlace con huella", async () => {
    const user = await confirmedUser();
    const client = visitor();
    await client.auth.resetPasswordForEmail(user.email);
    const hash = tokenHashIn(await lastMailTo(user.email), "recuperar");
    expect((await client.auth.verifyOtp({ token_hash: hash, type: "recovery" })).error).toBeNull();

    // Con `secure_password_change` prendida, la sesión recién canjeada alcanza.
    const changed = await client.auth.updateUser({ password: `P-${randomUUID()}` });
    expect(changed.error).toBeNull();

    const mail = await lastMailTo(user.email, 2);
    expect(mail.subject).toBe("Tu contraseña cambió");
    expect(linksIn(mail).sort()).toEqual([`${SITE}/ayuda`, `${SITE}/recuperar`]);
    expectNoWayIn(mail.html);
    expect(mail.html).toContain(terms.Plataforma);
  });

  it("el correo de «enlace de acceso» no trae enlace ni código", async () => {
    const user = await confirmedUser();
    const asked = await visitor().auth.signInWithOtp({
      email: user.email,
      options: { shouldCreateUser: false },
    });
    expect(asked.error).toBeNull();

    const mail = await lastMailTo(user.email);
    expect(mail.subject).toBe("Alguien pidió un enlace de acceso");
    expect(linksIn(mail)).toEqual([`${SITE}/ayuda`]);
    expectNoWayIn(mail.html);
  });

  it("el correo de cambio de correo no trae enlace ni código", async () => {
    const user = await confirmedUser();
    const password = `P-${randomUUID()}`;
    await admin().auth.admin.updateUserById(user.id, { password });
    const client = visitor();
    await client.auth.signInWithPassword({ email: user.email, password });

    const target = newEmail();
    const asked = await client.auth.updateUser({ email: target });
    expect(asked.error).toBeNull();

    const mail = await lastMailTo(target);
    expect(mail.subject).toBe("Alguien pidió cambiar el correo de tu cuenta");
    expect(linksIn(mail)).toEqual([`${SITE}/ayuda`]);
    expectNoWayIn(mail.html);
    // Con la doble confirmación, la dirección de antes recibe el mismo aviso.
    for (const previous of await mailsTo(user.email)) expectNoWayIn(previous.html);
  });

});
