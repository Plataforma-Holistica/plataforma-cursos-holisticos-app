import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createResourceStorage } from "@/adapters/supabase/storage";
import { createDrafts } from "@/services/drafts/drafts";
import { createDraftResources } from "@/services/drafts/resources";
import { createDraftsStore, createResourcesStore } from "@/services/drafts/store";
import { createResourceFiles } from "@/services/media/resource-files";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Los recursos de un curso (T-404, segunda solicitud) contra la base y el Storage locales. pgTAP simula el objeto;
// aquí se sube de verdad, y se mide lo que el diseño supone de Storage: que un segundo envío con la misma dirección no
// reemplaza, que la dirección no sirve para otra ruta, que la cubeta rechaza lo que no está en su lista, y la forma de
// los metadatos que confirmar compara.
//
// Los maestros y los borradores viven en una transacción del dueño que se revierte. Los objetos no: los escribe Storage
// con su propia conexión, y cada caso los borra.

const emails: string[] = [];
const uploaded: string[] = [];
const storage = createResourceStorage();

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

const servicesOn = (owner: Client) => {
  const resources = createDraftResources({
    store: createResourcesStore((actor, work) => asServerFor(owner, actor.claims, work)),
    files: createResourceFiles(storage),
    checkSession: (reader) => testServices().checkSession(reader),
    report: noReport,
  });
  return {
    resources,
    // Con lo mismo que arma `editor.ts`: borrar se lleva los objetos.
    drafts: createDrafts({
      afterDelete: resources.cleanUp,
      store: createDraftsStore(
        (actor, work) => asServerFor(owner, actor.claims, work),
        () => Promise.reject(new Error("Aquí no se lee como la persona.")),
        () => Promise.reject(new Error("Aquí no se lee como sistema.")),
      ),
      checkSession: (reader) => testServices().checkSession(reader),
      report: noReport,
    }),
  };
};

async function newCourse(owner: Client, who: Person): Promise<string> {
  const created = await servicesOn(owner).drafts.createCourse(who.jar, { token: crypto.randomUUID(), title: "Con recursos" });
  if (created.kind !== "created" || !created.id) throw new Error(`No se creó el curso: ${created.kind}`);
  return created.id;
}

const ascii = (text: string) => Buffer.from(text, "latin1");
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_BYTES = ascii("%PDF-1.7\nun contenido cualquiera\n%%EOF\n");

const put = (url: string, body: Buffer, mime: string) => fetch(url, { method: "PUT", headers: { "content-type": mime }, body: new Uint8Array(body) });

const pathOf = async (owner: Client, resource: string) =>
  (await owner.query<{ storage_path: string }>("select storage_path from public.draft_resources where id = $1", [resource])).rows[0]?.storage_path ?? null;

/** Empieza una subida y anota su objeto para borrarlo al final. */
async function begin(owner: Client, who: Person, course: string, fileName = "guia.pdf", size = PDF_BYTES.length) {
  const started = await servicesOn(owner).resources.beginResource(who.jar, { course, lesson: null, title: "Guía", fileName, size });
  if (started.kind !== "started") throw new Error(`No empezó: ${started.kind}`);
  const path = await pathOf(owner, started.resource);
  if (path === null) throw new Error("Sin ruta.");
  uploaded.push(path);
  return { ...started, path };
}

const stateOf = async (owner: Client, resource: string) =>
  (await owner.query<{ state: string }>("select state from public.draft_resources where id = $1", [resource])).rows[0]?.state ?? null;

