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

export async function createTestUser(): Promise<TestUser> {
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
