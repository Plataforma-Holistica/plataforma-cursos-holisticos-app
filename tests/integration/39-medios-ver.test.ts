import { generateKeyPairSync } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { signPlayback } from "@/adapters/mux/sign";
import { createMediaGrant } from "@/services/media/grant";
import { databaseMediaStore } from "@/services/media/store";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar, type KnownUser, type MemoryJar } from "./helpers/auth";
import { mediaStoreOn } from "./helpers/media";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// La función única de medios desde el área del alumno (T-202; RF-306, RN-01, RF-309), contra
// el Auth y la base locales: la guarda de sesión corre de verdad, y los hechos y el video se
// leen como servidor con las funciones de la base. Los cursos, las suscripciones y las
// cortesías se escriben dentro de una transacción del dueño que se revierte: nadie de la
// aplicación las escribe todavía, y cargar un curso deja auditoría.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = { id: "LlaveDePrueba01", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
const NOW = 1_800_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function person(): Promise<{ who: KnownUser; jar: MemoryJar }> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  return { who, jar };
}

interface Courses {
  teacher: string;
  /** La lección de Mux de un curso publicado y listado. */
  listed: string;
  /** La de un curso que sigue en revisión. */
  inReview: string;
}

/** Dos cursos cargados como sistema, uno ya publicado y listado, de la misma maestra. */
async function loadCourses(owner: Client): Promise<Courses> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de ver'), private.system_catalog_add('levels', 'Nivel de ver')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de ver', 'maestra-ver', null)::text as id")).rows[0]?.id ?? "";
  for (const slug of ["curso-ver-listado", "curso-ver-revision"]) {
    const course = {
      slug,
      title: `Curso ${slug}`,
      practice: "practica-de-ver",
      level: "nivel-de-ver",
      modules: [{ title: "Uno", lessons: [{ title: "Con Mux", video: { provider: "mux", asset_id: `Asset-${slug}`, playback_id: `Playback-${slug}`, duration_seconds: 356 } }] }],
    };
    const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
    if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  }
  // Publicar a mano, como sistema: aprobar pide a alguien del equipo con su código.
  await owner.query(
    `update public.course_registry set state = 'published', first_published_at = now()
       where course_id = (select course_id from public.published_courses where slug = 'curso-ver-listado')`,
  );
  await owner.query("update public.published_courses set is_listed = true where slug = 'curso-ver-listado'");
  const lessons = await owner.query<{ slug: string; id: string }>(
    "select c.slug, l.id::text as id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug like 'curso-ver-%'",
  );
  await asOwner(owner);
  const lessonOf = (slug: string) => lessons.rows.find((row) => row.slug === slug)?.id ?? "";
  return { teacher, listed: lessonOf("curso-ver-listado"), inReview: lessonOf("curso-ver-revision") };
}

async function subscribe(owner: Client, profile: string, values: { status: string; end: Date | null; created?: Date; failed?: Date; ended?: Date }) {
  await owner.query(
    `insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency,
                                       current_period_start, current_period_end, last_renewal_failed_at, ended_at, created_at)
     values ($1, 'manual', gen_random_uuid()::text, 'monthly', $2::public.subscription_status, 'MXN',
             $3::timestamptz - interval '30 days', $3, $4, $5, coalesce($6, now()))`,
    [profile, values.status, values.end, values.failed ?? null, values.ended ?? null, values.created ?? null],
  );
}

function mediaOn(owner: Client) {
  const reported: string[] = [];
  const media = createMediaGrant(
    { report: (code) => (reported.push(code), Promise.resolve()) },
    {
      teamStanding: testServices().teamStanding,
      checkSession: testServices().checkSession,
      store: mediaStoreOn(owner),
      signingKey: () => KEY,
      sign: signPlayback,
      now: () => NOW,
    },
  );
  return { ...media, reported };
}

/** La hora de la base dentro de la transacción: los hechos se leen con ella. */
async function dbNow(owner: Client): Promise<Date> {
  return (await owner.query<{ now: Date }>("select now() as now")).rows[0]?.now ?? new Date(Number.NaN);
}

