import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAuth, signIn as authSignIn, readSession } from "@/adapters/supabase/auth";
import { asSystem, type Tx } from "@/adapters/supabase/db";
import { IdentityUnavailableError } from "@/adapters/supabase/errors";
import { sql } from "@/adapters/supabase/sql";
import { evaluateGate } from "@/services/account/gate";

import { claimedUser, clearThrottle, freshOrigin, testServices } from "./helpers/account";
import { authAdmin, memoryJar, sessionCount, type KnownUser, type MemoryJar } from "./helpers/auth";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La guarda de sesión aplicada (TRD §9.2, fila «Lo que entra sin pasar por el formulario»,
// y §9.3). Corre en cada entrada con sesión, y además de lo que decide el dominio comprueba
// en la base que la sesión sea de las que abrió la aplicación y que siga viva en Auth.

const MINUTE = 60_000;
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
    const staging = testServices({ draftsAllowed: () => false });
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
