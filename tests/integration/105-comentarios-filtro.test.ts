import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { commentsStoreOn, createComments } from "@/services/comments/comments";
import { testModeration, type Moderation } from "@/services/comments/moderation";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { asOwner, asServer, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-502, primera solicitud: el filtro de punta a punta, por el servicio y el almacén de la aplicación (`commentsStoreOn`) sobre
// una transacción del dueño que se revierte. Publicar deja el texto en el filtro; el servicio le pregunta al proveedor (aquí, el
// de prueba) y asienta en otra entrada del almacén, con la revisión que se filtró. Lo que marca la lista de la base no llega al
// proveedor. La carrera entre un veredicto viejo y una edición está en la 101, con dos conexiones.
//
// Pide las marcas locales `comments_accept` y `comments_test_filter` (las pone `db:login`).

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; claims: VerifiedClaims };

async function person(): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, claims: check.claims };
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

/** El servicio sobre esa transacción, con el almacén de la aplicación, la guarda que deja pasar a `who` y ese proveedor. */
function commentsAs(owner: Client, who: Person, moderation: Moderation | null = testModeration) {
  const reported: string[] = [];
  const store = commentsStoreOn(async (claims, _reason, work) => {
    const { claims: verified } = readVerifiedClaims(claims);
    await asServer(owner, verified.userId, verified.sessionId ?? "");
    try {
      return await work(txOn(owner));
    } finally {
      await asOwner(owner);
    }
  });
  const service = createComments({
    store,
    checkSession: () => Promise.resolve({ kind: "pass", claims: who.claims }),
    report: (code) => (reported.push(code), Promise.resolve()),
    moderation: () => moderation,
  });
  return { ...service, reported };
}
const reader = {} as CookieReader;

