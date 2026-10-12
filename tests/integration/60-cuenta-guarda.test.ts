import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAuth, signIn as authSignIn, readSession } from "@/adapters/supabase/auth";
import { decodeSessionCookie, encodeSessionCookie } from "@/adapters/supabase/auth-cookies";
import { asServer, asSystem, type Tx } from "@/adapters/supabase/db";
import { IdentityUnavailableError } from "@/adapters/supabase/errors";
import { sql } from "@/adapters/supabase/sql";
import { evaluateGate } from "@/services/account/gate";
import { noteSession } from "@/services/account/store";

import { claimedUser, clearThrottle, freshOrigin, notedSessions, testServices } from "./helpers/account";
import {
  authAdmin,
  failingFetch,
  knownUser,
  memoryJar,
  networkDown,
  sessionCount,
  type KnownUser,
  type MemoryJar,
} from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La guarda de sesión aplicada (TRD §9.2, fila «Lo que entra sin pasar por el formulario»,
// y §9.3). Corre en cada entrada con sesión, y además de lo que decide el dominio comprueba
// en la base que la sesión sea de las que abrió la aplicación y que siga viva en Auth.

const MINUTE = 60_000;
const COOKIE = "plataforma-sesion";
const emails: string[] = [];

async function user(options: { complete?: boolean } = {}): Promise<KnownUser> {
  const created = await claimedUser();
  emails.push(created.email);
  if (options.complete) await completeAccountAsOwner(created.id);
  return created;
}

/** Una persona que ya entró por el servicio, con su cookie en un tarro. */
async function entered(options: { complete?: boolean } = {}): Promise<{ account: KnownUser; jar: MemoryJar }> {
  const account = await user(options);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, account, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return { account, jar };
}

class Revert extends Error {}

/** Corre `work` como sistema y lo revierte todo al final. */
async function reverted<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  let outcome: { value: T } | undefined;
  await expect(
    asSystem({ reason: "prueba" }, async (tx) => {
      outcome = { value: await work(tx) };
      throw new Revert();
    }),
  ).rejects.toBeInstanceOf(Revert);
  if (!outcome) throw new Error("la transacción no llegó al final");
  return outcome.value;
}

