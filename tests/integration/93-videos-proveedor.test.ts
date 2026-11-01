import type { Client } from "pg";
import { afterAll, describe, expect, it, vi, type Mock } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { readVerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createVideoStorage } from "@/adapters/supabase/storage";
import { getEnv } from "@/config/env";
import { createDrafts } from "@/services/drafts/drafts";
import { createDraftsStore, createVideosStore } from "@/services/drafts/store";
import { createDraftVideos } from "@/services/drafts/videos";
import { createVideoFiles, type VideoFiles } from "@/services/media/video-files";
import { createVideoProviders, type ProviderAsset, type VideoProvider } from "@/services/media/video-provider";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Crear un video en el proveedor y repararlo al leer (T-403, tercera solicitud; RF-604, FL-33), contra la base local y con Mux simulado: cada video
// cuesta dinero, y lo que importa es cuántas veces se crea. Lo que Mux contesta de verdad se midió el 2026-11-01 (`PROGRESO.md`), y lo prueba
// `src/adapters/mux/assets.test.ts`. Los archivos son filas de `storage.objects` en la misma transacción, salvo la dirección firmada, que va contra
// el Storage local.
//
// `now()` no avanza en una transacción: lo que se limita por fila se abre a mano (`again`).

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

const READY: ProviderAsset = { state: "ready", playback: "PLAY", seconds: 121, captions: false, error: null };
const PREPARING: ProviderAsset = { state: "preparing", playback: null, seconds: null, captions: false, error: null };

type FakeMux = { [Name in keyof VideoProvider]: Mock<VideoProvider[Name]> };

function fakeMux(overrides: Partial<FakeMux> = {}): FakeMux {
  let made = 0;
  return {
    create: vi.fn<VideoProvider["create"]>(() => {
      made += 1;
      return Promise.resolve(`ASSET-${made}`);
    }),
    read: vi.fn<VideoProvider["read"]>(() => Promise.resolve(PREPARING)),
    findByPassthrough: vi.fn<VideoProvider["findByPassthrough"]>(() => Promise.resolve([])),
    remove: vi.fn<VideoProvider["remove"]>(() => Promise.resolve(true)),
    ...overrides,
  };
}