describe("ver: una alumna y su cuenta (RN-01)", () => {
  it("sin suscripción: denied, como quien nunca se suscribió, y no sale el video", async () => {
    const { jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      const media = mediaOn(owner);
      expect(await media.getMediaGrant(jar, courses.listed, "watch")).toEqual({
        kind: "denied",
        account: { allowed: false, reason: "never_subscribed" },
      });
      expect(media.reported).toEqual([]);
    });
  });

  it("con su periodo pagado: firma el video del curso listado, cuenta, y hasta el fin del periodo", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      const end = new Date((await dbNow(owner)).getTime() + 20 * DAY_MS);
      await subscribe(owner, who.id, { status: "active", end });
      const grant = await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch");
      if (grant.kind !== "granted") throw new Error(`No firmó: ${grant.kind}`);
      expect(grant).toMatchObject({ playbackId: "Playback-curso-ver-listado", basis: "subscription", countsForPayout: true });
      expect(grant.until?.getTime()).toBe(end.getTime());
    });
  });

  it("un pago que se abrió y no se terminó no tapa a la suscripción que paga", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      const now = await dbNow(owner);
      await subscribe(owner, who.id, { status: "active", end: new Date(now.getTime() + 20 * DAY_MS), created: new Date(now.getTime() - 10 * DAY_MS) });
      await subscribe(owner, who.id, { status: "pending", end: null });
      expect(await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch")).toMatchObject({ kind: "granted", basis: "subscription" });
    });
  });

  it("con la renovación fallida: gracia, que cuenta, con los días de GRACIA_COBRO_DIAS desde la falla", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      const failed = new Date((await dbNow(owner)).getTime() - DAY_MS);
      const days = (await owner.query<{ days: number }>("select private.parameter_value('GRACIA_COBRO_DIAS', $1) as days", [failed])).rows[0]?.days ?? 0;
      await subscribe(owner, who.id, { status: "in_grace", end: failed, failed });
      const grant = await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch");
      expect(grant).toMatchObject({ kind: "granted", basis: "grace", countsForPayout: true });
      expect(grant.kind === "granted" && grant.until?.getTime()).toBe(failed.getTime() + days * DAY_MS);
    });
  });

  it("reembolsada: denied, con la fecha en que se cortó", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      const now = await dbNow(owner);
      const ended = new Date(now.getTime() - DAY_MS);
      await subscribe(owner, who.id, { status: "refunded", end: new Date(now.getTime() + 20 * DAY_MS), ended });
      expect(await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch")).toEqual({
        kind: "denied",
        account: { allowed: false, reason: "refunded", endedAt: ended },
      });
    });
  });

  it("con una cortesía: firma, sin puntos; revocada, ya no", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      await owner.query(
        "insert into public.courtesy_grants (profile_id, reason, starts_at, ends_at, granted_by) values ($1, 'prueba', now() - interval '1 day', null, $1)",
        [who.id],
      );
      expect(await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch")).toMatchObject({
        kind: "granted",
        basis: "courtesy",
        countsForPayout: false,
        until: null,
      });
      await owner.query("update public.courtesy_grants set revoked_at = now(), revoked_by = $1 where profile_id = $1", [who.id]);
      expect(await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch")).toMatchObject({ kind: "denied" });
    });
  });
});

describe("ver: el curso, el maestro dueño y el curso abierto", () => {
  it("un curso en revisión, a quien paga: lo mismo que una lección que no existe", async () => {
    const { who, jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      await subscribe(owner, who.id, { status: "active", end: new Date((await dbNow(owner)).getTime() + 20 * DAY_MS) });
      const media = mediaOn(owner);
      expect(await media.getMediaGrant(jar, courses.inReview, "watch")).toEqual({ kind: "no_video" });
      expect(await media.getMediaGrant(jar, "00000000-0000-4000-8000-000000000000", "watch")).toEqual({ kind: "no_video" });
      expect(media.reported).toEqual([]);
    });
  });

  it("la maestra dueña ve lo suyo en revisión, sin pagar y sin puntos; y la segunda barrera se lo da a ella y no a otra", async () => {
    const { who, jar } = await person();
    const other = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      await asSystem(owner);
      await owner.query("update public.teachers set profile_id = $1, status = 'active' where id = $2", [who.id, courses.teacher]);
      await asOwner(owner);
      expect(await mediaOn(owner).getMediaGrant(jar, courses.inReview, "watch")).toMatchObject({
        kind: "granted",
        playbackId: "Playback-curso-ver-revision",
        basis: "owner_preview",
        countsForPayout: false,
      });
      // La consulta misma, sin la regla: a otra cuenta la base no le suelta ese video.
      const session = await testServices().checkSession(other.jar);
      if (session.kind !== "pass") throw new Error(`La otra cuenta no pasó: ${session.kind}`);
      expect((await mediaStoreOn(owner).watchFacts(session.claims, courses.inReview))?.playbackId).toBeNull();
    });
  });

  it("el curso abierto: una cuenta verificada sin suscripción lo ve, sin puntos (RF-309)", async () => {
    const { jar } = await person();
    await reverted(async (owner) => {
      const courses = await loadCourses(owner);
      await asSystem(owner);
      await owner.query(
        "update public.course_registry set is_open = true, open_since = now() where course_id = (select course_id from public.published_lessons where id = $1)",
        [courses.listed],
      );
      await asOwner(owner);
      expect(await mediaOn(owner).getMediaGrant(jar, courses.listed, "watch")).toMatchObject({
        kind: "granted",
        basis: "open_course",
        countsForPayout: false,
      });
    });
  });
});

describe("ver, por el almacén de la aplicación", () => {
  it("las funciones de la base las ejecuta el servidor de verdad: una lección que no existe es no_video", async () => {
    const { jar } = await person();
    const reported: string[] = [];
    const media = createMediaGrant(
      { report: (code) => (reported.push(code), Promise.resolve()) },
      {
        teamStanding: testServices().teamStanding,
        checkSession: testServices().checkSession,
        store: databaseMediaStore,
        signingKey: () => KEY,
        sign: signPlayback,
        now: () => NOW,
      },
    );
    expect(await media.getMediaGrant(jar, "00000000-0000-4000-8000-000000000000", "watch")).toEqual({ kind: "no_video" });
    expect(reported).toEqual([]);
  });
});
