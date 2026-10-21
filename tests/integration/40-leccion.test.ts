import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createLessons, type LessonStore } from "@/services/lessons/lessons";
import { readCourseIsOpen, readCourseLessons } from "@/services/lessons/records";
import { createProgress } from "@/services/progress/progress";
import { readContinueWatching } from "@/services/progress/records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// La página de una lección (PA-22, T-203) contra la base local: el temario se lee como la
// persona, filtrando a mano lo listado y lo vigente, y si el curso es el abierto, como sistema.
// Los cursos se cargan dentro de una transacción del dueño que se revierte. Desde T-206, el
// temario trae el progreso de quien lee, y «continuar viendo» se lee igual; el progreso lo
// escribe aquí el dueño (lo escribe de verdad `record_heartbeats`, en 40-reproducciones).

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

/** Lee como la persona, dentro de la transacción del dueño. */
async function asPerson<T>(owner: Client, claims: VerifiedClaims, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(owner);
  await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [readVerifiedClaims(claims).json]);
  try {
    return await read(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

function storeOn(owner: Client): LessonStore {
  const tx = txOn(owner);
  return {
    courseLessons: (claims, slug) => asPerson(owner, claims, (each) => readCourseLessons(each, slug)),
    courseIsOpen: async (slug) => {
      await asOwner(owner);
      return readCourseIsOpen(tx, slug);
    },
  };
}

const lessons = (owner: Client) => createLessons({ store: storeOn(owner), report: () => Promise.resolve() });
const progress = (owner: Client) =>
  createProgress({ store: { continueRows: (claims) => asPerson(owner, claims, readContinueWatching) }, report: () => Promise.resolve() });

/** Lo que dejaría `record_heartbeats`: lo visto de una lección, escrito por el dueño. */
async function seen(
  owner: Client,
  profile: string,
  lesson: string,
  options: { covered?: string; completed?: boolean; position?: number; minutesAgo?: number; video?: string } = {},
): Promise<void> {
  await asOwner(owner);
  await owner.query(
    `insert into public.lesson_progress (profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, covered, completed_at,
                                         first_watched_at, last_watched_at, last_playback_session_id, last_seq)
     select $1, l.id, l.course_id, coalesce($6::uuid, l.video_asset_id), $5, $3::int4multirange, case when $4 then now() end,
            now() - make_interval(mins => $7), now() - make_interval(mins => $7), gen_random_uuid(), 0
     from public.published_lessons l where l.id = $2`,
    [profile, lesson, options.covered ?? "{[0,30)}", options.completed ?? false, options.position ?? 30, options.video ?? null, options.minutesAgo ?? 0],
  );
}

const videoOf = async (owner: Client, lesson: string) =>
  (await owner.query<{ id: string }>("select video_asset_id::text as id from public.published_lessons where id = $1", [lesson])).rows[0]?.id ?? "";

/** Un curso de dos módulos y tres lecciones, cargado como sistema; el de `listed` se publica y se lista. */
async function loadCourse(owner: Client, slug: string, listed: boolean, teacherProfile: string | null = null): Promise<string[]> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de lección'), private.system_catalog_add('levels', 'Nivel de lección')");
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de lección', $1, null)::text as id", [`maestra-${slug}`])).rows[0]?.id ?? "";
  if (teacherProfile !== null) await owner.query("update public.teachers set profile_id = $1, status = 'active' where id = $2", [teacherProfile, teacher]);
  const video = (n: number) => ({ provider: "mux", asset_id: `Asset-${slug}-${n}`, playback_id: `Playback-${slug}-${n}`, duration_seconds: 300 + n });
  const course = {
    slug,
    title: `Curso ${slug}`,
    summary: "Un curso de prueba.",
    practice: "practica-de-leccion",
    level: "nivel-de-leccion",
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
  }
  const ids = await owner.query<{ id: string }>(
    "select l.id::text as id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = $1 order by l.position",
    [slug],
  );
  await asOwner(owner);
  return ids.rows.map((row) => row.id);
}

describe("la página de una lección (PA-22)", () => {
  it("de un curso listado: el temario por módulos, la lección y la siguiente", async () => {
    const { claims } = await personClaims();
    await reverted(async (owner) => {
      const [first, second, third] = await loadCourse(owner, "leccion-listado", true);
      const answer = await lessons(owner).lessonPage(claims, "leccion-listado", second ?? "");
      if (answer.kind !== "found") throw new Error(`No la encontró: ${answer.kind}`);
      expect(answer.page.course).toEqual({ slug: "leccion-listado", title: "Curso leccion-listado", summary: "Un curso de prueba.", teacherName: "Maestra de lección" });
      expect(answer.page.modules.map((group) => [group.title, group.lessons.map((lesson) => lesson.title)])).toEqual([
        ["Uno", ["Primera", "Segunda"]],
        ["Dos", ["Tercera"]],
      ]);
      expect(answer.page.lesson).toMatchObject({ id: second, number: 2, title: "Segunda", moduleTitle: "Uno", durationSeconds: 302 });
      expect(answer.page.next).toEqual({ id: third, title: "Tercera" });
      // Nada del video viaja con la página.
      expect(JSON.stringify(answer.page)).not.toMatch(/Playback-|Asset-/);
      expect(first).toBeDefined();
    });
  });

  it("una lección de otro curso, con el slug de este: no existe", async () => {
    const { claims } = await personClaims();
    await reverted(async (owner) => {
      await loadCourse(owner, "leccion-listado", true);
      const [other] = await loadCourse(owner, "leccion-otro", true);
      expect(await lessons(owner).lessonPage(claims, "leccion-listado", other ?? "")).toEqual({ kind: "not_found" });
    });
  });

  it("de un curso sin listar: no existe, tampoco para la maestra dueña, que lo ve en su vista previa (PA-43)", async () => {
    const student = await personClaims();
    const owner_ = await personClaims();
    await reverted(async (owner) => {
      const [first] = await loadCourse(owner, "leccion-sin-listar", false, owner_.id);
      expect(await lessons(owner).lessonPage(student.claims, "leccion-sin-listar", first ?? "")).toEqual({ kind: "not_found" });
      expect(await lessons(owner).lessonPage(owner_.claims, "leccion-sin-listar", first ?? "")).toEqual({ kind: "not_found" });
    });
  });

  it("una lección retirada (una versión nueva la quitó): no existe, y el temario no la cuenta", async () => {
    const { claims } = await personClaims();
    await reverted(async (owner) => {
      const [first, second] = await loadCourse(owner, "leccion-retirada", true);
      await asSystem(owner);
      await owner.query("update public.published_lessons set is_current = false, retired_at = now() where id = $1", [first]);
      await asOwner(owner);
      expect(await lessons(owner).lessonPage(claims, "leccion-retirada", first ?? "")).toEqual({ kind: "not_found" });
      const answer = await lessons(owner).lessonPage(claims, "leccion-retirada", second ?? "");
      expect(answer.kind === "found" && answer.page.lessonCount).toBe(2);
    });
  });
});

describe("si el curso es el abierto, para quien llega sin sesión", () => {
  it("lo dice el registro del curso, no la copia de lo publicado; sin listar, nulo", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "leccion-abierto", true);
      await loadCourse(owner, "leccion-cerrado", false);
      // Cada pregunta con un servicio nuevo: el de verdad recuerda la respuesta treinta segundos.
      const ask = (slug: string) => lessons(owner).courseIsOpen(slug);
      expect(await ask("leccion-abierto")).toBe(false);
      await asSystem(owner);
      await owner.query("update public.published_courses set is_open = true where slug = 'leccion-abierto'");
      await asOwner(owner);
      expect(await ask("leccion-abierto")).toBe(false);
      await asSystem(owner);
      await owner.query(
        "update public.course_registry set is_open = true, open_since = now() where course_id = (select course_id from public.published_courses where slug = 'leccion-abierto')",
      );
      await asOwner(owner);
      expect(await ask("leccion-abierto")).toBe(true);
      expect(await ask("leccion-cerrado")).toBeNull();
      expect(await ask("no-existe")).toBeNull();
    });
  });
});

