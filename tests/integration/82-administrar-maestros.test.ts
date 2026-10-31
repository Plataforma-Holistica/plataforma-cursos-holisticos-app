import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { asServer as runAsServer, Tx } from "@/adapters/supabase/db";
import type { VerifiedClaims } from "@/services/account/account";
import { createTeacherAdminStore } from "@/services/teachers/admin-store";
import { teacherVersion } from "@/services/teachers/version";

import { claimedUser } from "./helpers/account";
import { anomalyStoreOn } from "./helpers/anomalies";
import { actAs, financePerson, type Finance } from "./helpers/finance";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { deleteTestUsersByEmail } from "./helpers/users";

// Administrar a los maestros (T-401; PA-65, PA-66 y proponer desde PA-68) contra la base local, con personas con su
// capacidad de verdad: que el almacén entiende lo que contesta cada función, con sus lecturas estrictas. Las reglas
// las prueban las pgTAP 58 a 62. Cada caso corre en una transacción que se revierte: la auditoría no admite borrado.

const emails: string[] = [];
let content: Finance;
let finance: Finance;

const claimsOf = (who: Finance) => ({ userId: who.person.id, aal: "aal2", sessionId: who.sessionId, issuedAt: 0 }) as VerifiedClaims;

/** El almacén de la aplicación sobre esa transacción, como servidor a nombre de las claims que se le pasen, sin confirmar. */
function storeOn(owner: Client) {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  const run = (async (actor: { claims: { userId: string; sessionId?: string | null } }, work: (tx: Tx) => Promise<unknown>) => {
    await asServer(owner, actor.claims.userId, actor.claims.sessionId ?? "");
    try {
      return await work(tx);
    } finally {
      await asOwner(owner);
    }
  }) as unknown as typeof runAsServer;
  return createTeacherAdminStore(run);
}

/** Da las dos capacidades en esta transacción. */
async function bothActing(owner: Client): Promise<void> {
  await actAs(owner, content);
  await actAs(owner, finance);
  await asOwner(owner);
}

/** Un maestro activo con cuenta. */
async function activeTeacher(owner: Client): Promise<string> {
  const person = await claimedUser();
  emails.push(person.email);
  await asSystem(owner);
  const { rows } = await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id::text", [person.id]);
  await asOwner(owner);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("Sin maestro.");
  return id;
}

/** Una alerta de salto de puntos de ese maestro, decidida como fraude por quien tiene finanzas. */
async function fraudAlert(owner: Client, teacher: string): Promise<string> {
  await asSystem(owner);
  const period = (await owner.query<{ p: number }>("select private.period_of(clock_timestamp())::int as p")).rows[0]?.p;
  await owner.query("select private.open_period($1)", [period]);
  const { rows } = await owner.query<{ id: string }>(
    "insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value) values ($1, 'teacher_points_jump', $2, 500, 300) returning id::text",
    [period, teacher],
  );
  await asOwner(owner);
  const alert = rows[0]?.id;
  if (alert === undefined) throw new Error("Sin alerta.");
  expect(await anomalyStoreOn(owner).review(claimsOf(finance), alert, "revisada", true, "evidencia")).toBe("reviewed");
  return alert;
}

beforeAll(async () => {
  content = await financePerson(emails, "content");
  finance = await financePerson(emails, "finance");
});

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