beforeEach(async () => {
  await clearThrottle();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("quién pasa", () => {
  it("sin cookie no hay sesión", async () => {
    expect(await testServices().checkSession(memoryJar())).toEqual({ kind: "anonymous" });
  });

  it("el correo de la sesión es el de la cuenta que entró, y sin sesión no hay correo", async () => {
    const { account, jar } = await entered({ complete: true });
    expect(await testServices().sessionEmail(jar)).toBe(account.email);
    expect(await testServices().sessionEmail(memoryJar())).toBeNull();
    // Una cookie que no se entiende no dice de quién es.
    const malformed = memoryJar(new Map([[COOKIE, "v1.a.b.c.cg"]]));
    expect(await testServices().sessionEmail(malformed)).toBeNull();
  });

  it("el correo de un token al que le cambiaron el cuerpo no se muestra: primero se verifica la firma", async () => {
    const { jar } = await entered({ complete: true });
    const tokens = decodeSessionCookie(jar.get(COOKIE) ?? "");
    if (!tokens) throw new Error("La cookie de prueba no se entiende.");
    const [header = "", payload = "", signature = ""] = tokens.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const altered = Buffer.from(JSON.stringify({ ...claims, email: "otra-persona@prueba.test" })).toString("base64url");
    const forged = encodeSessionCookie({ ...tokens, accessToken: `${header}.${altered}.${signature}` });
    if (!forged) throw new Error("No se pudo armar la cookie alterada.");

    const services = testServices();
    expect(await services.sessionEmail(memoryJar(new Map([[COOKIE, forged]])))).toBeNull();
    expect(await services.checkSession(memoryJar(new Map([[COOKIE, forged]])))).toEqual({ kind: "anonymous" });
  });

  it("cerrar lo que la guarda rechaza no le cierra la sesión a quien sí pasa", async () => {
    const { account, jar } = await entered({ complete: true });
    const services = testServices();
    expect(await services.closeRejectedSession(jar)).toBe("kept");
    expect(jar.get(COOKIE)).toBeDefined();
    expect(await sessionCount(account.id)).toBe(1);
    expect(await services.checkSession(jar)).toMatchObject({ kind: "pass" });

    // Tampoco a quien le falta completar la cuenta: esa sesión sí vale.
    const pending = await entered();
    expect(await services.closeRejectedSession(pending.jar)).toBe("kept");
    expect(await sessionCount(pending.account.id)).toBe(1);
    expect(services.reported).toEqual([]);
  });

  it("sin sesión no hay nada que cerrar", async () => {
    const jar = memoryJar();
    expect(await testServices().closeRejectedSession(jar)).toBe("none");
    expect(jar.writes).toEqual([]);
  });

  it("una sesión que la aplicación no abrió se cierra: la cookie se borra y Auth la da por terminada", async () => {
    const account = await user({ complete: true });
    const direct = memoryJar();
    expect((await createAuth().signIn(direct, account.email, account.password)).ok).toBe(true);
    expect(await sessionCount(account.id)).toBe(1);

    const services = testServices();
    expect(await services.closeRejectedSession(direct)).toBe("sign_in");
    expect(direct.get(COOKIE)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);
    expect(services.reported).toEqual([]);
  });

  it("una sesión anotada de una cuenta con la marca de contraseña prendida se cierra, y se le manda a recuperar", async () => {
    // No debería existir: una sesión solo se anota con la marca apagada. Es la segunda
    // capa: si algún día existe, no entra. Se arma como dueño de la base.
    const account = await knownUser();
    emails.push(account.email);
    const flagged = await ownerQuery<{ pending: boolean }>(
      "select password_reset_required as pending from public.profiles where id = $1",
      [account.id],
    );
    const jar = memoryJar();
    expect((await createAuth().signIn(jar, account.email, account.password)).ok).toBe(true);
    const read = await readSession(jar);
    if (read.kind !== "session" || read.claims.sessionId === null) throw new Error("La sesión de prueba no se leyó.");
    await ownerQuery("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [
      read.claims.sessionId,
      account.id,
    ]);

    const services = testServices();
    // Una cuenta que nunca canjeó un enlace de su buzón nace con la marca prendida.
    expect(flagged[0]?.pending).toBe(true);
    expect(await services.checkSession(jar)).toEqual({ kind: "must_sign_out", then: "recover" });
    expect(await services.closeRejectedSession(jar)).toBe("recover");
    expect(jar.get(COOKIE)).toBeUndefined();
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("si Auth no deja cerrarla, la cookie se borra igual y se reporta", async () => {
    const account = await user({ complete: true });
    const direct = memoryJar();
    expect((await createAuth().signIn(direct, account.email, account.password)).ok).toBe(true);

    const services = testServices({ auth: createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch }) });
    expect(await services.closeRejectedSession(direct)).toBe("sign_in");
    expect(direct.get(COOKIE)).toBeUndefined();
    expect(services.reported).toEqual(["session_not_closed"]);
  });

  it("cuando no se supo si la sesión vale, no se cierra", async () => {
    const { account, jar } = await entered({ complete: true });
    const real = createAuth();
    const services = testServices({
      auth: { ...real, readSession: () => Promise.resolve({ kind: "unknown" }) },
    });
    expect(await services.closeRejectedSession(jar)).toBe("kept");
    expect(jar.get(COOKIE)).toBeDefined();
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("«Salir» que Auth no pudo cerrar se reporta", async () => {
    const { jar } = await entered({ complete: true });
    const services = testServices({ auth: createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch }) });
    expect(await services.signOut(jar)).toBe("unknown");
    expect(jar.get(COOKIE)).toBeUndefined();
    expect(services.reported).toEqual(["session_not_closed"]);
  });

  it("una cuenta completa que entró por el servicio pasa", async () => {
    const { account, jar } = await entered({ complete: true });
    const checked = await testServices().checkSession(jar);
    expect(checked).toMatchObject({ kind: "pass", claims: { userId: account.id } });
  });

  it("a una cuenta reclamada pero sin completar le dice exactamente qué le falta", async () => {
    const { account, jar } = await entered();
    expect(await testServices().checkSession(jar)).toEqual({
      kind: "incomplete",
      claims: expect.objectContaining({ userId: account.id }),
      variant: "complete_account",
      missing: {
        name: true,
        adultDeclaration: true,
        documents: [
          { docType: "terms", why: "never_given" },
          { docType: "student_privacy_notice", why: "never_given" },
          { docType: "course_history_consent", why: "never_given" },
        ],
      },
    });
  });

  it("un consentimiento retirado vuelve a faltar", async () => {
    const { account, jar } = await entered({ complete: true });
    await ownerQuery(
      `with actor as (select set_config('app.actor_id', $1, true))
       insert into public.consents (profile_id, legal_document_id, action, origin)
       select $1::uuid, private.current_legal_document('course_history_consent'), 'withdrawn', 'account_settings'
       from actor`,
      [account.id],
    );
    expect(await testServices().checkSession(jar)).toMatchObject({
      kind: "incomplete",
      variant: "complete_account",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "course_history_consent", why: "withdrawn" }] },
    });
  });
});

