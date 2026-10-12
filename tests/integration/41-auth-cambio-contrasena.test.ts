import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  changeProvenPassword,
  closeAllWithProof,
  createAuth,
  discardProof,
  provePassword,
  signIn,
  type ProvenPassword,
} from "@/adapters/supabase/auth";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@/domain/access/password-policy";

import {
  authVisitor,
  failingFetch,
  knownUser,
  memoryJar,
  networkDown,
  sessionCount,
  tooManyRequests,
  type KnownUser,
} from "./helpers/auth";
import { lastMailTo, mailsTo } from "./helpers/mailbox";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// El adaptador de Auth, contra el Auth local: comprobar la contraseña actual de una cuenta
// y cambiarla con esa comprobación (TRD §9.2, fila «Cambio de contraseña desde la cuenta»).
// Auth no pide la contraseña actual para fijar otra: la única manera de cambiarla aquí es
// con la prueba de haber entrado recién con ella.

const emails: string[] = [];
const CHANGED = "Tu contraseña cambió";

async function user(options: { confirmed?: boolean } = {}): Promise<KnownUser> {
  const created = await knownUser(options);
  emails.push(created.email);
  return created;
}

const password = () => `P-${randomUUID()}`;

/** Otra sesión de esa cuenta, abierta por fuera: la de otro navegador. */
async function elsewhere(account: KnownUser): Promise<void> {
  const opened = await authVisitor().auth.signInWithPassword({ email: account.email, password: account.password });
  if (opened.error) throw new Error("La sesión de prueba no se abrió.");
}

async function proved(account: KnownUser): Promise<ProvenPassword> {
  const proof = await provePassword(account.email, account.password);
  if (!proof.ok) throw new Error(`La contraseña de prueba no se comprobó: ${proof.reason}`);
  return proof.proven;
}

