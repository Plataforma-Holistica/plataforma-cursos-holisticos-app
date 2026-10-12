import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { claimedUser } from "./helpers/account";
import { authAdmin, authVisitor, type KnownUser } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { totpCode } from "./helpers/totp";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La puerta del equipo (RF-105, RF-106; TRD §9.2, fila «Segundo factor»), contra lo que
// Supabase Auth escribe de verdad. Las pruebas de base (`12_puerta.test.sql`) rompen cada
// condición con filas puestas a mano; aquí las sesiones, los factores y las verificaciones
// los escribe Auth, que es de donde la puerta los lee.
//
// Lo que es del equipo (la capacidad, la atadura del factor) y la sesión anotada se ponen
// dentro de una transacción del dueño que se revierte: la auditoría no admite borrado, y
// las pruebas de base cuentan sus renglones. La pregunta se hace ahí mismo, por los dos
// caminos, con el rol y los ajustes que usa cada uno.

const emails: string[] = [];

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

interface Entered {
  person: KnownUser;
  client: SupabaseClient;
}

/** Una persona con su cuenta reclamada, que entró con su contraseña directo en Auth. */
async function entered(): Promise<Entered> {
  const person = await claimedUser();
  emails.push(person.email);
  const client = authVisitor();
  const signedIn = await client.auth.signInWithPassword({ email: person.email, password: person.password });
  if (signedIn.error) throw new Error(`La persona de prueba no entró: ${signedIn.error.code}`);
  return { person, client };
}

/** Da de alta un factor y lo verifica con esa misma sesión, que sube de nivel. */
async function verifiedFactor(client: SupabaseClient, name: string): Promise<string> {
  const factor = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: name });
  if (factor.error) throw new Error(`El factor de prueba no se dio de alta: ${factor.error.code}`);
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: factor.data.id, code: totpCode(factor.data.totp.secret) });
  if (verified.error) throw new Error(`El factor de prueba no se verificó: ${verified.error.code}`);
  return factor.data.id;
}

interface Token {
  /** Las claims del token, tal como las firmó Auth. */
  json: string;
  aal: string;
  sessionId: string;
}

/** El token de acceso que ese cliente tiene ahora mismo. */
async function tokenOf(client: SupabaseClient): Promise<Token> {
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("El cliente de prueba no tiene sesión.");
  const json = Buffer.from(data.session.access_token.split(".")[1] ?? "", "base64url").toString("utf8");
  const claims = JSON.parse(json) as { aal: string; session_id: string };
  return { json, aal: claims.aal, sessionId: claims.session_id };
}

interface Asked {
  /** Por el camino del usuario: `private.has_capability`, con su token. */
  user: boolean;
  /** Por el camino de servicio: `private.actor_has_capability`, con lo que declara el servidor. */
  service: boolean;
}

interface Setup {
  /** Qué factor queda atado a la persona. */
  bound: string;
  /** Si la aplicación anotó esa sesión. Por omisión, sí. */
  noted?: boolean;
  /** Algo más que cambiar antes de preguntar, como dueño. Recibe la sesión como `$1`. */
  tweak?: string;
}

/** ¿Pasa la puerta esa persona, con ese token? Con capacidad de configuración, y lo demás como diga `setup`. */
async function asks(person: KnownUser, token: Token, setup: Setup): Promise<Asked> {
  const owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  try {
    await owner.query("begin");
    await owner.query("grant app_service to postgres with set true, inherit false");
    await owner.query("select set_config('app.actor_kind', 'system', true)");
    await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'config')", [person.id]);
    await owner.query("insert into private.admin_factors (profile_id, factor_id) values ($1, $2)", [person.id, setup.bound]);
    await owner.query("select set_config('app.actor_kind', '', true)");
    if (setup.noted ?? true) {
      await owner.query("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [token.sessionId, person.id]);
    }
    if (setup.tweak) await owner.query(setup.tweak, [token.sessionId]);

    await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [token.json]);
    const user = await owner.query<{ passes: boolean }>("select private.has_capability('config') as passes");
    await owner.query("select set_config('role', 'none', true), set_config('request.jwt.claims', '', true)");

    await owner.query(
      "select set_config('app.actor_id', $1, true), set_config('app.actor_session', $2, true), set_config('role', 'app_service', true)",
      [person.id, token.sessionId],
    );
    const service = await owner.query<{ passes: boolean }>("select private.actor_has_capability('config') as passes");
    return { user: user.rows[0]?.passes === true, service: service.rows[0]?.passes === true };
  } finally {
    await owner.query("rollback").catch(() => undefined);
    await owner.end();
  }
}

const sessionsOf = (userId: string) =>
  ownerQuery<{ aal: string; factor: string | null }>(
    "select aal::text as aal, factor_id::text as factor from auth.sessions where user_id = $1",
    [userId],
  );

