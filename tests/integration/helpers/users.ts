import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

// Personas de prueba con una sesión de verdad: se dan de alta en el Auth local, inician
// sesión con su contraseña y devuelven su token. Así el token que llega al adaptador lo
// firmó el servidor de identidad, y el perfil lo creó el disparador de la base.
//
// La llave secreta solo se usa aquí, para dar de alta y borrar. No sale de las pruebas.

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} para las pruebas de integración.`);
  return value;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

export interface TestUserOptions {
  /**
   * Con la marca de contraseña apagada, como quien ya completó su registro desde el enlace
   * de su buzón. Sin esto la persona nace como toda cuenta nueva: con la marca prendida.
   */
  claimed?: boolean;
}

// La marca solo la apaga private.claim_account(), a nombre de la propia cuenta. El
// ayudante la llama como dueño de la base, declarando por quién actúa: es el atajo de las
// pruebas para no pasar por el correo.
async function claimAccount(id: string): Promise<void> {
  const owner = new Client({ connectionString: env("DATABASE_URL_DIRECT") });
  await owner.connect();
  try {
    await owner.query("begin");
    await owner.query("select set_config('app.actor_id', $1, true)", [id]);
    const result = await owner.query<{ status: string }>("select private.claim_account() as status");
    await owner.query("commit");
    const status = result.rows[0]?.status;
    if (status !== "claimed") {
      throw new Error(`La persona de prueba no quedó con la marca apagada: ${status ?? "sin respuesta"}.`);
    }
  } finally {
    await owner.end();
  }
}

export async function createTestUser(options: TestUserOptions = {}): Promise<TestUser> {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const email = `it-${randomUUID()}@prueba.test`;
  const password = `P-${randomUUID()}`;

  const admin = createClient(url, env("SUPABASE_SECRET_KEY"), noSession);
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`No se pudo dar de alta a la persona de prueba: ${created.error?.message}`);
  }

  const visitor = createClient(url, env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), noSession);
  const signedIn = await visitor.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`La persona de prueba no pudo iniciar sesión: ${signedIn.error?.message}`);
  }

  if (options.claimed) await claimAccount(created.data.user.id);

  return { id: created.data.user.id, email, accessToken: signedIn.data.session.access_token };
}

/** Borra a la persona y su perfil. El perfil no se va solo: no cuelga de auth.users. */
export async function deleteTestUsers(users: readonly TestUser[]): Promise<void> {
  if (users.length === 0) return;
  const admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), noSession);
  for (const user of users) await admin.auth.admin.deleteUser(user.id);

  // Como dueño de la base: la aplicación no tiene permiso de borrar perfiles.
  const owner = new Client({ connectionString: env("DATABASE_URL_DIRECT") });
  await owner.connect();
  try {
    await owner.query("delete from public.profiles where id = any($1::uuid[])", [
      users.map((user) => user.id),
    ]);
  } finally {
    await owner.end();
  }
}

/** Una dirección de prueba nueva. Todas llevan el mismo prefijo, para poder barrerlas. */
export function testEmail(): string {
  return `it-${randomUUID()}@prueba.test`;
}

/** Una consulta como dueño de la base: para mirar o atrasar lo que la aplicación no puede. */
export async function ownerQuery<Row extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const owner = new Client({ connectionString: env("DATABASE_URL_DIRECT") });
  await owner.connect();
  try {
    const result = await owner.query<Row>(text, [...values]);
    return result.rows;
  } finally {
    await owner.end();
  }
}

/**
 * Borra las cuentas de prueba por su correo, con su perfil. Sirve para las que nacieron
 * por el registro, de las que la prueba no conoce el identificador.
 */
export async function deleteTestUsersByEmail(emails: readonly string[]): Promise<void> {
  if (emails.length === 0) return;
  const rows = await ownerQuery<{ id: string }>(
    "select id from auth.users where email = any($1::text[])",
    [emails.map((email) => email.toLowerCase())],
  );
  await deleteTestUsers(rows.map((row) => ({ id: row.id, email: "", accessToken: "" })));
}
