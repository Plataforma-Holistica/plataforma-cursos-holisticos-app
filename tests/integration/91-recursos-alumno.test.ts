import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createResourceStorage } from "@/adapters/supabase/storage";
import { signPlayback } from "@/adapters/mux/sign";
import { createMediaGrant } from "@/services/media/grant";
import { createResourceFiles } from "@/services/media/resource-files";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, type KnownUser, type MemoryJar } from "./helpers/auth";
import { mediaStoreOn } from "./helpers/media";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Bajar un recurso (T-404, tercera solicitud; RF-308, FL-14) contra la base y el Storage locales: la puerta de medios de
// verdad, y lo que se mide de Storage. pgTAP simula el objeto; aquí se sube, y la dirección que sale se usa.
//
// Lo publicado y el freno viven en una transacción del dueño que se revierte. Los objetos no: los escribe Storage con su
// propia conexión, y se borran al final.

const emails: string[] = [];
const uploaded: string[] = [];
const storage = createResourceStorage();
const PDF_MIME = "application/pdf";
const PDF_BYTES = Buffer.from("%PDF-1.7\nun contenido cualquiera\n%%EOF\n", "latin1");

afterAll(async () => {
  await storage.remove(uploaded);
  await deleteTestUsersByEmail(emails);
});

async function person(): Promise<{ who: KnownUser; jar: MemoryJar }> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return { who, jar };
}

function mediaOn(owner: Client) {
  const reported: string[] = [];
  const media = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: testServices().teamStanding,
      checkSession: testServices().checkSession,
      store: mediaStoreOn(owner),
      signingKey: () => null,
      sign: signPlayback,
      files: createResourceFiles(storage),
      now: () => 1_800_000_000,
    },
  );
  return { ...media, reported };
}

async function upload(path: string, body: Buffer = PDF_BYTES): Promise<void> {
  const url = await storage.signUpload(path);
  if (url === null) throw new Error("No se firmó la subida.");
  const response = await fetch(url, { method: "PUT", headers: { "content-type": PDF_MIME }, body: new Uint8Array(body) });
  if (!response.ok) throw new Error(`No subió: ${response.status}`);
  uploaded.push(path);
}

interface Published {
  teacher: string;
  course: string;
  resource: string;
  path: string;
}

let nextSlug = 0;