describe("subir un recurso de verdad", () => {
  it("empezar, subir y confirmar: queda listo, con el tamaño y el tipo que Storage guardó", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect(started.mime).toBe(PDF_MIME);
      expect(started.url).toContain(`/object/upload/sign/course-resources/${started.path}`);
      expect((await put(started.url, PDF_BYTES, started.mime)).ok).toBe(true);

      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource })).toEqual({ kind: "ready" });
      const row = (
        await owner.query<{ state: string; size_bytes: string; object_id: string; object_version: string }>(
          "select state, size_bytes, object_id, object_version from public.draft_resources where id = $1",
          [started.resource],
        )
      ).rows[0];
      expect(row?.state).toBe("ready");
      expect(Number(row?.size_bytes)).toBe(PDF_BYTES.length);
      const object = (await owner.query<{ id: string; version: string }>("select id, version from storage.objects where bucket_id = 'course-resources' and name = $1", [started.path])).rows[0];
      expect(row?.object_id).toBe(object?.id);
      expect(row?.object_version).toBe(object?.version);
    });
  });

  it("sin subir no se confirma, y la fila se queda", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource })).toEqual({ kind: "not_uploaded" });
      expect(await stateOf(owner, started.resource)).toBe("pending");
    });
  });

  it("un segundo envío con la misma dirección no reemplaza lo subido: lo que se leyó es lo que se sirve", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, PDF_BYTES, started.mime)).ok).toBe(true);
      const version = async () =>
        (await owner.query<{ version: string }>("select version from storage.objects where bucket_id = 'course-resources' and name = $1", [started.path])).rows[0]?.version;
      const before = await version();
      expect((await put(started.url, ascii("%PDF-1.7\notra cosa"), started.mime)).ok).toBe(false);
      expect(await version()).toBe(before);
      expect(Buffer.from((await storage.readStart(started.path, PDF_BYTES.length)) ?? []).equals(PDF_BYTES)).toBe(true);
    });
  });

  it("tampoco si el navegador pide reemplazar: lo manda la firma, no su cabecera", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, PDF_BYTES, started.mime)).ok).toBe(true);
      const response = await fetch(started.url, {
        method: "PUT",
        headers: { "content-type": started.mime, "x-upsert": "true" },
        body: new Uint8Array(ascii("%PDF-1.7\notra cosa")),
      });
      expect(response.ok).toBe(false);
      expect(Buffer.from((await storage.readStart(started.path, PDF_BYTES.length)) ?? []).equals(PDF_BYTES)).toBe(true);
    });
  });

  it("la dirección no sirve para otra ruta", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      const other = started.url.replace(started.path, `${started.path}-otra`);
      expect((await put(other, PDF_BYTES, started.mime)).ok).toBe(false);
      expect(await storage.readStart(`${started.path}-otra`, 4)).toBeNull();
    });
  });

  it("la cubeta rechaza por sí misma un tipo que no está en su lista", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, ascii("<html></html>"), "text/html")).ok).toBe(false);
    });
  });
});

describe("lo que no es lo que dice", () => {
  it("un PDF disfrazado se rechaza por su contenido: la fila se va, y su objeto también", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, ascii("MZ esto es un ejecutable"), started.mime)).ok).toBe(true);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource })).toEqual({ kind: "rejected", reason: "content" });
      expect(await stateOf(owner, started.resource)).toBeNull();
      expect(await storage.readStart(started.path, 4)).toBeNull();
    });
  });

  it("subir con otro tipo del que dijo el servidor se rechaza por el tipo guardado", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, PDF_BYTES, "audio/mpeg")).ok).toBe(true);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource })).toEqual({ kind: "rejected", reason: "type" });
      expect(await storage.readStart(started.path, 4)).toBeNull();
    });
  });

  it("un Word se lee también por su final, y uno con macros se rechaza", async () => {
    const who = await person();
    const word = (...names: string[]) => Buffer.concat([ascii("PK\x03\x04"), Buffer.alloc(100_000), ...names.map(ascii), ascii("PK\x05\x06"), Buffer.alloc(18)]);
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);

      const good = word("[Content_Types].xml", "word/document.xml");
      const first = await begin(owner, who, course, "apuntes.docx", good.length);
      expect(first.mime).toBe(DOCX_MIME);
      expect((await put(first.url, good, first.mime)).ok).toBe(true);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: first.resource })).toEqual({ kind: "ready" });

      const macros = word("[Content_Types].xml", "word/document.xml", "word/vbaProject.bin");
      const second = await begin(owner, who, course, "con-macros.docx", macros.length);
      expect((await put(second.url, macros, second.mime)).ok).toBe(true);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: second.resource })).toEqual({ kind: "rejected", reason: "content" });
    });
  });

  it("un Word más chico que lo que se pide leer de su final también se lee", async () => {
    const who = await person();
    const small = Buffer.concat([ascii("PK\x03\x04"), ascii("[Content_Types].xml"), ascii("word/document.xml"), ascii("PK\x05\x06"), Buffer.alloc(18)]);
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course, "chico.docx", small.length);
      expect((await put(started.url, small, started.mime)).ok).toBe(true);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource })).toEqual({ kind: "ready" });
    });
  });

  it("un archivo de 0 bytes se rechaza por su tamaño: no se puede leer, y ya se sabe que no sirve", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, Buffer.alloc(0), started.mime)).ok).toBe(true);
      expect(await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource })).toEqual({ kind: "rejected", reason: "size" });
      expect(await stateOf(owner, started.resource)).toBeNull();
    });
  });
});

