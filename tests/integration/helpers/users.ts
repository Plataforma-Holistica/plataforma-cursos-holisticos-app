import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

import { localOwnerUrl } from "./local";

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
// pruebas para no pasar por el correo. De paso deja escrita la fecha desde la que vale su
// contraseña, sin la cual la aplicación no le anota sesiones.
export async function claimAccount(id: string): Promise<void> {
  const owner = new Client({ connectionString: localOwnerUrl() });
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

// Todas las personas de prueba nacen con un correo de esta forma (`testEmail`).
const TEST_EMAIL = "^it-[^@]+@prueba[.]test$";

/**
 * Borra a la persona y su perfil. El perfil no se va solo: no cuelga de auth.users.
 *
 * Solo contra la pila local, y solo a quien tiene correo de prueba: si alguno de los
 * identificadores es de otra persona, no borra a nadie.
 */
export async function deleteTestUsers(users: readonly TestUser[]): Promise<void> {
  if (users.length === 0) return;
  const ownerUrl = localOwnerUrl();
  const ids = users.map((user) => user.id);
  const strangers = await ownerQuery<{ id: string }>(
    "select id::text as id from auth.users where id = any($1::uuid[]) and (email is null or email !~ $2)",
    [ids, TEST_EMAIL],
  );
  if (strangers.length > 0) {
    throw new Error("La limpieza de las pruebas solo borra personas de prueba (it-…@prueba.test).");
  }

  const admin = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), noSession);
  for (const user of users) await admin.auth.admin.deleteUser(user.id);

  // Como dueño de la base: la aplicación no tiene permiso de borrar perfiles.
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query("begin");
    // Un consentimiento es un libro: no se borra ni como dueño, y cuelga de `profiles`. Para
    // no dejar residuo, y solo aquí, se desactiva su guardián dentro de la transacción. Solo
    // corre contra la base local y solo toca a las personas de prueba; una prueba de base
    // (05_legal) exige que el guardián esté habilitado.
    const consented = await owner.query(
      "select 1 from public.consents where profile_id = any($1::uuid[]) limit 1",
      [ids],
    );
    if ((consented.rowCount ?? 0) > 0) {
      await owner.query("alter table public.consents disable trigger consents_guard");
      await owner.query("delete from public.consents where profile_id = any($1::uuid[])", [ids]);
      await owner.query("alter table public.consents enable trigger consents_guard");
    }
    // Los cobros y sus partes también son libros (T-301), y cuelgan del perfil y de la
    // suscripción: igual que con los consentimientos, se apagan sus guardias dentro de esta
    // transacción, solo para las personas de prueba. El vigilante (`schema_violations_revenue`)
    // exige que queden prendidas.
    const charged = await owner.query("select 1 from public.charges where profile_id = any($1::uuid[]) limit 1", [ids]);
    if ((charged.rowCount ?? 0) > 0) {
      await owner.query("alter table public.revenue_allocations disable trigger ledger_no_update_delete");
      await owner.query("alter table public.charges disable trigger ledger_no_update_delete");
      await owner.query("delete from public.revenue_allocations where profile_id = any($1::uuid[])", [ids]);
      await owner.query("delete from public.charges where profile_id = any($1::uuid[])", [ids]);
      await owner.query("alter table public.charges enable trigger ledger_no_update_delete");
      await owner.query("alter table public.revenue_allocations enable trigger ledger_no_update_delete");
      await owner.query("delete from public.subscriptions where profile_id = any($1::uuid[])", [ids]);
    }
    await owner.query("delete from public.profiles where id = any($1::uuid[])", [ids]);
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}

/**
 * Deja la cuenta completa, como quien terminó su registro: nombre, edad declarada y los
 * tres consentimientos sobre los textos vigentes. Como dueño, declarando por quién actúa.
 */
export async function completeAccountAsOwner(id: string, name = "Persona de prueba"): Promise<void> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  try {
    await owner.query("begin");
    await owner.query("select set_config('app.actor_id', $1, true)", [id]);
    await owner.query("update public.profiles set display_name = $2, adult_declared_at = now() where id = $1", [
      id,
      name,
    ]);
    const inserted = await owner.query(
      `insert into public.consents (profile_id, legal_document_id, origin)
       select $1, private.current_legal_document(t.doc_type), 'signup'
       from unnest(array['terms', 'student_privacy_notice', 'course_history_consent']::public.legal_doc_type[]) as t (doc_type)`,
      [id],
    );
    await owner.query("commit");
    if (inserted.rowCount !== 3) throw new Error("No se guardaron los tres consentimientos de prueba.");
  } catch (error) {
    await owner.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}

/** Una dirección de prueba nueva. Todas llevan el mismo prefijo, para poder barrerlas. */
export function testEmail(): string {
  return `it-${randomUUID()}@prueba.test`;
}

/**
 * Una consulta como dueño de la base: para mirar o atrasar lo que la aplicación no puede.
 * Solo contra la base local.
 */
export async function ownerQuery<Row extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const owner = new Client({ connectionString: localOwnerUrl() });
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