const entersWith = async (account: KnownUser, secret: string) => (await signIn(memoryJar(), account.email, secret)).ok;

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("comprobar la contraseña actual", () => {
  it("con la contraseña correcta: da las claims de esa cuenta y deja una sesión que no llega a ningún navegador", async () => {
    const account = await user();
    const proof = await provePassword(account.email, account.password);
    expect(proof).toMatchObject({ ok: true, claims: { userId: account.id, aal: "aal1" } });
    if (!proof.ok) return;
    // Las claims de la prueba son las mismas que lleva por fuera, para que la guarda la admita.
    expect(proof.proven.claims).toBe(proof.claims);
    expect(await sessionCount(account.id)).toBe(1);
  });

  it.each([
    ["con otra contraseña", (account: KnownUser) => provePassword(account.email, "no-es-la-suya-1")],
    ["con un correo que no tiene cuenta", () => provePassword(`it-${randomUUID()}@prueba.test`, "da-igual-cual-1")],
  ])("%s: no acertó, y no queda ninguna sesión", async (_case, attempt) => {
    const account = await user();
    expect(await attempt(account)).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("una cuenta sin confirmar contesta lo suyo, como al entrar", async () => {
    const account = await user({ confirmed: false });
    expect(await provePassword(account.email, account.password)).toEqual({ ok: false, reason: "email_not_confirmed" });
  });

  it("sin respuesta de Auth, no se supo", async () => {
    const account = await user();
    const down = createAuth({ fetch: failingFetch(/\/token/, networkDown).fetch });
    expect(await down.provePassword(account.email, account.password)).toEqual({ ok: false, reason: "unknown" });
  });

  it("si la sesión que abre no se puede verificar, no sirve de prueba y se cierra", async () => {
    const account = await user();
    const blind = createAuth({ inspectToken: () => Promise.resolve({ state: "invalid" }) });
    expect(await blind.provePassword(account.email, account.password)).toEqual({ ok: false, reason: "unknown" });
    expect(await sessionCount(account.id)).toBe(0);
  });
});

describe("cambiar la contraseña con esa prueba", () => {
  it("la guarda, manda el aviso y cierra las demás sesiones; la de la prueba sigue hasta que se cierra", async () => {
    const account = await user();
    await elsewhere(account);
    await elsewhere(account);
    const proven = await proved(account);
    expect(await sessionCount(account.id)).toBe(3);

    const chosen = password();
    expect(await changeProvenPassword(proven, chosen)).toBe("ok");

    // Auth cerró las otras dos y dejó la de la prueba.
    expect(await sessionCount(account.id)).toBe(1);
    expect((await lastMailTo(account.email)).subject).toBe(CHANGED);
    expect(await entersWith(account, account.password)).toBe(false);
    expect(await entersWith(account, chosen)).toBe(true);

    // Cerrar la de la prueba no toca la sesión que acaba de entrar con la nueva.
    expect(await discardProof(proven)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(1);
  });

  it("una prueba alcanza para un solo intento", async () => {
    const account = await user();
    const proven = await proved(account);
    const first = password();
    expect(await changeProvenPassword(proven, first)).toBe("ok");
    expect(await changeProvenPassword(proven, password())).toBe("rejected");
    expect(await entersWith(account, first)).toBe(true);
  });

  it("no acepta un objeto con la forma de una prueba, armado en otro lado", async () => {
    const account = await user();
    const real = await proved(account);
    const forged = { claims: real.claims } as unknown as ProvenPassword;
    expect(await changeProvenPassword(forged, password())).toBe("rejected");
    expect(await discardProof(forged)).toBe("unknown");
    expect(await closeAllWithProof(forged)).toBe("unknown");
    expect(await entersWith(account, account.password)).toBe(true);
  });

  it("con la contraseña que ya tenía no cambia nada: ni cierra las demás sesiones ni manda el aviso", async () => {
    const account = await user();
    await elsewhere(account);
    const proven = await proved(account);
    expect(await changeProvenPassword(proven, account.password)).toBe("same_password");
    // No hay segundo camino por administración: las sesiones siguen como estaban.
    expect(await sessionCount(account.id)).toBe(2);
    // Un correo de control, y después se mira: el aviso no salió.
    const other = await user();
    expect(await changeProvenPassword(await proved(other), password())).toBe("ok");
    expect((await lastMailTo(other.email)).subject).toBe(CHANGED);
    expect(await mailsTo(account.email)).toEqual([]);
  });

  it("una contraseña más corta que el mínimo es débil, y una de más de 72 bytes se rechaza", async () => {
    const account = await user();
    expect(await changeProvenPassword(await proved(account), "a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe("weak_password");
    expect(await changeProvenPassword(await proved(account), "a".repeat(PASSWORD_MAX_BYTES + 1))).toBe("rejected");
    expect(await entersWith(account, account.password)).toBe(true);
  });

  it("sin respuesta de Auth, no se supo", async () => {
    const account = await user();
    const slow = createAuth({ fetch: failingFetch(/\/auth\/v1\/user$/, networkDown).fetch });
    const proof = await slow.provePassword(account.email, account.password);
    if (!proof.ok) throw new Error("La contraseña de prueba no se comprobó.");
    expect(await slow.changeProvenPassword(proof.proven, password())).toBe("unknown");
    expect(await entersWith(account, account.password)).toBe(true);
  });

  // Un límite de peticiones Auth lo contesta antes de tocar nada: se sabe que no cambió.
  it("con el límite de peticiones de Auth, se rechaza: no es «no se supo»", async () => {
    const account = await user();
    const limited = createAuth({ fetch: failingFetch(/\/auth\/v1\/user$/, tooManyRequests).fetch });
    const proof = await limited.provePassword(account.email, account.password);
    if (!proof.ok) throw new Error("La contraseña de prueba no se comprobó.");
    expect(await limited.changeProvenPassword(proof.proven, password())).toBe("rejected");
    expect(await entersWith(account, account.password)).toBe(true);
  });

  // Auth pide volver a identificarse a una sesión de más de un día. Una prueba siempre es
  // de ahora: si llegara a tener esa edad, no cambia nada.
  it("una prueba envejecida no cambia la contraseña", async () => {
    const account = await user();
    const proven = await proved(account);
    await ownerQuery("update auth.sessions set created_at = now() - interval '25 hours' where user_id = $1", [account.id]);
    expect(await changeProvenPassword(proven, password())).toBe("rejected");
    expect(await entersWith(account, account.password)).toBe(true);
  });
});

describe("cerrar la sesión de la prueba", () => {
  it("descartarla cierra solo esa sesión, y ya no cambia ninguna contraseña", async () => {
    const account = await user();
    await elsewhere(account);
    const proven = await proved(account);
    expect(await sessionCount(account.id)).toBe(2);

    expect(await discardProof(proven)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(1);
    expect(await changeProvenPassword(proven, password())).toBe("rejected");
    // Cerrar lo cerrado es haberlo cerrado.
    expect(await discardProof(proven)).toBe("closed");
  });

  it("cerrar todo con ella no deja ninguna sesión de la cuenta", async () => {
    const account = await user();
    await elsewhere(account);
    const proven = await proved(account);
    expect(await closeAllWithProof(proven)).toBe("closed");
    expect(await sessionCount(account.id)).toBe(0);
  });

  it("sin respuesta de Auth, no se supo y no se cerró", async () => {
    const account = await user();
    const down = createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch });
    const proof = await down.provePassword(account.email, account.password);
    if (!proof.ok) throw new Error("La contraseña de prueba no se comprobó.");
    expect(await down.discardProof(proof.proven)).toBe("unknown");
    expect(await sessionCount(account.id)).toBe(1);
  });

  // La sesión de la prueba sigue viva en Auth, que con ella sí dejaría cambiar la
  // contraseña. Quien la descartó ya decidió que no: cerrada o no, la prueba se gastó.
  it("una prueba que se descartó ya no cambia nada, aunque su sesión no se haya podido cerrar", async () => {
    const account = await user();
    const down = createAuth({ fetch: failingFetch(/\/logout/, networkDown).fetch });
    const proof = await down.provePassword(account.email, account.password);
    if (!proof.ok) throw new Error("La contraseña de prueba no se comprobó.");
    expect(await down.discardProof(proof.proven)).toBe("unknown");
    expect(await down.changeProvenPassword(proof.proven, password())).toBe("rejected");
    expect(await entersWith(account, account.password)).toBe(true);
  });
});
