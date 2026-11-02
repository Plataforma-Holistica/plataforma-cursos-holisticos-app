import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimedUser } from "./helpers/account";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-405, primera solicitud: enviar contra lo que corre a la vez, con dos conexiones de verdad. Lo que una transacción revertida no puede mostrar: lo que se firma se lee después
// de tomar la fila del registro, y por eso un video que se promueve o una práctica que se desactiva mientras tanto no terminan en una firma de algo que ya no es.
//
// Enviar es un libro que no se borra: lo que esta prueba confirma lo quita al terminar con las guardias apagadas (`session_replication_role = replica`), como la 58. La
// auditoría se queda. Pide los borradores legales (`db:drafts`), con su marca: el anexo de la versión 0.

let owner: Client;
let teacherProfile: string;
let teacherId: string;
let practice: string;
let level: string;
const session = randomUUID();
const emails: string[] = [];
const courses: string[] = [];

type Answer = { answer: string; missing?: { what: string }[]; annex?: { id: string }; content_sha256?: string; term_years?: number; submission_no?: number };

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

const asTeacher = (client: Client) => asServer(client, teacherProfile, session);

async function call(client: Client, text: string, params: unknown[]): Promise<Answer> {
  return (await client.query<{ r: Answer }>(`select ${text} as r`, params)).rows[0]!.r;
}

/** Un curso listo para enviar, con un video vigente en su única lección. Devuelve el curso, la lección y lo que dice la vista previa. */
async function readyCourse() {
  const ids = await inTx(owner, async () => {
    await asTeacher(owner);
    const created = await call(owner, "private.draft_create($1, $2)", [randomUUID(), "Curso de la carrera"]);
    const course = (created as unknown as { course: string }).course;
    courses.push(course);
    await call(owner, "private.draft_save_course($1, 1, $2, $3, $4, $5)", [course, "Curso de la carrera", "Un resumen.", practice, level]);
    const added = await call(owner, "private.draft_add_module($1, 1, $2)", [course, "Inicio"]);
    const moduleId = (added as unknown as { module: string }).module;
    const lessonAdded = await call(owner, "private.draft_add_lesson($1, $2, 1, $3)", [course, moduleId, "Primera"]);
    const lesson = (lessonAdded as unknown as { lesson: string }).lesson;
    await asOwner(owner);
    const video = await insertVideo(course, lesson, "ready", true);
    return { course, lesson, video };
  });
  const preview = await inTx(owner, async () => {
    await asTeacher(owner);
    const seen = await call(owner, "private.course_submit_preview($1)", [ids.course]);
    await asOwner(owner);
    return seen;
  });
  expect(preview.answer).toBe("ready");
  return { ...ids, preview };
}