function arrange(owner: Client, mux: VideoProvider, files: Partial<VideoFiles> = {}) {
  const reported: string[] = [];
  const removed: string[] = [];
  const videos = createDraftVideos({
    store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
    files: {
      signUpload: () => Promise.resolve({ endpoint: "http://x", token: "firma" }),
      facts: () => Promise.resolve({ contentOk: true, seconds: 120 }),
      remove: (paths) => {
        removed.push(...paths);
        return Promise.resolve();
      },
      signForProvider: (path) => Promise.resolve(`https://firmada/${path}`),
      ...files,
    },
    providers: { active: () => "mux", of: (name) => (name === "mux" ? mux : null) },
    checkSession: (reader) => testServices().checkSession(reader),
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  const drafts = createDrafts({
    afterDelete: (claims, course) => videos.cleanUp(claims, course),
    store: createDraftsStore(
      (actor, work) => asServerFor(owner, actor.claims, work),
      () => Promise.reject(new Error("Aquí no se lee como la persona.")),
      () => Promise.reject(new Error("Aquí no se lee como sistema.")),
    ),
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.reject(new Error("Nada debía reportarse.")),
  });
  return { videos, drafts, reported, removed };
}

async function newLesson(owner: Client, who: Person, drafts: ReturnType<typeof createDrafts>) {
  const created = await drafts.createCourse(who.jar, { token: crypto.randomUUID(), title: "Con videos" });
  if (created.kind !== "created" || !created.id) throw new Error(`No se creó el curso: ${created.kind}`);
  const course = created.id;
  const added = await drafts.addModule(who.jar, { course, seen: 1, title: "Módulo" });
  const moduleId = (await owner.query<{ id: string }>("select id from public.draft_modules where course_id = $1", [course])).rows[0]?.id;
  if (added.kind !== "created" || moduleId === undefined) throw new Error(`No se agregó el módulo: ${added.kind}`);
  await drafts.addLesson(who.jar, { course, module: moduleId, seen: 1, title: "Lección" });
  const lesson = (await owner.query<{ id: string }>("select id from public.draft_lessons where course_id = $1", [course])).rows[0]?.id;
  if (lesson === undefined) throw new Error("Sin lección.");
  return { course, lesson, module: moduleId };
}

/** Un video recibido: la fila, y lo que dejaría Storage al terminar de subir. */
async function received(owner: Client, who: Person, videos: ReturnType<typeof createDraftVideos>, where: { course: string; lesson: string }, seconds = 120): Promise<{ video: string; path: string }> {
  const go = await videos.beginVideo(who.jar, { ...where, fileName: "clase.mp4", size: 1000 });
  if (go.kind !== "go") throw new Error(`No empezó: ${go.kind}`);
  await owner.query("insert into storage.objects (bucket_id, name, version, metadata) values ('video-originals', $1, gen_random_uuid()::text, jsonb_build_object('size', 1000, 'mimetype', 'video/mp4'))", [go.path]);
  const confirmed = await createDraftVideos({
    store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
    files: { signUpload: vi.fn(), facts: () => Promise.resolve({ contentOk: true, seconds }), remove: vi.fn(), signForProvider: vi.fn() },
    providers: { active: () => null, of: () => null },
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.resolve(),
  }).confirmVideo(who.jar, { course: where.course, video: go.video });
  if (confirmed.kind !== "uploaded") throw new Error(`No confirmó: ${confirmed.kind}`);
  return { video: go.video, path: go.path };
}

const rowOf = async (owner: Client, video: string) =>
  (
    await owner.query<{ state: string; provider_asset_id: string | null; provider_playback_id: string | null; duration_seconds: number | null; captions_ready: boolean; is_current: boolean; error_code: string | null }>(
      "select state, provider_asset_id, provider_playback_id, duration_seconds, captions_ready, is_current, error_code from public.draft_videos where id = $1",
      [video],
    )
  ).rows[0];
const again = (owner: Client, video: string) => owner.query("update public.draft_videos set checked_at = null where id = $1", [video]);
const expireClaim = (owner: Client, video: string) => owner.query("update public.draft_videos set claimed_at = claimed_at - interval '6 minutes', checked_at = null where id = $1", [video]);
const usedMinutes = async (owner: Client, who: Person) =>
  (await owner.query<{ minutes: number }>("select coalesce(sum(u.minutes), 0)::int as minutes from private.video_usage u join public.teachers t on t.id = u.teacher_id where t.profile_id = $1", [who.id])).rows[0]?.minutes;
const trashCount = async (owner: Client, course: string) => (await owner.query<{ n: number }>("select count(*)::int as n from private.video_trash where course_id = $1", [course])).rows[0]?.n;
async function setParameter(owner: Client, key: string, value: string): Promise<void> {
  await owner.query("alter table public.business_parameters disable trigger user");
  await owner.query("update public.business_parameters set value = $2::jsonb where key = $1 and canceled_at is null", [key, value]);
  await owner.query("alter table public.business_parameters enable trigger user");
}

async function start(owner: Client, mux: VideoProvider, files: Partial<VideoFiles> = {}) {
  const who = await person();
  await teacher(owner, who);
  const services = arrange(owner, mux, files);
  const where = await newLesson(owner, who, services.drafts);
  return { who, where, ...services };
}

describe("crear en el proveedor", () => {
  it("de recibido a listo: crea una vez, cuenta los minutos una vez, y lo que mide Mux manda", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos } = await start(owner, mux);
      const { video, path } = await received(owner, who, videos, where);

      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(mux.create).toHaveBeenCalledExactlyOnceWith({ url: `https://firmada/${path}`, passthrough: video });
      expect(await rowOf(owner, video)).toMatchObject({ state: "processing", provider_asset_id: "ASSET-1", is_current: false });
      expect(await usedMinutes(owner, who)).toBe(2);

      // Procesando, y Mux sigue: no se escribe nada.
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: {} });
      expect(await rowOf(owner, video)).toMatchObject({ state: "processing" });

      // Lista: 121 s son un minuto más que los 120 que se leyeron.
      mux.read.mockResolvedValue(READY);
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(mux.read).toHaveBeenLastCalledWith("ASSET-1", 120);
      expect(await rowOf(owner, video)).toMatchObject({ state: "ready", provider_playback_id: "PLAY", duration_seconds: 121, captions_ready: false, is_current: true });
      expect(await usedMinutes(owner, who)).toBe(3);

      // Los subtítulos terminan después.
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: {} });
      mux.read.mockResolvedValue({ ...READY, captions: true });
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(await rowOf(owner, video)).toMatchObject({ captions_ready: true });

      expect(mux.create).toHaveBeenCalledTimes(1);
      expect(await usedMinutes(owner, who)).toBe(3);
    });
  });

  it("dos pestañas no pagan dos veces: mientras una crea, la otra no tiene nada que hacer", async () => {
    await reverted(async (owner) => {
      let finish: (asset: string) => void = () => undefined;
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => new Promise<string>((resolve) => (finish = resolve))) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);

      const first = videos.checkVideos(who.jar, { course: where.course });
      await vi.waitFor(() => expect(mux.create).toHaveBeenCalledTimes(1));
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: {} });
      expect(mux.create).toHaveBeenCalledTimes(1);
      finish("ASSET-1");
      expect(await first).toMatchObject({ changed: true });
      expect(await rowOf(owner, video)).toMatchObject({ state: "processing", provider_asset_id: "ASSET-1" });
    });
  });

  it("una respuesta ambigua de Mux no reintenta hasta que el reclamo venza: pudo haberlo creado, y todavía no aparecer en la lista", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve(null)) });
      const { who, where, videos, reported } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);

      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ state: "creating", provider_asset_id: null });
      expect(reported).toEqual(["video_provider_unavailable"]);
      expect(await usedMinutes(owner, who)).toBe(2);

      // Otra pestaña, una recarga: nada que hacer todavía. La lista aún no lo trae, y sin esto se crearía el segundo.
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.findByPassthrough).not.toHaveBeenCalled();
      expect(mux.create).toHaveBeenCalledTimes(1);

      // Vencido el reclamo, ya aparece: se anota el que hay, sin crear otro ni cobrar otra vez.
      mux.findByPassthrough.mockResolvedValue(["YA-CREADO"]);
      await expireClaim(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.findByPassthrough).toHaveBeenCalledWith(video, expect.any(Number));
      expect(mux.create).toHaveBeenCalledTimes(1);
      expect(await rowOf(owner, video)).toMatchObject({ state: "processing", provider_asset_id: "YA-CREADO" });
      expect(await usedMinutes(owner, who)).toBe(2);
    });
  });

  it("un rechazo de Mux vuelve a recibido y se dice, y lo que se reintenta se busca igual", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve("rejected")) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: true, blocked: { [video]: "failing" } });
      expect(await rowOf(owner, video)).toMatchObject({ state: "uploaded" });
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.findByPassthrough).toHaveBeenCalledTimes(1);
      expect(mux.create).toHaveBeenCalledTimes(2);
      expect(await usedMinutes(owner, who)).toBe(2);
    });
  });

  it("si no se puede buscar, no se crea otro", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve("rejected")), findByPassthrough: vi.fn<VideoProvider["findByPassthrough"]>(() => Promise.resolve(null)) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.create).toHaveBeenCalledTimes(1);
      expect(await rowOf(owner, video)).toMatchObject({ state: "uploaded" });
    });
  });

  it("un servidor que murió entre crear y anotar: a los 5 minutos el reclamo vence, lo encuentra, y no paga otra vez", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      // Lo que queda: la fila reclamada y un asset que nadie anotó.
      await asServerFor(owner, who.claims, () => owner.query("select private.video_claim($1::uuid, $2::uuid, 'mux')", [where.course, video]));
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.create).not.toHaveBeenCalled();

      mux.findByPassthrough.mockResolvedValue(["HUERFANO"]);
      await expireClaim(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.create).not.toHaveBeenCalled();
      expect(await rowOf(owner, video)).toMatchObject({ state: "processing", provider_asset_id: "HUERFANO" });
      expect(await usedMinutes(owner, who)).toBe(2);
    });
  });

  it("dos con el mismo passthrough: se queda con uno y borra el otro en la misma pasada", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve("rejected")) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      mux.findByPassthrough.mockResolvedValue(["UNO", "OTRO"]);
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ provider_asset_id: "UNO" });
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("OTRO");
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("los topes detienen antes de llamar a Mux, y lo dicen", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);

      await setParameter(owner, "VIDEO_MINUTOS_MES_MAX", "1");
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: { [video]: "over_minutes" } });
      await setParameter(owner, "VIDEO_MINUTOS_MES_MAX", "1500");

      await setParameter(owner, "VIDEO_SUBIDA_ABIERTA", "false");
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: { [video]: "closed" } });
      await setParameter(owner, "VIDEO_SUBIDA_ABIERTA", "true");

      await setParameter(owner, "VIDEOS_POR_HORA_MAX", "1");
      await owner.query("insert into private.rate_limit_counters (bucket, window_start, hits) select 'video_claim:' || t.id, date_trunc('hour', now()), 1 from public.teachers t where t.profile_id = $1", [who.id]);
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: { [video]: "throttled" } });

      expect(mux.create).not.toHaveBeenCalled();
      expect(await rowOf(owner, video)).toMatchObject({ state: "uploaded" });
      expect(await usedMinutes(owner, who)).toBe(0);
    });
  });

  it("sin proveedor, lo recibido se queda en recibido y no se cuenta", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      const none = createDraftVideos({
        store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
        files: { signUpload: vi.fn(), facts: vi.fn(), remove: vi.fn(), signForProvider: vi.fn() },
        providers: { active: () => null, of: () => null },
        checkSession: (reader) => testServices().checkSession(reader),
        report: () => Promise.reject(new Error("Nada debía reportarse.")),
      });
      expect(await none.checkVideos(who.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: {} });
      expect(await rowOf(owner, video)).toMatchObject({ state: "uploaded" });
      expect(await usedMinutes(owner, who)).toBe(0);
    });
  });
});

