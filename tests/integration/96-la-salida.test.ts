import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createDraftsStore } from "@/services/drafts/store";
import { readDraftCourse, readTeacherCourses } from "@/services/drafts/records";
import { createReviewStore } from "@/services/review/store";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { mediaStoreOn } from "./helpers/media";
import { asOwner, asServer, asSystem } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-405, segunda solicitud: la salida de la revisión, contra la base. Lo que el servicio lee de verdad: la cola en su lectura estricta (si la base soltara una ruta o la dirección, esto
// fallaría), lo que su maestro lee, un rechazo sin motivo que no se guarda, y dos personas devolviendo a la vez. Los envíos se fuerzan con las funciones de la primera solicitud: la
// aplicación todavía no envía.
//
// Enviar es un libro que no se borra: lo que esta prueba confirma lo quita al terminar con las guardias apagadas, como la 95. La auditoría se queda. Pide los borradores legales
// (`db:drafts`), con su marca: el anexo de la versión 0.

let owner: Client;
let teacherProfile: string;
let reviewerProfile: string;
let otherProfile: string;
let teacherId: string;
let practice: string;
let level: string;
const teacherSession = randomUUID();
const emails: string[] = [];
const courses: string[] = [];

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

/** El almacén de la aplicación, sobre una transacción de esa conexión y a nombre de las claims que se le pasen. */
function storeOn(client: Client, person: { id: string; session: string }) {
  const run = (async (_actor: unknown, work: (tx: Tx) => Promise<unknown>) => {
    await asServer(client, person.id, person.session);
    try {
      return await work(txOn(client));
    } finally {
      await asOwner(client);
    }
  }) as unknown as Parameters<typeof createReviewStore>[0];
  return createReviewStore(run);
}

const CLAIMS = {} as VerifiedClaims;
const review = (client: Client = owner) => storeOn(client, { id: reviewerProfile, session: reviewerSession });
let reviewerSession = "";
let reviewerEmail = "";

/** Un curso enviado de una lección con su video y un recurso. */
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
    await owner.query(
      `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                        provider, provider_asset_id, provider_playback_id, duration_seconds)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, gen_random_uuid(), 'v1', 600, 'mux', $6::text, $7::text, 600)`,
      [video, course, teacherId, lesson, `salida/${video}`, `asset-${video}`, `play-${video}`],
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
    return { course, lesson, submission };
  });
}

const row = async (course: string) =>
  (
    await owner.query<{ result: string; reason: string | null; what_to_fix: string | null; state: string }>(
      `select c.result::text, c.reason, c.what_to_fix, r.state::text from public.course_reviews c join public.course_registry r on r.course_id = c.course_id
       where c.course_id = $1 order by c.submission_no desc limit 1`,
      [course],
    )
  ).rows[0]!;

beforeAll(async () => {
  owner = await connect();
  await owner.query("grant app_service to postgres with set true, inherit false");
  const teacher = await claimedUser();
  const reviewer = await claimedUser();
  const other = await claimedUser();
  emails.push(teacher.email, reviewer.email, other.email);
  for (const person of [teacher, reviewer, other]) await completeAccountAsOwner(person.id);
  teacherProfile = teacher.id;
  reviewerProfile = reviewer.id;
  reviewerEmail = reviewer.email.toLowerCase();
  otherProfile = other.id;
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
    practice = (await owner.query<{ id: string }>("insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 9600, 1) returning id", [`salida-${tag}`, `Salida ${tag}`])).rows[0]!.id;
    level = (await owner.query<{ id: string }>("insert into public.levels (slug, name, position) values ($1, $2, 9600) returning id", [`salida-${tag}`, `Salida ${tag}`])).rows[0]!.id;
    await owner.query("select set_config('app.actor_id', $1, true)", [teacher.id]);
    await owner.query(
      "insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')",
      [teacher.id],
    );
    await asOwner(owner);
    // Con Contenido y un código de hace un momento: la puerta de los cambios la lee de su sesión. Con las guardias apagadas: la 02 y la 12 cuentan los renglones de auditoría de las capacidades y de los factores.
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
  await owner.query("delete from private.admin_factors where profile_id = $1", [reviewerProfile]);
  await owner.query("delete from public.admin_capabilities where profile_id = $1", [reviewerProfile]);
  await owner.query("commit");
  await owner.query("revoke app_service from postgres");
  await owner.end();
  await deleteTestUsersByEmail(emails);
});

describe("la cola, en la lectura estricta de la aplicación", () => {
  it("lo enviado entra por su fotografía, y nada que no deba sale de la base", async () => {
    const { course, lesson, submission } = await sentCourse("Respirar");
    const queue = await inTx(owner, () => review().queue(CLAIMS));
    const mine = queue?.courses.find((each) => each.courseId === course);
    expect(mine).toMatchObject({ title: "Respirar", summary: "Un resumen.", lessonCount: 1, totalDurationSeconds: 600 });
    expect(mine?.lessons[0]).toMatchObject({ lessonId: lesson, video: "playable", durationSeconds: 600, description: null, resources: [] });
    expect(mine?.submission).toMatchObject({ id: submission, number: 1, annex: { version: expect.any(Number), termYears: expect.any(Number) } });
    expect(mine?.submission?.annex.statement).toContain("«Respirar»");
  });
});

