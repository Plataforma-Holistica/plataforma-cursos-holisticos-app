import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createDrafts } from "@/services/drafts/drafts";
import { createDraftsStore } from "@/services/drafts/store";
import { readTeacherStanding } from "@/services/teachers/records";
import { createTeachers } from "@/services/teachers/standing";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// El portal del maestro (T-402, segunda solicitud) contra la base local: quién es maestro, la lista de
// sus cursos con lo que les falta, y las opciones del editor. Los maestros, las prácticas y los cursos
// viven en una transacción del dueño que se revierte.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; jar: ReturnType<typeof memoryJar>; claims: VerifiedClaims };

async function person(name?: string): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id, name);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, jar, claims: check.claims };
}

async function teacher(owner: Client, who: Person, status: "active" | "suspended" | "invited" = "active"): Promise<void> {
  await asSystem(owner);
  await owner.query(
    `insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
     values ($1, $2::public.teacher_status, case when $3 then now() end, case when $3 then 'prueba' end)`,
    [who.id, status, status === "suspended"],
  );
  await asOwner(owner);
}

/** Una práctica y un nivel, como el dueño declarado sistema. */
async function catalog(owner: Client): Promise<{ practice: string; level: string; other: string }> {
  await asSystem(owner);
  const tag = randomUUID().slice(0, 8);
  const practice = await owner.query<{ id: string }>(
    `insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 900001, 3) returning id`,
    [`respiracion-${tag}`, `Respiración ${tag}`],
  );
  const other = await owner.query<{ id: string }>(
    `insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 900002, 5) returning id`,
    [`yoga-${tag}`, `Yoga ${tag}`],
  );
  const level = await owner.query<{ id: string }>(
    `insert into public.levels (slug, name, position) values ($1, $2, 900001) returning id`,
    [`inicial-${tag}`, `Inicial ${tag}`],
  );
  await asOwner(owner);
  const id = (rows: { rows: { id: string }[] }) => rows.rows[0]?.id ?? "";
  return { practice: id(practice), level: id(level), other: id(other) };
}

