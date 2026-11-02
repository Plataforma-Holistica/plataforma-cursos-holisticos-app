import type { Client } from "pg";
import { Upload } from "tus-js-client";
import { afterAll, describe, expect, it } from "vitest";

import { videoTusOptions, isObjectAlreadyThere, type VideoTarget } from "@/app/portal/_editor/tus-upload";
import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createVideoStorage } from "@/adapters/supabase/storage";
import { createDrafts } from "@/services/drafts/drafts";
import { createDraftsStore, createVideosStore } from "@/services/drafts/store";
import { createDraftVideos } from "@/services/drafts/videos";
import { createVideoFiles } from "@/services/media/video-files";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Subir un video (T-403, segunda solicitud; RF-604, FL-33) contra la base y el Storage locales, por TUS de verdad y con las opciones
// que usa el navegador. El criterio del 06: una subida cortada se reanuda. pgTAP simula el objeto; aquí se sube, se corta, se renueva
// la firma, y se lee la duración de un archivo con su índice al final.
//
// Los maestros y los borradores viven en una transacción del dueño que se revierte. Los objetos no: los escribe Storage con su propia
// conexión, y se borran al final.

const emails: string[] = [];
const uploaded: string[] = [];
const storage = createVideoStorage();
const MP4 = "video/mp4";
const MOV = "video/quicktime";
const MB = 1024 * 1024;