describe("el progreso de quien lee (T-206, RF-307)", () => {
  it("el temario dice de cada lección si está sin empezar, a medias o terminada, y cuántas van; lo de otra cuenta no se ve", async () => {
    const ana = await personClaims();
    const beto = await personClaims();
    await reverted(async (owner) => {
      const [first, second, third] = await loadCourse(owner, "leccion-avance", true);
      await seen(owner, ana.id, first ?? "", { covered: "{[0,301)}", completed: true });
      await seen(owner, ana.id, second ?? "");
      await seen(owner, beto.id, third ?? "", { completed: true });
      const answer = await lessons(owner).lessonPage(ana.claims, "leccion-avance", second ?? "");
      if (answer.kind !== "found") throw new Error(`No la encontró: ${answer.kind}`);
      expect(answer.page.modules.flatMap((group) => group.lessons.map((lesson) => lesson.state))).toEqual(["completed", "in_progress", "not_started"]);
      expect(answer.page.progress).toEqual({ completed: 1, total: 3 });
      const other = await lessons(owner).lessonPage(beto.claims, "leccion-avance", second ?? "");
      expect(other.kind === "found" && other.page.progress).toEqual({ completed: 1, total: 3 });
      expect(other.kind === "found" && other.page.modules.flatMap((group) => group.lessons.map((lesson) => lesson.state))).toEqual([
        "not_started",
        "not_started",
        "completed",
      ]);
    });
  });

  it("si la lección cambió de video, lo visto del anterior no la deja a medias, pero terminada se queda", async () => {
    const { id, claims } = await personClaims();
    await reverted(async (owner) => {
      const [first, second, third] = await loadCourse(owner, "leccion-otro-video", true);
      // Lo guardado es del video de otra lección del curso: como si la lección lo hubiera cambiado.
      await seen(owner, id, first ?? "", { video: await videoOf(owner, third ?? "") });
      await seen(owner, id, second ?? "", { completed: true, video: await videoOf(owner, third ?? "") });
      const answer = await lessons(owner).lessonPage(claims, "leccion-otro-video", first ?? "");
      if (answer.kind !== "found") throw new Error(`No la encontró: ${answer.kind}`);
      expect(answer.page.modules.flatMap((group) => group.lessons.map((lesson) => lesson.state))).toEqual(["not_started", "completed", "not_started"]);
    });
  });

  it("continuar viendo: los cursos listados que empezó y no terminó, el más reciente primero, con la lección sugerida", async () => {
    const ana = await personClaims();
    const beto = await personClaims();
    await reverted(async (owner) => {
      const reciente = await loadCourse(owner, "continuar-reciente", true);
      const viejo = await loadCourse(owner, "continuar-viejo", true);
      const terminado = await loadCourse(owner, "continuar-terminado", true);
      const oculto = await loadCourse(owner, "continuar-oculto", false);
      await seen(owner, ana.id, reciente[0] ?? "", { completed: true, minutesAgo: 5 });
      await seen(owner, ana.id, viejo[1] ?? "", { minutesAgo: 60 });
      for (const lesson of terminado) await seen(owner, ana.id, lesson, { completed: true, minutesAgo: 1 });
      await seen(owner, ana.id, oculto[0] ?? "", { minutesAgo: 1 });
      await seen(owner, beto.id, reciente[2] ?? "");

      const answer = await progress(owner).continueWatching(ana.claims);
      expect(answer).toEqual({
        kind: "ready",
        courses: [
          {
            courseSlug: "continuar-reciente",
            courseTitle: "Curso continuar-reciente",
            teacherName: "Maestra de lección",
            completed: 1,
            total: 3,
            lesson: { id: reciente[1], title: "Segunda", number: 2 },
          },
          {
            courseSlug: "continuar-viejo",
            courseTitle: "Curso continuar-viejo",
            teacherName: "Maestra de lección",
            completed: 0,
            total: 3,
            lesson: { id: viejo[1], title: "Segunda", number: 2 },
          },
        ],
      });
      expect(await progress(owner).continueWatching(beto.claims)).toMatchObject({
        kind: "ready",
        courses: [{ courseSlug: "continuar-reciente", completed: 0, lesson: { id: reciente[2], number: 3 } }],
      });
    });
  });

  it("una lección que se retiró después de verla: la sugerida es la primera sin terminar (FL-13 A2)", async () => {
    const { id, claims } = await personClaims();
    await reverted(async (owner) => {
      const [first, second] = await loadCourse(owner, "continuar-retirada", true);
      await seen(owner, id, first ?? "", { completed: true, minutesAgo: 10 });
      await seen(owner, id, second ?? "", { minutesAgo: 1 });
      await asSystem(owner);
      await owner.query("update public.published_lessons set is_current = false, retired_at = now() where id = $1", [second]);
      await asOwner(owner);
      const answer = await progress(owner).continueWatching(claims);
      expect(answer.kind === "ready" && answer.courses.map((course) => [course.lesson.title, course.completed, course.total])).toEqual([["Tercera", 1, 2]]);
    });
  });
});

