import { describe, expect, it, vi } from "vitest";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/account";

import { CATALOG_MEMORY_MS, createBrowse, type BrowseStore } from "./browse";
import type { CourseLessonRow } from "./course";
import type { ShelfCourse } from "./shelf";

vi.mock("server-only", () => ({}));
vi.mock("@/adapters/supabase/db", () => ({ asServer: vi.fn(), asSystem: vi.fn(), asUser: vi.fn() }));
vi.mock("@/services/account/account", () => ({ checkSession: vi.fn() }));
vi.mock("@/services/error-reporting/server", () => ({ reportFailure: vi.fn() }));

// El servicio del catálogo del alumno, con su almacén simulado: qué se le pregunta, qué se
// recuerda y qué se contesta. Contra la base de verdad, en tests/integration/70-catalogo.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const reader = {} as CookieReader;

const COURSE: ShelfCourse = {
  slug: "respirar",
  title: "Respirar",
  summary: null,
  teacherName: "Ana Robles",
  teacherSlug: "ana-robles",
  practice: { slug: "meditacion", name: "Meditación", tone: 3, position: 1 },
  level: { slug: "principiante", name: "Principiante", position: 1 },
  lessonCount: 1,
  totalSeconds: 60,
  publishedAt: new Date(0),
  isOpen: false,
};
const LESSON: CourseLessonRow = {
  moduleId: "m1",
  moduleTitle: "Uno",
  modulePosition: 1,
  lessonId: "l1",
  lessonTitle: "Primera",
  lessonPosition: 1,
  durationSeconds: 60,
};
const TEACHER = { slug: "ana-robles", name: "Ana Robles", bio: "Semblanza." };

type Fake = {
  courses?: ShelfCourse[] | "throws";
  lessons?: CourseLessonRow[] | "throws";
  teacher?: typeof TEACHER | null | "throws";
  search?: { courses: string[]; teachers: string[] } | "throws";
  saved?: { slug: string }[] | "throws";
  session?: SessionCheck;
};

function browseWith(fake: Fake = {}) {
  let clock = 1_000_000;
  const reported: string[] = [];
  const answer = <T>(value: T | "throws") => (value === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve(value));
  const store = {
    listedCourses: vi.fn(() => answer(fake.courses ?? [COURSE])),
    listedTeacher: vi.fn(() => answer(fake.teacher === undefined ? TEACHER : fake.teacher)),
    courseLessons: vi.fn(() => {
      const lessons = fake.lessons ?? [LESSON];
      return lessons === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve({ resources: [], teacher: TEACHER, lessons });
    }),
    myCourse: vi.fn(() => Promise.resolve({ progress: [], saved: false })),
    search: vi.fn(() => answer(fake.search ?? { courses: ["respirar"], teachers: ["ana-robles"] })),
    mySavedCourses: vi.fn(() => answer(fake.saved ?? [])),
    saveCourse: vi.fn<BrowseStore["saveCourse"]>(() => Promise.resolve("saved")),
    removeCourse: vi.fn<BrowseStore["removeCourse"]>(() => Promise.resolve()),
  } satisfies BrowseStore;
  const checkSession = vi.fn<(reader: CookieReader) => Promise<SessionCheck>>(() => Promise.resolve(fake.session ?? { kind: "pass", claims }));
  const service = createBrowse({ store, checkSession, report: (code) => (reported.push(code), Promise.resolve()), now: () => clock });
  return { ...service, store, checkSession, reported, advance: (ms: number) => (clock += ms) };
}