describe("quitar y borrar", () => {
  it("quitar se lleva la fila y el objeto", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const course = await newCourse(owner, who);
      const started = await begin(owner, who, course);
      expect((await put(started.url, PDF_BYTES, started.mime)).ok).toBe(true);
      await servicesOn(owner).resources.confirmResource(who.jar, { course, resource: started.resource });
      expect(await servicesOn(owner).resources.removeResource(who.jar, { course, resource: started.resource, seen: 1 })).toEqual({ kind: "deleted" });
      expect(await stateOf(owner, started.resource)).toBeNull();
      expect(await storage.readStart(started.path, 4)).toBeNull();
    });
  });

  it("borrar una lección o el curso se lleva también los objetos", async () => {
    const who = await person();
    await reverted(async (owner) => {
      await teacher(owner, who);
      const services = servicesOn(owner);
      const course = await newCourse(owner, who);
      const added = await services.drafts.addModule(who.jar, { course, seen: 1, title: "Inicio" });
      if (added.kind !== "created" || !added.id) throw new Error(`Sin módulo: ${added.kind}`);
      const module = added.id;
      const lesson = await services.drafts.addLesson(who.jar, { course, module, seen: 1, title: "Una" });
      if (lesson.kind !== "created" || !lesson.id) throw new Error(`Sin lección: ${lesson.kind}`);
      const lessonId = lesson.id;

      const inLesson = await services.resources.beginResource(who.jar, { course, lesson: lessonId, title: "De la lección", fileName: "a.pdf", size: PDF_BYTES.length });
      if (inLesson.kind !== "started") throw new Error(`No empezó: ${inLesson.kind}`);
      const lessonPath = await pathOf(owner, inLesson.resource);
      if (lessonPath === null) throw new Error("Sin ruta.");
      uploaded.push(lessonPath);
      expect((await put(inLesson.url, PDF_BYTES, inLesson.mime)).ok).toBe(true);
      await services.resources.confirmResource(who.jar, { course, resource: inLesson.resource });
      expect(await storage.readStart(lessonPath, 4)).not.toBeNull();

      const revision = (await owner.query<{ revision: string }>("select revision from public.draft_lessons where id = $1", [lessonId])).rows[0]?.revision;
      expect(await services.drafts.deleteLesson(who.jar, { course, lesson: lessonId, seen: Number(revision) })).toEqual({ kind: "deleted" });
      expect(await storage.readStart(lessonPath, 4)).toBeNull();

      const started = await begin(owner, who, course);
      expect((await put(started.url, PDF_BYTES, started.mime)).ok).toBe(true);
      await services.resources.confirmResource(who.jar, { course, resource: started.resource });
      const content = (await owner.query<{ content_revision: string }>("select content_revision from public.course_drafts where course_id = $1", [course])).rows[0]?.content_revision;
      expect(await services.drafts.deleteCourse(who.jar, { course, seen: Number(content) })).toEqual({ kind: "deleted" });
      expect(await storage.readStart(started.path, 4)).toBeNull();
    });
  });

  it("otro maestro no firma, no confirma ni quita lo ajeno", async () => {
    const ana = await person();
    const beto = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      await teacher(owner, beto);
      const course = await newCourse(owner, ana);
      const started = await begin(owner, ana, course);
      const service = servicesOn(owner).resources;
      expect(await service.beginResource(beto.jar, { course, lesson: null, title: "Ajeno", fileName: "a.pdf", size: 10 })).toEqual({ kind: "not_found" });
      expect(await service.confirmResource(beto.jar, { course, resource: started.resource })).toEqual({ kind: "not_found" });
      expect(await service.removeResource(beto.jar, { course, resource: started.resource, seen: 1 })).toEqual({ kind: "not_found" });
      expect(await stateOf(owner, started.resource)).toBe("pending");
    });
  });
});
