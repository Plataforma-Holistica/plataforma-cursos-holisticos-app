import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createLessons, type LessonStore } from "@/services/lessons/lessons";
import { readCourseIsOpen, readCourseLessons } from "@/services/lessons/records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// La página de una lección (PA-22, T-203) contra la base local: el temario se lee como la
// persona, filtrando a mano lo listado y lo vigente, y si el curso es el abierto, como sistema.
// Los cursos se cargan dentro de una transacción del dueño que se revierte.

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

function storeOn(owner: Client): LessonStore {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  return {
    courseLessons: async (claims, slug) => {
      await asOwner(owner);
      await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [readVerifiedClaims(claims).json]);
      try {
        return await readCourseLessons(tx, slug);
      } finally {
        await asOwner(owner);
      }
    },
    courseIsOpen: async (slug) => {
      await asOwner(owner);
      return readCourseIsOpen(tx, slug);
    },
  };
}

const lessons = (owner: Client) => createLessons({ store: storeOn(owner), report: () => Promise.resolve() });

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
      const service = lessons(owner);
      expect(await service.courseIsOpen("leccion-abierto")).toBe(false);
      await asSystem(owner);
      await owner.query("update public.published_courses set is_open = true where slug = 'leccion-abierto'");
      await asOwner(owner);
      expect(await service.courseIsOpen("leccion-abierto")).toBe(false);
      await asSystem(owner);
      await owner.query(
        "update public.course_registry set is_open = true, open_since = now() where course_id = (select course_id from public.published_courses where slug = 'leccion-abierto')",
      );
      await asOwner(owner);
      expect(await service.courseIsOpen("leccion-abierto")).toBe(true);
      expect(await service.courseIsOpen("leccion-cerrado")).toBeNull();
      expect(await service.courseIsOpen("no-existe")).toBeNull();
    });
  });
});
