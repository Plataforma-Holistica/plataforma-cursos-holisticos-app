import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createReviewStore } from "@/services/review/store";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-405, cuarta solicitud: aprobar lo enviado, contra la base. El almacén de la aplicación en su lectura estricta: los videos que se le preguntan a Mux, la cola con lo que espera
// subtítulos, y aprobar, que publica desde la fotografía y borra el borrador. Y aprobar mientras alguien suspende al maestro, con dos conexiones de verdad: aprobar espera la fila del
// maestro, y contesta que está suspendido.
//
// Publicar y enviar son libros que no se borran: lo que esta prueba confirma lo quita al terminar con las guardias apagadas, como la 96, y los objetos de la cubeta con el permiso
// de Storage. La auditoría se queda. Pide los borradores legales (`db:drafts`) y la marca de los videos de prueba (`db:login`).

let owner: Client;
let teacherProfile: string;
let reviewerProfile: string;
let teacherId: string;
let practice: string;
let level: string;
const teacherSession = randomUUID();
const emails: string[] = [];
const courses: string[] = [];
const objects: string[] = [];

async function inTx<T>(client: Client, work: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

type Answer = Record<string, string> & { annex?: { id: string } };
const call = async (client: Client, text: string, params: unknown[]): Promise<Answer> => (await client.query<{ r: Answer }>(`select ${text} as r`, params)).rows[0]!.r;

const txOn = (client: Client): Tx => ({
  query: async (query, row) => (await client.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await client.query(query.text, [...query.values])).rowCount ?? 0,
});

/** El almacén de la aplicación, sobre una transacción de esa conexión y a nombre de quien revisa. */
function storeOn(client: Client) {
  const run = (async (_actor: unknown, work: (tx: Tx) => Promise<unknown>) => {
    await asServer(client, reviewerProfile, reviewerSession);
    try {
      return await work(txOn(client));
    } finally {
      await asOwner(client);
    }
  }) as unknown as Parameters<typeof createReviewStore>[0];
  return createReviewStore(run);
}

const CLAIMS = {} as VerifiedClaims;
let reviewerSession = "";

/** Un curso enviado de una lección, con su video, su original en la cubeta y un recurso. */
async function sentCourse(title: string) {
  return inTx(owner, async () => {
    await asServer(owner, teacherProfile, teacherSession);
    const course = (await call(owner, "private.draft_create($1, $2)", [randomUUID(), title])).course!;
    courses.push(course);
    await call(owner, "private.draft_save_course($1, 1, $2, $3, $4, $5)", [course, title, "Un resumen.", practice, level]);
    const moduleId = (await call(owner, "private.draft_add_module($1, 1, $2)", [course, "Inicio"])).module!;
    const lesson = (await call(owner, "private.draft_add_lesson($1, $2, 1, $3)", [course, moduleId, "Primera"])).lesson!;
    await asOwner(owner);
    const video = randomUUID();
    const path = `${teacherId}/${course}/${video}`;
    const object = (
      await owner.query<{ id: string }>(
        "insert into storage.objects (bucket_id, name, version, metadata) values ('video-originals', $1, 'v1', '{\"size\": 1000, \"mimetype\": \"video/mp4\"}') returning id",
        [path],
      )
    ).rows[0]!.id;
    objects.push(object);
    await owner.query(
      `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                        provider, provider_asset_id, provider_playback_id, duration_seconds)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, $6::uuid, 'v1', 600, 'mux', $7::text, $8::text, 600)`,
      [video, course, teacherId, lesson, path, object, `asset-${video}`, `play-${video}`],
    );
    await asServer(owner, teacherProfile, teacherSession);
    const seen = await call(owner, "private.course_submit_preview($1)", [course]);
    expect(seen.answer).toBe("ready");
    const sent = await call(owner, "private.course_submit($1, $2, $3, $4::integer, $5::integer, $6::inet, $7)", [
      course,
      seen.annex!.id,
      seen.content_sha256,
      seen.term_years,
      seen.submission_no,
      "203.0.113.7",
      "Navegador de prueba",
    ]);
    expect(sent.answer).toBe("submitted");
    await asOwner(owner);
    const submission = (await owner.query<{ id: string }>("select id from public.course_reviews where course_id = $1 and result = 'pending'", [course])).rows[0]!.id;
    return { course, lesson, video, submission };
  });
}

const state = async (course: string) =>
  (
    await owner.query<{ registry: string; review: string; published: number; drafts: number; original: string | null }>(
      `select (select r.state::text from public.course_registry r where r.course_id = $1) as registry,
              (select c.result::text from public.course_reviews c where c.course_id = $1 order by c.submission_no desc limit 1) as review,
              (select count(*)::int from public.published_lessons l where l.course_id = $1) as published,
              (select count(*)::int from public.course_drafts d where d.course_id = $1) as drafts,
              (select a.original_path from public.video_assets a where a.course_id = $1) as original`,
      [course],
    )
  ).rows[0]!;

beforeAll(async () => {
  owner = await connect();
  await owner.query("grant app_service to postgres with set true, inherit false");
  const teacher = await claimedUser();
  const reviewer = await claimedUser();
  emails.push(teacher.email, reviewer.email);
  for (const person of [teacher, reviewer]) await completeAccountAsOwner(person.id);
  teacherProfile = teacher.id;
  reviewerProfile = reviewer.id;
  const jar = memoryJar();
  const entered = await testServices().signIn(jar, reviewer, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  reviewerSession = readVerifiedClaims(check.claims).claims.sessionId ?? "";
  await inTx(owner, async () => {
    await asSystem(owner);
    teacherId = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [teacher.id])).rows[0]!.id;
    const tag = randomUUID().slice(0, 8);
    await owner.query("insert into public.published_teachers (teacher_id, slug, display_name) values ($1, $2, 'Maestra de la 98')", [teacherId, `maestra-${tag}`]);
    practice = (await owner.query<{ id: string }>("insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 9800, 1) returning id", [`publicar-${tag}`, `Publicar ${tag}`])).rows[0]!.id;
    level = (await owner.query<{ id: string }>("insert into public.levels (slug, name, position) values ($1, $2, 9800) returning id", [`publicar-${tag}`, `Publicar ${tag}`])).rows[0]!.id;
    await owner.query("select set_config('app.actor_id', $1, true)", [teacher.id]);
    await owner.query(
      "insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')",
      [teacher.id],
    );
    await asOwner(owner);
    // Con Contenido y un código de hace un momento. Con las guardias apagadas: la 02 y la 12 cuentan los renglones de auditoría de las capacidades y de los factores.
    await owner.query("set local session_replication_role = replica");
    await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'content')", [reviewer.id]);
    const factor = randomUUID();
    await owner.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values ($1, $2, 'equipo', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')", [factor, reviewer.id]);
    await owner.query("update auth.sessions set aal = 'aal2', factor_id = $1 where id = $2", [factor, reviewerSession]);
    await owner.query("insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at) values (gen_random_uuid(), $1, 'totp', now(), now())", [reviewerSession]);
    await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [reviewer.id, factor, reviewer.email.toLowerCase()]);
  });
});

