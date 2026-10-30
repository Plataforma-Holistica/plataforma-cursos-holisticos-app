import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { acceptAnswerOf, askAcceptInvitation, readTeacherStanding, readTeacherTexts, recordTeacherNotice } from "@/services/teachers/records";
import { createTeachers } from "@/services/teachers/standing";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { answer, asOwner, asServer, asSystem, print, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Aceptar la invitación de maestro y el aviso vuelto a pedir (T-401, PA-40), contra la base local: las consultas
// que usa la aplicación, como el servidor y a nombre de la persona, con la sesión que abrió Auth. Cada condición
// de la base se rompe en `58_invitacion_maestro.test.sql`; aquí se prueba que el servicio la llama bien. Todo en
// una transacción del dueño que se revierte.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

interface Person {
  id: string;
  email: string;
  claims: VerifiedClaims;
  jar: ReturnType<typeof memoryJar>;
}

async function person(name?: string): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id, name);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, email: who.email, claims: check.claims, jar };
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

/** Como el servidor, a nombre de esa persona y con su sesión. Lo que `asServer` del adaptador haría. */
async function asPersonServer<T>(owner: Client, claims: VerifiedClaims, work: (tx: Tx) => Promise<T>): Promise<T> {
  await asServer(owner, claims.userId, claims.sessionId ?? randomUUID());
  try {
    return await work(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

function teachersOn(owner: Client, ticket: string | null, reported: string[] = []) {
  return createTeachers({
    store: {
      standing: (claims, print_) => asPersonServer(owner, claims, (tx) => readTeacherStanding(tx, print_)),
      texts: (claims, draftsAllowed) => asPersonServer(owner, claims, (tx) => readTeacherTexts(tx, draftsAllowed)),
      accept: async (claims, print_, agreement, notice, evidence) =>
        acceptAnswerOf(await asPersonServer(owner, claims, (tx) => askAcceptInvitation(tx, print_, agreement, notice, evidence))),
      acceptNotice: (claims, notice, evidence, draftsAllowed) =>
        asPersonServer(owner, claims, (tx) => recordTeacherNotice(tx, claims.userId, notice, evidence, draftsAllowed)),
    },
    checkSession: (reader) => testServices().checkSession(reader),
    report: (code) => (reported.push(code), Promise.resolve()),
    readTicket: () => ticket,
    dropTicket: () => undefined,
    evidence: () => ({ address: "203.0.113.9", userAgent: "vitest" }),
    isLocal: () => true,
  });
}

/** El dueño declarado sistema da de alta un maestro, y su invitación al correo de esa persona. */
async function invited(owner: Client, who: Person): Promise<string> {
  await asSystem(owner);
  const teacher = await answer(owner, "private.system_add_teacher($1, $2, null)::text", ["Maestra Invitada", `m-${randomUUID()}`]);
  if (!teacher) throw new Error("No se creó el maestro.");
  expect(await answer(owner, "private.system_invite_teacher($1, $2)", [teacher, who.email])).toBe("invited_existing");
  await asOwner(owner);
  return teacher;
}

/** Deja la prueba del buzón, como al recuperar la contraseña en ese navegador. */
async function proveMailbox(owner: Client, who: Person, secret: string): Promise<void> {
  await asServer(owner, who.id, who.claims.sessionId ?? randomUUID());
  expect(await answer(owner, "private.claim_account($1)", [print(secret)])).toBe("already_claimed");
  await asOwner(owner);
}

describe("aceptar la invitación de maestro, contra la base", () => {
  it("de la invitación al portal: el estado, los textos, aceptar y el consentimiento", async () => {
    const nora = await person("Nora");
    await reverted(async (owner) => {
      await invited(owner, nora);
      const before = teachersOn(owner, null);
      expect(await before.teacherStanding(nora.jar)).toMatchObject({ kind: "teacher", standing: { state: "invited_unproven", name: "Maestra Invitada" } });

      await proveMailbox(owner, nora, "nora");
      const service = teachersOn(owner, print("nora"));
      expect(await service.teacherStanding(nora.jar)).toMatchObject({ kind: "teacher", standing: { state: "invited", name: "Maestra Invitada" } });

      const texts = await service.teacherTexts(nora.claims);
      expect(texts?.agreement?.title).toBeTruthy();
      expect(texts?.notice?.body).toBeTruthy();
      const shown = { agreement: texts?.agreement?.documentId ?? "", notice: texts?.notice?.documentId ?? "" };

      // Los textos cruzados no valen, y nada queda escrito.
      expect(await service.acceptTeacherInvitation(nora.jar, { agreement: shown.notice, notice: shown.agreement }, freshOrigin())).toEqual({
        kind: "answered",
        answer: "changed",
      });
      expect(await service.acceptTeacherInvitation(nora.jar, shown, freshOrigin())).toEqual({ kind: "accepted" });
      expect(await service.teacherStanding(nora.jar)).toMatchObject({ kind: "teacher", standing: { state: "active" } });

      const consents = await owner.query<{ type: string; origin: string; ip: string; agent: string }>(
        `select d.doc_type::text as type, c.origin, host(c.ip) as ip, c.user_agent as agent
         from public.consents c join public.legal_documents d on d.id = c.legal_document_id
         where c.profile_id = $1 and d.doc_type in ('teacher_agreement', 'teacher_privacy_notice') order by 1`,
        [nora.id],
      );
      expect(consents.rows).toEqual([
        { type: "teacher_agreement", origin: "teacher_invitation", ip: "203.0.113.9", agent: "vitest" },
        { type: "teacher_privacy_notice", origin: "teacher_invitation", ip: "203.0.113.9", agent: "vitest" },
      ]);

      // Un doble envío: ya no hay invitación viva, y como ya es maestro, quedó aceptada.
      expect(await service.acceptTeacherInvitation(nora.jar, shown, freshOrigin())).toEqual({ kind: "accepted" });
    });
  });

  it("sin el resguardo de ese navegador, o con otro, no acepta", async () => {
    const olga = await person("Olga");
    await reverted(async (owner) => {
      await invited(owner, olga);
      await proveMailbox(owner, olga, "olga");
      const shown = await teachersOn(owner, null).teacherTexts(olga.claims);
      const ids = { agreement: shown?.agreement?.documentId ?? "", notice: shown?.notice?.documentId ?? "" };
      expect(await teachersOn(owner, null).acceptTeacherInvitation(olga.jar, ids, freshOrigin())).toEqual({ kind: "answered", answer: "needs_mailbox_proof" });
      expect(await teachersOn(owner, print("otro")).acceptTeacherInvitation(olga.jar, ids, freshOrigin())).toEqual({ kind: "answered", answer: "needs_mailbox_proof" });
      expect(await teachersOn(owner, print("otro")).teacherStanding(olga.jar)).toMatchObject({ standing: { state: "invited_unproven" } });
    });
  });

  it("quien no tiene invitación no ve nada, y aceptar le dice que no la hay", async () => {
    const pia = await person("Pía");
    await reverted(async (owner) => {
      const service = teachersOn(owner, print("pia"));
      expect(await service.teacherStanding(pia.jar)).toMatchObject({ kind: "teacher", standing: { state: "none" } });
      const texts = await service.teacherTexts(pia.claims);
      expect(await service.acceptTeacherInvitation(pia.jar, { agreement: texts?.agreement?.documentId ?? "", notice: texts?.notice?.documentId ?? "" }, freshOrigin())).toEqual({
        kind: "answered",
        answer: "no_invitation",
      });
    });
  });
});

describe("el aviso del maestro vuelto a pedir, contra la base", () => {
  /** Un maestro activo con cuenta, sin el aviso aceptado. */
  async function activeTeacher(owner: Client, who: Person): Promise<string> {
    await asSystem(owner);
    const inserted = await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id::text as id", [who.id]);
    await asOwner(owner);
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("No se creó el maestro.");
    return id;
  }

  it("le falta, lo acepta, y la base lo deja escribir; con un aviso que no es el vigente no anota nada", async () => {
    const rosa = await person("Rosa");
    await reverted(async (owner) => {
      const teacher = await activeTeacher(owner, rosa);
      const service = teachersOn(owner, null);
      expect(await service.teacherStanding(rosa.jar)).toMatchObject({ kind: "teacher", standing: { state: "needs_notice", teacher: { id: teacher } } });

      // Sin el aviso, la base no ve a una maestra activa para escribir.
      const active = async () => {
        await asServer(owner, rosa.id, rosa.claims.sessionId ?? randomUUID());
        await owner.query("reset role");
        const result = await owner.query<{ id: string | null }>("select private.current_active_teacher_id()::text as id");
        await asOwner(owner);
        return result.rows[0]?.id ?? null;
      };
      expect(await active()).toBeNull();

      const texts = await service.teacherTexts(rosa.claims);
      const notice = texts?.notice?.documentId ?? "";
      expect(await service.acceptTeacherNotice(rosa.jar, { notice: texts?.agreement?.documentId ?? "" }, freshOrigin())).toEqual({ kind: "changed" });
      expect(await service.teacherStanding(rosa.jar)).toMatchObject({ standing: { state: "needs_notice" } });

      expect(await service.acceptTeacherNotice(rosa.jar, { notice }, freshOrigin())).toEqual({ kind: "accepted" });
      expect(await service.teacherStanding(rosa.jar)).toMatchObject({ standing: { state: "active", teacher: { id: teacher } } });
      expect(await active()).toBe(teacher);

      const consents = await owner.query<{ origin: string }>(
        "select c.origin from public.consents c where c.profile_id = $1 and c.legal_document_id = $2",
        [rosa.id, notice],
      );
      expect(consents.rows).toEqual([{ origin: "login_prompt" }]);

      // Ya no le falta: no anota otro.
      expect(await service.acceptTeacherNotice(rosa.jar, { notice }, freshOrigin())).toEqual({ kind: "accepted" });
      expect((await owner.query("select 1 from public.consents c where c.profile_id = $1 and c.legal_document_id = $2", [rosa.id, notice])).rowCount).toBe(1);
    });
  });

  it("a un maestro suspendido no se le pide, y su estado trae solo el texto escrito para él", async () => {
    const sara = await person("Sara");
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query(
        `insert into public.teachers (profile_id, status, suspended_at, suspension_reason, suspension_notice)
         values ($1, 'suspended', now(), 'motivo interno', 'Tu cuenta está en pausa.')`,
        [sara.id],
      );
      await asOwner(owner);
      const check = await teachersOn(owner, null).teacherStanding(sara.jar);
      expect(check).toMatchObject({ kind: "teacher", standing: { state: "suspended", notice: "Tu cuenta está en pausa." } });
      expect(JSON.stringify(check)).not.toContain("motivo interno");
      expect(await teachersOn(owner, null).acceptTeacherNotice(sara.jar, { notice: randomUUID() }, freshOrigin())).toEqual({ kind: "not_needed" });
    });
  });
});
