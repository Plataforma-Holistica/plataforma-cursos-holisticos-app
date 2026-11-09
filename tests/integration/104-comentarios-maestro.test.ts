import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { commentsStoreOn, createComments } from "@/services/comments/comments";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-501 · PA-45 (RF-609; plan aprobado por Sergio el 2026-11-08): los comentarios del maestro contra la base, por el almacén de la
// aplicación (`commentsStoreOn`) sobre una transacción del dueño que se revierte. Leer no pasa por la regla de acceso (decisión de
// Sergio): la base acota al maestro de quien actúa. Por eso aquí se exige la equivalencia: en cada estado de la lección, del curso y
// del maestro, PA-45 muestra un comentario si y solo si la regla le deja leer esa lección a su dueño. Y nada de otro maestro.
//
// Pide las marcas locales `comments_accept` y `comments_unfiltered` (las pone `db:login`).

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; claims: VerifiedClaims };

async function person(): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, claims: check.claims };
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

function commentsAs(owner: Client, who: Person) {
  const reported: string[] = [];
  const store = commentsStoreOn(
    async (claims, _reason, work) => {
      const { claims: verified } = readVerifiedClaims(claims);
      await asServer(owner, verified.userId, verified.sessionId ?? "");
      try {
        return await work(txOn(owner));
      } finally {
        await asOwner(owner);
      }
    },
    // Los cursos del filtro, como la persona: con sus claims de Auth, como la aplicación.
    async (claims, work) => {
      const { claims: verified } = readVerifiedClaims(claims);
      await asOwner(owner);
      await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [
        JSON.stringify({ sub: verified.userId, role: "authenticated", aal: "aal1", session_id: verified.sessionId }),
      ]);
      try {
        return await work(txOn(owner));
      } finally {
        await asOwner(owner);
      }
    },
  );
  const service = createComments({
    store,
    checkSession: () => Promise.resolve({ kind: "pass", claims: who.claims }),
    report: (code) => (reported.push(code), Promise.resolve()),
  });
  return { ...service, reported };
}
const reader = {} as CookieReader;

/** Un maestro con cuenta, activo y con su aviso al día. */
async function teacher(owner: Client, profile: string, tag: string): Promise<string> {
  const id = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [profile])).rows[0]!.id;
  await owner.query("insert into public.published_teachers (teacher_id, slug, display_name, is_listed) values ($1, $2, 'Maestra de la 104', true)", [id, `maestra-104-${tag}`]);
  await owner.query(
    `insert into public.legal_documents (doc_type, version, title, body, effective_from)
     select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
     where private.current_legal_document('teacher_privacy_notice') is null`,
  );
  await owner.query("insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')", [profile]);
  return id;
}

type LessonState = { current: boolean; listed: boolean; state: "published" | "changes_pending" | "withdrawn" };