describe("el tope de lo que está en camino", () => {
  it("abrir un curso asienta lo que el mismo maestro tiene procesándose en otro: si no, diez videos de un curso que ya no se abre detendrían a todos", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos, drafts } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      const other = await newLesson(owner, who, drafts);

      mux.read.mockResolvedValue(READY);
      await again(owner, video);
      expect(await videos.checkVideos(who.jar, { course: other.course })).toEqual({ kind: "checked", changed: true, blocked: {} });
      expect(await rowOf(owner, video)).toMatchObject({ state: "ready", is_current: true });
    });
  });

  it("lo recibido de otro curso no se crea desde aquí: eso gasta, y lo decide su propio editor", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos, drafts } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      const other = await newLesson(owner, who, drafts);
      await videos.checkVideos(who.jar, { course: other.course });
      expect(mux.create).not.toHaveBeenCalled();
      expect(await rowOf(owner, video)).toMatchObject({ state: "uploaded" });
    });
  });
});

describe("asentar", () => {
  it("con error se queda con su tipo, y no se vuelve la vigente", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ read: vi.fn<VideoProvider["read"]>(() => Promise.resolve({ state: "errored", playback: null, seconds: null, captions: false, error: "invalid_input" })) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ state: "errored", error_code: "invalid_input", is_current: false });
    });
  });

  it("lo que pasa del tope según Mux queda con error, y su asset se borra en la misma pasada", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ read: vi.fn<VideoProvider["read"]>(() => Promise.resolve({ ...READY, seconds: 7201 })) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ state: "errored", error_code: "too_long", provider_asset_id: null });
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("ASSET-1");
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("una respuesta vieja no pisa: lo asentado no vuelve a procesando", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ read: vi.fn<VideoProvider["read"]>(() => Promise.resolve(READY)) });
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      mux.read.mockResolvedValue(PREPARING);
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ state: "ready", provider_playback_id: "PLAY" });
    });
  });

  it("con el proveedor de prueba llega a lista sin llamar a nadie, con los segundos que se leyeron", async () => {
    await reverted(async (owner) => {
      const never = fakeMux();
      const { who, where } = await start(owner, never);
      const real = createVideoProviders(never);
      const videos = createDraftVideos({
        store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
        files: { signUpload: () => Promise.resolve({ endpoint: "http://x", token: "firma" }), facts: () => Promise.resolve({ contentOk: true, seconds: 120 }), remove: () => Promise.resolve(), signForProvider: () => Promise.resolve("https://no-se-usa") },
        providers: { active: () => "test", of: real.of },
        checkSession: (reader) => testServices().checkSession(reader),
        report: () => Promise.reject(new Error("Nada debía reportarse.")),
      });
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await again(owner, video);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ state: "ready", provider_asset_id: `test-${video}`, duration_seconds: 120, captions_ready: true, is_current: true });
      for (const each of [never.create, never.read, never.remove, never.findByPassthrough]) expect(each).not.toHaveBeenCalled();
    });
  });
});

