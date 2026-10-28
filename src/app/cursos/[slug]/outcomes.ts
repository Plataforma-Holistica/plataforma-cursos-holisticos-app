import { lessonPath, signUpPath } from "@/services/account/navigation";
import type { CourseDetail, CourseStanding } from "@/services/browse/browse";
import type { LessonAccess } from "@/services/media/media";

// El botón principal de la ficha de un curso (PA-02, tabla «Acciones»; T-210). Cambia según quién
// mira. Es una tabla pura: la página trae los hechos y esto decide qué botón y a dónde.
//
// Mientras no exista la pantalla de planes (T-30x), «Suscribirme para verlo» del visitante lleva a
// registrarse con la lección como destino, y el del alumno sin acceso, a la lección, donde PA-33
// explica por qué. Sin constancias (T-504), quien terminó el curso lo vuelve a ver desde la primera.

export type PrimaryAction =
  | { kind: "start" | "again" | "subscribe" | "open_free"; href: string }
  | { kind: "continue"; href: string; number: number }
  /** No se sabe quién mira, o la cuenta está suspendida: la ficha se ve, sin botón. */
  | { kind: "none" };

export type Viewer = { kind: "visitor" } | { kind: "unknown" } | { kind: "student"; access: LessonAccess; standing: CourseStanding | null };

export function primaryAction(detail: CourseDetail, viewer: Viewer): PrimaryAction {
  const slug = detail.course.slug;
  const first = lessonPath(slug, detail.firstLesson.id);
  if (first === null) return { kind: "none" };

  // No se sabe quién mira (una cuenta suspendida o a medias, o no se supo): sin botón.
  if (viewer.kind === "unknown") return { kind: "none" };
  if (viewer.kind === "visitor") return { kind: detail.course.isOpen ? "open_free" : "subscribe", href: signUpPath(first) };

  switch (viewer.access.kind) {
    case "suspended":
      return { kind: "none" };
    case "denied":
      return { kind: "subscribe", href: first };
    default:
      break;
  }

  const standing = viewer.standing;
  // Sin el avance (no se supo), se ofrece empezar: la lección arranca donde se quedó de todos modos.
  if (standing === null || !standing.started) return { kind: "start", href: first };
  if (standing.finished || standing.suggested === null) return { kind: "again", href: first };
  const suggested = lessonPath(slug, standing.suggested.id) ?? first;
  return { kind: "continue", href: suggested, number: standing.suggested.number };
}
