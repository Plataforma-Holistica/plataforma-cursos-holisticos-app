import { consentsPath, coursePath, ROUTES, signInPath } from "@/services/account/navigation";
import type { Notice } from "@/services/account/notice";
import type { ListChange } from "@/services/browse/browse";

// Mi lista (RF-311; FL-11 paso 6; T-210): qué pide el formulario y qué hace cada pantalla con
// cada respuesta. El botón está en tres pantallas (decisión de Sergio del 2026-10-28): la ficha
// del curso, el carrusel «Mi lista» del inicio y explorar. Cada una tiene su acción, y a dónde se
// vuelve lo ata la pantalla: del formulario solo sale qué curso, y ese ya tiene forma.
//
// El formulario dice la intención, guardar o quitar, no «cambiar»: un doble envío no se anula.

export type ListScreen = "course" | "home" | "explore";

export type ListRequest = { kind: "save" | "remove"; slug: string } | { kind: "none" };

/** Lo que pinta el botón o el carrusel después de un envío. */
export type ListState = { kind: "idle" } | { kind: "saved" | "removed" | "gone" | "unavailable"; slug: string; attempt: number };

export type ListOutcome =
  | { kind: "redirect"; to: string; notice: Notice | null; closeSession: boolean }
  /** `gone`: el curso ya no está listado. */
  | { kind: "saved" | "removed" | "gone" | "unavailable" };

const DO = /^(save|remove):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Qué botón se pulsó. Sin uno, con más de uno, o con algo que no es eso, cuenta como vacío. */
export function readListForm(form: unknown): ListRequest {
  if (!(form instanceof FormData)) return { kind: "none" };
  const values = form.getAll("do");
  const [value] = values;
  if (values.length !== 1 || typeof value !== "string" || value.length > 120) return { kind: "none" };
  const match = DO.exec(value);
  const [, kind, slug] = match ?? [];
  if ((kind !== "save" && kind !== "remove") || slug === undefined || slug.length > 100) return { kind: "none" };
  return { kind, slug };
}

/** La pantalla de cada botón: la ficha de ese curso, el inicio o explorar. */
function screenPath(screen: ListScreen, slug: string): string {
  switch (screen) {
    case "course":
      return coursePath(slug) ?? ROUTES.home;
    case "home":
      return ROUTES.home;
    case "explore":
      return ROUTES.explore;
  }
}

export function listOutcome(screen: ListScreen, slug: string, result: ListChange): ListOutcome {
  switch (result.kind) {
    case "saved":
    case "removed":
      return { kind: result.kind };
    case "not_found":
      return { kind: "gone" };
    case "unavailable":
      return { kind: "unavailable" };
    case "session": {
      const back = screenPath(screen, slug);
      switch (result.check.kind) {
        case "anonymous":
          return { kind: "redirect", to: signInPath(back), notice: null, closeSession: false };
        case "incomplete":
          // A la cuenta le falta algo: lo pide su pantalla, y después se vuelve aquí.
          return { kind: "redirect", to: consentsPath(back), notice: null, closeSession: false };
        case "suspended":
          // La pantalla lo dice: el inicio y explorar pintan PA-35, y la ficha va sin botón.
          return { kind: "redirect", to: back, notice: null, closeSession: false };
        case "unavailable":
          return { kind: "unavailable" };
        case "must_sign_out":
          return result.check.then === "recover"
            ? { kind: "redirect", to: ROUTES.recover, notice: "choose_password", closeSession: true }
            : { kind: "redirect", to: ROUTES.signIn, notice: null, closeSession: true };
      }
    }
  }
}
