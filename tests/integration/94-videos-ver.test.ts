import { generateKeyPairSync } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { signPlayback } from "@/adapters/mux/sign";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { readVerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createDrafts } from "@/services/drafts/drafts";
import { readDraftChoices, readDraftCourse, readTeacherCourses } from "@/services/drafts/records";
import { createDraftsStore, createVideosStore } from "@/services/drafts/store";
import { createDraftVideos } from "@/services/drafts/videos";
import { createMediaGrant } from "@/services/media/grant";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { mediaStoreOn } from "./helpers/media";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-403, cuarta solicitud: lo que el editor le dice al maestro de sus videos, contra la base (RF-604, FL-33). La vista previa pasa por la misma puerta que ver: nunca sale de
// `video_preview` lo que no es la vigente, ni lo de otro maestro, y no abre reproducción. El extremo a extremo usa el proveedor de prueba, que no tiene qué reproducir: la firma se prueba aquí.

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = { id: "LlaveDePrueba01", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
const emails: string[] = [];

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; email: string; jar: ReturnType<typeof memoryJar>; claims: VerifiedClaims };

async function person(): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, email: who.email, jar, claims: check.claims };
}

async function teacher(owner: Client, who: Person): Promise<void> {
  await asSystem(owner);
  await owner.query("insert into public.teachers (profile_id, status) values ($1, 'active')", [who.id]);
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

async function asServerFor<T>(owner: Client, claims: VerifiedClaims, write: (tx: Tx) => Promise<T>): Promise<T> {
  const { claims: verified } = readVerifiedClaims(claims);
  await asServer(owner, verified.userId, verified.sessionId ?? "");
  try {
    return await write(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

/** Lo que la pantalla lee, como la persona. */
async function asPerson<T>(owner: Client, claims: VerifiedClaims, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(owner);
  await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [readVerifiedClaims(claims).json]);
  try {
    return await read(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

function arrange(owner: Client) {
  const reported: string[] = [];
  const media = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: testServices().teamStanding,
      checkSession: testServices().checkSession,
      store: mediaStoreOn(owner),
      signingKey: () => KEY,
      sign: signPlayback,
      files: { signDownload: () => Promise.resolve(null) },
      now: () => 1_800_000_000,
    },
  );
  const drafts = createDrafts({
    afterDelete: () => Promise.resolve(),
    store: createDraftsStore(
      (actor, work) => asServerFor(owner, actor.claims, work),
      () => Promise.reject(new Error("Aquí no se lee como la persona.")),
      () => Promise.reject(new Error("Aquí no se lee como sistema.")),
    ),
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.reject(new Error("Nada debía reportarse.")),
  });
  const videos = createDraftVideos({
    store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
    files: {
      signUpload: () => Promise.resolve({ endpoint: "http://x", token: "firma" }),
      facts: () => Promise.resolve({ contentOk: true, seconds: 1200 }),
      remove: () => Promise.resolve(),
      signForProvider: (path) => Promise.resolve(`https://firmada/${path}`),
    },
    providers: { active: () => null, of: () => null },
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.resolve(),
  });
  return { media, drafts, videos, reported };
}

type Services = ReturnType<typeof arrange>;

async function newCourse(owner: Client, who: Person, drafts: Services["drafts"], lessons = 2) {
  const created = await drafts.createCourse(who.jar, { token: crypto.randomUUID(), title: "Con videos" });
  if (created.kind !== "created" || !created.id) throw new Error(`No se creó el curso: ${created.kind}`);
  const course = created.id;
  await drafts.addModule(who.jar, { course, seen: 1, title: "Módulo" });
  const moduleId = (await owner.query<{ id: string }>("select id from public.draft_modules where course_id = $1", [course])).rows[0]?.id;
  if (moduleId === undefined) throw new Error("Sin módulo.");
  for (let seen = 1; seen <= lessons; seen += 1) await drafts.addLesson(who.jar, { course, module: moduleId, seen, title: `Lección ${seen}` });
  const ids = (await owner.query<{ id: string }>("select id from public.draft_lessons where course_id = $1 order by position", [course])).rows.map((row) => row.id);
  return { course, lessons: ids };
}

/** Un video en la lección, ya recibido. */
async function received(owner: Client, who: Person, videos: Services["videos"], course: string, lesson: string) {
  const go = await videos.beginVideo(who.jar, { course, lesson, fileName: "clase.mp4", size: 1000 });
  if (go.kind !== "go") throw new Error(`No empezó: ${go.kind}`);
  await owner.query("insert into storage.objects (bucket_id, name, version, metadata) values ('video-originals', $1, gen_random_uuid()::text, jsonb_build_object('size', 1000, 'mimetype', 'video/mp4'))", [go.path]);
  const confirmed = await videos.confirmVideo(who.jar, { course, video: go.video });
  if (confirmed.kind !== "uploaded") throw new Error(`No confirmó: ${confirmed.kind}`);
  return go.video;
}

/** Lo deja listo y vigente, como lo deja Mux. */
async function ready(owner: Client, video: string, provider: string, playback: string): Promise<void> {
  await owner.query(
    `update public.draft_videos set state = 'ready', is_current = true, provider = $2, provider_asset_id = $3, provider_playback_id = $4, duration_seconds = 1200, settled_at = now() where id = $1`,
    [video, provider, `Asset${playback}`, playback],
  );
}

describe("la vista previa, contra la base", () => {
  it("su maestro la ve firmada, con su correo como marca, y sin abrir ninguna reproducción", async () => {
    await reverted(async (owner) => {
      const who = await person();
      await teacher(owner, who);
      const { media, drafts, videos, reported } = arrange(owner);
      const { course, lessons } = await newCourse(owner, who, drafts);
      const lesson = lessons[0] as string;
      await ready(owner, await received(owner, who, videos, course, lesson), "mux", "PlayUno");
      const sessions = async () => (await owner.query<{ n: number }>("select count(*)::int as n from public.playback_sessions where profile_id = $1", [who.id])).rows[0]?.n;
      const before = await sessions();

      const answer = await media.getDraftVideoGrant(who.jar, course, lesson);
      expect(answer).toMatchObject({ kind: "granted", playbackId: "PlayUno", watermark: who.email });
      expect(answer.kind === "granted" ? answer.tokens.video : "").toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(await sessions()).toBe(before);
      expect(reported).toEqual([]);
    });
  });

  it("otro maestro no la ve, ni sabe si existe", async () => {
    await reverted(async (owner) => {
      const who = await person();
      const other = await person();
      await teacher(owner, who);
      await teacher(owner, other);
      const { media, drafts, videos } = arrange(owner);
      const { course, lessons } = await newCourse(owner, who, drafts);
      const lesson = lessons[0] as string;
      await ready(owner, await received(owner, who, videos, course, lesson), "mux", "PlayUno");
      expect(await media.getDraftVideoGrant(other.jar, course, lesson)).toEqual({ kind: "no_video" });
    });
  });

  it("lo que no está listo no se ve, y lo del proveedor de prueba no tiene qué reproducir", async () => {
    await reverted(async (owner) => {
      const who = await person();
      await teacher(owner, who);
      const { media, drafts, videos } = arrange(owner);
      const { course, lessons } = await newCourse(owner, who, drafts);
      const [first, second] = lessons as [string, string];
      await received(owner, who, videos, course, first);
      expect(await media.getDraftVideoGrant(who.jar, course, first)).toEqual({ kind: "no_video" });
      await ready(owner, await received(owner, who, videos, course, second), "test", "PlayPrueba");
      expect(await media.getDraftVideoGrant(who.jar, course, second)).toEqual({ kind: "no_video" });
    });
  });

  it("al reemplazar se sigue viendo la vigente, no la que viene en camino", async () => {
    await reverted(async (owner) => {
      const who = await person();
      await teacher(owner, who);
      const { media, drafts, videos } = arrange(owner);
      const { course, lessons } = await newCourse(owner, who, drafts);
      const lesson = lessons[0] as string;
      await ready(owner, await received(owner, who, videos, course, lesson), "mux", "PlayVigente");
      await received(owner, who, videos, course, lesson);
      expect(await media.getDraftVideoGrant(who.jar, course, lesson)).toMatchObject({ kind: "granted", playbackId: "PlayVigente" });
    });
  });
});

describe("lo que el editor lee", () => {
  it("su maestro lee la fecha en que se borra, cuánto dura y desde cuándo se procesa, sin ruta ni asset", async () => {
    await reverted(async (owner) => {
      const who = await person();
      await teacher(owner, who);
      const { drafts, videos } = arrange(owner);
      const { course, lessons } = await newCourse(owner, who, drafts);
      const video = await received(owner, who, videos, course, lessons[0] as string);
      const draft = await asPerson(owner, who.claims, (tx) => readDraftCourse(tx, course));
      const shown = draft?.videos.find((each) => each.id === video);
      expect(shown).toMatchObject({ state: "uploaded", seconds: null, errorCode: null, claimedAt: null });
      const { created } = (await owner.query<{ created: Date }>("select created_at as created from public.draft_videos where id = $1", [video])).rows[0] as { created: Date };
      expect(new Date(shown?.deletesAt ?? "").getTime()).toBe(created.getTime() + 7 * 86_400_000);
      expect(JSON.stringify(shown)).not.toMatch(/storage|asset|playback/i);
    });
  });

  it("el editor sabe lo acordado para una lección", async () => {
    await reverted(async (owner) => {
      const choices = await readDraftChoices(txOn(owner), null, null);
      expect(choices.lessonTolerance).toEqual({ minSeconds: 900, maxSeconds: 1500 });
    });
  });

  it("si el parámetro trae otra forma se queda sin aviso, y el editor sigue: el aviso no bloquea nada", async () => {
    await reverted(async (owner) => {
      await owner.query("alter table public.business_parameters disable trigger user");
      await owner.query("update public.business_parameters set value = '\"otra cosa\"'::jsonb where key = 'TOLERANCIA_LECCION' and canceled_at is null");
      await owner.query("alter table public.business_parameters enable trigger user");
      const choices = await readDraftChoices(txOn(owner), null, null);
      expect(choices.lessonTolerance).toBeNull();
      expect(choices.videoMaxBytes).toBeGreaterThan(0);
    });
  });

  it("«Faltan» cuenta cada lección sin un video listo: lo que se procesa o tiene error, todavía no", async () => {
    await reverted(async (owner) => {
      const who = await person();
      await teacher(owner, who);
      const { drafts, videos } = arrange(owner);
      const { course, lessons } = await newCourse(owner, who, drafts, 3);
      const [first, second] = lessons as [string, string];
      const mine = async () => (await asPerson(owner, who.claims, (tx) => readTeacherCourses(tx))).find((each) => each.id === course)?.draft;

      expect(await mine()).toMatchObject({ lessons: 3, lessonsWithoutVideo: 3 });
      const uploaded = await received(owner, who, videos, course, first);
      expect(await mine()).toMatchObject({ lessons: 3, lessonsWithoutVideo: 3 });
      await owner.query("update public.draft_videos set state = 'processing', claimed_at = now(), provider_asset_id = 'AssetUno' where id = $1", [uploaded]);
      expect(await mine()).toMatchObject({ lessons: 3, lessonsWithoutVideo: 3 });
      await owner.query("update public.draft_videos set state = 'errored', error_code = 'x', settled_at = now() where id = $1", [uploaded]);
      expect(await mine()).toMatchObject({ lessonsWithoutVideo: 3 });
      await ready(owner, await received(owner, who, videos, course, second), "mux", "PlayDos");
      expect(await mine()).toMatchObject({ lessons: 3, lessonsWithoutVideo: 2 });
    });
  });
});
