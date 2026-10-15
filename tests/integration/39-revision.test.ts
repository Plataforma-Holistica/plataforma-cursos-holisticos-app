import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createReviewQueue } from "@/services/review/queue";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor, type KnownUser, type MemoryJar } from "./helpers/auth";
import { reviewStoreOn } from "./helpers/review";
import { asOwner, asSystem, reverted, teamStoreOn } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La cola de revisión y aprobar (RF-701; T-108), contra el Auth y la base locales: la guarda
// del equipo corre de verdad, y la cola y aprobar usan el mismo almacén que la aplicación,
// dentro de una transacción del dueño que se revierte (aprobar escribe en tablas auditadas).
// Cada caso comprueba al final que la auditoría quedó como estaba.

const emails: string[] = [];
afterAll(async () => {
  await ownerQuery("delete from private.second_factor_attempts");
  await deleteTestUsersByEmail(emails);
});

async function entered(person: KnownUser): Promise<MemoryJar> {
  const jar = memoryJar();
  const result = await testServices().signIn(jar, person, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return jar;
}

async function auditRows(): Promise<number> {
  const rows = await ownerQuery<{ n: number }>("select count(*)::int as n from public.audit_log");
  return rows[0]?.n ?? -1;
}

/** Un curso de una lección de Mux, cargado como sistema dentro de la transacción. Devuelve su id. */
async function loadCourse(owner: Client, slug: string): Promise<string> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de revisión'), private.system_catalog_add('levels', 'Nivel de revisión')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de revisión', 'maestra-revision', null) as id")).rows[0]?.id;
  const course = {
    slug,
    title: `Curso ${slug}`,
    practice: "practica-de-revision",
    level: "nivel-de-revision",
    modules: [
      {
        title: "Uno",
        lessons: [{ title: "Con Mux", video: { provider: "mux", asset_id: `Asset${slug.replace(/-/g, "")}`, playback_id: `Playback${slug.replace(/-/g, "")}`, duration_seconds: 356 } }],
      },
    ],
  };
  const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
  if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  const id = (await owner.query<{ id: string }>("select course_id::text as id from public.published_courses where slug = $1", [slug])).rows[0]?.id;
  await asOwner(owner);
  return id ?? "";
}

/** Alguien del equipo con esas capacidades y su código dado, dentro de la transacción, con un curso por aprobar. */
async function staged<T>(capabilities: string[], fn: (stage: { owner: Client; jar: MemoryJar; person: KnownUser; course: string }) => Promise<T>) {
  const person = await claimedUser();
  emails.push(person.email);
  await completeAccountAsOwner(person.id);
  const factor = await secondFactorFor(person);
  const jar = await entered(person);
  const audited = await auditRows();
  const result = await reverted(async (owner) => {
    const services = testServices({ teamStore: teamStoreOn(owner) });
    await asSystem(owner);
    for (const capability of capabilities) {
      await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, $2::public.capability)", [person.id, capability]);
    }
    await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
      person.id,
      factor.factorId,
      person.email.toLowerCase(),
    ]);
    await asOwner(owner);
    expect(await services.giveSecondFactorCode(jar, totpCode(factor.secret))).toEqual({ kind: "verified" });
    const course = await loadCourse(owner, "curso-revision");
    return fn({ owner, jar, person, course });
  });
  expect(await auditRows()).toBe(audited);
  return result;
}

function reviewOn(owner: Client) {
  const services = testServices({ teamStore: teamStoreOn(owner) });
  const reported: string[] = [];
  const review = createReviewQueue(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    { teamStanding: services.teamStanding, store: reviewStoreOn(owner) },
  );
  return { ...review, reported, services };
}

describe("la cola de revisión y aprobar, contra la base", () => {
  it("con Contenido y su código: lo ve en la cola, lo aprueba, y sale de la cola listado", async () => {
    await staged(["content"], async ({ owner, jar, course }) => {
      const review = reviewOn(owner);
      const check = await review.services.teamStanding(jar);
      if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
      const before = await review.reviewQueue(check.claims);
      if (before.kind !== "queue") throw new Error("No leyó la cola.");
      expect(before.queue.freshCode).toBe(true);
      const mine = before.queue.courses.find((each) => each.courseId === course);
      expect(mine).toMatchObject({ title: "Curso curso-revision", teacherName: "Maestra de revisión", teacherListed: false, lessonCount: 1 });
      expect(mine?.lessons.map((each) => [each.title, each.video])).toEqual([["Con Mux", "playable"]]);

      expect(await review.approveCourse(jar, { course })).toEqual({ kind: "answered", answer: "approved" });
      // Una pestaña vieja, o un formulario reenviado: ya no está por revisar.
      expect(await review.approveCourse(jar, { course })).toEqual({ kind: "answered", answer: "not_pending" });
      const after = await review.reviewQueue(check.claims);
      expect(after.kind === "queue" && after.queue.courses.some((each) => each.courseId === course)).toBe(false);
      const listed = await owner.query<{ course: boolean; teacher: boolean }>(
        `select c.is_listed as course, t.is_listed as teacher from public.published_courses c
         join public.published_teachers t on t.teacher_id = c.teacher_id where c.course_id = $1`,
        [course],
      );
      expect(listed.rows[0]).toEqual({ course: true, teacher: true });
      expect(review.reported).toEqual([]);
    });
  });

  it("con el código vencido: la cola se lee, y aprobar pide darlo otra vez sin publicar", async () => {
    await staged(["content"], async ({ owner, jar, person, course }) => {
      const review = reviewOn(owner);
      await owner.query(
        `update auth.mfa_amr_claims c set updated_at = now() - interval '1 hour'
         from auth.sessions s where c.session_id = s.id and s.user_id = $1`,
        [person.id],
      );
      const check = await review.services.teamStanding(jar);
      if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
      const read = await review.reviewQueue(check.claims);
      expect(read.kind === "queue" && read.queue.freshCode).toBe(false);
      expect(await review.approveCourse(jar, { course })).toEqual({ kind: "answered", answer: "needs_fresh_code" });
      const state = await owner.query<{ state: string }>("select state::text from public.course_registry where course_id = $1", [course]);
      expect(state.rows[0]?.state).toBe("in_review");
    });
  });

  it("con la práctica desactivada por fuera, o un curso que no existe: lo dice, sin publicar", async () => {
    await staged(["content"], async ({ owner, jar, course }) => {
      const review = reviewOn(owner);
      expect(await review.approveCourse(jar, { course: "00000000-0000-4000-8000-000000000000" })).toEqual({ kind: "answered", answer: "not_found" });
      await asSystem(owner);
      await owner.query("update public.practices set is_active = false where slug = 'practica-de-revision'");
      await asOwner(owner);
      expect(await review.approveCourse(jar, { course })).toEqual({ kind: "answered", answer: "practice_inactive" });
    });
  });

  it("del equipo sin Contenido: aprobar contesta refused, y la cola, leída por debajo de la guarda, es nula", async () => {
    await staged(["config"], async ({ owner, jar, course }) => {
      const review = reviewOn(owner);
      expect(await review.approveCourse(jar, { course })).toEqual({ kind: "refused" });
      const check = await review.services.teamStanding(jar);
      if (check.kind !== "team") throw new Error("La persona de prueba no quedó en el equipo.");
      expect(await reviewStoreOn(owner).queue(check.claims)).toBeNull();
      expect(await review.reviewQueue(check.claims)).toEqual({ kind: "unavailable" });
    });
  });
});
