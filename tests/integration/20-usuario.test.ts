import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { verifyAccessToken, type VerifiedClaims } from "@/adapters/supabase/claims";
import { asSystem, asUser } from "@/adapters/supabase/db";
import { DatabaseError, UnverifiedClaimsError } from "@/adapters/supabase/errors";
import { sql } from "@/adapters/supabase/sql";

import { createTestUser, deleteTestUsers, type TestUser } from "./helpers/users";

// «Como usuario» (ADR-31, TRD §8.10). La prueba que cierra el riesgo de la decisión: la
// aplicación entra con un rol que salta la seguridad por fila, y aun así, por una persona,
// solo se lee lo propio.

const PERMISSION_DENIED = "42501";

let ana: TestUser;
let beto: TestUser;
let anaClaims: VerifiedClaims;
let betoClaims: VerifiedClaims;

beforeAll(async () => {
  [ana, beto] = await Promise.all([createTestUser(), createTestUser()]);
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

const ids = z.object({ id: z.uuid() });
const count = z.object({ n: z.number() });

describe("verifyAccessToken", () => {
  it("devuelve quién es la persona, con el token que firmó el servidor de identidad", () => {
    expect(anaClaims).toMatchObject({ userId: ana.id, aal: "aal1" });
    expect(betoClaims.userId).toBe(beto.id);
  });

  it("rechaza un texto que no es un token", async () => {
    expect(await verifyAccessToken("no-es-un-token")).toBeNull();
    expect(await verifyAccessToken("")).toBeNull();
  });

  it("rechaza un token con la firma alterada", async () => {
    // El primer carácter de la firma, no el último: en base64url el último lleva bits de
    // relleno, y cambiarlo puede dejar la firma igual.
    const [header, payload, signature = ""] = ana.accessToken.split(".");
    const first = signature.startsWith("A") ? "B" : "A";
    const tampered = `${header}.${payload}.${first}${signature.slice(1)}`;
    expect(tampered).not.toBe(ana.accessToken);
    expect(await verifyAccessToken(tampered)).toBeNull();
  });

  it("rechaza un token sin firma, aunque diga ser de otra persona", async () => {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const [, payload] = ana.accessToken.split(".");
    const original = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as object;
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...original, sub: beto.id })}.`;
    expect(await verifyAccessToken(forged)).toBeNull();
  });
});

describe("asUser", () => {
  it("como alumna solo se lee lo propio", async () => {
    const seen = await asUser(anaClaims, async (tx) => ({
      profiles: await tx.query(sql`select id from public.profiles`, ids),
      audit: await tx.query(sql`select count(*)::int as n from public.audit_log`, count),
      parameters: await tx.query(sql`select count(*)::int as n from public.business_parameters`, count),
    }));
    expect(seen.profiles).toEqual([{ id: ana.id }]);
    expect(seen.audit).toEqual([{ n: 0 }]);
    expect(seen.parameters).toEqual([{ n: 0 }]);
  });

  it("la misma consulta, sin bajar de rol, lo vería todo: por eso existe asUser", async () => {
    const [row] = await asSystem({}, (tx) =>
      tx.query(
        sql`select count(*)::int as n from public.profiles where id in (${ana.id}, ${beto.id})`,
        count,
      ),
    );
    expect(row?.n).toBe(2);
  });

  it("dos alumnas no se ven entre sí", async () => {
    const seen = await asUser(betoClaims, (tx) => tx.query(sql`select id from public.profiles`, ids));
    expect(seen).toEqual([{ id: beto.id }]);

    const touched = await asUser(anaClaims, (tx) =>
      tx.execute(sql`update public.profiles set display_name = 'Intrusa' where id = ${beto.id}`),
    );
    expect(touched).toBe(0);
  });

  it("la transacción corre con su rol y su identidad, y sin autor declarado", async () => {
    const context = z.object({
      role: z.string(),
      uid: z.uuid(),
      actor: z.uuid(),
      is_system: z.boolean(),
      app_actor: z.string().nullable(),
      app_kind: z.string().nullable(),
    });
    const [row] = await asUser(anaClaims, (tx) =>
      tx.query(
        sql`select current_user::text as role, auth.uid() as uid, private.actor_id() as actor,
              private.actor_is_system() as is_system,
              current_setting('app.actor_id', true) as app_actor,
              current_setting('app.actor_kind', true) as app_kind`,
        context,
      ),
    );
    expect(row).toEqual({
      role: "authenticated",
      uid: ana.id,
      actor: ana.id,
      is_system: false,
      app_actor: "",
      app_kind: "",
    });
  });

  it.each([
    ["insertar un parámetro", sql`
      insert into public.business_parameters (key, value, status, effective_from)
      values ('GRACIA_COBRO_DIAS', '10', 'proposed', now() + interval '1 day')`],
    ["borrar su propio perfil", sql`delete from public.profiles`],
    ["cambiar su propio estado", sql`update public.profiles set status = 'suspended'`],
    ["escribir en la auditoría", sql`
      insert into public.audit_log (actor_kind, category, action, entity_table)
      values ('system', 'config', 'x', 'x')`],
  ])("no puede %s", async (_name, statement) => {
    const attempt = asUser(anaClaims, (tx) => tx.execute(statement));
    await expect(attempt).rejects.toBeInstanceOf(DatabaseError);
    await expect(attempt).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it("lo que sí puede escribir se guarda de verdad", async () => {
    const name = `Ana ${Date.now()}`;
    const touched = await asUser(anaClaims, (tx) =>
      tx.execute(sql`update public.profiles set display_name = ${name} where id = ${ana.id}`),
    );
    expect(touched).toBe(1);

    const [row] = await asUser(anaClaims, (tx) =>
      tx.query(sql`select display_name as name from public.profiles`, z.object({ name: z.string() })),
    );
    expect(row?.name).toBe(name);
  });

  it("al terminar, la conexión vuelve a ser de app_service", async () => {
    const who = z.object({ pid: z.number(), role: z.string(), claims: z.string().nullable() });
    const read = sql`
      select pg_backend_pid() as pid, current_user::text as role,
        current_setting('request.jwt.claims', true) as claims`;
    const [asAna] = await asUser(anaClaims, (tx) => tx.query(read, who));
    const [after] = await asSystem({}, (tx) => tx.query(read, who));
    expect(asAna?.role).toBe("authenticated");
    expect(asAna?.claims).toContain(ana.id);
    expect(after).toEqual({ pid: asAna?.pid, role: "app_service", claims: "" });
  });

  it("rechaza unas claims que el adaptador no verificó", async () => {
    const copied = { ...anaClaims };
    const invented = { userId: beto.id, aal: "aal2", sessionId: null };
    for (const forged of [copied, invented]) {
      await expect(
        asUser(forged as VerifiedClaims, (tx) => tx.query(sql`select id from public.profiles`, ids)),
      ).rejects.toBeInstanceOf(UnverifiedClaimsError);
    }
  });
});