describe("el inicio", () => {
  it("arma las filas con los cursos listados", async () => {
    const service = browseWith();
    const answer = await service.homeShelf();
    expect(answer.kind).toBe("ready");
    if (answer.kind === "ready") expect(answer.shelf.newest.map((each) => each.slug)).toEqual(["respirar"]);
  });

  it("recuerda lo leído treinta segundos, y después vuelve a leer", async () => {
    const service = browseWith();
    await service.homeShelf();
    await service.coursePage("respirar");
    service.advance(CATALOG_MEMORY_MS - 1);
    await service.homeShelf();
    expect(service.store.listedCourses).toHaveBeenCalledTimes(1);
    service.advance(1);
    await service.homeShelf();
    expect(service.store.listedCourses).toHaveBeenCalledTimes(2);
  });

  it("si no se supo, lo reporta, lo dice, y lo recuerda también", async () => {
    const service = browseWith({ courses: "throws" });
    expect(await service.homeShelf()).toEqual({ kind: "unavailable" });
    expect(await service.homeShelf()).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["catalog_unavailable"]);
    expect(service.store.listedCourses).toHaveBeenCalledTimes(1);
  });
});

describe("la ficha de un curso", () => {
  it("la encuentra, con su temario y su maestro", async () => {
    const service = browseWith();
    expect(await service.coursePage("respirar")).toMatchObject({
      kind: "found",
      detail: { course: { slug: "respirar" }, teacher: TEACHER, firstLesson: { id: "l1" } },
    });
    expect(service.store.courseLessons).toHaveBeenCalledExactlyOnceWith("respirar");
  });

  it.each([
    ["un slug sin forma, sin preguntar", "Respirar/../x"],
    ["un curso que no está listado", "otro"],
  ])("no existe: %s", async (_, slug) => {
    const service = browseWith();
    expect(await service.coursePage(slug)).toEqual({ kind: "not_found" });
    expect(service.store.courseLessons).not.toHaveBeenCalled();
  });

  it("el temario se recuerda treinta segundos, también si no se supo", async () => {
    const service = browseWith({ lessons: "throws" });
    await service.coursePage("respirar");
    await service.coursePage("respirar");
    expect(service.store.courseLessons).toHaveBeenCalledTimes(1);
    expect(service.reported).toEqual(["catalog_unavailable"]);
  });

  it("un curso listado sin lecciones vigentes tampoco existe", async () => {
    expect(await browseWith({ lessons: [] }).coursePage("respirar")).toEqual({ kind: "not_found" });
  });

  it("si no se pudo leer el temario, no se supo", async () => {
    const service = browseWith({ lessons: "throws" });
    expect(await service.coursePage("respirar")).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["catalog_unavailable"]);
  });

  it("el avance se lee como la persona, del curso de la ficha", async () => {
    const service = browseWith();
    const page = await service.coursePage("respirar");
    if (page.kind !== "found") throw new Error("sin ficha");
    expect(await service.courseStanding(claims, page.detail)).toMatchObject({ kind: "ready", standing: { completed: 0, total: 1 }, saved: false });
    expect(service.store.myCourse).toHaveBeenCalledExactlyOnceWith(claims, "respirar");
  });

  it("dice, en la misma lectura, si el curso está en su lista", async () => {
    const service = browseWith();
    service.store.myCourse.mockResolvedValueOnce({ progress: [], saved: true });
    const page = await service.coursePage("respirar");
    if (page.kind !== "found") throw new Error("sin ficha");
    expect(await service.courseStanding(claims, page.detail)).toMatchObject({ kind: "ready", saved: true });
  });

  it("si no se supo el avance, se reporta aparte", async () => {
    const service = browseWith();
    service.store.myCourse.mockRejectedValueOnce(new Error("sin base"));
    const page = await service.coursePage("respirar");
    if (page.kind !== "found") throw new Error("sin ficha");
    expect(await service.courseStanding(claims, page.detail)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["course_progress_unavailable"]);
  });
});

