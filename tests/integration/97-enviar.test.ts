import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { resolveOrigin } from "@/services/account/origin";
import { createSubmitStore } from "@/services/drafts/store";
import { createSubmit } from "@/services/drafts/submit";
import type { ProviderAsset, VideoProvider } from "@/services/media/video-provider";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, type MemoryJar } from "./helpers/auth";
import { connect } from "./helpers/finance";
import { asOwner, asServer, asSystem } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-405, tercera solicitud: enviar desde el portal, contra la base y el Auth locales. El servicio de verdad, con la guarda de sesión de verdad y el almacén de la aplicación: lo que se
// firma lleva la dirección, el navegador, la sesión y su nivel; sin la casilla, con lo visto viejo o con un video que su proveedor ya no tiene, no se escribe nada. Mux se cambia por
// uno de mentira que dice lo que la prueba pida.
//
// Enviar es un libro que no se borra: lo que esta prueba confirma lo quita al terminar con las guardias apagadas, como la 95. La auditoría se queda. Pide los borradores legales.

let owner: Client;
let teacherId: string;
let practice: string;
let level: string;
let jar: MemoryJar;
let claims: VerifiedClaims;
let session = "";
const emails: string[] = [];
const courses: string[] = [];
let muxSays: ProviderAsset | "gone" | null = { state: "ready", playback: "Play", seconds: 600, captions: true, error: null };

const txOn = (client: Client): Tx => ({
  query: async (query, row) => (await client.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await client.query(query.text, [...query.values])).rowCount ?? 0,
});

/** El almacén de la aplicación, sobre conexiones del dueño que toman el rol del servidor a nombre de las claims. Cada llamada confirma, como en la aplicación. */
const run = (async (actor: { claims: VerifiedClaims }, work: (tx: Tx) => Promise<unknown>) => {
  const { claims: verified } = readVerifiedClaims(actor.claims);
  await owner.query("begin");
  try {
    await asServer(owner, verified.userId, verified.sessionId ?? "");
    const result = await work(txOn(owner));
    await asOwner(owner);
    await owner.query("commit");
    return result;
  } catch (error) {
    await owner.query("rollback").catch(() => undefined);
    throw error;
  }
}) as unknown as Parameters<typeof createSubmitStore>[0];

const mux: VideoProvider = {
  create: () => Promise.resolve(null),
  findByPassthrough: () => Promise.resolve(null),
  remove: () => Promise.resolve(true),
  // Lo que guarda la prueba: la reproducción es `play-` y el resto del asset. Con «listo», Mux contesta esa.
  read: (asset) => Promise.resolve(muxSays !== null && muxSays !== "gone" && muxSays.playback === "Play" ? { ...muxSays, playback: asset.replace(/^asset-/, "play-") } : muxSays),
};
const reported: string[] = [];
const submit = createSubmit({
  store: createSubmitStore(run),
  providers: { active: () => "mux", of: (name) => (name === "mux" ? mux : null) },
  checkSession: (reader) => testServices().checkSession(reader),
  // Como lo arma `editor.ts`, con el proxy de fiar: la dirección canónica y el navegador recortado.
  evidence: (origin) => {
    const { address, userAgent } = resolveOrigin(origin, true);
    return { address, userAgent };
  },
  report: (code) => (reported.push(code), Promise.resolve()),
});
const ORIGIN = { realIp: "203.0.113.9", userAgent: "Navegador de la 97" };

async function readyCourse(title: string): Promise<string> {
  await owner.query("begin");
  await asServer(owner, claims.userId, session);
  const call = async (text: string, params: unknown[]) => (await owner.query<{ r: Record<string, string> }>(`select ${text} as r`, params)).rows[0]!.r;
  const course = (await call("private.draft_create($1, $2)", [randomUUID(), title])).course!;
  courses.push(course);
  await call("private.draft_save_course($1, 1, $2, $3, $4, $5)", [course, title, "Un resumen.", practice, level]);
  const moduleId = (await call("private.draft_add_module($1, 1, $2)", [course, "Inicio"])).module!;
  const lesson = (await call("private.draft_add_lesson($1, $2, 1, $3)", [course, moduleId, "Primera"])).lesson!;
  await asOwner(owner);
  const video = randomUUID();
  await owner.query(
    `insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                      provider, provider_asset_id, provider_playback_id, duration_seconds)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ready', true, 'clase.mp4', 'video/mp4', $5::text, 1000, gen_random_uuid(), 'v1', 600, 'mux', $6::text, $7::text, 600)`,
    [video, course, teacherId, lesson, `enviar/${video}`, `asset-${video}`, `play-${video}`],
  );
  await owner.query("commit");
  return course;
}