/** Un curso de una lección de ese maestro, en ese estado, con un comentario publicado de `author`. */
async function lessonIn(owner: Client, teacherId: string, author: string, how: LessonState): Promise<{ lesson: string; course: string; comment: string }> {
  const tag = randomUUID().slice(0, 8);
  const course = (
    await owner.query<{ id: string }>(
      `insert into public.course_registry (teacher_id, state, first_published_at, pending_version_state, withdrawn_at, withdrawal_reason)
       values ($1, $2, now(), case when $2 = 'changes_pending' then 'draft'::public.course_version_state end,
               case when $2 = 'withdrawn' then now() end, case when $2 = 'withdrawn' then 'Prueba de la 104' end)
       returning course_id as id`,
      [teacherId, how.state],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_courses (course_id, teacher_id, slug, title, teacher_name, lesson_count, total_duration_seconds, is_listed)
     values ($1, $2, $3, $4, 'Maestra de la 104', 1, 100, $5)`,
    [course, teacherId, `pa45-104-${tag}`, `Curso ${tag}`, how.listed],
  );
  const moduleId = randomUUID();
  await owner.query("insert into public.published_modules (id, course_id, title, position) values ($1, $2, 'Módulo', 1)", [moduleId, course]);
  const lesson = randomUUID();
  const video = (
    await owner.query<{ id: string }>(
      `insert into public.video_assets (course_id, teacher_id, lesson_id, provider, status, duration_seconds, provider_asset_id, provider_playback_id)
       values ($1, $2, $3, 'test', 'ready', 100, $4, $4) returning id`,
      [course, teacherId, lesson, `pa45-104-${tag}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds, is_current, retired_at)
     values ($1, $2, $3, $4, $5, 'Lección', 1, 100, $6, case when $6 then null else now() end)`,
    [lesson, course, moduleId, teacherId, video, how.current],
  );
  const comment = (
    await owner.query<{ id: string }>(
      `insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, status, filter_verdict)
       values ($1, $2, $3, $4, 'Una pregunta', 'published', 'pass') returning id`,
      [lesson, course, teacherId, author],
    )
  ).rows[0]!.id;
  return { lesson, course, comment };
}

const STATES: LessonState[] = [true, false].flatMap((current) =>
  [true, false].flatMap((listed) => (["published", "changes_pending", "withdrawn"] as const).map((state) => ({ current, listed, state }))),
);

describe("PA-45 contra la base", () => {
  it.each([["active"], ["suspended"]] as const)("maestra %s: muestra un comentario si y solo si la regla le deja leer la lección", async (status) => {
    const [maestra, ana] = [await person(), await person()];
    await reverted(async (owner) => {
      await asOwner(owner);
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
      const teacherId = await teacher(owner, maestra.id, randomUUID().slice(0, 8));
      const lessons = [];
      for (const how of STATES) lessons.push({ how, ...(await lessonIn(owner, teacherId, ana.id, how)) });
      if (status === "suspended") {
        await owner.query("update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba de la 104' where id = $1", [teacherId]);
      }
      await owner.query("set local session_replication_role = origin");

      const asMaestra = commentsAs(owner, maestra);
      const shown = new Set<string>();
      for (let before: string | null = null, round = 0; round < 5; round++) {
        const page = await asMaestra.teacherComments(maestra.claims, { course: null, unanswered: false, before });
        if (page.kind !== "ready") throw new Error(`PA-45 contestó ${page.kind}`);
        for (const item of page.items) shown.add(item.id);
        if (page.next === null) break;
        before = page.next;
      }
      for (const { how, lesson, comment } of lessons) {
        const rule = await asMaestra.lessonComments(maestra.claims, lesson, null);
        expect({ how, shown: shown.has(comment) }).toEqual({ how, shown: rule.kind === "ready" });
      }
      // La regla deja leer al menos algo: si no, la equivalencia no probaría nada.
      expect(shown.size).toBeGreaterThan(0);
      expect(asMaestra.reported).toEqual([]);
    });
  });

  it("nada de otro maestro, tampoco pidiendo su curso; y quien no es maestro no tiene PA-45", async () => {
    const [maestra, otro, ana] = [await person(), await person(), await person()];
    await reverted(async (owner) => {
      await asOwner(owner);
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
      const mine = await lessonIn(owner, await teacher(owner, maestra.id, randomUUID().slice(0, 8)), ana.id, { current: true, listed: true, state: "published" });
      const theirs = await lessonIn(owner, await teacher(owner, otro.id, randomUUID().slice(0, 8)), ana.id, { current: true, listed: true, state: "published" });
      await owner.query("set local session_replication_role = origin");
      const asMaestra = commentsAs(owner, maestra);
      const all = await asMaestra.teacherComments(maestra.claims, { course: null, unanswered: false, before: null });
      expect(all).toMatchObject({ kind: "ready", items: [{ id: mine.comment, lessonId: mine.lesson, courseId: mine.course, answered: false }], write: "ok" });
      expect(await asMaestra.teacherComments(maestra.claims, { course: theirs.course, unanswered: false, before: null })).toMatchObject({ kind: "ready", items: [], write: null });
      expect(await asMaestra.teacherCommentCourses(maestra.claims)).toEqual({ kind: "ready", courses: [{ id: mine.course, title: expect.stringMatching(/^Curso /) }] });
      expect(await commentsAs(owner, ana).teacherComments(ana.claims, { course: null, unanswered: false, before: null })).toEqual({ kind: "not_teacher" });
    });
  });

  it("responde desde PA-45 por la misma entrada que la lección, y la respuesta lo deja respondido", async () => {
    const [maestra, ana] = [await person(), await person()];
    await reverted(async (owner) => {
      await asOwner(owner);
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
      const mine = await lessonIn(owner, await teacher(owner, maestra.id, randomUUID().slice(0, 8)), ana.id, { current: true, listed: true, state: "published" });
      await owner.query("set local session_replication_role = origin");
      const asMaestra = commentsAs(owner, maestra);
      const written = await asMaestra.postLessonComment(reader, { lessonId: mine.lesson, parentId: mine.comment, body: "Gracias por preguntar" });
      expect(written).toMatchObject({ kind: "written", state: "published" });
      expect(await asMaestra.teacherComments(maestra.claims, { course: null, unanswered: true, before: null })).toMatchObject({ kind: "ready", items: [] });
      const all = await asMaestra.teacherComments(maestra.claims, { course: null, unanswered: false, before: null });
      expect(all).toMatchObject({ kind: "ready", items: [{ id: mine.comment, answered: true, replies: { items: [{ own: true, teacher: true, body: "Gracias por preguntar" }] } }] });
    });
  });
});