const PASSES: Asked = { user: true, service: true };
const STOPPED: Asked = { user: false, service: false };

describe("la puerta del equipo, contra una sesión de verdad", () => {
  it("pasa la sesión que Auth verificó con el factor atado, y solo esa", async () => {
    const { person, client } = await entered();

    // Con la contraseña sola no hay segundo nivel: no pasa, se le ate lo que se le ate.
    expect(await asks(person, await tokenOf(client), { bound: randomUUID() })).toEqual(STOPPED);

    const factor = await verifiedFactor(client, "el suyo");
    const token = await tokenOf(client);
    expect(token.aal).toBe("aal2");
    expect(await sessionsOf(person.id)).toEqual([{ aal: "aal2", factor }]);

    expect(await asks(person, token, { bound: factor })).toEqual(PASSES);
    // Con la sesión verificada, pero con otro factor atado: no es el suyo.
    expect(await asks(person, token, { bound: randomUUID() })).toEqual(STOPPED);
    // Una sesión que la aplicación no abrió no pasa, aunque Auth la tenga verificada.
    expect(await asks(person, token, { bound: factor, noted: false })).toEqual(STOPPED);
  });

  it("renovar el token no la tumba", async () => {
    const { person, client } = await entered();
    const factor = await verifiedFactor(client, "el suyo");

    const refreshed = await client.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(await asks(person, await tokenOf(client), { bound: factor })).toEqual(PASSES);
  });

  it("ni la rejuvenece: cuenta cuándo se dio el código, no cuándo se renovó el token", async () => {
    const { person, client } = await entered();
    const factor = await verifiedFactor(client, "el suyo");
    const before = await tokenOf(client);

    // La verificación se hace vieja de verdad, con la fila ya escrita por Auth. La cuenta
    // se borra al terminar, y sus filas de Auth con ella.
    await ownerQuery("update auth.mfa_amr_claims set updated_at = now() - interval '13 hours' where session_id = $1", [
      before.sessionId,
    ]);
    expect(await asks(person, before, { bound: factor })).toEqual(STOPPED);

    // Y después se renueva el token. Si Auth moviera esa hora al renovar, la ventana no se
    // cerraría nunca: aquí se vería.
    const refreshed = await client.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    const after = await tokenOf(client);
    expect(after.sessionId).toBe(before.sessionId);
    expect(await asks(person, after, { bound: factor })).toEqual(STOPPED);
  });

  it("quien cambia su factor llamando directo a Auth deja de pasar: el nuevo no es el atado", async () => {
    const { person, client } = await entered();
    const bound = await verifiedFactor(client, "el atado");
    expect(await asks(person, await tokenOf(client), { bound })).toEqual(PASSES);

    // Con su sesión verificada, borra su factor y da de alta otro, sin pasar por la aplicación.
    expect((await client.auth.mfa.unenroll({ factorId: bound })).error).toBeNull();
    const planted = await verifiedFactor(client, "el nuevo");
    const token = await tokenOf(client);
    // Para Auth todo está en orden: la misma cuenta, en segundo nivel, con su factor nuevo.
    expect(token.aal).toBe("aal2");
    expect(await sessionsOf(person.id)).toEqual([{ aal: "aal2", factor: planted }]);

    expect(await asks(person, token, { bound })).toEqual(STOPPED);
  });

  it("con dos factores verificados, pasa solo la sesión que se verificó con el atado", async () => {
    const { person, client } = await entered();
    const bound = await verifiedFactor(client, "el atado");
    // Con su sesión verificada da de alta un segundo factor, sin borrar el primero, y lo
    // verifica: Auth anota en la sesión el último con el que se verificó.
    const second = await verifiedFactor(client, "el segundo");
    const token = await tokenOf(client);
    expect(await sessionsOf(person.id)).toEqual([{ aal: "aal2", factor: second }]);

    // El atado sigue existiendo y verificado, pero esta sesión no se verificó con él.
    expect(await asks(person, token, { bound })).toEqual(STOPPED);
    expect(await asks(person, token, { bound: second })).toEqual(PASSES);
  });

  it("si le borran el factor por administración, su token sigue diciendo segundo nivel y ya no pasa", async () => {
    const { person, client } = await entered();
    const factor = await verifiedFactor(client, "el suyo");
    const token = await tokenOf(client);
    expect(await asks(person, token, { bound: factor })).toEqual(PASSES);

    const deleted = await authAdmin().auth.admin.mfa.deleteFactor({ id: factor, userId: person.id });
    expect(deleted.error).toBeNull();

    // El token ya emitido no cambió: sigue diciendo `aal2` hasta que venza.
    expect(token.aal).toBe("aal2");
    expect(await asks(person, token, { bound: factor })).toEqual(STOPPED);
  });
});
