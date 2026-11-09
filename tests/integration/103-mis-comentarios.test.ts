import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { commentsStoreOn, createComments } from "@/services/comments/comments";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-501 · «Mis comentarios» (PA-24; decisiones de Sergio del 2026-11-08): la lista de lo propio contra la base, por el almacén de
// la aplicación (`commentsStoreOn`) sobre una transacción del dueño que se revierte. Lo que importa: que quien perdió el acceso
// a la lección vea lo suyo y lo borre con la revisión que vio, que nadie vea lo de otro, y que leerla no pase por la regla de
// acceso.
//
// Pide las marcas locales `comments_accept` y `comments_unfiltered` (las pone `db:login`).

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

/** El servicio sobre esa transacción, con el almacén de la aplicación y la guarda que deja pasar a `who`. */
function commentsAs(owner: Client, who: Person) {
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
  });
  return { ...service, reported };
}
const reader = {} as CookieReader;

/** Un curso publicado y listado, de una lección, de una maestra sin cuenta; con el interruptor prendido. */
async function world(owner: Client): Promise<{ lesson: string }> {
  const tag = randomUUID().slice(0, 8);
  await asOwner(owner);
  await owner.query("set local session_replication_role = replica");
  await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
  const teacher = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values (null, 'invited') returning id")).rows[0]!.id;
  await owner.query("insert into public.published_teachers (teacher_id, slug, display_name, is_listed) values ($1, $2, 'Maestra de la 103', true)", [teacher, `maestra-103-${tag}`]);
  const course = (
    await owner.query<{ id: string }>("insert into public.course_registry (teacher_id, state, first_published_at) values ($1, 'published', now()) returning course_id as id", [teacher])
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_courses (course_id, teacher_id, slug, title, teacher_name, lesson_count, total_duration_seconds, is_listed)
     values ($1, $2, $3, 'Curso de la 103', 'Maestra de la 103', 1, 100, true)`,
    [course, teacher, `mis-103-${tag}`],
  );
  const moduleId = randomUUID();
  await owner.query("insert into public.published_modules (id, course_id, title, position) values ($1, $2, 'Módulo', 1)", [moduleId, course]);
  const lesson = randomUUID();
  const video = (
    await owner.query<{ id: string }>(
      `insert into public.video_assets (course_id, teacher_id, lesson_id, provider, status, duration_seconds, provider_asset_id, provider_playback_id)
       values ($1, $2, $3, 'test', 'ready', 100, $4, $4) returning id`,
      [course, teacher, lesson, `mis-103-${tag}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
     values ($1, $2, $3, $4, $5, 'Lección de la 103', 1, 100)`,
    [lesson, course, moduleId, teacher, video],
  );
  await owner.query("set local session_replication_role = origin");
  return { lesson };
}

async function subscribe(owner: Client, profile: string): Promise<void> {
  await owner.query(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start, current_period_end)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', 'active', 'MXN', now() - interval '1 day', now() + interval '30 days')`,
    [profile],
  );
}

/** La suscripción se venció: el periodo terminó hace más que la gracia. */
async function expire(owner: Client, profile: string): Promise<void> {
  await asOwner(owner);
  await owner.query("set local session_replication_role = replica");
  await owner.query("update public.subscriptions set status = 'canceled', current_period_start = now() - interval '90 days', current_period_end = now() - interval '60 days' where profile_id = $1", [profile]);
  await owner.query("set local session_replication_role = origin");
}