describe("la ficha de un maestro", () => {
  it("lo encuentra, con sus cursos listados y su semblanza", async () => {
    const other = { ...COURSE, slug: "otro", teacherSlug: "beto", teacherName: "Beto" };
    const answer = await browseWith({ courses: [COURSE, other] }).teacherPage("ana-robles");
    expect(answer).toMatchObject({ kind: "found", teacher: { slug: "ana-robles", name: "Ana Robles", bio: "Semblanza.", practices: ["Meditación"] } });
    if (answer.kind === "found") expect(answer.courses.map((each) => each.slug)).toEqual(["respirar"]);
  });

  it("un slug que no es de nadie no llega a la base: lo decide la lista recordada", async () => {
    const service = browseWith();
    for (const slug of ["a1", "a2", "a3"]) expect(await service.teacherPage(slug)).toEqual({ kind: "not_found" });
    expect(service.store.listedTeacher).not.toHaveBeenCalled();
    expect(service.store.listedCourses).toHaveBeenCalledTimes(1);
  });

  it("la semblanza se recuerda treinta segundos", async () => {
    const service = browseWith();
    await service.teacherPage("ana-robles");
    await service.teacherPage("ana-robles");
    expect(service.store.listedTeacher).toHaveBeenCalledTimes(1);
    service.advance(CATALOG_MEMORY_MS);
    await service.teacherPage("ana-robles");
    expect(service.store.listedTeacher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no está listado", { teacher: null }, "ana-robles"],
    ["no tiene cursos listados", { courses: [] }, "ana-robles"],
    ["el slug no tiene forma", {}, "Ana Robles"],
  ])("no existe si %s", async (_, fake: Fake, slug) => {
    expect(await browseWith(fake).teacherPage(slug)).toEqual({ kind: "not_found" });
  });

  it("si no se supo, lo dice", async () => {
    expect(await browseWith({ teacher: "throws" }).teacherPage("ana-robles")).toEqual({ kind: "unavailable" });
  });
});

describe("explorar (PA-21)", () => {
  const NOTHING = { q: null, practice: null, teacher: null, level: null };
  const OTHER: ShelfCourse = { ...COURSE, slug: "otro", title: "Otro", practice: null, level: null, publishedAt: new Date(5) };

  it("sin filtro ni búsqueda da los filtros y el inicio, sin resultados ni búsqueda", async () => {
    const service = browseWith({ courses: [COURSE, OTHER] });
    const answer = await service.explore(NOTHING);
    expect(answer.kind).toBe("ready");
    if (answer.kind !== "ready") return;
    expect(answer.results).toBeNull();
    expect(answer.facets.practices).toEqual([{ slug: "meditacion", name: "Meditación" }]);
    expect(answer.shelf.practices.map((row) => row.slug)).toEqual(["meditacion"]);
    expect(service.store.search).not.toHaveBeenCalled();
  });

  it("con un filtro, filtra lo listado sin preguntarle a la base", async () => {
    const service = browseWith({ courses: [COURSE, OTHER] });
    const answer = await service.explore({ ...NOTHING, practice: "meditacion" });
    if (answer.kind !== "ready") throw new Error(answer.kind);
    expect(answer.results?.courses.map((each) => each.slug)).toEqual(["respirar"]);
    expect(service.store.search).not.toHaveBeenCalled();
  });

  it("un filtro que no existe no se aplica: se contesta como si no se hubiera pedido", async () => {
    const service = browseWith();
    const answer = await service.explore({ ...NOTHING, practice: "reiki" });
    if (answer.kind !== "ready") throw new Error(answer.kind);
    expect(answer.query.practice).toBeNull();
    expect(answer.results).toBeNull();
  });

  it("con búsqueda, le pregunta a la base y recuerda la respuesta treinta segundos", async () => {
    const service = browseWith({ courses: [COURSE, OTHER] });
    const answer = await service.explore({ ...NOTHING, q: "ana" });
    if (answer.kind !== "ready") throw new Error(answer.kind);
    expect(service.store.search).toHaveBeenCalledExactlyOnceWith("ana");
    expect(answer.results?.courses.map((each) => each.slug)).toEqual(["respirar"]);
    expect(answer.results?.teachers.map((each) => each.slug)).toEqual(["ana-robles"]);
    await service.explore({ ...NOTHING, q: "ana", practice: "meditacion" });
    expect(service.store.search).toHaveBeenCalledTimes(1);
    service.advance(CATALOG_MEMORY_MS);
    await service.explore({ ...NOTHING, q: "ana" });
    expect(service.store.search).toHaveBeenCalledTimes(2);
  });

  it("si la búsqueda no se pudo, «no se supo», reportado", async () => {
    const service = browseWith({ search: "throws" });
    expect(await service.explore({ ...NOTHING, q: "ana" })).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["catalog_unavailable"]);
  });

  it("si lo listado no se pudo, «no se supo», sin buscar", async () => {
    const service = browseWith({ courses: "throws" });
    expect(await service.explore({ ...NOTHING, q: "ana" })).toEqual({ kind: "unavailable" });
    expect(service.store.search).not.toHaveBeenCalled();
  });
});