async function deactivate(owner: Client, practice: string): Promise<void> {
  await asSystem(owner);
  await owner.query("update public.practices set is_active = false where id = $1", [practice]);
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

async function asSystemFor<T>(owner: Client, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asSystem(owner);
  try {
    return await read(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

const drafts = (owner: Client) =>
  createDrafts({
    store: createDraftsStore(
      (actor, work) => asServerFor(owner, actor.claims, work),
      (claims, work) => asPerson(owner, claims, work),
      (_context, work) => asSystemFor(owner, work),
    ),
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.reject(new Error("Nada debía reportarse.")),
  });

const teachers = (owner: Client) =>
  createTeachers({
    store: { standing: (claims) => asPerson(owner, claims, (tx) => readTeacherStanding(tx)) },
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.reject(new Error("Nada debía reportarse.")),
  });

async function created(promise: Promise<{ kind: string; id?: string | null }>): Promise<string> {
  const answer = await promise;
  if (answer.kind !== "created" || !answer.id) throw new Error(`No se creó: ${answer.kind}`);
  return answer.id;
}

describe("El portal del maestro, contra la base", () => {
  it("quién es maestro lo dice la base: activo, suspendido, o nadie (una alumna, una invitación)", async () => {
    const [ana, beto, caro, dani] = await Promise.all([person(), person(), person(), person()]);
    await reverted(async (owner) => {
      await teacher(owner, ana);
      await teacher(owner, beto, "suspended");
      await teacher(owner, caro, "invited");
      const service = teachers(owner);
      const ids = await owner.query<{ profile_id: string; id: string }>("select profile_id, id from public.teachers where profile_id = any($1)", [[ana.id, beto.id]]);
      const idOf = (who: Person) => ids.rows.find((row) => row.profile_id === who.id)?.id;
      expect(await service.teacherStanding(ana.jar)).toEqual({ kind: "teacher", claims: expect.anything(), standing: { state: "active", teacher: { id: idOf(ana) } } });
      expect(await service.teacherStanding(beto.jar)).toEqual({ kind: "teacher", claims: expect.anything(), standing: { state: "suspended", teacher: { id: idOf(beto) } } });
      expect(await service.teacherStanding(caro.jar)).toEqual({ kind: "teacher", claims: expect.anything(), standing: { state: "none" } });
      expect(await service.teacherStanding(dani.jar)).toEqual({ kind: "teacher", claims: expect.anything(), standing: { state: "none" } });
    });
  });

  it("la lista dice lo que le falta a cada borrador, y una práctica desactivada cuenta como que falta", async () => {
    const ana = await person("Ana Ruiz");
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const { practice, level } = await catalog(owner);
      const service = drafts(owner);
      const course = await created(service.createCourse(ana.jar, { token: randomUUID(), title: "Respirar" }));

      const empty = await service.teacherCourses(ana.claims);
      expect(empty).toEqual({
        kind: "ready",
        value: [
          expect.objectContaining({
            id: course,
            teacherName: "Ana Ruiz",
            practiceName: null,
            coverTone: null,
            draft: { hasSummary: false, practiceReady: false, levelReady: false, lessons: 0, modulesWithLessons: 0 },
          }),
        ],
      });

      expect(await service.saveCourse(ana.jar, { course, seen: 1, title: "Respirar", summary: "Para empezar.", practiceId: practice, levelId: level }))
        .toEqual({ kind: "saved" });
      const inicio = await created(service.addModule(ana.jar, { course, seen: 1, title: "Inicio" }));
      await created(service.addModule(ana.jar, { course, seen: 2, title: "Vacío" }));
      await created(service.addLesson(ana.jar, { course, module: inicio, seen: 1, title: "Una" }));
      await created(service.addLesson(ana.jar, { course, module: inicio, seen: 2, title: "Dos" }));
      const full = await service.teacherCourses(ana.claims);
      expect(full.kind === "ready" && full.value[0]).toMatchObject({
        practiceName: expect.stringMatching(/^Respiración /),
        coverTone: 3,
        draft: { hasSummary: true, practiceReady: true, levelReady: true, lessons: 2, modulesWithLessons: 1 },
      });

      await deactivate(owner, practice);
      const after = await service.teacherCourses(ana.claims);
      expect(after.kind === "ready" && after.value[0]).toMatchObject({
        practiceName: null,
        draft: { hasSummary: true, practiceReady: false, levelReady: true },
      });
    });
  });

  it("el editor ofrece las activas y la elegida aunque se haya desactivado, y guardar otro campo no la quita", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const { practice, level, other } = await catalog(owner);
      const service = drafts(owner);
      const course = await created(service.createCourse(ana.jar, { token: randomUUID(), title: "Respirar" }));
      expect(await service.saveCourse(ana.jar, { course, seen: 1, title: "Respirar", summary: null, practiceId: practice, levelId: level }))
        .toEqual({ kind: "saved" });
      await deactivate(owner, practice);

      const choices = await service.draftChoices({ practiceId: practice, levelId: level });
      if (choices.kind !== "ready") throw new Error("No se leyeron las opciones.");
      expect(choices.value.practices).toEqual(
        expect.arrayContaining([
          { id: practice, name: expect.stringMatching(/^Respiración /), tone: 3, active: false },
          { id: other, name: expect.stringMatching(/^Yoga /), tone: 5, active: true },
        ]),
      );
      expect(choices.value.levels).toEqual(expect.arrayContaining([{ id: level, name: expect.stringMatching(/^Inicial /), active: true }]));
      // Sin elegida, la desactivada no se ofrece.
      const fresh = await service.draftChoices({ practiceId: null, levelId: null });
      expect(fresh.kind === "ready" && fresh.value.practices.map((each) => each.id)).not.toContain(practice);

      // El formulario reenvía la elegida tal cual: la base la conserva, y el título cambia.
      expect(await service.saveCourse(ana.jar, { course, seen: 2, title: "Respirar despacio", summary: null, practiceId: practice, levelId: level }))
        .toEqual({ kind: "saved" });
      const draft = await service.draftCourse(ana.claims, course);
      expect(draft.kind === "ready" && draft.value).toMatchObject({ title: "Respirar despacio", practiceId: practice, teacherName: "Persona de prueba" });
      // Ya con otra, volver a la desactivada no se puede.
      expect(await service.saveCourse(ana.jar, { course, seen: 3, title: "Respirar despacio", summary: null, practiceId: other, levelId: level }))
        .toEqual({ kind: "saved" });
      expect(await service.saveCourse(ana.jar, { course, seen: 4, title: "Respirar despacio", summary: null, practiceId: practice, levelId: level }))
        .toEqual({ kind: "practice_inactive" });
    });
  });

  it("un id de otro maestro o de otro curso no cambia nada", async () => {
    const [ana, beto] = await Promise.all([person(), person()]);
    await reverted(async (owner) => {
      await teacher(owner, ana);
      await teacher(owner, beto);
      const service = drafts(owner);
      const mine = await created(service.createCourse(ana.jar, { token: randomUUID(), title: "Mío" }));
      const other = await created(service.createCourse(ana.jar, { token: randomUUID(), title: "Otro mío" }));
      const inicio = await created(service.addModule(ana.jar, { course: mine, seen: 1, title: "Inicio" }));
      const lesson = await created(service.addLesson(ana.jar, { course: mine, module: inicio, seen: 1, title: "Una" }));
      // Beto con los ids de Ana.
      expect(await service.saveLesson(beto.jar, { course: mine, lesson, seen: 1, title: "Mía", description: null })).toEqual({ kind: "not_found" });
      expect(await service.deleteCourse(beto.jar, { course: mine, seen: 1 })).toEqual({ kind: "not_found" });
      // Ana con la lección de un curso en el formulario de otro.
      expect(await service.saveLesson(ana.jar, { course: other, lesson, seen: 1, title: "Cruzada", description: null })).toEqual({ kind: "not_found" });
      expect(await service.deleteModule(ana.jar, { course: other, module: inicio, seen: 1 })).toEqual({ kind: "not_found" });
      const draft = await service.draftCourse(ana.claims, mine);
      expect(draft.kind === "ready" && draft.value?.modules[0]?.lessons[0]).toMatchObject({ id: lesson, title: "Una", revision: 1 });
      expect(await service.draftCourse(beto.claims, mine)).toEqual({ kind: "ready", value: null });
    });
  });
});