afterAll(async () => {
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query("set local storage.allow_delete_query = 'true'");
  await owner.query("delete from public.published_resources where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.published_lessons where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.published_modules where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.published_courses where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.video_assets where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.licenses where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.course_reviews where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.draft_videos where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from private.video_trash where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.draft_lessons where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.draft_modules where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.course_drafts where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.course_registry where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from storage.objects where id = any($1::uuid[])", [objects]);
  await owner.query("delete from public.practices where id = $1", [practice]);
  await owner.query("delete from public.levels where id = $1", [level]);
  await owner.query("delete from public.published_teachers where teacher_id = $1", [teacherId]);
  await owner.query("delete from public.teachers where id = $1", [teacherId]);
  await owner.query("delete from private.admin_factors where profile_id = $1", [reviewerProfile]);
  await owner.query("delete from public.admin_capabilities where profile_id = $1", [reviewerProfile]);
  await owner.query("commit");
  await owner.query("revoke app_service from postgres");
  await owner.end();
  await deleteTestUsersByEmail(emails);
});

describe("aprobar lo enviado, en la lectura estricta de la aplicación", () => {
  it("los videos para Mux, lo que espera subtítulos, y aprobar publica y borra el borrador", async () => {
    const { course, lesson, video, submission } = await sentCourse("Respirar en la 98");
    const store = storeOn(owner);
    expect(await inTx(owner, () => store.approveAssets(CLAIMS, { course, submission }))).toEqual({
      kind: "ok",
      assets: [{ video, lesson, provider: "mux", asset: `asset-${video}`, playback: `play-${video}` }],
    });
    const queue = await inTx(owner, () => store.queue(CLAIMS));
    expect(queue?.courses.find((each) => each.courseId === course)?.submission?.captionsMissing).toEqual([lesson]);

    // Sin los subtítulos que Mux dijo, no; con ellos, sí.
    expect(await inTx(owner, () => store.approveSubmission(CLAIMS, { course, submission, captions: [] }))).toBe("captions_pending");
    expect(await inTx(owner, () => store.approveSubmission(CLAIMS, { course, submission: randomUUID(), captions: [video] }))).toBe("changed");
    expect(await state(course)).toMatchObject({ registry: "in_review", review: "pending", published: 0, drafts: 1 });
    expect(await inTx(owner, () => store.approveSubmission(CLAIMS, { course, submission, captions: [video] }))).toBe("approved");
    expect(await state(course)).toEqual({ registry: "published", review: "approved", published: 1, drafts: 0, original: `${teacherId}/${course}/${video}` });
    expect(await inTx(owner, () => store.approveAssets(CLAIMS, { course, submission }))).toEqual({ kind: "not_pending" });
  });

  it("aprobar mientras alguien suspende al maestro: espera su fila, y no publica", async () => {
    const { course, video, submission } = await sentCourse("A la vez en la 98");
    const first = await connect();
    const second = await connect();
    try {
      // Suspender toma la fila del maestro para cambiarla, como `suspend_teacher`.
      await first.query("begin");
      await asSystem(first);
      await first.query("update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba', suspension_notice = 'Prueba' where id = $1", [teacherId]);
      await second.query("begin");
      const waiting = storeOn(second).approveSubmission(CLAIMS, { course, submission, captions: [video] });
      await waitBehind(owner, first, 1);
      await first.query("commit");
      expect(await waiting).toBe("teacher_suspended");
      await second.query("commit");
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
      await inTx(owner, async () => {
        await asSystem(owner);
        await owner.query("update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = $1", [teacherId]);
        await asOwner(owner);
      });
    }
    expect(await state(course)).toMatchObject({ registry: "in_review", review: "pending", published: 0, drafts: 1 });
  });
});