async function insertVideo(course: string, lesson: string, state: "ready" | "processing", current: boolean): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                      provider, provider_asset_id, provider_playback_id, duration_seconds)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::public.draft_video_state, $6::boolean, 'clase.mp4', 'video/mp4', $7::text, 1000, gen_random_uuid(), 'v1', 600, 'mux', $8::text,
             $9::text, $10::integer)`,
    [id, course, teacherId, lesson, state, current, `carrera/${id}`, `asset-${id}`, state === "ready" ? `play-${id}` : null, state === "ready" ? 600 : null],
  );
  return id;
}

const submit = (client: Client, course: string, preview: Answer) =>
  call(client, "private.course_submit($1, $2, $3, $4, $5, $6::inet, $7)", [course, preview.annex!.id, preview.content_sha256, preview.term_years, preview.submission_no, "203.0.113.7", "Navegador de prueba"]);

const evidence = async (course: string) =>
  (await owner.query<{ reviews: number; licenses: number; state: string }>(
    `select (select count(*)::int from public.course_reviews c where c.course_id = $1) as reviews,
            (select count(*)::int from public.licenses l where l.course_id = $1) as licenses,
            (select r.state::text from public.course_registry r where r.course_id = $1) as state`,
    [course],
  )).rows[0]!;

beforeAll(async () => {
  owner = await connect();
  await owner.query("grant app_service to postgres with set true, inherit false");
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  teacherProfile = who.id;
  await inTx(owner, async () => {
    await asSystem(owner);
    teacherId = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [who.id])).rows[0]!.id;
    const tag = randomUUID().slice(0, 8);
    practice = (await owner.query<{ id: string }>("insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 9500, 1) returning id", [`carrera-${tag}`, `Carrera ${tag}`])).rows[0]!.id;
    level = (await owner.query<{ id: string }>("insert into public.levels (slug, name, position) values ($1, $2, 9500) returning id", [`carrera-${tag}`, `Carrera ${tag}`])).rows[0]!.id;
    await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
    await owner.query(
      "insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')",
      [who.id],
    );
    await asOwner(owner);
  });
});

afterAll(async () => {
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query("delete from public.licenses where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.course_reviews where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.draft_videos where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from private.video_trash where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.draft_lessons where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.draft_modules where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.course_drafts where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.course_registry where course_id = any($1::uuid[])", [courses]);
  await owner.query("delete from public.practices where id = $1", [practice]);
  await owner.query("delete from public.levels where id = $1", [level]);
  await owner.query("delete from public.teachers where id = $1", [teacherId]);
  await owner.query("commit");
  await owner.query("revoke app_service from postgres");
  await owner.end();
  await deleteTestUsersByEmail(emails);
});

/** Dos conexiones con su transacción abierta, que se revierten si algo falla antes de confirmar. */
async function withTwo(work: (first: Client, second: Client) => Promise<void>): Promise<void> {
  const first = await connect();
  const second = await connect();
  try {
    await first.query("begin");
    await second.query("begin");
    await work(first, second);
  } finally {
    await second.query("rollback").catch(() => undefined);
    await first.query("rollback").catch(() => undefined);
    await first.end();
    await second.end();
  }
}

describe("dos envíos a la vez", () => {
  it("el segundo espera y contesta submitted, sin firmar otra vez", async () => {
    const { course, preview } = await readyCourse();
    await withTwo(async (first, second) => {
      await asTeacher(first);
      await asTeacher(second);
      expect((await submit(first, course, preview)).answer).toBe("submitted");
      const waiting = submit(second, course, preview);
      await waitBehind(owner, first, 1);
      await first.query("commit");
      expect((await waiting).answer).toBe("submitted");
      await second.query("commit");
    });
    expect(await evidence(course)).toEqual({ reviews: 1, licenses: 1, state: "in_review" });
  });
});

describe("un video que termina mientras se envía", () => {
  it("si promover va primero, enviar espera, ve el video nuevo y no firma lo de antes", async () => {
    const { course, lesson, video, preview } = await readyCourse();
    const replacement = await insertVideo(course, lesson, "processing", false);
    await withTwo(async (first, second) => {
      await asTeacher(first);
      await asTeacher(second);
      expect((await call(first, "private.video_settle($1, 'ready', $2, 600, false, null)", [replacement, `play-${replacement}`])).answer).toBe("ready");
      const waiting = submit(second, course, preview);
      await waitBehind(owner, first, 1);
      await first.query("commit");
      // Leer antes de tomar la fila diría `not_ready`, porque vería el reemplazo procesando.
      expect((await waiting).answer).toBe("changed");
      await second.query("commit");
    });
    expect(await evidence(course)).toEqual({ reviews: 0, licenses: 0, state: "draft" });
    const current = await owner.query<{ id: string }>("select id from public.draft_videos where lesson_id = $1 and is_current", [lesson]);
    expect(current.rows.map((row) => row.id)).toEqual([replacement]);
    const trash = await owner.query("select 1 from private.video_trash where video_id = $1", [video]);
    expect(trash.rowCount).toBe(1);
  });

  it("unos subtítulos que terminan mientras se envía no se estorban con enviar", async () => {
    const { course, video, preview } = await readyCourse();
    await withTwo(async (first, second) => {
      await asTeacher(first);
      await asTeacher(second);
      expect((await submit(first, course, preview)).answer).toBe("submitted");
      expect((await call(second, "private.video_settle($1, 'ready', $2, 600, true, null)", [video, `play-${video}`])).answer).toBe("ready");
      await second.query("commit");
      await first.query("commit");
    });
    expect(await evidence(course)).toEqual({ reviews: 1, licenses: 1, state: "in_review" });
    const row = await owner.query<{ captions_ready: boolean }>("select captions_ready from public.draft_videos where id = $1", [video]);
    expect(row.rows[0]?.captions_ready).toBe(true);
  });
});

describe("una práctica que se desactiva mientras se envía", () => {
  it("si desactivar va primero, enviar espera su lista y no firma", async () => {
    const { course, preview } = await readyCourse();
    await withTwo(async (first, second) => {
      await asSystem(first);
      await first.query("select private.catalog_lock('practices')");
      await first.query("update public.practices set is_active = false where id = $1", [practice]);
      await asTeacher(second);
      const waiting = submit(second, course, preview);
      await waitBehind(owner, first, 1);
      await first.query("commit");
      const answered = await waiting;
      expect(answered.answer).toBe("not_ready");
      expect(answered.missing?.map((line) => line.what)).toEqual(["practice"]);
      await second.query("commit");
    });
    expect(await evidence(course)).toEqual({ reviews: 0, licenses: 0, state: "draft" });
    await inTx(owner, async () => {
      await asSystem(owner);
      await owner.query("update public.practices set is_active = true where id = $1", [practice]);
      await asOwner(owner);
    });
  });

  it("si enviar va primero, quien desactiva espera y ya lo ve en uso", async () => {
    const { course, preview } = await readyCourse();
    // Los otros casos dejan cursos en revisión con esta práctica: cuenta el de este caso, no los de antes.
    const before = (await owner.query<{ n: number }>("select private.catalog_in_use('practices', $1) as n", [practice])).rows[0]!.n;
    await withTwo(async (first, second) => {
      await asTeacher(first);
      expect((await submit(first, course, preview)).answer).toBe("submitted");
      await asSystem(second);
      const waiting = second.query("select private.catalog_lock('practices')");
      await waitBehind(owner, first, 1);
      await first.query("commit");
      await waiting;
      const used = await second.query<{ n: number }>("select private.catalog_in_use('practices', $1) as n", [practice]);
      expect(used.rows[0]?.n).toBe(before + 1);
    });
    expect((await evidence(course)).state).toBe("in_review");
  });
});