describe("«Mis comentarios» contra la base", () => {
  it("quien perdió el acceso ve lo suyo y lo borra con la revisión que vio; nadie más lo ve", async () => {
    const [ana, beto] = [await person(), await person()];
    await reverted(async (owner) => {
        const { lesson } = await world(owner);
        await subscribe(owner, ana.id);
        const asAna = commentsAs(owner, ana);
        expect(await asAna.chooseCommentName(reader, "Ana")).toEqual({ kind: "saved", pseudonym: "Ana" });
        const written = await asAna.postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Lo que escribí" });
        expect(written).toMatchObject({ kind: "written", state: "published" });
        const id = written.kind === "written" ? written.id : "";

        await expire(owner, ana.id);
        // Sin acceso, la lección ya no le da sus comentarios: de ahí no sale el id ni la revisión.
        expect(await asAna.lessonComments(ana.claims, lesson, null)).toMatchObject({ kind: "no_access" });
        const mine = await asAna.myComments(ana.claims, null);
        expect(mine).toEqual({
          kind: "ready",
          next: null,
          items: [
            {
              id,
              revision: 1,
              body: "Lo que escribí",
              state: "published",
              edited: false,
              createdAt: expect.any(String),
              isReply: false,
              courseTitle: "Curso de la 103",
              lessonTitle: "Lección de la 103",
              link: { slug: expect.stringMatching(/^mis-103-/), lessonId: lesson },
            },
          ],
        });
        expect(await commentsAs(owner, beto).myComments(beto.claims, null)).toEqual({ kind: "ready", items: [], next: null });

        expect(await asAna.deleteLessonComment(reader, { commentId: id, revision: 1 })).toEqual({ kind: "deleted" });
        expect(await asAna.myComments(ana.claims, null)).toEqual({ kind: "ready", items: [], next: null });
        expect(asAna.reported).toEqual([]);
    });
  });

  it("si cambió entre leer la lista y borrar, contesta `changed` y no borra", async () => {
    const ana = await person();
    await reverted(async (owner) => {
        const { lesson } = await world(owner);
        await subscribe(owner, ana.id);
        const asAna = commentsAs(owner, ana);
        await asAna.chooseCommentName(reader, "Ana");
        const written = await asAna.postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Primero" });
        const id = written.kind === "written" ? written.id : "";
        const seen = await asAna.myComments(ana.claims, null);
        const revision = seen.kind === "ready" ? (seen.items[0]?.revision ?? 0) : 0;
        expect(await asAna.editLessonComment(reader, { commentId: id, body: "Después", revision })).toMatchObject({ kind: "written" });
        expect(await asAna.deleteLessonComment(reader, { commentId: id, revision })).toEqual({ kind: "changed" });
        expect(await asAna.myComments(ana.claims, null)).toMatchObject({ kind: "ready", items: [{ id, body: "Después", revision: revision + 1, edited: true }] });
    });
  });

  it("con el veto también se lee y se borra lo suyo; lo que queda en revisión aparece, lo oculto no", async () => {
    const cata = await person();
    await reverted(async (owner) => {
        const { lesson } = await world(owner);
        await subscribe(owner, cata.id);
        const asCata = commentsAs(owner, cata);
        await asCata.chooseCommentName(reader, "Cata");
        const shown = await asCata.postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Se ve" });
        const hidden = await asCata.postLessonComment(reader, { lessonId: lesson, parentId: null, body: "Se oculta" });
        await asOwner(owner);
        await owner.query("set local session_replication_role = replica");
        await owner.query("update public.comments set status = 'in_review' where id = $1", [shown.kind === "written" ? shown.id : ""]);
        await owner.query("update public.comments set status = 'hidden', hidden_at = now() where id = $1", [hidden.kind === "written" ? hidden.id : ""]);
        await owner.query("update public.profiles set comment_ban_until = now() + interval '1 day' where id = $1", [cata.id]);
        await owner.query("set local session_replication_role = origin");
        const mine = await asCata.myComments(cata.claims, null);
        expect(mine).toMatchObject({ kind: "ready", items: [{ body: "Se ve", state: "in_review" }] });
        const item = mine.kind === "ready" ? mine.items[0] : undefined;
        expect(await asCata.deleteLessonComment(reader, { commentId: item?.id ?? "", revision: item?.revision ?? 0 })).toEqual({ kind: "deleted" });
    });
  });

  it("un cursor sin forma empieza por lo más reciente; uno bien formado sigue después", async () => {
    const ana = await person();
    await reverted(async (owner) => {
        const { lesson } = await world(owner);
        await subscribe(owner, ana.id);
        const asAna = commentsAs(owner, ana);
        await asAna.chooseCommentName(reader, "Ana");
        for (const n of [1, 2, 3]) await asAna.postLessonComment(reader, { lessonId: lesson, parentId: null, body: `Número ${n}` });
        const all = await asAna.myComments(ana.claims, "basura");
        expect(all).toMatchObject({ kind: "ready", next: null });
        const items = all.kind === "ready" ? all.items : [];
        expect(items).toHaveLength(3);
        const first = items[0]!;
        const after = await asAna.myComments(ana.claims, `${first.createdAt}_${first.id}`);
        expect(after.kind === "ready" ? after.items.map((each) => each.id) : null).toEqual(items.slice(1).map((each) => each.id));
    });
  });
});