describe("la papelera", () => {
  it("quitar un video borra el asset y el archivo, y no deja nada", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos, removed } = await start(owner, mux);
      const { video, path } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await videos.removeVideo(who.jar, { course: where.course, video })).toEqual({ kind: "deleted" });
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("ASSET-1");
      expect(removed).toEqual([path]);
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("quitar después de una respuesta perdida busca el asset y lo borra: si no, quedaría pagado y sin nombre", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve(null)), findByPassthrough: vi.fn<VideoProvider["findByPassthrough"]>(() => Promise.resolve(["PERDIDO"])) });
      const { who, where, videos, removed } = await start(owner, mux);
      const { video, path } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await rowOf(owner, video)).toMatchObject({ state: "creating", provider_asset_id: null });

      expect(await videos.removeVideo(who.jar, { course: where.course, video })).toEqual({ kind: "deleted" });
      await owner.query("update private.video_trash set created_at = now() - interval '6 minutes' where course_id = $1", [where.course]);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.findByPassthrough).toHaveBeenCalledWith(video, expect.any(Number));
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("PERDIDO");
      expect(removed).toEqual([path]);
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("lo que se fue reclamado espera antes de buscar: un asset recién creado puede no aparecer todavía en la lista", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve(null)) });
      const { who, where, videos, removed } = await start(owner, mux);
      const { video, path } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await videos.removeVideo(who.jar, { course: where.course, video });
      expect(mux.findByPassthrough).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
      expect(await trashCount(owner, where.course)).toBe(1);

      await owner.query("update private.video_trash set created_at = now() - interval '6 minutes' where course_id = $1", [where.course]);
      mux.findByPassthrough.mockResolvedValue(["TARDE"]);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("TARDE");
      expect(removed).toEqual([path]);
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("si no se pudo buscar, el renglón y el archivo se quedan, y sale cuando sí", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ create: vi.fn<VideoProvider["create"]>(() => Promise.resolve(null)), findByPassthrough: vi.fn<VideoProvider["findByPassthrough"]>(() => Promise.resolve(null)) });
      const { who, where, videos, removed } = await start(owner, mux);
      const { video, path } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await videos.removeVideo(who.jar, { course: where.course, video });
      expect(removed).toEqual([]);
      expect(await trashCount(owner, where.course)).toBe(1);

      await owner.query("update private.video_trash set created_at = now() - interval '6 minutes' where course_id = $1", [where.course]);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.findByPassthrough).toHaveBeenCalled();
      expect(removed).toEqual([]);
      expect(await trashCount(owner, where.course)).toBe(1);

      mux.findByPassthrough.mockResolvedValue(["PERDIDO"]);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("PERDIDO");
      expect(removed).toEqual([path]);
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("vacía más de 20 de una vez, y lo que no sale no detiene a lo demás", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ remove: vi.fn<VideoProvider["remove"]>((asset) => Promise.resolve(asset !== "TERCO-0" && asset !== "TERCO-1")) });
      const { who, where, videos } = await start(owner, mux);
      const teacherId = (await owner.query<{ id: string }>("select id from public.teachers where profile_id = $1", [who.id])).rows[0]?.id;
      const names = [...Array.from({ length: 2 }, (_, i) => `TERCO-${i}`), ...Array.from({ length: 23 }, (_, i) => `ASSET-${i}`)];
      for (const asset of names) {
        await owner.query("insert into private.video_trash (teacher_id, course_id, provider, provider_asset_id) values ($1, $2, 'mux', $3)", [teacherId, where.course, asset]);
      }
      await videos.cleanUp(who.claims, where.course);
      expect(mux.remove).toHaveBeenCalledTimes(25);
      const left = await owner.query<{ provider_asset_id: string }>("select provider_asset_id from private.video_trash where course_id = $1 order by provider_asset_id", [where.course]);
      expect(left.rows.map((each) => each.provider_asset_id)).toEqual(["TERCO-0", "TERCO-1"]);
    });
  });

  it("si Mux no lo borró se queda, sin tocar el archivo, y sale cuando sí", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux({ remove: vi.fn<VideoProvider["remove"]>(() => Promise.resolve(false)) });
      const { who, where, videos, removed, reported } = await start(owner, mux);
      const { video, path } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(await videos.removeVideo(who.jar, { course: where.course, video })).toEqual({ kind: "deleted" });
      expect(removed).toEqual([]);
      expect(await trashCount(owner, where.course)).toBe(1);
      expect(reported).toEqual(["video_cleanup_failed"]);

      mux.remove.mockResolvedValue(true);
      await videos.checkVideos(who.jar, { course: where.course });
      expect(removed).toEqual([path]);
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("borrar la lección se lleva su video, también de Mux: la cascada también pasa por la papelera", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos, drafts, removed } = await start(owner, mux);
      const { path } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      const seen = (await owner.query<{ revision: number }>("select revision::int as revision from public.draft_lessons where id = $1", [where.lesson])).rows[0]?.revision ?? 0;
      expect(await drafts.deleteLesson(who.jar, { course: where.course, lesson: where.lesson, seen })).toMatchObject({ kind: "deleted" });
      expect(mux.remove).toHaveBeenCalledExactlyOnceWith("ASSET-1");
      expect(removed).toEqual([path]);
      expect(await trashCount(owner, where.course)).toBe(0);
    });
  });

  it("lo de otro maestro no le toca", async () => {
    await reverted(async (owner) => {
      const mux = fakeMux();
      const { who, where, videos } = await start(owner, mux);
      const { video } = await received(owner, who, videos, where);
      await videos.checkVideos(who.jar, { course: where.course });
      await videos.removeVideo(who.jar, { course: where.course, video });
      mux.remove.mockClear();
      await owner.query("insert into private.video_trash (teacher_id, course_id, video_id, provider, provider_asset_id) select t.id, $2, $3, 'mux', 'DE-ELLA' from public.teachers t where t.profile_id = $1", [who.id, where.course, video]);

      const other = await person();
      await teacher(owner, other);
      const services = arrange(owner, mux);
      expect(await services.videos.checkVideos(other.jar, { course: where.course })).toEqual({ kind: "checked", changed: false, blocked: {} });
      expect(mux.remove).not.toHaveBeenCalled();
      expect(await trashCount(owner, where.course)).toBe(1);
    });
  });
});

