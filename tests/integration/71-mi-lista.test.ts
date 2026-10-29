import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { readVerifiedClaims, type VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { createBrowse } from "@/services/browse/browse";
import {
  readCourseLessons,
  readIsSaved,
  readListedCourses,
  readListedTeacher,
  readMyCourseProgress,
  readMySavedCourses,
  removeSavedCourse,
  saveListedCourse,
  searchCatalog,
} from "@/services/browse/records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Mi lista (RF-311, T-210) contra la base local: la guarda de sesión corre de verdad, la persona
// lee la suya como ella misma, y el servidor escribe a su nombre. Los cursos y lo guardado viven
// en una transacción del dueño que se revierte; cada caso mira solo sus cursos (por su prefijo).

const emails: string[] = [];
afterAll(async () => {
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

async function asServerFor<T>(owner: Client, claims: VerifiedClaims, write: (tx: Tx) => Promise<T>): Promise<T> {
  const { claims: verified } = readVerifiedClaims(claims);
  await asServer(owner, verified.userId, verified.sessionId ?? "");
  try {
    return await write(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

async function asSystemRead<T>(owner: Client, read: (tx: Tx) => Promise<T>): Promise<T> {
  await asOwner(owner);
  return read(txOn(owner));
}

/** El servicio sobre esa transacción. Cada llamada arma uno nuevo, así que lee lo de ahora. */
const browse = (owner: Client) =>
  createBrowse({
    store: {
      listedCourses: () => asSystemRead(owner, readListedCourses),
      listedTeacher: (slug) => asSystemRead(owner, (tx) => readListedTeacher(tx, slug)),
      courseLessons: (slug) => asSystemRead(owner, (tx) => readCourseLessons(tx, slug)),
      myCourse: (claims, slug) =>
        asPerson(owner, claims, async (tx) => ({ progress: await readMyCourseProgress(tx, slug), saved: await readIsSaved(tx, slug) })),
      search: (q) => asSystemRead(owner, (tx) => searchCatalog(tx, q)),
      mySavedCourses: (claims) => asPerson(owner, claims, readMySavedCourses),
      saveCourse: (claims, slug) => asServerFor(owner, claims, (tx) => saveListedCourse(tx, slug)),
      removeCourse: (claims, slug) => asServerFor(owner, claims, (tx) => removeSavedCourse(tx, slug)),
    },
    checkSession: (reader) => testServices().checkSession(reader),
    report: () => Promise.reject(new Error("Nada debía reportarse.")),
  });

/** Un curso de una lección; el de `listed` se publica y se lista. */
async function loadCourse(owner: Client, slug: string, listed: boolean): Promise<void> {
  await asSystem(owner);
  await owner.query("select set_config('app.local_courses', 'on', true)");
  await owner.query("select private.system_catalog_add('practices', 'Práctica de la lista'), private.system_catalog_add('levels', 'Nivel de la lista')");
  const level = (await owner.query<{ slug: string }>("select slug from public.levels where name = 'Nivel de la lista'")).rows[0]?.slug ?? "";
  const teacher = (await owner.query<{ id: string }>("select private.system_add_teacher('Maestra de la lista', $1, null)::text as id", [`maestra-${slug}`])).rows[0]?.id ?? "";
  const course = {
    slug,
    title: `Curso ${slug}`,
    summary: "Un curso de prueba.",
    practice: "practica-de-la-lista",
    level,
    modules: [{ title: "Uno", lessons: [{ title: "Primera", video: { provider: "mux", asset_id: `Asset-${slug}`, playback_id: `Playback-${slug}`, duration_seconds: 300 } }] }],
  };
  const loaded = (await owner.query<{ answer: string }>("select private.system_load_course($1::uuid, $2::jsonb) ->> 'answer' as answer", [teacher, JSON.stringify(course)])).rows[0];
  if (loaded?.answer !== "loaded") throw new Error(`No cargó el curso: ${loaded?.answer}`);
  if (listed) {
    await owner.query(
      "update public.course_registry set state = 'published', first_published_at = now() where course_id = (select course_id from public.published_courses where slug = $1)",
      [slug],
    );
    await setListed(owner, slug, true);
  }
  await asOwner(owner);
}

async function setListed(owner: Client, slug: string, listed: boolean): Promise<void> {
  await asSystem(owner);
  await owner.query("update public.published_courses set is_listed = $2 where slug = $1", [slug, listed]);
  await asOwner(owner);
}

const mine = (courses: readonly { slug: string }[]) => courses.map((each) => each.slug).filter((slug) => slug.startsWith("lista-"));

async function listOf(owner: Client, who: Person): Promise<string[]> {
  const answer = await browse(owner).myList(who.claims);
  if (answer.kind !== "ready") throw new Error(`No se leyó la lista: ${answer.kind}`);
  return mine(answer.courses);
}

async function isSaved(owner: Client, who: Person, slug: string): Promise<boolean> {
  const service = browse(owner);
  const page = await service.coursePage(slug);
  if (page.kind !== "found") throw new Error(`Sin ficha: ${page.kind}`);
  const standing = await service.courseStanding(who.claims, page.detail);
  if (standing.kind !== "ready") throw new Error("No se leyó el avance");
  return standing.saved;
}

describe("Mi lista (RF-311), contra la base", () => {
  it("guarda solo lo listado, dos veces da lo mismo, y la ficha lo sabe", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-uno", true);
      await loadCourse(owner, "lista-dos", true);
      await loadCourse(owner, "lista-oculta", false);
      expect(await isSaved(owner, ana, "lista-uno")).toBe(false);
      expect(await browse(owner).saveCourse(ana.jar, "lista-uno")).toEqual({ kind: "saved" });
      expect(await browse(owner).saveCourse(ana.jar, "lista-dos")).toEqual({ kind: "saved" });
      expect(await browse(owner).saveCourse(ana.jar, "lista-uno")).toEqual({ kind: "saved" });
      expect(await browse(owner).saveCourse(ana.jar, "lista-oculta")).toEqual({ kind: "not_found" });
      expect(await browse(owner).saveCourse(ana.jar, "lista-no-existe")).toEqual({ kind: "not_found" });
      expect(await listOf(owner, ana)).toEqual(["lista-dos", "lista-uno"]);
      expect(await isSaved(owner, ana, "lista-uno")).toBe(true);
      const rows = await owner.query<{ n: number }>("select count(*)::int as n from public.saved_courses where profile_id = $1", [ana.id]);
      expect(rows.rows[0]?.n).toBe(2);
    });
  });

  it("quitar, también lo que ya no estaba", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-quitar", true);
      await browse(owner).saveCourse(ana.jar, "lista-quitar");
      expect(await browse(owner).removeCourse(ana.jar, "lista-quitar")).toEqual({ kind: "removed" });
      expect(await browse(owner).removeCourse(ana.jar, "lista-quitar")).toEqual({ kind: "removed" });
      expect(await listOf(owner, ana)).toEqual([]);
      expect(await isSaved(owner, ana, "lista-quitar")).toBe(false);
    });
  });

  it("lo de otra persona no se ve ni se quita", async () => {
    const [ana, beto] = [await person(), await person()];
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-ajena", true);
      await browse(owner).saveCourse(beto.jar, "lista-ajena");
      expect(await listOf(owner, ana)).toEqual([]);
      expect(await isSaved(owner, ana, "lista-ajena")).toBe(false);
      expect(await browse(owner).removeCourse(ana.jar, "lista-ajena")).toEqual({ kind: "removed" });
      expect(await listOf(owner, beto)).toEqual(["lista-ajena"]);
    });
  });

  it("un curso que deja de estar listado se oculta, se puede quitar, y vuelve si se lista otra vez", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-vuelve", true);
      await browse(owner).saveCourse(ana.jar, "lista-vuelve");
      await setListed(owner, "lista-vuelve", false);
      expect(await listOf(owner, ana)).toEqual([]);
      expect(await browse(owner).saveCourse(ana.jar, "lista-vuelve")).toEqual({ kind: "not_found" });
      await setListed(owner, "lista-vuelve", true);
      expect(await listOf(owner, ana)).toEqual(["lista-vuelve"]);
      await setListed(owner, "lista-vuelve", false);
      expect(await browse(owner).removeCourse(ana.jar, "lista-vuelve")).toEqual({ kind: "removed" });
      await setListed(owner, "lista-vuelve", true);
      expect(await listOf(owner, ana)).toEqual([]);
    });
  });

  it("uno retirado no se pinta aunque siga marcado como listado: lo listado lo decide el registro", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-retirada", true);
      await browse(owner).saveCourse(ana.jar, "lista-retirada");
      await asSystem(owner);
      await owner.query(
        "update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba' where course_id = (select course_id from public.published_courses where slug = 'lista-retirada')",
      );
      await asOwner(owner);
      // La persona la ve en su lectura (lo marcado como listado), y el cruce la quita.
      expect(await asPerson(owner, ana.claims, readMySavedCourses)).toContainEqual({ slug: "lista-retirada" });
      expect(await listOf(owner, ana)).toEqual([]);
    });
  });

  it("sin una sesión que pase no se escribe nada", async () => {
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-sin-sesion", true);
      expect(await browse(owner).saveCourse(memoryJar(), "lista-sin-sesion")).toEqual({ kind: "session", check: { kind: "anonymous" } });
      const rows = await owner.query<{ n: number }>(
        "select count(*)::int as n from public.saved_courses s join public.published_courses c on c.course_id = s.course_id where c.slug = 'lista-sin-sesion'",
      );
      expect(rows.rows[0]?.n).toBe(0);
    });
  });

  it("el guardián no deja al servidor escribir a nombre de otra persona, ni a la persona escribir directo", async () => {
    const [ana, beto] = [await person(), await person()];
    await reverted(async (owner) => {
      await loadCourse(owner, "lista-guardian", true);
      const course = (await owner.query<{ id: string }>("select course_id::text as id from public.published_courses where slug = 'lista-guardian'")).rows[0]?.id;
      const insert = "insert into public.saved_courses (profile_id, course_id) values ($1, $2)";
      await owner.query("savepoint antes");
      await asServer(owner, ana.id, readVerifiedClaims(ana.claims).claims.sessionId ?? "");
      await expect(owner.query(insert, [beto.id, course])).rejects.toMatchObject({ code: "42501" });
      await owner.query("rollback to savepoint antes");
      await asOwner(owner);
      await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [readVerifiedClaims(ana.claims).json]);
      await expect(owner.query(insert, [ana.id, course])).rejects.toMatchObject({ code: "42501" });
      await owner.query("rollback to savepoint antes");
      await asOwner(owner);
      // Y a su nombre, sí: la regla es la persona, no el rol.
      await asServer(owner, ana.id, readVerifiedClaims(ana.claims).claims.sessionId ?? "");
      await owner.query(insert, [ana.id, course]);
      await asOwner(owner);
    });
  });
});