describe("Mi lista (RF-311)", () => {
  const SECOND: ShelfCourse = { ...COURSE, slug: "soltar", title: "Soltar", publishedAt: new Date(1) };

  it("la lee como la persona y la cruza con lo listado, en el orden en que la guardó", async () => {
    const service = browseWith({ courses: [COURSE, SECOND], saved: [{ slug: "soltar" }, { slug: "ya-no-listado" }, { slug: "respirar" }] });
    const answer = await service.myList(claims);
    expect(answer).toEqual({ kind: "ready", courses: [SECOND, COURSE] });
    expect(service.store.mySavedCourses).toHaveBeenCalledExactlyOnceWith(claims);
  });

  it("no se recuerda: cada lectura le pregunta a la base", async () => {
    const service = browseWith();
    await service.myList(claims);
    await service.myList(claims);
    expect(service.store.mySavedCourses).toHaveBeenCalledTimes(2);
  });

  it("si lo listado no se supo, no la lee", async () => {
    const service = browseWith({ courses: "throws" });
    expect(await service.myList(claims)).toEqual({ kind: "unavailable" });
    expect(service.store.mySavedCourses).not.toHaveBeenCalled();
    expect(service.reported).toEqual(["catalog_unavailable"]);
  });

  it("si la lista no se pudo leer, «no se supo», reportado aparte", async () => {
    const service = browseWith({ saved: "throws" });
    expect(await service.myList(claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["saved_courses_unavailable"]);
  });

  describe.each([
    ["saveCourse", "saved"],
    ["removeCourse", "removed"],
  ] as const)("%s", (method, done) => {
    it("corre la guarda y escribe a nombre de la sesión que pasó", async () => {
      const service = browseWith();
      expect(await service[method](reader, "respirar")).toEqual({ kind: done });
      expect(service.checkSession).toHaveBeenCalledExactlyOnceWith(reader);
      expect(service.store[method]).toHaveBeenCalledExactlyOnceWith(claims, "respirar");
    });

    it.each(["", "Respirar", "../respirar", "a".repeat(101), "respirar-"])("un slug sin forma (%j) no llega a la guarda ni a la base", async (slug) => {
      const service = browseWith();
      expect(await service[method](reader, slug)).toEqual({ kind: "not_found" });
      expect(service.checkSession).not.toHaveBeenCalled();
      expect(service.store[method]).not.toHaveBeenCalled();
    });

    it.each<SessionCheck>([
      { kind: "anonymous" },
      { kind: "suspended" },
      { kind: "must_sign_out", then: "sign_in" },
      { kind: "unavailable" },
      { kind: "incomplete", claims, variant: "complete_account", missing: { name: true, adultDeclaration: false, documents: [] } },
    ])("lo que no pasa la guarda ($kind) sale tal cual, sin escribir", async (check) => {
      const service = browseWith({ session: check });
      expect(await service[method](reader, "respirar")).toEqual({ kind: "session", check });
      expect(service.store[method]).not.toHaveBeenCalled();
    });

    it("si la base no contestó, «no se supo», reportado", async () => {
      const service = browseWith();
      service.store[method].mockRejectedValueOnce(new Error("sin base"));
      expect(await service[method](reader, "respirar")).toEqual({ kind: "unavailable" });
      expect(service.reported).toEqual(["saved_courses_unavailable"]);
    });
  });

  it("guardar un curso que no está listado contesta que no existe", async () => {
    const service = browseWith();
    service.store.saveCourse.mockResolvedValueOnce("not_found");
    expect(await service.saveCourse(reader, "retirado")).toEqual({ kind: "not_found" });
    expect(service.reported).toEqual([]);
  });
});
