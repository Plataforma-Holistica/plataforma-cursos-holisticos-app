import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { commentTextOk } from "@/domain/comments/comment-text";
import { commentsStoreOn, createComments } from "@/services/comments/comments";
import { testModeration } from "@/services/comments/moderation";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { asOwner, asServer, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-501, segunda solicitud: el servicio de los comentarios contra la base, por el almacén de la aplicación (`commentsStoreOn`)
// sobre una transacción del dueño que se revierte. La base no mira el acceso: aquí se intenta, uno por uno, lo que no debe
// pasar, y lo que pasa. Y la regla del texto de TypeScript contra `private.comment_text_ok` en todos los puntos de código.
//
// Pide las marcas locales `comments_accept` y `comments_test_filter` (las pone `db:login`).

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

/** El servicio sobre esa transacción, con el almacén de la aplicación y la guarda que deja pasar a `who`. */
function commentsAs(owner: Client, who: Person) {
  const reported: string[] = [];
  const store = commentsStoreOn(async (claims, _reason, work) => {
    const { claims: verified } = readVerifiedClaims(claims);
    await asServer(owner, verified.userId, verified.sessionId ?? "");
    try {
      return await work(txOn(owner));
    } finally {
      await asOwner(owner);
    }
  });
  const service = createComments({
    store,
    checkSession: () => Promise.resolve({ kind: "pass", claims: who.claims }),
    report: (code) => (reported.push(code), Promise.resolve()),
    // El proveedor de prueba del filtro (T-502): la base solo acepta su aprobado con la marca local que pone `db:login`.
    moderation: () => testModeration,
  });
  return { ...service, reported };
}
const reader = {} as CookieReader;

/** Un curso publicado y listado de una lección, de ese maestro. */
async function course(owner: Client, teacherId: string, tag: string, open = false): Promise<{ course: string; lesson: string }> {
  const course = (
    await owner.query<{ id: string }>(
      "insert into public.course_registry (teacher_id, state, first_published_at, is_open, open_since) values ($1, 'published', now(), $2, case when $2 then now() end) returning course_id as id",
      [teacherId, open],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_courses (course_id, teacher_id, slug, title, teacher_name, lesson_count, total_duration_seconds, is_listed, is_open)
     values ($1, $2, $3, 'Curso de la 102', 'Maestra de la 102', 1, 100, true, $4)`,
    [course, teacherId, `comentarios-102-${tag}`, open],
  );
  const moduleId = randomUUID();
  await owner.query("insert into public.published_modules (id, course_id, title, position) values ($1, $2, 'Módulo', 1)", [moduleId, course]);
  const lesson = randomUUID();
  const video = (
    await owner.query<{ id: string }>(
      `insert into public.video_assets (course_id, teacher_id, lesson_id, provider, status, duration_seconds, provider_asset_id, provider_playback_id)
       values ($1, $2, $3, 'test', 'ready', 100, $4, $4) returning id`,
      [course, teacherId, lesson, `comentarios-102-${tag}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
     values ($1, $2, $3, $4, $5, 'Lección', 1, 100)`,
    [lesson, course, moduleId, teacherId, video],
  );
  return { course, lesson };
}

async function teacher(owner: Client, profile: string | null, tag: string): Promise<string> {
  // Sin cuenta, la base solo lo acepta invitado (`teachers_active_has_profile`).
  const id = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, $2) returning id", [profile, profile === null ? "invited" : "active"])).rows[0]!.id;
  await owner.query("insert into public.published_teachers (teacher_id, slug, display_name, is_listed) values ($1, $2, 'Maestra de la 102', true)", [id, `maestra-102-${tag}`]);
  return id;
}

/**
 * El mundo de cada caso, en la transacción que se revierte: el interruptor prendido; una maestra sin cuenta con un curso
 * cerrado (`closed`) y el abierto (`open`); y Teo, maestro con cuenta, su aviso al día y sin suscripción, con el suyo (`own`).
 */
async function world(owner: Client, teo: Person) {
  const tag = randomUUID().slice(0, 8);
  await asOwner(owner);
  await owner.query("set local session_replication_role = replica");
  await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
  // Si ya había un curso abierto, deja de serlo: solo hay uno.
  await owner.query("update public.course_registry set is_open = false, open_since = null where is_open");
  await owner.query("update public.published_courses set is_open = false where is_open");
  const scripted = await teacher(owner, null, `${tag}-a`);
  const closed = await course(owner, scripted, `${tag}-a`);
  const open = await course(owner, scripted, `${tag}-o`, true);
  const teoId = await teacher(owner, teo.id, `${tag}-t`);
  const own = await course(owner, teoId, `${tag}-t`);
  // El aviso del maestro: una base sin borradores no lo trae.
  await owner.query(
    `insert into public.legal_documents (doc_type, version, title, body, effective_from)
     select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
     where private.current_legal_document('teacher_privacy_notice') is null`,
  );
  await owner.query("insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')", [teo.id]);
  await owner.query("set local session_replication_role = origin");
  return { closed: closed.lesson, open: open.lesson, own: own.lesson };
}

async function subscribe(owner: Client, profile: string): Promise<void> {
  await owner.query(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
    [profile],
  );
}

/** Un comentario publicado de `author` en `lesson`, escrito a mano (sin el servicio ni la regla). */
async function planted(owner: Client, lesson: string, author: string, body: string): Promise<string> {
  await asOwner(owner);
  await owner.query("set local session_replication_role = replica");
  const id = (
    await owner.query<{ id: string }>(
      `insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, status, filter_verdict, filter_provider)
       select l.id, l.course_id, l.teacher_id, $2, $3, 'published', 'pass', 'test' from public.published_lessons l where l.id = $1 returning id`,
      [lesson, author, body],
    )
  ).rows[0]!.id;
  await owner.query("set local session_replication_role = origin");
  return id;
}

const bodyOf = async (owner: Client, comment: string) =>
  (await owner.query<{ body: string | null }>("select body from public.comments where id = $1", [comment])).rows[0]?.body;
const countIn = async (owner: Client, lesson: string) =>
  Number((await owner.query<{ n: string }>("select count(*)::text as n from public.comments where lesson_id = $1", [lesson])).rows[0]!.n);

describe("el servicio de los comentarios contra la base (T-501)", () => {
  it("las marcas locales están puestas", async () => {
    const owner = new Client({ connectionString: localOwnerUrl() });
    await owner.connect();
    try {
      const flags = (await owner.query<{ flag: string }>("select flag from private.local_flags where flag in ('comments_accept', 'comments_test_filter') order by flag")).rows;
      expect(flags.map((row) => row.flag)).toEqual(["comments_accept", "comments_test_filter"]);
    } finally {
      await owner.end();
    }
  });

  it("con suscripción se lee y se escribe, y el portón dice lo que falta", async () => {
    const [ana, teo] = [await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      await subscribe(owner, ana.id);
      const service = commentsAs(owner, ana);
      expect(await service.lessonComments(ana.claims, lessons.closed, null)).toMatchObject({ kind: "ready", items: [], write: { kind: "gate", answer: "needs_pseudonym" } });
      expect(await service.chooseCommentName(reader, "Ana de la 102")).toEqual({ kind: "saved", pseudonym: "Ana de la 102" });
      const posted = await service.postLessonComment(reader, { lessonId: lessons.closed, parentId: null, body: "Hola\r\na todos" });
      expect(posted).toMatchObject({ kind: "written", state: "published" });
      const read = await service.lessonComments(ana.claims, lessons.closed, null);
      expect(read).toMatchObject({ kind: "ready", count: 1, me: { teacher: false, pseudonym: "Ana de la 102" }, write: { kind: "ok" } });
      if (read.kind !== "ready" || posted.kind !== "written") throw new Error("sin leer");
      expect(read.items.map((item) => [item.body, item.own, item.revision])).toEqual([["Hola\na todos", true, 1]]);
      expect(await service.editLessonComment(reader, { commentId: posted.id, body: "Hola otra vez", revision: 1 })).toMatchObject({ kind: "written" });
      expect(await service.editLessonComment(reader, { commentId: posted.id, body: "Con la de antes", revision: 1 })).toEqual({ kind: "changed" });
      expect(await service.commentReplies(ana.claims, lessons.closed, posted.id, null)).toEqual({ kind: "ready", items: [], next: null });
      expect(service.reported).toEqual([]);
    });
  });

  it("sin suscripción, en un curso que no es el abierto: ni se lee ni se escribe, y no sale ningún texto", async () => {
    const [ana, beto, teo] = [await person(), await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      const comment = await planted(owner, lessons.closed, ana.id, "Lo que Beto no debe leer");
      const own = await planted(owner, lessons.closed, beto.id, "Lo que Beto escribió cuando pagaba");
      const service = commentsAs(owner, beto);
      const refused = { kind: "no_access", account: { allowed: false, reason: "never_subscribed" } };
      expect(await service.lessonComments(beto.claims, lessons.closed, null)).toEqual(refused);
      expect(await service.commentReplies(beto.claims, lessons.closed, comment, null)).toEqual(refused);
      expect(await service.postLessonComment(reader, { lessonId: lessons.closed, parentId: null, body: "Sin pagar" })).toEqual(refused);
      expect(await service.postLessonComment(reader, { lessonId: lessons.closed, parentId: comment, body: "Sin pagar" })).toEqual(refused);
      expect(await service.editLessonComment(reader, { commentId: own, body: "Editado sin pagar", revision: 1 })).toEqual(refused);
      expect(await bodyOf(owner, own)).toBe("Lo que Beto escribió cuando pagaba");
      expect(await countIn(owner, lessons.closed)).toBe(2);
      // Lo suyo lo borra igual, y elige su seudónimo: piden solo la sesión.
      expect(await service.deleteLessonComment(reader, { commentId: own, revision: 1 })).toEqual({ kind: "deleted" });
      expect(await service.chooseCommentName(reader, "Beto")).toEqual({ kind: "saved", pseudonym: "Beto" });
      expect(service.reported).toEqual([]);
    });
  });

  it("el curso abierto sin suscripción se lee y no se escribe, y con el correo sin verificar tampoco se lee", async () => {
    const [ana, beto, teo] = [await person(), await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      const comment = await planted(owner, lessons.open, ana.id, "En el abierto");
      const own = await planted(owner, lessons.open, beto.id, "De Beto en el abierto");
      const service = commentsAs(owner, beto);
      expect(await service.chooseCommentName(reader, "Beto")).toMatchObject({ kind: "saved" });
      const read = await service.lessonComments(beto.claims, lessons.open, null);
      expect(read).toMatchObject({ kind: "ready", count: 2, write: { kind: "read_only" } });
      expect(await service.postLessonComment(reader, { lessonId: lessons.open, parentId: null, body: "Sin pagar" })).toEqual({ kind: "read_only" });
      expect(await service.postLessonComment(reader, { lessonId: lessons.open, parentId: comment, body: "Sin pagar" })).toEqual({ kind: "read_only" });
      expect(await service.editLessonComment(reader, { commentId: own, body: "Editado", revision: 1 })).toEqual({ kind: "read_only" });
      expect(await countIn(owner, lessons.open)).toBe(2);
      expect(await bodyOf(owner, own)).toBe("De Beto en el abierto");
      await owner.query("update auth.users set email_confirmed_at = null where id = $1", [beto.id]);
      expect(await service.lessonComments(beto.claims, lessons.open, null)).toEqual({ kind: "no_access", account: { allowed: false, reason: "never_subscribed" } });
      expect(service.reported).toEqual([]);
    });
  });

  it("si no se sabe si la cuenta tiene acceso, no se lee ni se escribe, también en el abierto, y se reporta", async () => {
    const [ana, teo] = [await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      // Una renovación que falló cuando todavía no existía la gracia: la regla de la cuenta contesta «no se supo».
      await owner.query(
        `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end, last_renewal_failed_at)
         values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'in_grace', 'MXN', '1999-12-01', '2000-01-01', '2000-01-01')`,
        [ana.id],
      );
      const service = commentsAs(owner, ana);
      expect(await service.chooseCommentName(reader, "Ana")).toMatchObject({ kind: "saved" });
      for (const lesson of [lessons.closed, lessons.open]) {
        expect(await service.lessonComments(ana.claims, lesson, null)).toEqual({ kind: "unavailable" });
        expect(await service.postLessonComment(reader, { lessonId: lesson, parentId: null, body: "¿Pasa?" })).toEqual({ kind: "unavailable" });
        expect(await countIn(owner, lesson)).toBe(0);
      }
      expect(service.reported).toEqual(Array(4).fill("comments_unavailable"));
    });
  });

  it("la cuenta suspendida no lee ni escribe", async () => {
    const [ana, teo] = [await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      await subscribe(owner, ana.id);
      const own = await planted(owner, lessons.closed, ana.id, "Antes de la suspensión");
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba de la 102' where id = $1", [ana.id]);
      await owner.query("set local session_replication_role = origin");
      const service = commentsAs(owner, ana);
      expect(await service.lessonComments(ana.claims, lessons.closed, null)).toEqual({ kind: "suspended_account" });
      expect(await service.postLessonComment(reader, { lessonId: lessons.closed, parentId: null, body: "Suspendida" })).toEqual({ kind: "suspended_account" });
      expect(await service.editLessonComment(reader, { commentId: own, body: "Suspendida", revision: 1 })).toEqual({ kind: "suspended_account" });
      expect(await bodyOf(owner, own)).toBe("Antes de la suspensión");
    });
  });

  it("el maestro escribe en lo suyo sin suscripción, y no edita con la lección de su curso lo que tiene en otro", async () => {
    const [ana, teo] = [await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      const service = commentsAs(owner, teo);
      expect(await service.lessonComments(teo.claims, lessons.own, null)).toMatchObject({ kind: "ready", me: { teacher: true }, write: { kind: "ok" } });
      expect(await service.postLessonComment(reader, { lessonId: lessons.own, parentId: null, body: "Bienvenidos" })).toMatchObject({ kind: "written", state: "published" });
      // Lo que Teo tiene en el curso de otra maestra, de cuando pagaba: con su lección se decide, y ahí no tiene acceso.
      const elsewhere = await planted(owner, lessons.closed, teo.id, "De Teo en otro curso");
      expect(await service.editLessonComment(reader, { commentId: elsewhere, body: "Editado desde lo mío", revision: 1 })).toEqual({
        kind: "no_access",
        account: { allowed: false, reason: "never_subscribed" },
      });
      expect(await bodyOf(owner, elsewhere)).toBe("De Teo en otro curso");
      // Lo de un alumno en su lección no es suyo: no existe para él.
      const foreign = await planted(owner, lessons.own, ana.id, "De Ana en el curso de Teo");
      expect(await service.editLessonComment(reader, { commentId: foreign, body: "Lo cambió el maestro", revision: 1 })).toEqual({ kind: "not_found" });
      expect(await service.deleteLessonComment(reader, { commentId: foreign, revision: 1 })).toEqual({ kind: "not_found" });
      expect(await bodyOf(owner, foreign)).toBe("De Ana en el curso de Teo");
      expect(service.reported).toEqual([]);
    });
  });

  it("con el veto se lee y no se escribe; con suscripción, el correo sin verificar escribe; y una lección sin listar no existe", async () => {
    const [ana, beto, teo] = [await person(), await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      await subscribe(owner, ana.id);
      await subscribe(owner, beto.id);
      const vetoed = commentsAs(owner, ana);
      expect(await vetoed.chooseCommentName(reader, "Ana")).toMatchObject({ kind: "saved" });
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.profiles set comment_ban_until = now() + interval '1 day' where id = $1", [ana.id]);
      await owner.query("set local session_replication_role = origin");
      expect(await vetoed.lessonComments(ana.claims, lessons.closed, null)).toMatchObject({ kind: "ready", write: { kind: "gate", answer: "banned" } });
      expect(await vetoed.postLessonComment(reader, { lessonId: lessons.closed, parentId: null, body: "Con el veto" })).toEqual({ kind: "gate", answer: "banned" });
      expect(await vetoed.chooseCommentName(reader, "Ana otra")).toEqual({ kind: "banned" });
      expect(await countIn(owner, lessons.closed)).toBe(0);
      // RN-01: con suscripción, el correo sin verificar no quita el acceso.
      await owner.query("update auth.users set email_confirmed_at = null where id = $1", [beto.id]);
      const unverified = commentsAs(owner, beto);
      expect(await unverified.chooseCommentName(reader, "Beto")).toMatchObject({ kind: "saved" });
      expect(await unverified.postLessonComment(reader, { lessonId: lessons.closed, parentId: null, body: "Sin verificar" })).toMatchObject({ kind: "written" });
      expect(await countIn(owner, lessons.closed)).toBe(1);
      // Sin listar, la lección no existe: ni se lee ni se escribe, y no es una contradicción de la base.
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.published_courses set is_listed = false where course_id = (select course_id from public.published_lessons where id = $1)", [lessons.closed]);
      await owner.query("set local session_replication_role = origin");
      expect(await unverified.lessonComments(beto.claims, lessons.closed, null)).toEqual({ kind: "not_found" });
      expect(await unverified.postLessonComment(reader, { lessonId: lessons.closed, parentId: null, body: "Sin listar" })).toEqual({ kind: "not_found" });
      expect(await countIn(owner, lessons.closed)).toBe(1);
      expect([...vetoed.reported, ...unverified.reported]).toEqual([]);
    });
  });

  it("una lección que no existe o un cursor sin forma no le sacan nada a la base", async () => {
    const [ana, teo] = [await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      await subscribe(owner, ana.id);
      const service = commentsAs(owner, ana);
      expect(await service.lessonComments(ana.claims, randomUUID(), null)).toEqual({ kind: "not_found" });
      // Con un comentario, para que se note si el cursor se usó: uno de antes de todo lo dejaría fuera.
      const newest = await planted(owner, lessons.closed, ana.id, "El más reciente");
      for (const cursor of ["2026-11-07T20:00:00Z_no-es-un-id", `2026-02-30T00:00:00Z_${randomUUID()}`, `0001-01-01T00:00:00Z_${randomUUID()}`]) {
        expect(await service.lessonComments(ana.claims, lessons.closed, cursor)).toMatchObject({ kind: "ready", items: [{ id: newest }] });
      }
      // Y uno con forma, de antes de todo, sí se usa: no queda nada.
      expect(await service.lessonComments(ana.claims, lessons.closed, `2001-01-01T00:00:00Z_${randomUUID()}`)).toMatchObject({ kind: "ready", items: [] });
    });
  });
});

const reportsOf = async (owner: Client, comment: string) =>
  (await owner.query<{ reporter_id: string; counts: boolean }>("select reporter_id, counts from public.comment_reports where comment_id = $1 order by created_at, reporter_id", [comment])).rows;

describe("reportar contra la base: si cuenta lo decide la regla (T-502; RF-803)", () => {
  it("en el curso abierto, quien lee sin suscripción reporta y no cuenta; con suscripción, cuenta", async () => {
    const [ana, beto, cata, teo] = [await person(), await person(), await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      await subscribe(owner, cata.id);
      const comment = await planted(owner, lessons.open, ana.id, "En el abierto");
      expect(await commentsAs(owner, beto).reportLessonComment(reader, { commentId: comment, reason: "spam", note: null })).toEqual({ kind: "reported" });
      expect(await commentsAs(owner, cata).reportLessonComment(reader, { commentId: comment, reason: "abusive", note: "Un insulto" })).toEqual({ kind: "reported" });
      const rows = await reportsOf(owner, comment);
      expect(Object.fromEntries(rows.map((row) => [row.reporter_id, row.counts]))).toEqual({ [beto.id]: false, [cata.id]: true });
      expect((await owner.query<{ report_count: number }>("select report_count from public.comments where id = $1", [comment])).rows[0]!.report_count).toBe(1);
    });
  });

  it("sin suscripción, en un curso que no es el abierto, no se lee y no se reporta", async () => {
    const [ana, beto, teo] = [await person(), await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      const comment = await planted(owner, lessons.closed, ana.id, "En el cerrado");
      expect(await commentsAs(owner, beto).reportLessonComment(reader, { commentId: comment, reason: "spam", note: null })).toEqual({
        kind: "no_access",
        account: { allowed: false, reason: "never_subscribed" },
      });
      expect(await reportsOf(owner, comment)).toEqual([]);
    });
  });

  it("el maestro reporta en lo suyo y cuenta; lo que no está publicado no existe", async () => {
    const [ana, teo] = [await person(), await person()];
    await reverted(async (owner) => {
      const lessons = await world(owner, teo);
      const comment = await planted(owner, lessons.own, ana.id, "En el curso de Teo");
      expect(await commentsAs(owner, teo).reportLessonComment(reader, { commentId: comment, reason: "medical_advice", note: null })).toEqual({ kind: "reported" });
      expect((await reportsOf(owner, comment)).map((row) => row.counts)).toEqual([true]);
      await owner.query("set local session_replication_role = replica");
      await owner.query("update public.comments set status = 'in_review', filter_verdict = 'flagged' where id = $1", [comment]);
      await owner.query("set local session_replication_role = origin");
      expect(await commentsAs(owner, teo).reportLessonComment(reader, { commentId: comment, reason: "spam", note: null })).toEqual({ kind: "not_found" });
    });
  });
});

describe("la regla del texto es la de la base, en todos los puntos de código", () => {
  const LAST = 0x10ffff;
  const codePoints = Array.from({ length: LAST }, (_, index) => index + 1).filter((n) => n < 0xd800 || n > 0xdfff);
  const ZWJ = 0x200d;
  const contexts = [
    { name: "solo, en una línea", sql: "chr(n)", js: (c: string) => c, max: 40, multiline: false },
    { name: "entre letras, en varias líneas", sql: "'a' || chr(n) || 'b'", js: (c: string) => `a${c}b`, max: 4000, multiline: true },
    { name: "entre letras, en una línea", sql: "'a' || chr(n) || 'b'", js: (c: string) => `a${c}b`, max: 40, multiline: false },
    { name: "después de la unión", sql: `'a' || chr(${ZWJ}) || chr(n) || 'b'`, js: (c: string) => `a\u{200d}${c}b`, max: 4000, multiline: true },
    { name: "antes de la unión", sql: `'a' || chr(n) || chr(${ZWJ}) || 'b'`, js: (c: string) => `a${c}\u{200d}b`, max: 4000, multiline: true },
  ];

  it.each(contexts)("$name", async (context) => {
    const owner = new Client({ connectionString: localOwnerUrl() });
    await owner.connect();
    let bits: string;
    try {
      bits = (
        await owner.query<{ bits: string }>(
          `select string_agg(case when private.comment_text_ok(${context.sql}, $1, $2) then '1' else '0' end, '' order by n) as bits
           from generate_series(1, ${LAST}) n where n not between 55296 and 57343`,
          [context.max, context.multiline],
        )
      ).rows[0]!.bits;
    } finally {
      await owner.end();
    }
    expect(bits.length).toBe(codePoints.length);
    const differ: string[] = [];
    codePoints.forEach((n, index) => {
      const mine = commentTextOk(context.js(String.fromCodePoint(n)), context.max, context.multiline) ? "1" : "0";
      if (mine !== bits[index] && differ.length < 20) differ.push(`U+${n.toString(16).toUpperCase().padStart(4, "0")} (base ${bits[index]})`);
    });
    expect(differ).toEqual([]);
  }, 600_000);
});