describe("el último consentimiento, cuando dos empatan", () => {
  // La hora de un consentimiento es la de su transacción: dos del mismo texto escritos en
  // una sola quedan con la misma. Ante el empate manda el retiro, que es lo que no deja pasar.
  it("otorgado y retirado en la misma transacción: cuenta como retirado", async () => {
    const { account, jar } = await entered({ complete: true });
    await ownerQuery(
      `with actor as (select set_config('app.actor_id', $1, true)),
       retirado as (
         insert into public.consents (profile_id, legal_document_id, action, origin)
         select $1::uuid, private.current_legal_document('terms'), 'withdrawn', 'account_settings' from actor
         returning 1)
       insert into public.consents (profile_id, legal_document_id, action, origin)
       select $1::uuid, private.current_legal_document('terms'), 'granted', 'account_settings' from actor`,
      [account.id],
    );
    expect(await testServices().checkSession(jar)).toMatchObject({
      kind: "incomplete",
      missing: { documents: [{ docType: "terms", why: "withdrawn" }] },
    });
  });
});

describe("solo las sesiones que abrió la aplicación", () => {
  // Con la llave publicable, que es pública, cualquiera le pide una sesión directo a Auth.
  it("una sesión abierta directo en Auth, con la contraseña correcta, no pasa", async () => {
    const account = await user({ complete: true });
    const direct = memoryJar();
    expect((await authSignIn(direct, account.email, account.password)).ok).toBe(true);
    // Para Auth es una sesión como cualquier otra, y su token verifica.
    expect((await readSession(direct)).kind).toBe("session");

    expect(await testServices().checkSession(direct)).toEqual({ kind: "must_sign_out", then: "sign_in" });
  });

  it("tras salir, una copia de la cookie no pasa aunque su token siga verificando", async () => {
    const { jar } = await entered({ complete: true });
    const kept = jar.copy();
    expect(await testServices().signOut(jar)).toBe("closed");

    expect((await readSession(kept)).kind).toBe("session");
    expect(await testServices().checkSession(kept)).toEqual({ kind: "must_sign_out", then: "sign_in" });
  });

  it("tras cambiar la contraseña por administración, la cookie de antes no pasa", async () => {
    const { account, jar } = await entered({ complete: true });
    await authAdmin().auth.admin.updateUserById(account.id, { password: "otra-contraseña-larga" });
    expect(await sessionCount(account.id)).toBe(0);

    expect((await readSession(jar)).kind).toBe("session");
    expect(await testServices().checkSession(jar)).toEqual({ kind: "must_sign_out", then: "sign_in" });
  });

  it("renovar la sesión no rompe el reconocimiento: es la misma sesión", async () => {
    const { account, jar } = await entered({ complete: true });
    const before = jar.get("plataforma-sesion");
    const renewed = await createAuth({ now: () => Date.now() + 14 * MINUTE }).refreshSession(jar);
    expect(renewed.kind).toBe("session");
    expect(jar.get("plataforma-sesion")).not.toBe(before);

    expect(await testServices().checkSession(jar)).toMatchObject({ kind: "pass", claims: { userId: account.id } });
  });

  it("la sesión de una persona no sirve con la cuenta de otra", async () => {
    const first = await entered({ complete: true });
    const second = await entered({ complete: true });
    const one = await testServices().checkSession(first.jar);
    const other = await testServices().checkSession(second.jar);
    expect(one).toMatchObject({ kind: "pass", claims: { userId: first.account.id } });
    expect(other).toMatchObject({ kind: "pass", claims: { userId: second.account.id } });
  });

  // Un token que verifica pero no dice de qué sesión es no se puede reconocer: se cierra,
  // sin llegar a la base.
  it("un token sin identificador de sesión, o con uno sin forma, no pasa", async () => {
    const { jar } = await entered({ complete: true });
    const real = createAuth();
    for (const sessionId of [null, "no-es-un-identificador"]) {
      const services = testServices({
        auth: {
          ...real,
          readSession: async (reader) => {
            const read = await real.readSession(reader);
            return read.kind === "session" ? { ...read, claims: { ...read.claims, sessionId } } : read;
          },
        },
      });
      expect(await services.checkSession(jar)).toEqual({ kind: "must_sign_out", then: "sign_in" });
      expect(services.reported).toEqual([]);
    }
  });
});

