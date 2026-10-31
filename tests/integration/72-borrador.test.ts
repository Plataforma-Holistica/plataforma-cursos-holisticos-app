import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createDrafts } from "@/services/drafts/drafts";
import { createDraftsStore } from "@/services/drafts/store";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// El borrador de un curso (RF-603, T-402) contra la base local: la guarda de sesión corre de verdad,
// el maestro lee lo suyo como él mismo, y el servidor escribe a su nombre por las funciones del
// borrador. Los maestros y sus cursos viven en una transacción del dueño que se revierte.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; jar: ReturnType<typeof memoryJar>; claims: VerifiedClaims };

async function person(): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, jar, claims: check.claims };
}

/** Hace maestra a esa persona, en el estado que se diga, como el dueño declarado sistema. */
async function teacher(owner: Client, who: Person, status: "active" | "suspended" = "active"): Promise<void> {
  await asSystem(owner);
  await owner.query(
    `insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
     values ($1, $2::public.teacher_status, case when $3 then now() end, case when $3 then 'prueba' end)`,
    [who.id, status, status === "suspended"],
  );
  // Con el aviso del maestro aceptado: sin él, la base no lo deja escribir (decisión de Sergio del 2026-10-30, T-401).
  await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
  await owner.query(
    "insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')",
    [who.id],
  );
  await asOwner(owner);
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

async function asPerson<T>(owner: Client, claims: VerifiedClaims, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(owner);
  await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [readVerifiedClaims(claims).json]);
  try {
    return await read(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

async function asServerFor<T>(owner: Client, claims: VerifiedClaims, write: (tx: Tx) => Promise<T>): Promise<T> {
  const { claims: verified } = readVerifiedClaims(claims);
  await asServer(owner, verified.userId, verified.sessionId ?? "");
  try {
    return await write(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

/**
 * El servicio con el almacén de verdad (`store.ts`): sus consultas, sus listas de respuestas y su
 * reintento, sobre esa transacción en vez de abrir otra.
 */
const drafts = (owner: Client) =>
  createDrafts({ afterDelete: () => Promise.resolve(),
    store: createDraftsStore(
      (actor, work) => asServerFor(owner, actor.claims, work),
      (claims, work) => asPerson(owner, claims, work),
    ),
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.reject(new Error("Nada debía reportarse.")),
  });

/** El borrador como lo lee su maestra; falla si no lo ve. */
async function draftOf(owner: Client, who: Person, course: string) {
  const read = await drafts(owner).draftCourse(who.claims, course);
  if (read.kind !== "ready" || read.value === null) throw new Error("La maestra no leyó su borrador.");
  return read.value;
}

async function created(promise: Promise<{ kind: string; id?: string | null }>): Promise<string> {
  const answer = await promise;
  if (answer.kind !== "created" || !answer.id) throw new Error(`No se creó: ${answer.kind}`);
  return answer.id;
}

describe("El borrador de un curso (RF-603), contra la base", () => {
  it("la maestra crea, llena, reordena y vuelve a leer su curso", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const service = drafts(owner);
      const token = randomUUID();
      const course = await created(service.createCourse(ana.jar, { token, title: "Respirar en calma" }));
      expect(await service.createCourse(ana.jar, { token, title: "Respirar en calma" })).toEqual({ kind: "created", id: course });
      expect(await service.saveCourse(ana.jar, { course, seen: 1, title: "Respirar", summary: "Para empezar.\r\nDespacio.", practiceId: null, levelId: null }))
        .toEqual({ kind: "saved" });
      const first = await created(service.addModule(ana.jar, { course, seen: 1, title: "Inicio" }));
      const second = await created(service.addModule(ana.jar, { course, seen: 2, title: "Práctica" }));
      expect(await service.addModule(ana.jar, { course, seen: 2, title: "Práctica" })).toEqual({ kind: "changed" });
      const one = await created(service.addLesson(ana.jar, { course, module: first, seen: 1, title: "Una" }));
      const two = await created(service.addLesson(ana.jar, { course, module: first, seen: 2, title: "Dos" }));
      expect(await service.moveLesson(ana.jar, { course, lesson: two, seen: { module: first, position: 2 }, to: { module: second, position: 1 } }))
        .toEqual({ kind: "moved" });
      expect(await service.saveLesson(ana.jar, { course, lesson: one, seen: 1, title: "Una lección", description: "Qué se hace." }))
        .toEqual({ kind: "saved" });
      expect(await service.moveModule(ana.jar, { course, module: second, seenPosition: 2, toPosition: 1 })).toEqual({ kind: "moved" });
      expect(await service.renameModule(ana.jar, { course, module: first, seen: 2, title: "Cierre" })).toEqual({ kind: "changed" });

      const draft = await draftOf(owner, ana, course);
      expect(draft).toMatchObject({ state: "draft", version: 1, title: "Respirar", summary: "Para empezar.\nDespacio.", revision: 2 });
      expect(draft.modules.map((module) => [module.title, module.lessons.map((lesson) => lesson.title)])).toEqual([
        ["Práctica", ["Dos"]],
        ["Inicio", ["Una lección"]],
      ]);
      expect(draft.modules[1]?.lessons[0]).toMatchObject({ id: one, description: "Qué se hace.", revision: 2 });

      const courses = await service.teacherCourses(ana.claims);
      expect(courses).toEqual({ kind: "ready", value: [expect.objectContaining({ id: course, state: "draft", title: "Respirar", contentRevision: draft.contentRevision })] });
    });
  });

  it("otra maestra ni lo lee ni lo cambia; una alumna no es maestra; una suspendida solo lee", async () => {
    const [ana, beto, caro, dani] = await Promise.all([person(), person(), person(), person()]);
    await reverted(async (owner) => {
      await teacher(owner, ana);
      await teacher(owner, beto);
      await teacher(owner, caro);
      const service = drafts(owner);
      const course = await created(service.createCourse(ana.jar, { token: randomUUID(), title: "De Ana" }));
      const caros = await created(service.createCourse(caro.jar, { token: randomUUID(), title: "De Caro" }));

      expect(await service.draftCourse(beto.claims, course)).toEqual({ kind: "ready", value: null });
      expect(await service.teacherCourses(beto.claims)).toEqual({ kind: "ready", value: [] });
      expect(await service.saveCourse(beto.jar, { course, seen: 1, title: "Mío", summary: null, practiceId: null, levelId: null }))
        .toEqual({ kind: "not_found" });
      expect(await service.deleteCourse(beto.jar, { course, seen: 1 })).toEqual({ kind: "not_found" });
      expect(await service.createCourse(dani.jar, { token: randomUUID(), title: "No soy maestra" })).toEqual({ kind: "not_teacher" });

      await asSystem(owner);
      await owner.query("update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where profile_id = $1", [caro.id]);
      await asOwner(owner);
      expect(await service.createCourse(caro.jar, { token: randomUUID(), title: "Otro" })).toEqual({ kind: "suspended" });
      expect(await service.addModule(caro.jar, { course: caros, seen: 1, title: "Uno" })).toEqual({ kind: "suspended" });
      expect((await draftOf(owner, caro, caros)).title).toBe("De Caro");
    });
  });

  it("borrar un borrador se lleva el registro con todo lo suyo", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const service = drafts(owner);
      const course = await created(service.createCourse(ana.jar, { token: randomUUID(), title: "Para borrar" }));
      const first = await created(service.addModule(ana.jar, { course, seen: 1, title: "Uno" }));
      await created(service.addLesson(ana.jar, { course, module: first, seen: 1, title: "Una" }));
      expect(await service.deleteCourse(ana.jar, { course, seen: 1 })).toEqual({ kind: "changed" });
      const seen = (await draftOf(owner, ana, course)).contentRevision;
      expect(await service.deleteCourse(ana.jar, { course, seen })).toEqual({ kind: "deleted" });
      expect(await service.draftCourse(ana.claims, course)).toEqual({ kind: "ready", value: null });
      const left = await owner.query<{ n: number }>(
        `select (select count(*) from public.course_registry where course_id = $1)
              + (select count(*) from public.draft_lessons where course_id = $1) as n`,
        [course],
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
    });
  });
});