/** El mundo: el interruptor prendido y Teo, maestro con cuenta y su aviso al día, con un curso publicado y listado. */
async function world(owner: Client, teo: Person): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  await asOwner(owner);
  await owner.query("set local session_replication_role = replica");
  await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
  const teacherId = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [teo.id])).rows[0]!.id;
  await owner.query("insert into public.published_teachers (teacher_id, slug, display_name, is_listed) values ($1, $2, 'Maestro de la 105', true)", [teacherId, `maestro-105-${tag}`]);
  const course = (await owner.query<{ id: string }>("insert into public.course_registry (teacher_id, state, first_published_at) values ($1, 'published', now()) returning course_id as id", [teacherId]))
    .rows[0]!.id;
  await owner.query(
    `insert into public.published_courses (course_id, teacher_id, slug, title, teacher_name, lesson_count, total_duration_seconds, is_listed)
     values ($1, $2, $3, 'Curso de la 105', 'Maestro de la 105', 1, 100, true)`,
    [course, teacherId, `filtro-105-${tag}`],
  );
  const moduleId = randomUUID();
  await owner.query("insert into public.published_modules (id, course_id, title, position) values ($1, $2, 'Módulo', 1)", [moduleId, course]);
  const lesson = randomUUID();
  const video = (
    await owner.query<{ id: string }>(
      `insert into public.video_assets (course_id, teacher_id, lesson_id, provider, status, duration_seconds, provider_asset_id, provider_playback_id)
       values ($1, $2, $3, 'test', 'ready', 100, $4, $4) returning id`,
      [course, teacherId, lesson, `filtro-105-${tag}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
     values ($1, $2, $3, $4, $5, 'Lección', 1, 100)`,
    [lesson, course, moduleId, teacherId, video],
  );
  await owner.query(
    `insert into public.legal_documents (doc_type, version, title, body, effective_from)
     select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
     where private.current_legal_document('teacher_privacy_notice') is null`,
  );
  await owner.query("insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')", [teo.id]);
  // Un término de la lista, para esta transacción.
  await owner.query("insert into private.comment_filter_terms (term) values ('zorbak') on conflict do nothing");
  await owner.query("set local session_replication_role = origin");
  return lesson;
}

const filtered = async (owner: Client, id: string) =>
  (await owner.query<{ row: string }>("select concat_ws(' ', status, filter_verdict, filter_provider) as row from public.comments where id = $1", [id])).rows[0]!.row;

describe("el filtro de punta a punta (T-502; RF-802)", () => {
  it("con el proveedor de prueba: se publica, o queda en revisión por lo que contestó", async () => {
    const teo = await person();
    await reverted(async (owner) => {
      const lesson = await world(owner, teo);
      const service = commentsAs(owner, teo);
      const cases = [
        ["Una respuesta", "published", "published pass test"],
        ["Algo dudoso [revisar]", "in_review", "in_review flagged test"],
        ["Algo que preocupa [riesgo]", "in_review", "in_review risk test"],
        ["El proveedor no contestó [sin-filtro]", "in_review", "in_review unavailable test"],
      ] as const;
      for (const [body, state, row] of cases) {
        const written = await service.postLessonComment(reader, { lessonId: lesson, parentId: null, body });
        expect(written).toMatchObject({ kind: "written", state });
        if (written.kind !== "written") throw new Error(written.kind);
        expect(await filtered(owner, written.id)).toBe(row);
      }
      expect(service.reported).toEqual([]);
    });
  });

  it("sin proveedor, en revisión; y lo que marca la lista de la base no llega al proveedor", async () => {
    const teo = await person();
    await reverted(async (owner) => {
      const lesson = await world(owner, teo);
      const none = await commentsAs(owner, teo, null).postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Sin proveedor" });
      if (none.kind !== "written") throw new Error(none.kind);
      expect(none.state).toBe("in_review");
      expect(await filtered(owner, none.id)).toBe("in_review unavailable none");
      const spy: Moderation = { provider: "modelo", classify: vi.fn<Moderation["classify"]>(() => Promise.resolve("pass")) };
      const listed = await commentsAs(owner, teo, spy).postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Esto es z0rb4k" });
      if (listed.kind !== "written") throw new Error(listed.kind);
      expect(listed.state).toBe("in_review");
      expect(await filtered(owner, listed.id)).toBe("in_review flagged terms");
      expect(spy.classify).not.toHaveBeenCalled();
    });
  });

  it("editar vuelve a pasar por el filtro, con la revisión nueva; borrar lo que está en revisión deja su copia", async () => {
    const teo = await person();
    await reverted(async (owner) => {
      const lesson = await world(owner, teo);
      const service = commentsAs(owner, teo);
      const written = await service.postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Primero" });
      if (written.kind !== "written") throw new Error(written.kind);
      expect(await service.editLessonComment(reader, { commentId: written.id, body: "Corregido", revision: 1 })).toEqual({ kind: "written", id: written.id, state: "published" });
      expect(await service.editLessonComment(reader, { commentId: written.id, body: "Corregido [revisar]", revision: 2 })).toEqual({ kind: "written", id: written.id, state: "in_review" });
      expect(await service.deleteLessonComment(reader, { commentId: written.id, revision: 3 })).toEqual({ kind: "deleted" });
      const copy = (await owner.query<{ body: string; author_id: string }>("select body, author_id from private.comment_evidence where comment_id = $1", [written.id])).rows;
      expect(copy).toEqual([{ body: "Corregido [revisar]", author_id: teo.id }]);
    });
  });

  it("un seudónimo que marca la lista se rechaza", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await asOwner(owner);
      await owner.query("insert into private.comment_filter_terms (term) values ('zorbak') on conflict do nothing");
      expect(await commentsAs(owner, ana).chooseCommentName(reader, "Zorbak")).toEqual({ kind: "flagged" });
      expect(await commentsAs(owner, ana).chooseCommentName(reader, "Ana")).toEqual({ kind: "saved", pseudonym: "Ana" });
    });
  });

  it("la base local tiene la marca del proveedor de prueba y no la de publicar sin filtro", async () => {
    const owner = new Client({ connectionString: localOwnerUrl() });
    await owner.connect();
    try {
      const flags = (await owner.query<{ flag: string }>("select flag from private.local_flags where flag like 'comments_%' order by flag")).rows.map((row) => row.flag);
      expect(flags).toEqual(["comments_accept", "comments_test_filter"]);
    } finally {
      await owner.end();
    }
  });
});
