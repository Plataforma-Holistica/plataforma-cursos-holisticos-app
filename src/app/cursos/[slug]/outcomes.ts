import { lessonPath, plansPath, signUpPath } from "@/services/account/navigation";
import type { CourseDetail, CourseStanding } from "@/services/browse/browse";
import type { LessonAccess } from "@/services/media/media";

// El botón principal de la ficha de un curso (PA-02, tabla «Acciones»; T-210). Cambia según quién
// mira. Es una tabla pura: la página trae los hechos y esto decide qué botón y a dónde.
//
// «Suscribirme para verlo» lleva a los planes (PA-04, T-302) con la primera lección como destino, al
// visitante y al alumno sin acceso; el curso abierto, a registrarse. Sin constancias (T-504), quien terminó el curso lo vuelve a ver desde la primera.

export type PrimaryAction =
  | { kind: "start" | "again" | "subscribe" | "open_free"; href: string }
  | { kind: "continue"; href: string; number: number }
  /** No se sabe quién mira o si tiene acceso, o la cuenta está suspendida: la ficha se ve, sin botón. */
  | { kind: "none" };

export type Viewer = { kind: "visitor" } | { kind: "unknown" } | { kind: "student"; access: LessonAccess; standing: CourseStanding | null };

export function primaryAction(detail: CourseDetail, viewer: Viewer): PrimaryAction {
  const slug = detail.course.slug;
  const first = lessonPath(slug, detail.firstLesson.id);
  if (first === null) return { kind: "none" };

  // No se sabe quién mira (una cuenta suspendida o a medias, o no se supo): sin botón.
  if (viewer.kind === "unknown") return { kind: "none" };
  if (viewer.kind === "visitor") return detail.course.isOpen ? { kind: "open_free", href: signUpPath(first) } : { kind: "subscribe", href: plansPath(first) };

  switch (viewer.access.kind) {
    case "denied":
      return { kind: "subscribe", href: plansPath(first) };
    case "allowed":
      break;
    // Suspendida, sin video que ver, o no se supo: no se sabe qué botón le toca, y ninguno se
    // promete (como cuando no se sabe quién mira). El temario sigue llevando a cada lección.
    default:
      return { kind: "none" };
  }

  const standing = viewer.standing;
  // Sin el avance (no se supo), se ofrece empezar: la lección arranca donde se quedó de todos modos.
  if (standing === null || !standing.started) return { kind: "start", href: first };
  if (standing.finished || standing.suggested === null) return { kind: "again", href: first };
  const suggested = lessonPath(slug, standing.suggested.id) ?? first;
  return { kind: "continue", href: suggested, number: standing.suggested.number };
}