/** Un curso publicado y listado (o no), con un recurso publicado sobre un objeto que se subió de verdad. */
async function publish(owner: Client, options: { listed?: boolean; open?: boolean; title?: string } = {}): Promise<Published> {
  const { listed = true, open = false, title = "Guía de respiración" } = options;
  const slug = `curso-recurso-${process.pid}-${++nextSlug}`;
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de bajar'), private.system_catalog_add('levels', 'Nivel de bajar')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de bajar', $1, null)::text as id", [`maestra-${slug}`])).rows[0]?.id ?? "";
  const loaded = await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [
    teacher,
    JSON.stringify({
      slug,
      title: `Curso ${slug}`,
      practice: "practica-de-bajar",
      level: "nivel-de-bajar",
      modules: [{ title: "Uno", lessons: [{ title: "Con Mux", video: { provider: "mux", asset_id: `Asset${nextSlug}`, playback_id: `Playback${nextSlug}`, duration_seconds: 600 } }] }],
    }),
  ]);
  if (loaded.rows[0]?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded.rows[0]?.answer}`);
  const course = (await owner.query<{ id: string }>("select course_id::text as id from public.published_courses where slug = $1", [slug])).rows[0]?.id ?? "";
  await owner.query("update public.course_registry set state = 'published', first_published_at = now(), is_open = $2, open_since = case when $2 then now() end where course_id = $1", [course, open]);
  await owner.query("update public.published_courses set is_listed = $2, is_open = $3 where course_id = $1", [course, listed, open]);
  const path = `${teacher}/${course}/${randomUUID()}`;
  await upload(path);
  const inserted = await owner.query<{ id: string }>(
    `insert into public.published_resources (course_id, teacher_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
     select $1::uuid, $2::uuid, $3, 'pdf', $4, o.name, o.id, o.version, (o.metadata ->> 'size')::bigint, 1
       from storage.objects o where o.bucket_id = 'course-resources' and o.name = $5
     returning id::text as id`,
    [course, teacher, title, PDF_MIME, path],
  );
  await asOwner(owner);
  const resource = inserted.rows[0]?.id;
  if (resource === undefined) throw new Error("No se publicó el recurso: Storage no tiene el objeto.");
  return { teacher, course, resource, path };
}

async function subscribe(owner: Client, profile: string): Promise<void> {
  await owner.query(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
    [profile],
  );
}

const hits = async (owner: Client, profile: string) =>
  (await owner.query<{ hits: number }>("select coalesce(sum(hits), 0)::int as hits from private.rate_limit_counters where bucket = $1", [`resource_download:${profile}`])).rows[0]?.hits;

describe("bajar lo publicado", () => {
  it("con acceso: una dirección que entrega el archivo como adjunto, con el nombre que arma el servidor, y cuenta en el freno", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource } = await publish(owner);
      await subscribe(owner, who.id);
      const media = mediaOn(owner);
      const grant = await media.getResourceGrant(jar, resource);
      if (grant.kind !== "granted") throw new Error(`No se dio: ${grant.kind}`);
      expect(media.reported).toEqual([]);
      expect(await hits(owner, who.id)).toBe(1);

      const response = await fetch(grant.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(PDF_MIME);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(decodeURIComponent(response.headers.get("content-disposition") ?? "")).toContain("Guía de respiración.pdf");
      expect(Buffer.from(await response.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
    });
  });

  it("el nombre sin lo que rompe una cabecera: lo que un maestro escriba en el título no se le mete a la respuesta", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource } = await publish(owner, { title: 'Guía"; filename="otro.exe' });
      await subscribe(owner, who.id);
      const grant = await mediaOn(owner).getResourceGrant(jar, resource);
      if (grant.kind !== "granted") throw new Error(`No se dio: ${grant.kind}`);
      const header = decodeURIComponent((await fetch(grant.url)).headers.get("content-disposition") ?? "");
      expect(header).toMatch(/^attachment;/);
      expect(header).not.toContain('"; filename="');
      expect(header).toContain(".pdf");
    });
  });

  it("la dirección no sirve para otra ruta, ni sin su testigo, ni con un testigo cambiado", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource, path } = await publish(owner);
      const other = await publish(owner);
      await subscribe(owner, who.id);
      const grant = await mediaOn(owner).getResourceGrant(jar, resource);
      if (grant.kind !== "granted") throw new Error(`No se dio: ${grant.kind}`);
      expect((await fetch(grant.url.replace(path, other.path))).ok).toBe(false);
      expect((await fetch(grant.url.replace(/token=[^&]+/, ""))).ok).toBe(false);
      expect((await fetch(grant.url.replace(/token=([^&]{4})/, "token=xxxx"))).ok).toBe(false);
    });
  });

  it("una dirección caducada ya no entrega nada (FL-14, E2)", async () => {
    await reverted(async (owner) => {
      const { path } = await publish(owner);
      const url = await storage.signDownload(path, "a.pdf", 1);
      if (url === null) throw new Error("No se firmó.");
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect((await fetch(url)).ok).toBe(false);
    });
  });

  it("sin acceso: el motivo para PA-33, sin firmar y sin gastar su cupo", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource } = await publish(owner);
      const media = mediaOn(owner);
      expect(await media.getResourceGrant(jar, resource)).toEqual({ kind: "denied", account: { allowed: false, reason: "never_subscribed" } });
      expect(await hits(owner, who.id)).toBe(0);
    });
  });

  it("el curso abierto incluye los recursos (RF-309): sin suscripción y con el correo verificado", async () => {
    const { jar } = await person();
    await reverted(async (owner) => {
      const { resource } = await publish(owner, { open: true });
      expect((await mediaOn(owner).getResourceGrant(jar, resource)).kind).toBe("granted");
    });
  });

  it("de un curso sin listar, se contesta igual que lo que no existe", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource } = await publish(owner, { listed: false });
      await subscribe(owner, who.id);
      expect(await mediaOn(owner).getResourceGrant(jar, resource)).toEqual({ kind: "not_found" });
      expect(await mediaOn(owner).getResourceGrant(jar, randomUUID())).toEqual({ kind: "not_found" });
    });
  });

  it("con el objeto reemplazado por fuera, la barrera no lo suelta: lo publicado es lo que se revisó", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource, path } = await publish(owner);
      await subscribe(owner, who.id);
      const secret = process.env.SUPABASE_SECRET_KEY ?? "";
      const replaced = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "")}/storage/v1/object/course-resources/${path}`, {
        method: "PUT",
        headers: { apikey: secret, authorization: `Bearer ${secret}`, "content-type": PDF_MIME, "x-upsert": "true" },
        body: new Uint8Array(Buffer.from("%PDF-1.7\notro contenido\n%%EOF\n", "latin1")),
      });
      expect(replaced.ok).toBe(true);
      const media = mediaOn(owner);
      expect(await media.getResourceGrant(jar, resource)).toEqual({ kind: "unavailable" });
      expect(media.reported).toEqual(["resource_grant_unavailable"]);
      expect(await hits(owner, who.id)).toBe(0);
    });
  });

  it("con el tope gastado: `throttled`, sin firmar", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const { resource } = await publish(owner);
      await subscribe(owner, who.id);
      await owner.query(
        `insert into private.rate_limit_counters (bucket, window_start, hits)
         values ($1, date_trunc('hour', now()), (private.parameter_value('TOPE_DESCARGAS_HORA'))::integer)`,
        [`resource_download:${who.id}`],
      );
      expect(await mediaOn(owner).getResourceGrant(jar, resource)).toEqual({ kind: "throttled" });
    });
  });
});

