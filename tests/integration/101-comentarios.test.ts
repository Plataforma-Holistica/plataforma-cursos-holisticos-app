import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimedUser } from "./helpers/account";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// T-501, primera solicitud: los comentarios contra lo que corre a la vez, con dos conexiones de verdad. Lo que una transacción revertida no puede mostrar:
// dos ediciones con la misma versión, responder mientras el autor borra el comentario, y el freno con dos envíos a la vez.
//
// Lo publicado se arma a mano, con las guardias apagadas, y se quita al terminar igual; el interruptor se prende para esta prueba y vuelve a como estaba.
// Pide la marca local `comments_test_filter` (la pone `db:login`): sin ella, el aprobado del proveedor de prueba no publica.

let owner: Client;
let other: Client;
const emails: string[] = [];
const people: string[] = [];
let teacherId: string;
let course: string;
let lesson: string;
let switchBefore: unknown;

type Answer = { answer: string; id?: string; revision?: number; state?: string };

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

/** Lo que contesta una función como el servidor a nombre de una persona, en la transacción abierta de esa conexión, tal cual. */
async function raw(client: Client, person: string, text: string, params: unknown[]): Promise<Answer> {
  await asServer(client, person, randomUUID());
  const answer = (await client.query<{ r: Answer }>(`select ${text} as r`, params)).rows[0]!.r;
  await asOwner(client);
  return answer;
}

/** Lo mismo, y lo que queda en el filtro, asentado. */
async function as(client: Client, person: string, text: string, params: unknown[]): Promise<Answer> {
  await asServer(client, person, randomUUID());
  let answer = (await client.query<{ r: Answer }>(`select ${text} as r`, params)).rows[0]!.r;
  // Como el servidor (T-502): lo que queda en el filtro se asienta con el aprobado del proveedor de prueba.
  if (answer.state === "in_filter") {
    const settled = await client.query<{ r: Answer }>("select private.comment_settle($1, $2::bigint, 'pass', 'test') as r", [answer.id, answer.revision]);
    answer = { ...answer, state: settled.rows[0]!.r.state };
  }
  await asOwner(client);
  return answer;
}

const revision = async (comment: string) =>
  (await owner.query<{ revision: string }>("select revision::text as revision from public.comments where id = $1", [comment])).rows[0]!.revision;

async function post(person: string, body: string, parent: string | null = null): Promise<string> {
  const answer = await inTx(owner, () => as(owner, person, "private.comment_post($1, $2, $3)", [lesson, parent, body]));
  expect(answer.answer).toBe("ok");
  return answer.id!;
}

async function student(pseudonym: string): Promise<string> {
  const who = await claimedUser();
  emails.push(who.email);
  people.push(who.id);
  await completeAccountAsOwner(who.id);
  expect((await inTx(owner, () => as(owner, who.id, "private.comment_set_pseudonym($1)", [pseudonym]))).answer).toBe("ok");
  return who.id;
}

