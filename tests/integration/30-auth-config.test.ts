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
  it("CO-01: registrar un correo nuevo manda el enlace a /verificar, sin sesión, y el perfil nace con la marca", async () => {
    const lifetime = await parameter("VIGENCIA_ENLACE_CONTRASENA");
    const email = newEmail();

    const signedUp = await visitor().auth.signUp({ email, password: `P-${randomUUID()}` });
    expect(signedUp.error).toBeNull();
    expect(signedUp.data.session).toBeNull();

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

  it("registrar un correo que ya tiene cuenta contesta igual y no manda nada", async () => {
    const user = await confirmedUser();
    const again = await visitor().auth.signUp({ email: user.email, password: `P-${randomUUID()}` });
    expect(again.error).toBeNull();
    expect(again.data.session).toBeNull();
    expect(again.data.user?.id).not.toBe(user.id);

    // Un correo centinela, pedido después: cuando llega, el otro ya habría llegado.
    const sentinel = newEmail();
    await visitor().auth.signUp({ email: sentinel, password: `P-${randomUUID()}` });
    await waitForMails(sentinel, 1);
    expect(await mailsTo(user.email)).toEqual([]);
  });
});
