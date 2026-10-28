import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createBrowse } from "@/services/browse/browse";
import { readCourseLessons, readListedCourses, readListedTeacher, readMyCourseProgress } from "@/services/browse/records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// El catálogo del alumno (T-210) contra la base local: lo público se lee como sistema y filtra a
// mano lo listado y lo vigente; el avance de cada quien, como la persona. Los cursos se cargan
// dentro de una transacción del dueño que se revierte, y cada caso mira solo los suyos (por su
// prefijo): la base local puede traer además los cursos de prueba de `db:courses`.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

async function personClaims(): Promise<{ id: string; claims: VerifiedClaims }> {
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

async function asPerson<T>(owner: Client, claims: VerifiedClaims, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(owner);
  await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [readVerifiedClaims(claims).json]);
  try {
    return await read(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

/** Como sistema: el servidor salta la seguridad por fila, así que el filtro es el de la consulta. */
async function asServerRead<T>(owner: Client, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(owner);
  return read(txOn(owner));
}

const browse = (owner: Client) =>
  createBrowse({
    store: {
      listedCourses: () => asServerRead(owner, readListedCourses),
      listedTeacher: (slug) => asServerRead(owner, (tx) => readListedTeacher(tx, slug)),
      courseLessons: (slug) => asServerRead(owner, (tx) => readCourseLessons(tx, slug)),
      myCourseProgress: (claims, slug) => asPerson(owner, claims, (tx) => readMyCourseProgress(tx, slug)),
    },
    report: () => Promise.resolve(),
  });

/** Un curso de dos módulos y tres lecciones; el de `listed` se publica y se lista, con su maestra. */
async function loadCourse(owner: Client, slug: string, listed: boolean, level = "Nivel de catálogo"): Promise<string[]> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de catálogo'), private.system_catalog_add('levels', $1)", [level]);
  const levelSlug = (await owner.query<{ slug: string }>("select slug from public.levels where name = $1", [level])).rows[0]?.slug ?? "";
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de catálogo', $1, 'Su semblanza.')::text as id", [`maestra-${slug}`])).rows[0]?.id ?? "";
  const video = (n: number) => ({ provider: "mux", asset_id: `Asset-${slug}-${n}`, playback_id: `Playback-${slug}-${n}`, duration_seconds: 300 });
  const course = {
    slug,
    title: `Curso ${slug}`,
    summary: "Un curso de prueba.",
    practice: "practica-de-catalogo",
    level: levelSlug,
    modules: [
      { title: "Uno", lessons: [{ title: "Primera", video: video(1) }, { title: "Segunda", video: video(2) }] },
      { title: "Dos", lessons: [{ title: "Tercera", video: video(3) }] },
    ],
  };
  const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
  if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  if (listed) {
    await owner.query(
      "update public.course_registry set state = 'published', first_published_at = now() where course_id = (select course_id from public.published_courses where slug = $1)",
      [slug],
    );
    await owner.query("update public.published_courses set is_listed = true where slug = $1", [slug]);
    await owner.query("update public.published_teachers set is_listed = true where teacher_id = $1", [teacher]);
  }
  const ids = await owner.query<{ id: string }>(
    "select l.id::text as id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = $1 order by l.position",
    [slug],
  );
  await asOwner(owner);
  return ids.rows.map((row) => row.id);
}

const mine = (slugs: readonly string[]) => slugs.filter((slug) => slug.startsWith("catalogo-"));

describe("lo público del catálogo, leído como sistema", () => {
  it("el inicio lleva solo lo listado, con su práctica, su nivel y su maestra", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "catalogo-listado", true);
      await loadCourse(owner, "catalogo-sin-listar", false);
      const answer = await browse(owner).homeShelf();
      if (answer.kind !== "ready") throw new Error(`No se leyó: ${answer.kind}`);
      expect(mine(answer.shelf.newest.map((course) => course.slug))).toEqual(["catalogo-listado"]);
      const course = answer.shelf.newest.find((each) => each.slug === "catalogo-listado");
      expect(course).toMatchObject({
        title: "Curso catalogo-listado",
        teacherName: "Maestra de catálogo",
        teacherSlug: "maestra-catalogo-listado",
        practice: { slug: "practica-de-catalogo", name: "Práctica de catálogo" },
        level: { name: "Nivel de catálogo" },
        lessonCount: 3,
        totalSeconds: 900,
        isOpen: false,
      });
      expect(answer.shelf.practices.find((row) => row.slug === "practica-de-catalogo")?.courses.map((each) => each.slug)).toEqual(["catalogo-listado"]);
      expect(answer.shelf.teachers.find((each) => each.slug === "maestra-catalogo-listado")).toEqual({
        slug: "maestra-catalogo-listado",
        name: "Maestra de catálogo",
        practices: ["Práctica de catálogo"],
        // El tono de su práctica: la base lo da por rotación al crearla.
        tone: course?.practice?.tone,
        courseCount: 1,
      });
    });
  });

  it("una práctica desactivada no se nombra: el curso sigue listado, sin fila de práctica", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "catalogo-practica-apagada", true);
      await asSystem(owner);
      await owner.query("update public.practices set is_active = false where slug = 'practica-de-catalogo'");
      const answer = await browse(owner).homeShelf();
      if (answer.kind !== "ready") throw new Error(`No se leyó: ${answer.kind}`);
      expect(answer.shelf.newest.find((each) => each.slug === "catalogo-practica-apagada")?.practice).toBeNull();
      expect(answer.shelf.practices.find((row) => row.slug === "practica-de-catalogo")).toBeUndefined();
    });
  });

  it("si el curso es el abierto lo dice su registro, no la copia de lo publicado", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "catalogo-abierto", true);
      await asSystem(owner);
      await owner.query("update public.published_courses set is_open = true where slug = 'catalogo-abierto'");
      const course = async () => {
        const answer = await browse(owner).coursePage("catalogo-abierto");
        return answer.kind === "found" ? answer.detail.course.isOpen : null;
      };
      expect(await course()).toBe(false);
      await asSystem(owner);
      await owner.query(
        "update public.course_registry set is_open = true, open_since = now() where course_id = (select course_id from public.published_courses where slug = 'catalogo-abierto')",
      );
      expect(await course()).toBe(true);
    });
  });

  it("la ficha de un curso: su temario vigente por módulos y su maestra con semblanza; sin listar, no existe", async () => {
    await reverted(async (owner) => {
      const [first, second] = await loadCourse(owner, "catalogo-ficha", true);
      await loadCourse(owner, "catalogo-ficha-oculta", false);
      await asSystem(owner);
      await owner.query("update public.published_lessons set is_current = false, retired_at = now() where id = $1", [second]);
      const answer = await browse(owner).coursePage("catalogo-ficha");
      if (answer.kind !== "found") throw new Error(`No la encontró: ${answer.kind}`);
      expect(answer.detail.modules.map((group) => [group.title, group.lessons.map((lesson) => [lesson.title, lesson.number])])).toEqual([
        ["Uno", [["Primera", 1]]],
        ["Dos", [["Tercera", 2]]],
      ]);
      expect(answer.detail.firstLesson.id).toBe(first);
      expect(answer.detail.teacher).toEqual({ slug: "maestra-catalogo-ficha", name: "Maestra de catálogo", bio: "Su semblanza." });
      // Nada del video viaja con la ficha.
      expect(JSON.stringify(answer.detail)).not.toMatch(/Playback-|Asset-/);
      expect(await browse(owner).coursePage("catalogo-ficha-oculta")).toEqual({ kind: "not_found" });
    });
  });

  it("la ficha de una maestra listada lleva sus cursos listados; sin cursos listados, no existe", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "catalogo-maestra", true);
      await loadCourse(owner, "catalogo-maestra-oculta", false);
      const answer = await browse(owner).teacherPage("maestra-catalogo-maestra");
      if (answer.kind !== "found") throw new Error(`No la encontró: ${answer.kind}`);
      expect(answer.teacher).toMatchObject({ name: "Maestra de catálogo", bio: "Su semblanza.", practices: ["Práctica de catálogo"] });
      expect(answer.courses.map((course) => course.slug)).toEqual(["catalogo-maestra"]);
      expect(await browse(owner).teacherPage("maestra-catalogo-maestra-oculta")).toEqual({ kind: "not_found" });
    });
  });
});