describe("el almacén contra la base", () => {
  it("invitar, volver a invitar el mismo correo, reenviar y revocar", async () => {
    await reverted(async (owner) => {
      await bothActing(owner);
      const store = storeOn(owner);
      const who = claimsOf(content);
      const email = `it-invitada-${Date.now()}@prueba.test`;
      expect(await store.invite(who, "Nora Invitada", email)).toBe("invited_new");
      expect(await store.invite(who, "Otra Vez", email)).toBe("already_invited");
      expect(await store.invite(who, "A mí", content.person.email)).toBe("self");

      const roster = await store.roster(who);
      const row = roster?.teachers.find((each) => each.email === email);
      expect(row).toMatchObject({ name: "Nora Invitada", status: "invited", invitation: "pending", isSelf: false });
      expect(roster?.freshCode).toBe(true);
      if (row === undefined) throw new Error("Sin fila.");

      expect(await store.reinvite(who, row.id)).toBe("invited_new");
      expect(await store.revoke(who, row.id)).toBe("revoked");
      expect(await store.revoke(who, row.id)).toBe("not_found");
      const after = await store.roster(who);
      const revoked = after?.teachers.find((each) => each.id === row.id);
      expect(revoked?.invitation).toBe("revoked");
      // Lo que se vio cambió: el servicio contestaría `changed`.
      expect(teacherVersion(row)).not.toBe(revoked === undefined ? "" : teacherVersion(revoked));
    });
  });

  it("el fundador, suspender y levantar", async () => {
    await reverted(async (owner) => {
      await bothActing(owner);
      const store = storeOn(owner);
      const who = claimsOf(content);
      const teacher = await activeTeacher(owner);
      expect(await store.setFounder(who, teacher, "2020-01-01")).toBe("too_early");
      const far = `${new Date().getUTCFullYear() + 2}-01-01`;
      expect(await store.setFounder(who, teacher, far)).toBe("set");
      expect(await store.setFounder(who, teacher, far)).toBe("unchanged");
      expect(await store.setFounder(who, teacher, null)).toBe("cleared");

      expect(await store.suspend(who, teacher, "Motivo interno", "Lo que lee")).toBe("suspended");
      expect(await store.suspend(who, teacher, "Otra vez", "Lo que lee")).toBe("already_suspended");
      const read = await store.roster(who);
      expect(read?.teachers.find((each) => each.id === teacher)).toMatchObject({
        status: "suspended",
        suspension: "manual",
        suspensionReason: "Motivo interno",
        suspensionNotice: "Lo que lee",
      });
      expect(await store.lift(who, teacher)).toBe("lifted");
      expect(await store.lift(who, teacher)).toBe("not_suspended");
    });
  });

  it("el fraude con dos personas: finanzas propone, retira y vuelve a proponer; otra persona confirma", async () => {
    await reverted(async (owner) => {
      await bothActing(owner);
      const store = storeOn(owner);
      const alerts = anomalyStoreOn(owner);
      const teacher = await activeTeacher(owner);
      const alert = await fraudAlert(owner, teacher);

      expect(await alerts.propose(claimsOf(finance), alert, "Puntos inflados")).toBe("proposed");
      expect(await alerts.propose(claimsOf(finance), alert, "Otra vez")).toBe("already_pending");

      // PA-68 sabe cuál propuesta es de cuál alerta, y de quién.
      const seen = await alerts.alerts(claimsOf(finance));
      const card = seen?.alerts.find((each) => each.id === alert);
      expect(card?.suspension?.mine).toBe(true);
      const request = card?.suspension?.id;
      if (request === undefined) throw new Error("Sin propuesta.");

      expect(await alerts.withdraw(claimsOf(content), request)).toBe("forbidden");
      expect(await alerts.withdraw(claimsOf(finance), request)).toBe("withdrawn");
      expect(await alerts.propose(claimsOf(finance), alert, "Puntos inflados")).toBe("proposed");

      const roster = await store.roster(claimsOf(content));
      const pending = roster?.requests.find((each) => each.teacherId === teacher);
      expect(pending).toMatchObject({ reason: "Puntos inflados", proposedBySelf: false, markedBySelf: false, aboutSelf: false });
      if (pending === undefined) throw new Error("Sin propuesta.");
      expect(roster?.teachers.find((each) => each.id === teacher)?.fraudPending).toBe(true);

      expect(await store.decide(claimsOf(content), pending.id, true, null, "Lo que lee")).toBe("confirmed");
      const after = await store.roster(claimsOf(content));
      expect(after?.teachers.find((each) => each.id === teacher)).toMatchObject({ status: "suspended", suspension: "fraud", fraudPending: false });
      expect(after?.requests).toEqual([]);
    });
  });

  it("rechazar la deja sin suspender", async () => {
    await reverted(async (owner) => {
      await bothActing(owner);
      const store = storeOn(owner);
      const alerts = anomalyStoreOn(owner);
      const teacher = await activeTeacher(owner);
      const alert = await fraudAlert(owner, teacher);
      expect(await alerts.propose(claimsOf(finance), alert, "Puntos inflados")).toBe("proposed");
      const pending = (await store.roster(claimsOf(content)))?.requests[0];
      if (pending === undefined) throw new Error("Sin propuesta.");
      expect(await store.decide(claimsOf(content), pending.id, false, "Sin caso", null)).toBe("rejected");
      const after = await store.roster(claimsOf(content));
      expect(after?.teachers.find((each) => each.id === teacher)).toMatchObject({ status: "active", fraudPending: false });
    });
  });

  it("a quien no tiene Contenido, la lista contesta nula y los cambios `forbidden`", async () => {
    await reverted(async (owner) => {
      await actAs(owner, finance);
      await asOwner(owner);
      const store = storeOn(owner);
      expect(await store.roster(claimsOf(finance))).toBeNull();
      expect(await store.invite(claimsOf(finance), "Nora", `it-nora-${Date.now()}@prueba.test`)).toBe("forbidden");
    });
  });
});