describe("el video de lo enviado", () => {
  it("Contenido lo ve con su propia marca de agua, y quien no es nadie no recibe nada", async () => {
    const { course, lesson } = await sentCourse("Con marca");
    const media = mediaStoreOn(owner);
    const claimsOf = (id: string, session: string) => ({ userId: id, sessionId: session }) as unknown as VerifiedClaims;
    await inTx(owner, async () => {
      const seen = await media.draftVideo(claimsOf(reviewerProfile, reviewerSession), course, lesson);
      expect(seen).toMatchObject({ provider: "mux", durationSeconds: 600, email: reviewerEmail });
      expect(await media.draftVideo(claimsOf(otherProfile, randomUUID()), course, lesson)).toBeNull();
    });
  });
});

describe("devolver", () => {
  it("un rechazo sin motivo no se guarda", async () => {
    const { course, submission } = await sentCourse("Sin motivo");
    await inTx(owner, async () => {
      expect(await review().returnCourse(CLAIMS, { course, submission, reason: "   ", whatToFix: "Corrige." })).toBe("invalid");
    });
    expect(await row(course)).toEqual({ result: "pending", reason: null, what_to_fix: null, state: "in_review" });
  });

  it("devuelto: su maestro lo lee en PA-42 y PA-43, con otro maestro sin verlo", async () => {
    const { course, submission } = await sentCourse("Con motivo");
    await inTx(owner, async () => {
      expect(await review().returnCourse(CLAIMS, { course, submission, reason: "El audio se corta.", whatToFix: "Súbela otra vez." })).toBe("returned");
    });
    expect(await row(course)).toEqual({ result: "rejected", reason: "El audio se corta.", what_to_fix: "Súbela otra vez.", state: "draft" });

    const asPerson = (id: string) =>
      (async (_claims: unknown, work: (tx: Tx) => Promise<unknown>) => {
        await asOwner(owner);
        await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: id, role: "authenticated", aal: "aal1", session_id: teacherSession })]);
        try {
          return await work(txOn(owner));
        } finally {
          await asOwner(owner);
        }
      }) as never;
    const asServerFor = (id: string) =>
      (async (_actor: unknown, work: (tx: Tx) => Promise<unknown>) => {
        await asServer(owner, id, teacherSession);
        try {
          return await work(txOn(owner));
        } finally {
          await asOwner(owner);
        }
      }) as never;
    const teacherStore = createDraftsStore(asServerFor(teacherProfile), asPerson(teacherProfile));
    await inTx(owner, async () => {
      const list = await teacherStore.teacherCourses(CLAIMS);
      expect(list.find((each) => each.id === course)?.returned).toMatchObject({ reason: "El audio se corta.", whatToFix: "Súbela otra vez." });
      const draft = await teacherStore.draftCourse(CLAIMS, course);
      expect(draft?.returned).toMatchObject({ reason: "El audio se corta.", whatToFix: "Súbela otra vez." });
      // Lo que se lee como la persona no trae nada de la revisión: lo trae la consulta del servidor.
      const direct = await asPersonRead(owner, teacherProfile, (tx) => readDraftCourse(tx, course));
      expect(direct?.returned).toBeNull();
      const listed = await asPersonRead(owner, teacherProfile, (tx) => readTeacherCourses(tx));
      expect(listed.find((each) => each.id === course)?.returned).toBeNull();
      const stranger = createDraftsStore(asServerFor(otherProfile), asPerson(otherProfile));
      expect(await stranger.teacherCourses(CLAIMS)).toEqual([]);
    });
  });

  it("dos personas a la vez: una lo devuelve, y la otra espera y contesta not_pending", async () => {
    const { course, submission } = await sentCourse("A la vez");
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      await second.query("begin");
      expect(await review(first).returnCourse(CLAIMS, { course, submission, reason: "Primero.", whatToFix: "Corrige." })).toBe("returned");
      const waiting = review(second).returnCourse(CLAIMS, { course, submission, reason: "Segundo.", whatToFix: "Otra." });
      await waitBehind(owner, first, 1);
      await first.query("commit");
      expect(await waiting).toBe("not_pending");
      await second.query("commit");
    } finally {
      await second.query("rollback").catch(() => undefined);
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
    expect(await row(course)).toEqual({ result: "rejected", reason: "Primero.", what_to_fix: "Corrige.", state: "draft" });
  });
});

/** Lee como la persona, en la transacción abierta. */
async function asPersonRead<T>(client: Client, id: string, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(client);
  await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: id, role: "authenticated", aal: "aal1", session_id: teacherSession })]);
  try {
    return await read(txOn(client));
  } finally {
    await asOwner(client);
  }
}
