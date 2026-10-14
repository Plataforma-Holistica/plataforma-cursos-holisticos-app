import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createCatalogLists } from "@/services/catalog/lists";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor, type KnownUser, type MemoryJar } from "./helpers/auth";
import { catalogStoreOn } from "./helpers/catalog";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Las prácticas y los niveles (RF-709, T-106), contra el Auth y la base locales: la guarda
// del equipo corre de verdad, y las listas se cambian con las mismas consultas que usa la
// aplicación, dentro de una transacción del dueño que se revierte (lo que cambian queda en la
// auditoría, que no admite borrado). Cada caso comprueba al final que la auditoría quedó como
// estaba.

const emails: string[] = [];

afterAll(async () => {
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

async function entered(person: KnownUser): Promise<MemoryJar> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, person, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return jar;
}

async function auditRows(): Promise<number> {
  const rows = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
  return rows[0]?.n ?? -1;
}

/** Alguien del equipo con esas capacidades, con su factor atado y su código dado, dentro de la transacción. */
async function asTeamMember<T>(capabilities: string[], fn: (stage: { owner: Client; jar: MemoryJar; person: KnownUser }) => Promise<T>) {
  const person = await claimedUser();
  emails.push(person.email);
  await completeAccountAsOwner(person.id);
  const factor = await secondFactorFor(person);
  const jar = await entered(person);
  const audited = await auditRows();
  const result = await reverted(async (owner) => {
    const services = testServices({ teamStore: teamStoreOn(owner) });
    await asSystem(owner);
    for (const capability of capabilities) {
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2::public.capability)", [person.id, capability]);
    }
    await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
      person.id,
      factor.factorId,
      person.email.toLowerCase(),
    ]);
    await asOwner(owner);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    return fn({ owner, jar, person });
  });
  expect(await auditRows()).toBe(audited);
  return result;
}

/** El servicio de las listas, con la guarda de verdad y el almacén sobre esa transacción. */
function catalogOn(owner: Client) {
  const services = testServices({ teamStore: teamStoreOn(owner) });
  const reported: string[] = [];
  const catalog = createCatalogLists(
    {
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    },
    { teamStanding: services.teamStanding, store: catalogStoreOn(owner) },
  );
  return { ...catalog, reported, services };
}

describe("quien tiene Contenido y su código reciente cambia las listas", () => {
  it("agrega, renombra, ordena, desactiva y reactiva, y la lista lo dice", async () => {
    await asTeamMember(["content"], async ({ owner, jar }) => {
      const catalog = catalogOn(owner);
      const check = await catalog.services.teamStanding(jar);
      if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");

      const yoga = await catalog.addItem(jar, { list: "practices", name: "  Yoga  " });
      if (yoga.kind !== "answered" || yoga.answer !== "added" || yoga.id === null) throw new Error(`No agregó: ${JSON.stringify(yoga)}`);
      const meditation = await catalog.addItem(jar, { list: "practices", name: "Meditación" });
      if (meditation.kind !== "answered" || meditation.id === null) throw new Error("No agregó la segunda.");
      expect(await catalog.addItem(jar, { list: "practices", name: "yoga" })).toEqual({ kind: "answered", answer: "duplicate", id: yoga.id });
      expect(await catalog.addItem(jar, { list: "levels", name: "Principiante" })).toMatchObject({ kind: "answered", answer: "added" });

      expect(await catalog.renameItem(jar, { list: "practices", id: yoga.id, name: "Yoga suave" })).toEqual({ kind: "answered", answer: "renamed" });
      expect(await catalog.moveItem(jar, { list: "practices", id: meditation.id, direction: "up" })).toEqual({ kind: "answered", answer: "moved" });
      expect(await catalog.setItemActive(jar, { list: "practices", id: yoga.id, active: false })).toEqual({
        kind: "answered",
        answer: "deactivated",
      });

      const read = await catalog.catalogLists(check.claims);
      if (read.kind !== "lists") throw new Error("Las listas no se pudieron leer.");
      expect(read.lists.freshCode).toBe(true);
      expect(read.lists.practices.map((each) => [each.name, each.slug, each.position, each.isActive, each.coverTone])).toEqual([
        ["Meditación", "meditacion", 1, true, 2],
        ["Yoga suave", "yoga", 2, false, 1],
      ]);
      expect(read.lists.levels.map((each) => each.name)).toEqual(["Principiante"]);

      expect(await catalog.setItemActive(jar, { list: "practices", id: yoga.id, active: true })).toEqual({
        kind: "answered",
        answer: "reactivated",
      });
      // Cada cambio quedó en la auditoría con su autor, dentro de la transacción.
      const audited = await owner.query<{ n: number }>(
        "select count(*)::int as n from public.audit_log where entity_table in ('public.practices', 'public.levels') and actor_id = $1",
        [check.claims.userId],
      );
      expect(audited.rows[0]?.n).toBeGreaterThanOrEqual(7);
      expect(catalog.reported).toEqual([]);
    });
  });

  it("con el código vencido, la base pide darlo otra vez y no cambia nada", async () => {
    await asTeamMember(["content"], async ({ owner, jar, person }) => {
      const catalog = catalogOn(owner);
      await owner.query(
        `update auth.mfa_amr_claims c set updated_at = now() - interval '1 hour'
         from auth.sessions s where c.session_id = s.id and s.user_id = $1`,
        [person.id],
      );
      expect(await catalog.addItem(jar, { list: "practices", name: "Yoga" })).toEqual({ kind: "answered", answer: "needs_fresh_code", id: null });
      const rows = await owner.query<{ n: number }>("select count(*)::int as n from public.practices");
      expect(rows.rows[0]?.n).toBe(0);
    });
  });
});

describe("quien no tiene Contenido", () => {
  it("alguien del equipo con configuración: la guarda lo rechaza, y nada se le pregunta a la base", async () => {
    await asTeamMember(["config", "support"], async ({ owner, jar }) => {
      const catalog = catalogOn(owner);
      expect(await catalog.addItem(jar, { list: "practices", name: "Yoga" })).toEqual({ kind: "refused" });
      const check = await catalog.services.teamStanding(jar);
      if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
      // Y la base, preguntada directo, tampoco le da las listas.
      expect(await catalog.catalogLists(check.claims)).toEqual({ kind: "unavailable" });
      expect(catalog.reported).toEqual([]);
    });
  });

  it("una cuenta común: rechazada, sin preguntarle nada a la base", async () => {
    const person = await claimedUser();
    emails.push(person.email);
    await completeAccountAsOwner(person.id);
    const jar = await entered(person);
    const catalog = createCatalogLists({ report: () => Promise.resolve() }, { teamStanding: testServices().teamStanding, store: catalogStoreOn(null as never) });
    expect(await catalog.addItem(jar, { list: "practices", name: "Yoga" })).toEqual({ kind: "refused" });
    expect(await catalog.renameItem(jar, { list: "practices", id: person.id, name: "Yoga" })).toEqual({ kind: "refused" });
  });
});
