import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import { claimedUser, clearThrottle, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, type KnownUser, type MemoryJar } from "./helpers/auth";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Los subtítulos se recuerdan en la cuenta (RF-310; diseño, sección 5.4; T-203), contra la base
// y el Auth locales: la página lee la elección como la persona, y el reproductor la guarda por
// el servidor, siempre en la cuenta de la sesión que pasó la guarda.

const emails: string[] = [];

async function entered(): Promise<{ account: KnownUser; jar: MemoryJar }> {
  const account = await claimedUser();
  emails.push(account.email);
  await completeAccountAsOwner(account.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, account, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return { account, jar };
}

async function passedClaims(jar: MemoryJar): Promise<VerifiedClaims> {
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La sesión de prueba no pasó la guarda: ${check.kind}`);
  return check.claims;
}

async function storedChoice(userId: string): Promise<boolean | undefined> {
  const rows = await ownerQuery<{ on: boolean }>("select captions_on as on from public.profiles where id = $1", [userId]);
  return rows[0]?.on;
}

beforeEach(async () => {
  await clearThrottle();
});

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("la elección de subtítulos", () => {
  it("una cuenta nueva los tiene apagados", async () => {
    const { jar } = await entered();
    const services = testServices();
    expect(await services.captionsChoice(await passedClaims(jar))).toEqual({ kind: "ready", on: false });
    expect(services.reported).toEqual([]);
  });

  it("encenderlos queda en esa cuenta y en ninguna otra, y apagarlos también", async () => {
    const ana = await entered();
    const beatriz = await entered();
    const services = testServices();
    expect(await services.rememberCaptions(ana.jar, true)).toEqual({ kind: "saved", on: true });
    expect(await services.captionsChoice(await passedClaims(ana.jar))).toEqual({ kind: "ready", on: true });
    expect(await services.captionsChoice(await passedClaims(beatriz.jar))).toEqual({ kind: "ready", on: false });
    expect(await storedChoice(beatriz.account.id)).toBe(false);
    expect(await services.rememberCaptions(ana.jar, false)).toEqual({ kind: "saved", on: false });
    expect(await storedChoice(ana.account.id)).toBe(false);
    expect(services.reported).toEqual([]);
  });

  it("sin una sesión que pase, no se guarda nada: se contesta lo que dijo la guarda", async () => {
    const { account } = await entered();
    const services = testServices();
    const answer = await services.rememberCaptions(memoryJar(), true);
    expect(answer.kind).toBe("session");
    expect(await storedChoice(account.id)).toBe(false);
  });

  it("unas claims a las que se les cambió la cuenta no leen la de nadie: no se supo, y se reporta", async () => {
    const ana = await entered();
    const beatriz = await entered();
    await testServices().rememberCaptions(beatriz.jar, true);
    const forged = { ...(await passedClaims(ana.jar)), userId: beatriz.account.id };
    const services = testServices();
    expect(await services.captionsChoice(forged)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["captions_choice_unavailable"]);
  });

  it("unas claims cuya cuenta ya no tiene perfil: no se supo, y se reporta", async () => {
    const account = await claimedUser();
    emails.push(account.email);
    const jar = memoryJar();
    await testServices().signIn(jar, account, freshOrigin());
    const check = await testServices().checkSession(jar);
    if (check.kind !== "incomplete") throw new Error(`La cuenta de prueba no quedó sin completar: ${check.kind}`);
    // Sin completar: un perfil con consentimientos no se puede borrar.
    await ownerQuery("delete from public.profiles where id = $1", [account.id]);
    const services = testServices();
    expect(await services.captionsChoice(check.claims)).toEqual({ kind: "unavailable" });
    expect(services.reported).toEqual(["captions_choice_unavailable"]);
  });

  it("no deja nada en la auditoría", async () => {
    const { jar } = await entered();
    const before = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
    await testServices().rememberCaptions(jar, true);
    const after = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