/** Lo que muestra PA-44, para mandarlo de vuelta. */
async function seen(course: string) {
  const read = await submit.submitPreview(claims, course);
  if (read.kind !== "ready" || read.value.kind !== "ready") throw new Error(`La vista previa no está lista: ${JSON.stringify(read)}`);
  const preview = read.value;
  return { course, annex: preview.annex.id, seen: preview.contentSha256, term: preview.termYears, submission: preview.submissionNo };
}

const evidence = async (course: string) =>
  (
    await owner.query<{ reviews: number; ip: string | null; user_agent: string | null; session_id: string | null; aal: string | null; state: string }>(
      `select (select count(*)::int from public.course_reviews c where c.course_id = $1) as reviews,
              (select host(l.ip) from public.licenses l where l.course_id = $1) as ip,
              (select l.user_agent from public.licenses l where l.course_id = $1) as user_agent,
              (select l.session_id::text from public.licenses l where l.course_id = $1) as session_id,
              (select l.aal from public.licenses l where l.course_id = $1) as aal,
              (select r.state::text from public.course_registry r where r.course_id = $1) as state`,
      [course],
    )
  ).rows[0]!;

beforeAll(async () => {
  owner = await connect();
  await owner.query("grant app_service to postgres with set true, inherit false");
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  jar = memoryJar();
  const entered = await testServices().signIn(jar, who, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  claims = check.claims;
  session = readVerifiedClaims(claims).claims.sessionId ?? "";
  await owner.query("begin");
  await asSystem(owner);
  teacherId = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [who.id])).rows[0]!.id;
  const tag = randomUUID().slice(0, 8);
  practice = (await owner.query<{ id: string }>("insert into public.practices (slug, name, position, cover_tone) values ($1, $2, 9700, 1) returning id", [`enviar-${tag}`, `Enviar ${tag}`])).rows[0]!.id;
  level = (await owner.query<{ id: string }>("insert into public.levels (slug, name, position) values ($1, $2, 9700) returning id", [`enviar-${tag}`, `Enviar ${tag}`])).rows[0]!.id;
  await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
  await owner.query(
    "insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')",
    [who.id],
  );
  await asOwner(owner);
  await owner.query("commit");
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

describe("enviar", () => {
  it("lo firmado lleva la dirección, el navegador, la sesión y su nivel", async () => {
    const course = await readyCourse("Con todo");
    expect(await submit.submitCourse(jar, { ...(await seen(course)), accepted: true }, ORIGIN)).toEqual({ kind: "submitted" });
    expect(await evidence(course)).toEqual({ reviews: 1, ip: "203.0.113.9", user_agent: "Navegador de la 97", session_id: session, aal: "aal1", state: "in_review" });
  });

  it("sin la casilla no se escribe nada", async () => {
    const course = await readyCourse("Sin casilla");
    expect(await submit.submitCourse(jar, { ...(await seen(course)), accepted: false }, ORIGIN)).toEqual({ kind: "not_accepted" });
    expect((await evidence(course)).reviews).toBe(0);
  });

  it("con lo visto viejo contesta changed y no firma", async () => {
    const course = await readyCourse("Visto viejo");
    expect(await submit.submitCourse(jar, { ...(await seen(course)), seen: "0".repeat(64), accepted: true }, ORIGIN)).toEqual({ kind: "changed" });
    expect((await evidence(course)).reviews).toBe(0);
  });

  it("un video que Mux ya no tiene no se firma, y si Mux no contesta tampoco", async () => {
    const course = await readyCourse("Mux dice");
    try {
      muxSays = "gone";
      expect(await submit.submitCourse(jar, { ...(await seen(course)), accepted: true }, ORIGIN)).toEqual({ kind: "video_not_ready", lessons: [expect.any(String)] });
      muxSays = null;
      expect(await submit.submitCourse(jar, { ...(await seen(course)), accepted: true }, ORIGIN)).toEqual({ kind: "unavailable" });
      expect(reported).toContain("submit_provider_unavailable");
    } finally {
      muxSays = { state: "ready", playback: "Play", seconds: 600, captions: true, error: null };
    }
    expect((await evidence(course)).reviews).toBe(0);
  });
});

describe("lo que el maestro lee después", () => {
  it("lo aceptado, sin el origen, y el texto de esa versión", async () => {
    const course = await readyCourse("Para leer");
    const shown = await seen(course);
    expect(await submit.submitCourse(jar, { ...shown, accepted: true }, ORIGIN)).toEqual({ kind: "submitted" });
    const accepted = await submit.acceptedAnnexes(claims);
    if (accepted.kind !== "ready") throw new Error("No se leyó lo aceptado.");
    const mine = accepted.value.find((each) => each.courseId === course);
    expect(mine).toMatchObject({ courseTitle: "Para leer", submissionNo: 1, annex: { id: shown.annex } });
    expect(JSON.stringify(accepted.value)).not.toMatch(/203\.0\.113|Navegador/);
    const text = await submit.annexText(claims, shown.annex);
    expect(text).toMatchObject({ kind: "ready", value: { id: shown.annex } });
  });
});