describe("lo que no está publicado de verdad, no aparece", () => {
  it("un curso retirado no aparece aunque siga marcado como listado", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "catalogo-retirado", true);
      await asSystem(owner);
      await owner.query(
        `update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'Prueba del catálogo'
          where course_id = (select course_id from public.published_courses where slug = 'catalogo-retirado')`,
      );
      const answer = await browse(owner).homeShelf();
      if (answer.kind !== "ready") throw new Error(`No se leyó: ${answer.kind}`);
      expect(mine(answer.shelf.newest.map((course) => course.slug))).toEqual([]);
      expect(await browse(owner).coursePage("catalogo-retirado")).toEqual({ kind: "not_found" });
    });
  });

  it("el curso de una maestra sin listar se ve, sin enlace a ella, y su ficha no existe", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "catalogo-sin-maestra", true);
      await asSystem(owner);
      await owner.query("update public.published_teachers set is_listed = false where slug = 'maestra-catalogo-sin-maestra'");
      const page = await browse(owner).coursePage("catalogo-sin-maestra");
      if (page.kind !== "found") throw new Error(`No la encontró: ${page.kind}`);
      expect(page.detail.course.teacherSlug).toBeNull();
      expect(page.detail.teacher).toBeNull();
      expect(await browse(owner).teacherPage("maestra-catalogo-sin-maestra")).toEqual({ kind: "not_found" });
    });
  });
});

describe("el avance de cada quien, leído como la persona", () => {
  it("lee solo lo suyo, de las lecciones vigentes del curso", async () => {
    const ana = await personClaims();
    const beto = await personClaims();
    await reverted(async (owner) => {
      const [first, second] = await loadCourse(owner, "catalogo-avance", true);
      for (const [profile, lesson, completed] of [
        [ana.id, first, true],
        [ana.id, second, false],
        [beto.id, first, true],
      ] as const) {
        await owner.query(
          `insert into public.lesson_progress (profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, covered, completed_at,
                                               first_watched_at, last_watched_at, last_playback_session_id, last_seq)
           select $1, l.id, l.course_id, l.video_asset_id, 60, '{[0,60)}'::int4multirange, case when $3 then now() end, now(), now(), gen_random_uuid(), 0
           from public.published_lessons l where l.id = $2`,
          [profile, lesson, completed],
        );
      }
      const page = await browse(owner).coursePage("catalogo-avance");
      if (page.kind !== "found") throw new Error(`No la encontró: ${page.kind}`);
      const standing = await browse(owner).courseStanding(ana.claims, page.detail);
      if (standing.kind !== "ready") throw new Error(`No se leyó: ${standing.kind}`);
      expect(standing.standing).toMatchObject({ completed: 1, total: 3, started: true, finished: false, suggested: { id: second, number: 2 } });
      expect(standing.standing.states.get(second ?? "")).toBe("in_progress");
    });
  });
});