describe("dos reclamos a la vez, con dos conexiones de verdad", () => {
  it("el segundo espera al primero, y al entrar ve que ya no le toca: un solo cobro", async () => {
    const owner = await connect();
    const first = await connect();
    const second = await connect();
    const who = await person();
    const mux = fakeMux();
    let course: string | null = null;
    try {
      await owner.query("grant app_service to postgres with set true, inherit false");
      await owner.query("begin");
      await teacher(owner, who);
      const { drafts, videos } = arrange(owner, mux);
      const where = await newLesson(owner, who, drafts);
      course = where.course;
      const { video } = await received(owner, who, videos, where);
      await owner.query("commit");

      const { claims: verified } = readVerifiedClaims(who.claims);
      const claim = (client: Client) => client.query<{ result: { answer: string } }>("select private.video_claim($1::uuid, $2::uuid, 'mux') as result", [where.course, video]);
      await first.query("begin");
      await asServer(first, verified.userId, verified.sessionId ?? "");
      expect((await claim(first)).rows[0]?.result.answer).toBe("claimed");
      await second.query("begin");
      await asServer(second, verified.userId, verified.sessionId ?? "");
      const waiting = claim(second);
      await waitBehind(owner, first, 1);
      await first.query("reset role");
      await first.query("commit");
      expect((await waiting).rows[0]?.result.answer).toBe("busy");
      await second.query("reset role");
      await second.query("commit");
      expect(await usedMinutes(owner, who)).toBe(2);
    } finally {
      for (const client of [first, second]) {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
      // Lo que esta prueba confirmó, con las guardias apagadas. La auditoría se queda.
      await owner.query("rollback").catch(() => undefined);
      try {
        await owner.query("begin");
        await owner.query("set local session_replication_role = replica");
        await owner.query("delete from storage.objects where bucket_id = 'video-originals' and name in (select storage_path from public.draft_videos where course_id = $1)", [course]);
        await owner.query("delete from public.draft_videos where course_id = $1", [course]);
        await owner.query("delete from public.draft_lessons where course_id = $1", [course]);
        await owner.query("delete from public.draft_modules where course_id = $1", [course]);
        await owner.query("delete from public.course_drafts where course_id = $1", [course]);
        await owner.query("delete from public.course_registry where course_id = $1", [course]);
        await owner.query("delete from private.video_usage where teacher_id in (select id from public.teachers where profile_id = $1)", [who.id]);
        await owner.query("delete from private.rate_limit_counters where bucket like 'video\\_%' or bucket like 'video%'");
        await owner.query("delete from public.teachers where profile_id = $1", [who.id]);
        await owner.query("delete from public.consents where profile_id = $1", [who.id]);
        await owner.query("commit");
      } finally {
        await owner.query("rollback").catch(() => undefined);
        await owner.query("revoke app_service from postgres");
        await owner.end();
      }
    }
  }, 60_000);
});

describe("la dirección que se le da a Mux", () => {
  it("contra el Storage local: abre ese archivo por rangos, y solo ese", async () => {
    const storage = createVideoStorage();
    const files = createVideoFiles(storage);
    const path = `prueba-93/${crypto.randomUUID()}.mp4`;
    const root = `${getEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "")}/storage/v1`;
    const secret = getEnv().SUPABASE_SECRET_KEY;
    const up = await fetch(`${root}/object/video-originals/${path}`, {
      method: "POST",
      headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": "video/mp4" },
      body: Buffer.from("bytes del video"),
    });
    expect(up.ok).toBe(true);
    try {
      const url = await files.signForProvider(path);
      expect(url).toContain(`${root}/object/sign/video-originals/${path}?token=`);
      const read = await fetch(url ?? "", { headers: { range: "bytes=0-4" } });
      expect(read.status).toBe(206);
      expect(await read.text()).toBe("bytes");
      const token = new URL(url ?? "").searchParams.get("token") ?? "";
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp: number; iat: number };
      expect(payload.exp - payload.iat).toBe(6 * 60 * 60);
      const other = await fetch(`${root}/object/sign/video-originals/prueba-93/otro.mp4?token=${token}`);
      expect(other.ok).toBe(false);
      await other.arrayBuffer();
    } finally {
      await storage.remove([path]);
    }
  });

  it("si Storage no firma es nulo, sin lanzar ni decir por qué", async () => {
    const files = createVideoFiles(createVideoStorage(() => Promise.resolve(new Response("{}", { status: 500 }))));
    expect(await files.signForProvider("a/b")).toBeNull();
    const down = createVideoFiles(createVideoStorage(() => Promise.reject(new Error("caída"))));
    expect(await down.signForProvider("a/b")).toBeNull();
    const odd = createVideoFiles(createVideoStorage(() => Promise.resolve(new Response(JSON.stringify({ signedURL: "https://otro/x" })))));
    expect(await odd.signForProvider("a/b")).toBeNull();
  });
});