describe("lo que cualquiera lee de lo publicado", () => {
  it("la ficha lista los recursos del curso y la lección los suyos; ninguna lectura trae la ruta", async () => {
    const { readCourseLessons } = await import("@/services/browse/records");
    const { readLessonResources } = await import("@/services/lessons/records");
    await reverted(async (owner) => {
      const { course, teacher, resource, path } = await publish(owner);
      const tx = {
        query: async (query: { text: string; values: readonly unknown[] }, row: { parse: (each: unknown) => unknown }) =>
          (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
        execute: async () => 0,
      } as never;
      const slug = (await owner.query<{ slug: string }>("select slug from public.published_courses where course_id = $1", [course])).rows[0]?.slug ?? "";
      const read = await readCourseLessons(tx, slug);
      expect(read.resources).toEqual([{ id: resource, title: "Guía de respiración", kind: "pdf", sizeBytes: PDF_BYTES.length }]);
      expect(JSON.stringify(read)).not.toContain(path);

      const lesson = (await owner.query<{ id: string }>("select id::text as id from public.published_lessons where course_id = $1", [course])).rows[0]?.id ?? "";
      await asSystem(owner);
      const lessonPath = `${teacher}/${course}/${randomUUID()}`;
      await upload(lessonPath);
      await owner.query(
        `insert into public.published_resources (course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
         select $1::uuid, $2::uuid, $3::uuid, 'De la lección', 'pdf', $4, o.name, o.id, o.version, (o.metadata ->> 'size')::bigint, 1
           from storage.objects o where o.bucket_id = 'course-resources' and o.name = $5`,
        [course, teacher, lesson, PDF_MIME, lessonPath],
      );
      await asOwner(owner);
      const rows = await readLessonResources(tx, lesson);
      expect(rows.map((row) => row.title)).toEqual(["De la lección"]);
      // Lo de la lección no se cuela en la ficha.
      expect((await readCourseLessons(tx, slug)).resources.map((row) => row.title)).toEqual(["Guía de respiración"]);
    });
  });
});
