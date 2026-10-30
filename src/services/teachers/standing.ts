import "server-only";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

// En qué estado está quien pide el portal del maestro (T-402; flujo de la app §6.2). Quién es maestro
// lo dice la base: aquí solo se decide a quién se le pregunta y en qué orden. La guarda de sesión va
// primero, y lo que no sea «pasa» se contesta tal cual. «No se supo» nunca es «no es maestro».
//
// La segunda solicitud de T-401 (carril A) cambia la lectura por `private.teacher_standing()` y suma
// los estados de la invitación y del aviso del maestro; quien llama no cambia.

/** El estado del maestro de quien actúa, como lo dice la base. Una invitación o un maestro que se fue cuentan como `none`. */
export type TeacherStanding = { state: "none" } | { state: "active" | "suspended"; teacher: { id: string } };

/** Lo que la guarda de sesión contesta cuando no deja pasar. */
type Refused = Exclude<SessionCheck, { kind: "pass" }>;

export type TeacherCheck = Refused | { kind: "teacher"; claims: VerifiedClaims; standing: TeacherStanding };

export interface TeacherStore {
  standing(claims: VerifiedClaims): Promise<TeacherStanding>;
}

export interface TeachersDeps {
  store: TeacherStore;
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  report: (code: FailureCode) => Promise<void>;
}

export function createTeachers(deps: TeachersDeps) {
  /** Lo que leen las guardas de las pantallas del portal. */
  async function teacherStanding(reader: CookieReader): Promise<TeacherCheck> {
    const check = await deps.checkSession(reader);
    if (check.kind !== "pass") return check;
    try {
      return { kind: "teacher", claims: check.claims, standing: await deps.store.standing(check.claims) };
    } catch {
      await deps.report("teacher_unavailable");
      return { kind: "unavailable" };
    }
  }

  return { teacherStanding };
}
