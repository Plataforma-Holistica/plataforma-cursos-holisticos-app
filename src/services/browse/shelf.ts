// Las filas del catálogo del alumno (RF-301, RF-303; T-210), armadas con los cursos listados
// que lee `records.ts`. Es puro: no toca la base ni el reloj.
//
// «Para empezar» (FL-10) son los cursos del primer nivel del orden de PA-67, los más nuevos
// primero (decisión de Sergio del 2026-10-27: «principiante, nuevos primero»). Si ningún curso
// listado es de ese nivel, la fila no aparece.

/** Un curso listado, con lo que lleva su tarjeta y su ficha. */
export interface ShelfCourse {
  slug: string;
  title: string;
  summary: string | null;
  teacherName: string;
  /** El slug de su maestro, si su maestro está listado. */
  teacherSlug: string | null;
  practice: { slug: string; name: string; tone: number; position: number } | null;
  level: { slug: string; name: string; position: number } | null;
  lessonCount: number;
  totalSeconds: number;
  publishedAt: Date;
  /** El curso abierto (RF-309): se ve sin suscripción. */
  isOpen: boolean;
}

export interface ShelfTeacher {
  slug: string;
  name: string;
  /** Las prácticas de sus cursos listados, en el orden de PA-67. */
  practices: string[];
  courseCount: number;
}

export interface PracticeRow {
  slug: string;
  name: string;
  tone: number;
  courses: ShelfCourse[];
}

export interface HomeShelf {
  starters: ShelfCourse[];
  newest: ShelfCourse[];
  practices: PracticeRow[];
  teachers: ShelfTeacher[];
}

/** Cuántas tarjetas lleva una fila, como mucho: lo demás se encuentra en explorar. */
export const ROW_LIMIT = 12;

/** Los más nuevos primero; entre dos del mismo instante, por slug, para que el orden no baile. */
export function newestFirst(a: ShelfCourse, b: ShelfCourse): number {
  return b.publishedAt.getTime() - a.publishedAt.getTime() || a.slug.localeCompare(b.slug);
}

/** Los maestros con cursos listados, por nombre, con sus prácticas en el orden de PA-67. */
export function teachersOf(courses: readonly ShelfCourse[]): ShelfTeacher[] {
  const found = new Map<string, { name: string; practices: Map<string, number>; count: number }>();
  for (const course of courses) {
    if (course.teacherSlug === null) continue;
    let teacher = found.get(course.teacherSlug);
    if (teacher === undefined) {
      teacher = { name: course.teacherName, practices: new Map(), count: 0 };
      found.set(course.teacherSlug, teacher);
    }
    teacher.count += 1;
    if (course.practice !== null) teacher.practices.set(course.practice.name, course.practice.position);
  }
  return [...found.entries()]
    .map(([slug, teacher]) => ({
      slug,
      name: teacher.name,
      practices: [...teacher.practices.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name),
      courseCount: teacher.count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es") || a.slug.localeCompare(b.slug));
}

/** Las filas del inicio (PA-20). Una práctica sin cursos listados no lleva fila. */
export function homeShelfOf(courses: readonly ShelfCourse[]): HomeShelf {
  const ordered = [...courses].sort(newestFirst);

  const firstLevel = ordered.reduce<number | null>(
    (lowest, course) => (course.level === null ? lowest : lowest === null ? course.level.position : Math.min(lowest, course.level.position)),
    null,
  );
  const starters = firstLevel === null ? [] : ordered.filter((course) => course.level?.position === firstLevel);

  const practices = new Map<string, PracticeRow & { position: number }>();
  for (const course of ordered) {
    if (course.practice === null) continue;
    let row = practices.get(course.practice.slug);
    if (row === undefined) {
      row = { slug: course.practice.slug, name: course.practice.name, tone: course.practice.tone, position: course.practice.position, courses: [] };
      practices.set(course.practice.slug, row);
    }
    if (row.courses.length < ROW_LIMIT) row.courses.push(course);
  }

  return {
    starters: starters.slice(0, ROW_LIMIT),
    newest: ordered.slice(0, ROW_LIMIT),
    practices: [...practices.values()]
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ slug: row.slug, name: row.name, tone: row.tone, courses: row.courses })),
    teachers: teachersOf(ordered),
  };
}
