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

// T-405, quinta solicitud: las versiones de un curso publicado, contra la base. La cola con una versión en la lectura estricta de la aplicación (qué versión es y qué cambió), y tres
// carreras con dos conexiones de verdad: dos «Editar» a la vez abren una sola versión; descartar mientras un video del borrador se asienta no se interbloquea (asentar toma la fila del
// video y después el registro para compartir, como `video_settle` y `video_promote`); y descartar mientras se envía espera, y contesta que ya no se puede.
//
// Publicar y enviar son libros que no se borran: lo que esta prueba confirma lo quita al terminar con las guardias apagadas, como la 98, y los objetos de la cubeta con el permiso
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

/** Un video listo de una lección del borrador, con su original en la cubeta. Vigente, o en camino de reemplazarla. */
async function videoFor(course: string, lesson: string, state: "ready" | "processing" = "ready") {
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
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::public.draft_video_state, $6::boolean, 'clase.mp4', 'video/mp4', $7::text, 1000, $8::uuid, 'v1', 600, 'mux', $9::text,
             $10::text, $11::integer)`,
    [video, course, teacherId, lesson, state, state === "ready", path, object, `asset-${video}`, state === "ready" ? `play-${video}` : null, state === "ready" ? 600 : null],
  );
  return video;
}

/** Enviar lo que haya en el borrador, como el maestro. */
async function submit(client: Client, course: string) {
  await asServer(client, teacherProfile, teacherSession);
  const seen = await call(client, "private.course_submit_preview($1)", [course]);
  expect(seen.answer).toBe("ready");
  const sent = await call(client, "private.course_submit($1, $2, $3, $4::integer, $5::integer, $6::inet, $7)", [
    course,
    seen.annex!.id,
    seen.content_sha256,
    seen.term_years,
    seen.submission_no,
    "203.0.113.7",
    "Navegador de prueba",
  ]);
  await asOwner(client);
  return sent.answer;
}

const pending = async (course: string) =>
  (await owner.query<{ id: string }>("select id from public.course_reviews where course_id = $1 and result = 'pending'", [course])).rows[0]!.id;

/** Un curso publicado de una lección, con su video, y su versión abierta. */
async function publishedWithVersion(title: string) {
  const course = await inTx(owner, async () => {
    await asServer(owner, teacherProfile, teacherSession);
    const created = (await call(owner, "private.draft_create($1, $2)", [randomUUID(), title])).course!;
    courses.push(created);
    await call(owner, "private.draft_save_course($1, 1, $2, $3, $4, $5)", [created, title, "Un resumen.", practice, level]);
    const moduleId = (await call(owner, "private.draft_add_module($1, 1, $2)", [created, "Inicio"])).module!;
    const lesson = (await call(owner, "private.draft_add_lesson($1, $2, 1, $3)", [created, moduleId, "Primera"])).lesson!;
    await asOwner(owner);
    await videoFor(created, lesson);
    expect(await submit(owner, created)).toBe("submitted");
    return created;
  });
  const videos = (await owner.query<{ id: string }>("select id from public.draft_videos where course_id = $1 and is_current", [course])).rows.map((row) => row.id);
  expect(await inTx(owner, async () => storeOn(owner).approveSubmission(CLAIMS, { course, submission: await pending(course), captions: videos }))).toBe("approved");
  return course;
}

const open = async (client: Client, course: string) => {
  await asServer(client, teacherProfile, teacherSession);
  const answer = (await call(client, "private.course_version_open($1)", [course])).answer;
  await asOwner(client);
  return answer;
};

const discard = async (client: Client, course: string, seen: string) => {
  await asServer(client, teacherProfile, teacherSession);
  const answer = (await call(client, "private.course_version_discard($1, $2::bigint)", [course, seen])).answer;
  await asOwner(client);
  return answer;
};

const contentRevision = async (course: string) =>
  (await owner.query<{ revision: string }>("select content_revision::text as revision from public.course_drafts where course_id = $1", [course])).rows[0]!.revision;

const state = async (course: string) =>
  (
    await owner.query<{ registry: string; drafts: number }>(
      `select (select r.state::text || coalesce('/' || r.pending_version_state::text, '') from public.course_registry r where r.course_id = $1) as registry,
              (select count(*)::int from public.course_drafts d where d.course_id = $1) as drafts`,
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
    await owner.query("insert into public.published_teachers (teacher_id, slug, display_name) values ($1, $2, 'Maestra de la 100')", [teacherId, `maestra-${tag}`]);
    practice = (await owner.query<{ id: string }>("insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 10000, 1) returning id", [`versiones-${tag}`, `Versiones ${tag}`])).rows[0]!.id;
    level = (await owner.query<{ id: string }>("insert into public.levels (slug, name, position) values ($1, $2, 10000) returning id", [`versiones-${tag}`, `Versiones ${tag}`])).rows[0]!.id;
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

describe("una versión, en la lectura estricta de la aplicación", () => {
  it("la cola dice que es una versión, cuál, y qué cambió", async () => {
    const course = await publishedWithVersion("Respirar en la 100");
    expect(await inTx(owner, () => open(owner, course))).toBe("opened");
    await inTx(owner, async () => {
      const revision = (await owner.query<{ r: string }>("select revision::text as r from public.course_drafts where course_id = $1", [course])).rows[0]!.r;
      await asServer(owner, teacherProfile, teacherSession);
      expect((await call(owner, "private.draft_save_course($1, $2::bigint, $3, $4, $5, $6)", [course, revision, "Respirar mejor en la 100", "Un resumen.", practice, level])).answer).toBe("saved");
      await asOwner(owner);
      expect(await submit(owner, course)).toBe("submitted");
    });
    const queue = await inTx(owner, () => storeOn(owner).queue(CLAIMS));
    const row = queue?.courses.find((each) => each.courseId === course);
    expect(row?.submission).toMatchObject({ version: 2, isRevision: true, changes: { course: ["title"], lessonsAdded: [], lessonsRemoved: [] } });
  });
});

describe("dos a la vez, con dos conexiones de verdad", () => {
  it("dos «Editar» a la vez abren una sola versión", async () => {
    const course = await publishedWithVersion("Dos editar en la 100");
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      expect(await open(first, course)).toBe("opened");
      await second.query("begin");
      const waiting = open(second, course);
      await waitBehind(owner, first, 1);
      await first.query("commit");
      expect(await waiting).toBe("open");
      await second.query("commit");
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
    expect(await state(course)).toEqual({ registry: "changes_pending/draft", drafts: 1 });
  });

  it("descartar mientras un video de la versión se asienta: espera, y no se interbloquea", async () => {
    const course = await publishedWithVersion("Asentar en la 100");
    expect(await inTx(owner, () => open(owner, course))).toBe("opened");
    const lesson = (await owner.query<{ id: string }>("select id from public.draft_lessons where course_id = $1", [course])).rows[0]!.id;
    const arriving = await inTx(owner, () => videoFor(course, lesson, "processing"));
    const seen = await contentRevision(course);
    const first = await connect();
    const second = await connect();
    try {
      // Un asentado que ya tomó la fila del video (lo primero que hace `video_settle`); descartar llega en ese momento, y después el asentado termina de verdad, promoviendo
      // el video (`video_promote` pide el registro para compartir). Si descartar tomara el registro antes que los videos, aquí se interbloquearían.
      await first.query("begin");
      await first.query("select 1 from public.draft_videos where id = $1 for update", [arriving]);
      await second.query("begin");
      const waiting = discard(second, course, seen);
      await waitBehind(owner, first, 1);
      await asServer(first, teacherProfile, teacherSession);
      expect((await call(first, "private.video_settle($1, 'ready', $2, 600, true, null)", [arriving, `play-${arriving}`])).answer).toBe("ready");
      await asOwner(first);
      await first.query("commit");
      expect(await waiting).toBe("discarded");
      await second.query("commit");
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
    expect(await state(course)).toEqual({ registry: "published", drafts: 0 });
  });

  it("descartar mientras se envía: espera, y contesta que ya no se puede", async () => {
    const course = await publishedWithVersion("Enviar y descartar en la 100");
    expect(await inTx(owner, () => open(owner, course))).toBe("opened");
    const seen = await contentRevision(course);
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      expect(await submit(first, course)).toBe("submitted");
      await second.query("begin");
      const waiting = discard(second, course, seen);
      await waitBehind(owner, first, 1);
      await first.query("commit");
      expect(await waiting).toBe("not_editable");
      await second.query("commit");
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
    expect(await state(course)).toEqual({ registry: "changes_pending/in_review", drafts: 1 });
  });
});
