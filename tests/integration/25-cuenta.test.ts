import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { verifyAccessToken, type VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asSystem, asUser } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";

import { createTestUser, deleteTestUsers, type TestUser } from "./helpers/users";

// La marca de quién fijó la contraseña (TRD §9.2), por el camino real: la cuenta nace en
// el Auth local, el perfil lo crea el disparador, y el código llega a la base con las tres
// funciones del adaptador. Lo que cada rol puede y no puede hacer con la columna lo prueba
// supabase/tests/07_cuenta.test.sql; aquí se comprueba que el adaptador no abre otro camino.

const PERMISSION_DENIED = "42501";

let ana: TestUser;
let beto: TestUser;
let anaClaims: VerifiedClaims;
let betoClaims: VerifiedClaims;

beforeAll(async () => {
  [ana, beto] = await Promise.all([createTestUser(), createTestUser({ claimed: true })]);
  const [first, second] = await Promise.all([
    verifyAccessToken(ana.accessToken),
    verifyAccessToken(beto.accessToken),
  ]);
  if (!first || !second) throw new Error("El token de una persona de prueba no se verificó.");
  anaClaims = first;
  betoClaims = second;
});

afterAll(async () => {
  await deleteTestUsers([ana, beto].filter(Boolean));
});

const flag = z.object({ pending: z.boolean() });
const claim = z.object({ status: z.string() });

const readFlag = (claims: VerifiedClaims) =>
  asUser(claims, (tx) => tx.query(sql`select password_reset_required as pending from public.profiles`, flag));

describe("la marca de contraseña", () => {
  it("una cuenta dada de alta en Auth nace con la marca prendida", async () => {
    expect(await readFlag(anaClaims)).toEqual([{ pending: true }]);
  });

  it("el ayudante de pruebas deja a una persona con la marca apagada", async () => {
    expect(await readFlag(betoClaims)).toEqual([{ pending: false }]);
  });

  it("el servidor no la apaga con un update, ni a nombre de la propia persona", async () => {
    const attempt = asServer({ claims: anaClaims, reason: "prueba" }, (tx) =>
      tx.execute(sql`update public.profiles set password_reset_required = false where id = ${ana.id}`),
    );
    await expect(attempt).rejects.toMatchObject({ code: PERMISSION_DENIED });
    expect(await readFlag(anaClaims)).toEqual([{ pending: true }]);
  });

  it("la persona tampoco, con su sesión", async () => {
    const attempt = asUser(anaClaims, (tx) =>
      tx.execute(sql`update public.profiles set password_reset_required = false where id = ${ana.id}`),
    );
    await expect(attempt).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it("un trabajo del sistema no reclama ninguna cuenta", async () => {
    const result = await asSystem({ reason: "prueba" }, (tx) =>
      tx.query(sql`select private.claim_account() as status`, claim),
    );
    expect(result).toEqual([{ status: "ineligible" }]);
    expect(await readFlag(anaClaims)).toEqual([{ pending: true }]);
  });

  it("el servidor la reclama a nombre de la persona, una sola vez", async () => {
    const reclaim = () =>
      asServer({ claims: anaClaims, reason: "prueba" }, (tx) =>
        tx.query(sql`select private.claim_account() as status`, claim),
      );
    expect(await reclaim()).toEqual([{ status: "claimed" }]);
    expect(await readFlag(anaClaims)).toEqual([{ pending: false }]);
    expect(await reclaim()).toEqual([{ status: "already_claimed" }]);
  });
});