afterAll(async () => {
  await storage.remove(uploaded);
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

const noReport = () => Promise.reject(new Error("Nada debía reportarse."));

const servicesOn = (owner: Client) => ({
  videos: createDraftVideos({
    store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
    files: createVideoFiles(storage),
    checkSession: (reader) => testServices().checkSession(reader),
    report: noReport,
  }),
  drafts: createDrafts({
    afterDelete: () => Promise.resolve(),
    store: createDraftsStore(
      (actor, work) => asServerFor(owner, actor.claims, work),
      () => Promise.reject(new Error("Aquí no se lee como la persona.")),
      () => Promise.reject(new Error("Aquí no se lee como sistema.")),
    ),
    checkSession: (reader) => testServices().checkSession(reader),
    report: noReport,
  }),
});

/** Un curso con una lección, a nombre de quien sube. */
async function newLesson(owner: Client, who: Person): Promise<{ course: string; lesson: string }> {
  const { drafts } = servicesOn(owner);
  const created = await drafts.createCourse(who.jar, { token: crypto.randomUUID(), title: "Con videos" });
  if (created.kind !== "created" || !created.id) throw new Error(`No se creó el curso: ${created.kind}`);
  const course = created.id;
  const added = await drafts.addModule(who.jar, { course, seen: 1, title: "Módulo" });
  const moduleId = (await owner.query<{ id: string }>("select id from public.draft_modules where course_id = $1", [course])).rows[0]?.id;
  if (added.kind !== "created" || moduleId === undefined) throw new Error(`No se agregó el módulo: ${added.kind}`);
  await drafts.addLesson(who.jar, { course, module: moduleId, seen: 1, title: "Lección" });
  const lesson = (await owner.query<{ id: string }>("select id from public.draft_lessons where course_id = $1", [course])).rows[0]?.id;
  if (lesson === undefined) throw new Error("Sin lección.");
  return { course, lesson };
}

// Los archivos: un video de mentiras con la forma de uno de verdad.
function atom(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
function mvhd(timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(100);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return atom("mvhd", body);
}
const ftyp = atom("ftyp", Buffer.from("isom", "latin1"), Buffer.alloc(4), Buffer.from("isommp42", "latin1"));
/** Con el índice al final, detrás de `bytes` de video: lo que deja una cámara, y lo que obliga a leer por rangos. */
const videoOf = (seconds: number, bytes = 1024) => Buffer.concat([ftyp, atom("mdat", Buffer.alloc(bytes)), atom("moov", mvhd(1000, seconds * 1000))]);

type Go = VideoTarget & { token: string };

async function begin(owner: Client, who: Person, where: { course: string; lesson: string }, file: Buffer, fileName = "clase.mp4"): Promise<Go> {
  const started = await servicesOn(owner).videos.beginVideo(who.jar, { ...where, fileName, size: file.length });
  if (started.kind !== "go") throw new Error(`No empezó: ${started.kind}`);
  uploaded.push(started.path);
  return started;
}

/** Sube por TUS con las opciones del navegador. `stopAfter` corta al llevar esos bytes, como un corte de red. */
function send(go: Go, file: Buffer, options: { stopAfter?: number; resumeFrom?: string; token?: string; mime?: string } = {}): Promise<{ result: "done" | "cut" | "failed"; url: string | null; error: Error | null }> {
  return new Promise((resolve) => {
    const target = options.mime === undefined ? go : { ...go, mime: options.mime };
    const upload: Upload = new Upload(file, {
      ...videoTusOptions(target, {
        token: () => Promise.resolve(options.token ?? go.token),
        onProgress: () => undefined,
        onSuccess: () => resolve({ result: "done", url: upload.url, error: null }),
        onError: (error) => resolve({ result: "failed", url: upload.url, error }),
      }),
      retryDelays: [],
      ...(options.resumeFrom === undefined ? {} : { uploadUrl: options.resumeFrom }),
      onChunkComplete: (_chunk, accepted) => {
        if (options.stopAfter !== undefined && accepted >= options.stopAfter) {
          void upload.abort().then(() => resolve({ result: "cut", url: upload.url, error: null }));
        }
      },
    });
    upload.start();
  });
}

const rowOf = async (owner: Client, video: string) =>
  (
    await owner.query<{ state: string; size_bytes: string; read_seconds: number | null; object_version: string | null }>(
      "select state, size_bytes, read_seconds, object_version from public.draft_videos where id = $1",
      [video],
    )
  ).rows[0] ?? null;

const objectOf = async (owner: Client, path: string) =>
  (await owner.query<{ size: string; mime: string }>("select metadata ->> 'size' as size, metadata ->> 'mimetype' as mime from storage.objects where bucket_id = 'video-originals' and name = $1", [path])).rows[0] ?? null;

describe("subir un video de verdad", () => {
  it("se corta, se reanuda donde iba con otra firma, y confirmar lee la duración del índice al final", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const { videos } = servicesOn(owner);
      const file = videoOf(125, 13 * MB);
      const go = await begin(owner, who, where, file);

      const first = await send(go, file, { stopAfter: 6 * MB });
      expect(first.result).toBe("cut");
      if (first.url === null) throw new Error("Sin dirección de subida.");

      // A medias no hay objeto, y confirmar no destruye nada: se puede seguir.
      expect(await objectOf(owner, go.path)).toBeNull();
      expect(await videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "not_uploaded" });
      expect((await rowOf(owner, go.video))?.state).toBe("uploading");

      // Volver a elegir el mismo archivo es la misma fila y la misma ruta.
      const again = await videos.beginVideo(who.jar, { ...where, fileName: "clase.mp4", size: file.length });
      expect(again).toMatchObject({ kind: "go", video: go.video, path: go.path, resumed: true });

      // Storage sabe cuánto lleva: no se vuelve a mandar lo que ya tiene.
      const head = await fetch(first.url, { method: "HEAD", headers: { "tus-resumable": "1.0.0", "x-signature": go.token } });
      expect(Number(head.headers.get("upload-offset"))).toBeGreaterThanOrEqual(6 * MB);

      // La firma se renueva preguntando otra vez, y la nueva termina lo que empezó la otra.
      const renewed = await videos.renewVideoUpload(who.jar, { course: where.course, video: go.video });
      if (renewed.kind !== "renewed") throw new Error(`No renovó: ${renewed.kind}`);
      const second = await send(go, file, { resumeFrom: first.url, token: renewed.token });
      expect(second).toMatchObject({ result: "done" });

      // Lo que Storage guardó es el archivo completo y con el tipo que fijó el servidor.
      expect(await objectOf(owner, go.path)).toEqual({ size: String(file.length), mime: MP4 });

      expect(await videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "uploaded" });
      const row = await rowOf(owner, go.video);
      expect(row).toMatchObject({ state: "uploaded", size_bytes: String(file.length), read_seconds: 125 });
      expect(row?.object_version).not.toBeNull();

      // Confirmar dos veces (dos pestañas, o una respuesta perdida) contesta lo mismo.
      expect(await videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "uploaded" });
      // Y ya subido, renovar no da otra firma.
      expect(await videos.renewVideoUpload(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "not_found" });
    });
  }, 120_000);

  it("un objeto ya confirmado no se reemplaza: Storage contesta 409, y se reconoce para no reintentar", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const file = videoOf(60);
      const go = await begin(owner, who, where, file);
      expect((await send(go, file)).result).toBe("done");
      const version = (await owner.query<{ version: string }>("select version from storage.objects where bucket_id = 'video-originals' and name = $1", [go.path])).rows[0]?.version;

      const other = await send(go, videoOf(90));
      expect(other.result).toBe("failed");
      expect(other.error !== null && isObjectAlreadyThere(other.error)).toBe(true);
      expect((await owner.query<{ version: string }>("select version from storage.objects where bucket_id = 'video-originals' and name = $1", [go.path])).rows[0]?.version).toBe(version);
      expect(await servicesOn(owner).videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "uploaded" });
      expect((await rowOf(owner, go.video))?.read_seconds).toBe(60);
    });
  }, 60_000);

  it("la firma de una ruta no sirve para otra", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const one = await newLesson(owner, who);
      const two = await newLesson(owner, who);
      const file = videoOf(30);
      const first = await begin(owner, who, one, file);
      const second = await begin(owner, who, two, file);
      const crossed = await send(second, file, { token: first.token });
      expect(crossed.result).toBe("failed");
      expect(await objectOf(owner, second.path)).toBeNull();
    });
  }, 60_000);

  it("otro archivo con una subida a medias: dice cuál elegir", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const file = videoOf(30);
      const go = await begin(owner, who, where, file);
      const other = await servicesOn(owner).videos.beginVideo(who.jar, { ...where, fileName: "otra.mp4", size: 99 });
      expect(other).toEqual({ kind: "pending", video: go.video, fileName: "clase.mp4" });
    });
  });

  it("lo que no se pudo leer no destruye la fila", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const file = videoOf(30);
      const go = await begin(owner, who, where, file);
      expect((await send(go, file)).result).toBe("done");
      // Storage no contesta al leer.
      const broken = createDraftVideos({
        store: createVideosStore((actor, work) => asServerFor(owner, actor.claims, work)),
        files: createVideoFiles(createVideoStorage(() => Promise.reject(new Error("caída")))),
        checkSession: (reader) => testServices().checkSession(reader),
        report: noReport,
      });
      expect(await broken.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "unavailable" });
      expect((await rowOf(owner, go.video))?.state).toBe("uploading");
      expect(await servicesOn(owner).videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "uploaded" });
    });
  }, 60_000);

  it.each([
    ["no es un video", Buffer.from("%PDF-1.7\nun contenido cualquiera, bastante largo\n", "latin1"), "clase.mp4", undefined, "content"],
    ["es un MOV sin ftyp con nombre de MP4", Buffer.concat([atom("wide"), atom("moov", mvhd(600, 6000))]), "clase.mp4", undefined, "content"],
    ["no tiene índice", Buffer.concat([ftyp, atom("mdat", Buffer.alloc(40))]), "clase.mp4", undefined, "duration"],
    ["dice 0 segundos", Buffer.concat([ftyp, atom("moov", mvhd(1000, 0))]), "clase.mp4", undefined, "duration"],
    ["pasa de 2 horas", videoOf(2 * 3600 + 1), "clase.mp4", undefined, "too_long"],
    ["se subió con otro tipo que el que fijó el servidor", videoOf(30), "clase.mp4", MOV, "type"],
  ])("se rechaza y se va la fila, con su ruta a la papelera: %s", async (_name, file, fileName, mime, reason) => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const go = await begin(owner, who, where, file, fileName);
      expect((await send(go, file, mime === undefined ? {} : { mime })).result).toBe("done");
      expect(await servicesOn(owner).videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "rejected", reason });
      expect(await rowOf(owner, go.video)).toBeNull();
      const trash = await owner.query<{ storage_path: string }>("select storage_path from private.video_trash where video_id = $1", [go.video]);
      expect(trash.rows).toEqual([{ storage_path: go.path }]);
    });
  }, 60_000);

  it("un MOV con índice al principio y sin ftyp sirve", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const file = Buffer.concat([atom("moov", mvhd(600, 6000)), atom("mdat", Buffer.alloc(100))]);
      const go = await begin(owner, who, where, file, "clase.mov");
      expect(go.mime).toBe(MOV);
      expect((await send(go, file)).result).toBe("done");
      expect(await servicesOn(owner).videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "uploaded" });
      expect((await rowOf(owner, go.video))?.read_seconds).toBe(10);
    });
  }, 60_000);

  it("quitar deja la fila fuera y la firma ya no se renueva", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const where = await newLesson(owner, who);
      const go = await begin(owner, who, where, videoOf(30));
      const { videos } = servicesOn(owner);
      expect(await videos.removeVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "deleted" });
      expect(await videos.renewVideoUpload(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "not_found" });
      expect(await videos.confirmVideo(who.jar, { course: where.course, video: go.video })).toEqual({ kind: "not_found" });
    });
  });
});