beforeAll(async () => {
  owner = await connect();
  other = await connect();
  await owner.query("grant app_service to postgres with set true, inherit false");
  expect((await owner.query("select 1 from private.local_flags where flag = 'comments_test_filter'")).rowCount).toBe(1);
  const tag = randomUUID().slice(0, 8);
  // Un maestro activo tiene cuenta; aquí no comenta.
  const teacher = await claimedUser();
  emails.push(teacher.email);
  await inTx(owner, async () => {
    await owner.query("set local session_replication_role = replica");
    switchBefore = (await owner.query<{ value: unknown }>("select value from public.business_parameters where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null")).rows[0]!.value;
    await owner.query("update public.business_parameters set value = 'true' where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null");
    teacherId = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status) values ($1, 'active') returning id", [teacher.id])).rows[0]!.id;
    await owner.query("insert into public.published_teachers (teacher_id, slug, display_name, is_listed) values ($1, $2, 'Maestra de la 101', true)", [teacherId, `maestra-${tag}`]);
    course = (await owner.query<{ id: string }>("insert into public.course_registry (teacher_id, state, first_published_at) values ($1, 'published', now()) returning course_id as id", [teacherId])).rows[0]!.id;
    await owner.query(
      `insert into public.published_courses (course_id, teacher_id, slug, title, teacher_name, lesson_count, total_duration_seconds, is_listed)
       values ($1, $2, $3, 'Curso de la 101', 'Maestra de la 101', 1, 100, true)`,
      [course, teacherId, `comentarios-${tag}`],
    );
    const moduleId = randomUUID();
    await owner.query("insert into public.published_modules (id, course_id, title, position) values ($1, $2, 'Módulo', 1)", [moduleId, course]);
    lesson = randomUUID();
    const video = (
      await owner.query<{ id: string }>(
        `insert into public.video_assets (course_id, teacher_id, lesson_id, provider, status, duration_seconds, provider_asset_id, provider_playback_id)
         values ($1, $2, $3, 'test', 'ready', 100, $4, $4) returning id`,
        [course, teacherId, lesson, `comentarios-${tag}`],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
       values ($1, $2, $3, $4, $5, 'Lección', 1, 100)`,
      [lesson, course, moduleId, teacherId, video],
    );
  });
});

afterAll(async () => {
  await owner.query("begin");
  await owner.query("set local session_replication_role = replica");
  await owner.query("delete from public.comments where course_id = $1", [course]);
  await owner.query("delete from public.profile_privacy where profile_id = any($1::uuid[])", [people]);
  await owner.query("delete from private.rate_limit_counters where bucket = any($1::text[])", [people.map((id) => `comments:${id}`)]);
  await owner.query("delete from public.published_lessons where course_id = $1", [course]);
  await owner.query("delete from public.video_assets where course_id = $1", [course]);
  await owner.query("delete from public.published_modules where course_id = $1", [course]);
  await owner.query("delete from public.published_courses where course_id = $1", [course]);
  await owner.query("delete from public.course_registry where course_id = $1", [course]);
  await owner.query("delete from public.published_teachers where teacher_id = $1", [teacherId]);
  await owner.query("delete from public.teachers where id = $1", [teacherId]);
  await owner.query("update public.business_parameters set value = $1 where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null", [JSON.stringify(switchBefore)]);
  await owner.query("commit");
  await owner.query("revoke app_service from postgres");
  await owner.end();
  await other.end();
  await deleteTestUsersByEmail(emails);
});

describe("los comentarios con dos conexiones (T-501)", () => {
  it("un veredicto que llega mientras se edita espera a la edición, y no publica el texto nuevo (T-502)", async () => {
    const ana = await student("Ana del filtro");
    const comment = await post(ana, "El original");
    const seen = Number(await revision(comment));
    await owner.query("begin");
    expect(await raw(owner, ana, "private.comment_edit($1, $2, $3::bigint)", [comment, "El nuevo", seen])).toEqual({
      answer: "ok",
      id: comment,
      revision: seen + 1,
      state: "in_filter",
    });
    await other.query("begin");
    const late = raw(other, ana, "private.comment_settle($1, $2::bigint, 'pass', 'test')", [comment, seen]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect(await late).toEqual({ answer: "stale", state: "in_review" });
    await other.query("commit");
    const row = (await owner.query<{ status: string; body: string }>("select status::text as status, body from public.comments where id = $1", [comment])).rows[0]!;
    expect(row).toEqual({ status: "in_filter", body: "El nuevo" });
    // El de su revisión, sí.
    expect(await inTx(owner, () => raw(owner, ana, "private.comment_settle($1, $2::bigint, 'pass', 'test')", [comment, seen + 1]))).toEqual({ answer: "ok", state: "published" });
  });

  it("dos ediciones con la misma versión: la segunda espera a la primera y contesta «changed»", async () => {
    const ana = await student("Ana de la 101");
    const comment = await post(ana, "El original");
    const seen = await revision(comment);
    await owner.query("begin");
    expect((await as(owner, ana, "private.comment_edit($1, $2, $3::bigint)", [comment, "Desde una pestaña", seen])).answer).toBe("ok");
    await other.query("begin");
    const second = as(other, ana, "private.comment_edit($1, $2, $3::bigint)", [comment, "Desde la otra", seen]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await second).answer).toBe("changed");
    await other.query("commit");
    const row = (await owner.query<{ body: string; revision: string }>("select body, revision::text as revision from public.comments where id = $1", [comment])).rows[0]!;
    expect(row).toEqual({ body: "Desde una pestaña", revision: String(Number(seen) + 1) });
  });

  it("responder mientras el autor borra: la respuesta que llega primero se queda, y el borrado espera; al revés, la respuesta ya no encuentra el comentario", async () => {
    const ana = await student("Ana, la que borra");
    const beto = await student("Beto, el que responde");
    const first = await post(ana, "Un comentario que se va a borrar");

    // La respuesta primero: toma el comentario para compartir, y el borrado espera a que confirme.
    await owner.query("begin");
    const reply = await as(owner, beto, "private.comment_post($1, $2, $3)", [lesson, first, "Llego antes"]);
    expect(reply.answer).toBe("ok");
    await other.query("begin");
    const deleting = as(other, ana, "private.comment_delete($1, $2::bigint)", [first, await revision(first)]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await deleting).answer).toBe("ok");
    await other.query("commit");
    const rows = (await owner.query<{ id: string; status: string }>("select id, status::text as status from public.comments where id = any($1::uuid[]) order by created_at", [[first, reply.id]])).rows;
    expect(rows.map((row) => row.status)).toEqual(["deleted", "published"]);

    // El borrado primero: la respuesta espera, y al seguir ya no hay a qué responder.
    const second = await post(ana, "Otro que se va a borrar");
    await owner.query("begin");
    expect((await as(owner, ana, "private.comment_delete($1, $2::bigint)", [second, await revision(second)])).answer).toBe("ok");
    await other.query("begin");
    const late = as(other, beto, "private.comment_post($1, $2, $3)", [lesson, second, "Llego tarde"]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await late).answer).toBe("bad_parent");
    await other.query("commit");
    expect((await owner.query("select 1 from public.comments where parent_id = $1", [second])).rowCount).toBe(0);
  });

  it("responder a una respuesta mientras el autor borra el original: lo que se toma es el de arriba, y el borrado espera", async () => {
    const ana = await student("Ana, la del original");
    const beto = await student("Beto, el de la respuesta");
    const original = await post(ana, "El original con respuesta");
    const answer = await post(beto, "La respuesta de Beto", original);

    // FL-15 A1: la respuesta a una respuesta cuelga del original, y por eso es él el que se toma para compartir.
    await owner.query("begin");
    const reply = await as(owner, beto, "private.comment_post($1, $2, $3)", [lesson, answer, "A mi respuesta"]);
    expect(reply.answer).toBe("ok");
    await other.query("begin");
    const deleting = as(other, ana, "private.comment_delete($1, $2::bigint)", [original, await revision(original)]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await deleting).answer).toBe("ok");
    await other.query("commit");
    const row = (await owner.query<{ parent_id: string }>("select parent_id from public.comments where id = $1", [reply.id])).rows[0]!;
    expect(row.parent_id).toBe(original);

    // El borrado primero: la respuesta a la respuesta espera por el original, y al seguir ya no hay a qué responder.
    const second = await post(ana, "Otro original con respuesta");
    const secondAnswer = await post(beto, "Otra respuesta de Beto", second);
    await owner.query("begin");
    expect((await as(owner, ana, "private.comment_delete($1, $2::bigint)", [second, await revision(second)])).answer).toBe("ok");
    await other.query("begin");
    const late = as(other, beto, "private.comment_post($1, $2, $3)", [lesson, secondAnswer, "Llego tarde"]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await late).answer).toBe("bad_parent");
    await other.query("commit");
    expect((await owner.query("select 1 from public.comments where parent_id = $1", [second])).rowCount).toBe(1);
  });

  it("responder a una respuesta mientras su autor la borra: también se toma ella, y borrada ya no se responde", async () => {
    const ana = await student("Ana, la que responde a la respuesta");
    const beto = await student("Beto, el que se arrepiente");
    const original = await post(ana, "El original de la respuesta que se borra");
    const answer = await post(beto, "Una respuesta que se borra", original);

    // La respuesta primero: el borrado de la respuesta espera, y lo nuevo se queda colgado del original.
    await owner.query("begin");
    const reply = await as(owner, ana, "private.comment_post($1, $2, $3)", [lesson, answer, "A la respuesta de Beto"]);
    expect(reply.answer).toBe("ok");
    await other.query("begin");
    const deleting = as(other, beto, "private.comment_delete($1, $2::bigint)", [answer, await revision(answer)]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await deleting).answer).toBe("ok");
    await other.query("commit");
    const row = (await owner.query<{ parent_id: string }>("select parent_id from public.comments where id = $1", [reply.id])).rows[0]!;
    expect(row.parent_id).toBe(original);

    // El borrado primero: la respuesta espera por la respuesta, y al seguir la encuentra borrada.
    const secondAnswer = await post(beto, "Otra respuesta que se borra", original);
    await owner.query("begin");
    expect((await as(owner, beto, "private.comment_delete($1, $2::bigint)", [secondAnswer, await revision(secondAnswer)])).answer).toBe("ok");
    await other.query("begin");
    const late = as(other, ana, "private.comment_post($1, $2, $3)", [lesson, secondAnswer, "Llego tarde a la respuesta"]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    expect((await late).answer).toBe("bad_parent");
    await other.query("commit");
    expect((await owner.query("select 1 from public.comments where body = $1", ["Llego tarde a la respuesta"])).rowCount).toBe(0);
  });

  it("el freno con dos envíos a la vez: con nueve en la ventana, solo uno de los dos pasa", async () => {
    const ana = await student("Ana, la apurada");
    for (let n = 1; n <= 9; n += 1) await post(ana, `Comentario ${n}`);
    await owner.query("begin");
    const firstTry = await as(owner, ana, "private.comment_post($1, null, $2)", [lesson, "El décimo"]);
    await other.query("begin");
    const secondTry = as(other, ana, "private.comment_post($1, null, $2)", [lesson, "El undécimo"]);
    await waitBehind(await connectWatcher(), owner, 1);
    await owner.query("commit");
    const answers = [firstTry.answer, (await secondTry).answer];
    await other.query("commit");
    expect(answers).toEqual(["ok", "throttled"]);
    expect((await owner.query("select 1 from public.comments where author_id = $1", [ana])).rowCount).toBe(10);
  });
});

// Una tercera conexión para mirar quién espera: las dos de la prueba están ocupadas en sus transacciones.
let watcher: Client | null = null;
async function connectWatcher(): Promise<Client> {
  watcher ??= await connect();
  return watcher;
}
afterAll(async () => {
  await watcher?.end();
});