describe("continuar viendo filtra a mano lo que la maestra dueña ve de más", () => {
  it("su curso sin listar no sale", async () => {
    const teacher = await personClaims();
    await reverted(async (owner) => {
      const hidden = await loadCourse(owner, "duena-sin-listar", false, teacher.id);
      await seen(owner, teacher.id, hidden[0] ?? "");
      expect(await progress(owner).continueWatching(teacher.claims)).toEqual({ kind: "ready", courses: [] });
    });
  });

  it("de su curso listado no cuenta la lección retirada", async () => {
    const teacher = await personClaims();
    await reverted(async (owner) => {
      const listed = await loadCourse(owner, "duena-listado", true, teacher.id);
      await seen(owner, teacher.id, listed[0] ?? "");
      await asSystem(owner);
      await owner.query("update public.published_lessons set is_current = false, retired_at = now() where id = $1", [listed[2]]);
      await asOwner(owner);
      const answer = await progress(owner).continueWatching(teacher.claims);
      expect(answer.kind === "ready" && answer.courses.map((course) => [course.courseSlug, course.total])).toEqual([["duena-listado", 2]]);
    });
  });
});

describe("continuar viendo: la última vista y el tope de lo que se lee", () => {
  it("la sugerida sale de la última lección que vio, no de la primera", async () => {
    const { id, claims } = await personClaims();
    await reverted(async (owner) => {
      const [first, , third] = await loadCourse(owner, "continuar-ultima", true);
      await seen(owner, id, first ?? "", { completed: true, minutesAgo: 10 });
      await seen(owner, id, third ?? "", { minutesAgo: 1 });
      const answer = await progress(owner).continueWatching(claims);
      expect(answer.kind === "ready" && answer.courses[0]?.lesson.title).toBe("Tercera");
    });
  });

  it("con más de 50 cursos empezados se leen los más recientes", async () => {
    const { id, claims } = await personClaims();
    await reverted(async (owner) => {
      const recent = await loadCourse(owner, "continuar-de-hoy", true);
      await seen(owner, id, recent[0] ?? "", { minutesAgo: 1 });
      for (let index = 0; index < 50; index += 1) {
        const [lesson] = await loadCourse(owner, `continuar-viejo-${index}`, true);
        await seen(owner, id, lesson ?? "", { minutesAgo: 60 + index });
      }
      const answer = await progress(owner).continueWatching(claims);
      expect(answer.kind === "ready" && answer.courses[0]?.courseSlug).toBe("continuar-de-hoy");
      expect(answer.kind === "ready" && answer.courses).toHaveLength(20);
    });
  }, 60_000);
});