describe("reclamar y anotar a la vez", () => {
  const stateRow = z.object({ state: z.string() });

  // El orden lo da el candado del perfil, que toman las dos funciones. Aquí el reclamo se
  // queda abierto, sin confirmar; la anotación de una entrada que empezó antes tiene que
  // esperarlo y, al seguir, ver su fecha.
  it("la anotación espera al reclamo en curso y ve su fecha: la entrada vieja no se anota", async () => {
    const account = await user({ complete: true });
    const direct = await authSignIn(memoryJar(), account.email, account.password);
    if (!direct.ok || !direct.claims.sessionId) throw new Error("La persona de prueba no entró a Auth.");
    const { claims } = direct;
    const sessionId = direct.claims.sessionId;
    const [clock] = await ownerQuery<{ started: string }>("select clock_timestamp()::text as started");
    if (!clock) throw new Error("La base no devolvió su hora.");

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reach: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const claiming = asServer({ claims, reason: "prueba" }, async (tx) => {
      const [row] = await tx.query(sql`select private.claim_account() as state`, stateRow);
      reach();
      await held;
      return row?.state;
    });
    await reached;

    let settled = false;
    const noting = asServer({ claims, reason: "prueba" }, (tx) => noteSession(tx, sessionId, clock.started)).finally(
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const waited = !settled;

    // Pase lo que pase, el reclamo se suelta: si no, se quedaría abierto hasta vencer.
    release();
    expect(await claiming).toBe("already_claimed");
    // Lo que prueba el orden: la anotación vio la fecha que el reclamo confirmó.
    expect(await noting).toBe("stale");
    expect(waited).toBe(true);
    expect(await notedSessions(account.id)).toBe(0);
  });

  // Ese orden supone que cada sentencia ve lo ya confirmado. Con una foto fija de la base,
  // las dos funciones se niegan a correr.
  it.each([
    ["anotar", "select private.note_session(gen_random_uuid(), clock_timestamp())"],
    ["reclamar", "select private.claim_account()"],
    ["cerrar una sesión", "select private.close_session(gen_random_uuid(), gen_random_uuid())"],
    ["cerrar las demás", "select private.close_other_sessions(gen_random_uuid())"],
    ["fechar un cambio de contraseña", "select private.note_password_change()"],
  ])("con un aislamiento que no es el de siempre, %s lanza", async (_name, call) => {
    const account = await user();
    const owner = new Client({ connectionString: localOwnerUrl() });
    await owner.connect();
    try {
      await owner.query("begin isolation level repeatable read");
      await owner.query("select set_config('app.actor_id', $1, true)", [account.id]);
      await expect(owner.query(call)).rejects.toMatchObject({ code: "25000" });
    } finally {
      await owner.query("rollback").catch(() => undefined);
      await owner.end();
    }
  });
});

describe("la cuenta dejó de poder entrar", () => {
  it("sin perfil: la sesión se cierra", async () => {
    const { account, jar } = await entered();
    await ownerQuery("delete from public.profiles where id = $1", [account.id]);
    expect(await testServices().checkSession(jar)).toEqual({ kind: "must_sign_out", then: "sign_in" });
  });
});

describe("cuando no se puede saber", () => {
  it("con el token vencido no es «sin sesión»: no se supo", async () => {
    const { jar } = await entered({ complete: true });
    const later = testServices({ auth: createAuth({ now: () => Date.now() + 16 * MINUTE }) });
    expect(await later.checkSession(jar)).toEqual({ kind: "unavailable" });
  });

  it("sin las claves públicas a la mano, no se supo", async () => {
    const { jar } = await entered({ complete: true });
    const blind = testServices({
      auth: createAuth({ inspectToken: () => Promise.reject(new IdentityUnavailableError()) }),
    });
    expect(await blind.checkSession(jar)).toEqual({ kind: "unavailable" });
  });

  it("si la base no deja leer, no se supo, y se reporta", async () => {
    const { jar } = await entered({ complete: true });
    const real = createAuth();
    // Las claims vencen entre leer la cookie y abrir la transacción: la base las rechaza.
    const services = testServices({
      auth: {
        ...real,
        readSession: async (reader) => {
          const read = await real.readSession(reader);
          const now = Date.now.bind(Date);
          vi.spyOn(Date, "now").mockImplementation(() => now() + 60 * MINUTE);
          return read;
        },
      },
    });
    expect(await services.checkSession(jar)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["gate_unavailable"]);
  });

  // Fuera de local un borrador (versión 0) no es un texto vigente: sin texto no hay
  // consentimiento válido, nadie entra, y eso es un fallo de operación.
  it("fuera de local, un texto que solo existe como borrador deja la guarda sin poder decidir", async () => {
    const { jar } = await entered({ complete: true });
    const staging = testServices({ isLocal: () => false });
    expect(await staging.checkSession(jar)).toEqual({ kind: "unavailable" });
    expect(staging.reported).toEqual(["gate_no_current_text"]);
  });
});

describe("los hechos de los textos, leídos de la base", () => {
  // Publicar una versión no se puede deshacer: se hace dentro de una transacción que se
  // revierte, y ahí mismo se le pregunta a la guarda.
  const publish = (tx: Tx, requiresReconsent: boolean) =>
    tx.execute(sql`
      insert into public.legal_documents (doc_type, version, title, body, effective_from, requires_reconsent)
      values ('terms', 1, 'Términos', 'Texto publicado', now(), ${requiresReconsent})`);

  // Una versión se puede publicar con fecha: mientras no rija, no le pide nada a nadie.
  it("una versión que todavía no rige no pide volver a aceptar, aunque lo vaya a pedir", async () => {
    const account = await user({ complete: true });
    const view = await reverted(async (tx) => {
      await tx.execute(sql`
        insert into public.legal_documents (doc_type, version, title, body, effective_from, requires_reconsent)
        values ('terms', 1, 'Términos', 'Texto por venir', now() + interval '1 day', true)`);
      return evaluateGate(tx, account.id, true);
    });
    expect(view).toEqual({ kind: "pass" });
  });

  it("una versión nueva que pide volver a aceptar se le presenta como texto actualizado", async () => {
    const account = await user({ complete: true });
    const view = await reverted(async (tx) => {
      await publish(tx, true);
      return evaluateGate(tx, account.id, true);
    });
    expect(view).toEqual({
      kind: "incomplete",
      variant: "updated_texts",
      missing: { name: false, adultDeclaration: false, documents: [{ docType: "terms", why: "new_version" }] },
    });
  });

  it("una versión nueva que no lo pide no detiene a nadie", async () => {
    const account = await user({ complete: true });
    const view = await reverted(async (tx) => {
      await publish(tx, false);
      return evaluateGate(tx, account.id, true);
    });
    expect(view).toEqual({ kind: "pass" });
  });

  it("con una versión publicada, el texto vigente ya no es un borrador ni fuera de local", async () => {
    const account = await user({ complete: true });
    const view = await reverted(async (tx) => {
      await publish(tx, false);
      return evaluateGate(tx, account.id, false);
    });
    // Los otros dos tipos siguen siendo borradores: fuera de local, esos faltan.
    expect(view).toEqual({ kind: "unavailable", reason: "no_current_text" });
  });

  it("una cuenta con la marca prendida va a recuperar, tenga lo que tenga", async () => {
    const id = randomUUID();
    const view = await reverted(async (tx) => {
      await tx.execute(sql`insert into public.profiles (id, display_name) values (${id}, 'Sin reclamar')`);
      return evaluateGate(tx, id, true);
    });
    expect(view).toEqual({ kind: "must_recover" });
  });

  // Suspender deja un renglón de auditoría, que no se borra: se hace y se pregunta dentro
  // de la misma transacción revertida.
  it("una cuenta suspendida ve el aviso de cuenta suspendida, antes que cualquier otra cosa", async () => {
    const account = await user();
    const view = await reverted(async (tx) => {
      await tx.execute(sql`
        update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba'
        where id = ${account.id}`);
      return evaluateGate(tx, account.id, true);
    });
    expect(view).toEqual({ kind: "suspended" });
  });

  it("un perfil que no existe no es nadie", async () => {
    const view = await reverted((tx) => evaluateGate(tx, "a0000000-0000-4000-8000-0000000000ff", true));
    expect(view).toEqual({ kind: "gone" });
  });
});
