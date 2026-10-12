import "server-only";

import { z } from "zod";

import type { CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asUser } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import { parseDisplayName, type DisplayNameResult } from "@/domain/access/display-name";
import { describeUserAgent, type Device } from "@/domain/access/user-agent";

import { isSessionId, type SessionCheck } from "./admission";
import type { AccountDependencies } from "./deps";
import { evaluateGate } from "./gate";
import { saveName } from "./records";
import { closeOtherSessions as closeOthersInBase, closeSession as closeInBase, listSessions } from "./store";

// Administrar la cuenta (RF-109; flujo de la app FL-27; diseño PA-25): lo que una persona
// con sesión cambia de su propia cuenta. Por ahora, el nombre y las sesiones abiertas. La
// contraseña llega en su propia solicitud, y el cambio de correo espera a que haya correo
// propio (T-310).
//
// Una regla para todo el archivo: cada escritura vuelve a correr la guarda de sesión, y la
// cuenta sobre la que se escribe es la de esa sesión. Nada de lo que llega dice de quién es.
// De una sesión que se quiere cerrar llega su identificador, y la base solo lo busca entre
// las de quien actúa.

export type AccountProfile =
  /** `name` es nulo solo si la cuenta no tiene nombre guardado: la guarda no deja llegar así. */
  | { kind: "ready"; name: string | null }
  /** No se supo. */
  | { kind: "unavailable" };

export type NameChange =
  /** Quedó guardado, sin espacios en los extremos. */
  | { kind: "saved"; name: string }
  | { kind: "invalid"; reason: Extract<DisplayNameResult, { ok: false }>["reason"] }
  /** La sesión no llega hasta aquí: se obedece lo que dijo la guarda. */
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

/** Una sesión abierta de la cuenta, como la pinta la lista. Las horas, en UTC y en formato ISO. */
export interface OpenSession {
  id: string;
  openedAt: string;
  /** La última vez que se usó, o nulo si no se sabe. */
  lastActiveAt: string | null;
  /** De qué navegador y sistema dijo ser al abrirse. Lo que no se reconoce, en nulo. */
  device: Device;
  /** Es la sesión con la que se está viendo la lista. */
  current: boolean;
}

export type AccountSessions =
  /** La de actividad más reciente, primero. La sesión con la que se pide siempre está. */
  | { kind: "ready"; sessions: OpenSession[] }
  | { kind: "unavailable" };

export type SessionClosing =
  | { kind: "closed" }
  /** No es una sesión de esta cuenta, o ya no estaba abierta. Hacia fuera es lo mismo. */
  | { kind: "not_found" }
  /** Es la sesión con la que se pide: esa no se cierra por aquí, se sale. */
  | { kind: "current" }
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

export type OthersClosing =
  /** `count`: cuántas se cerraron en Auth, anotadas o no. */
  | { kind: "closed"; count: number }
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

/** Lo que estos servicios usan de los de entrada. */
export interface ManagementCore {
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
}

const nameRow = z.object({ display_name: z.string().nullable() });

export function createManagement(deps: Pick<AccountDependencies, "report" | "isLocal">, core: ManagementCore) {
  /**
   * Lo que la pantalla de la cuenta pinta de la persona. Recibe las claims con las que la
   * guarda dejó pasar a su página, y lee como esa persona: la base filtra por ella.
   */
  async function accountProfile(claims: VerifiedClaims): Promise<AccountProfile> {
    try {
      const rows = await asUser(claims, (tx) =>
        tx.query(sql`select p.display_name from public.profiles p where p.id = ${claims.userId}::uuid`, nameRow),
      );
      const [row] = rows;
      // Sin perfil no hay cuenta que administrar: la guarda ya habría cerrado esa sesión.
      if (!row) throw new Error("Una sesión que pasó la guarda no tiene perfil.");
      return { kind: "ready", name: row.display_name };
    } catch {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Cambiar el nombre (FL-27, paso 1). Exige una sesión que pase la guarda: a una cuenta a
   * la que le falta algo se lo pide primero su pantalla (PA-15). El criterio de «nombre
   * válido» es el mismo de la guarda, así que lo guardado nunca deja a la cuenta sin nombre.
   *
   * La guarda de sesión corre en su propia transacción. En la de la escritura se vuelve a
   * mirar la cuenta, ya con el nombre puesto: si dejó de pasar entre una y otra, nada se
   * guarda. El orden importa: guardar toma la fila, así que la evaluación de después ve lo
   * que otra transacción confirmó mientras esta esperaba.
   */
  async function changeName(reader: CookieReader, input: { name: string }): Promise<NameChange> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };

    const parsed = parseDisplayName(input.name);
    if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };

    try {
      await asServer({ claims: check.claims, reason: "change_name" }, async (tx) => {
        // Sin perfil no se guardó nada, y no se dice que sí: la cuenta se fue entre la guarda y aquí.
        if (!(await saveName(tx, check.claims.userId, parsed.name))) {
          throw new Error("Una sesión que pasó la guarda no tiene perfil.");
        }
        // Lanzar deshace la escritura: una cuenta suspendida, o a la que le falta algo, no cambia.
        const view = await evaluateGate(tx, check.claims.userId, deps.isLocal());
        if (view.kind !== "pass") throw new Error("La cuenta dejó de pasar la guarda mientras se guardaba su nombre.");
      });
    } catch {
      // Antes de darlo por caída se le vuelve a preguntar a la guarda de sesión: una cuenta
      // que cambió a media operación no es una falla, y se contesta lo que la guarda dice
      // ahora. Si insiste en que pasa, o tampoco supo, eso no explica el fallo: lo que falló
      // fue guardar, y se reporta aquí, sin contar con que la guarda reporte lo suyo.
      const now = await core.checkSession(reader);
      if (now.kind !== "pass" && now.kind !== "unavailable") return { kind: "session", check: now };
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
    return { kind: "saved", name: parsed.name };
  }

  /**
   * Las sesiones abiertas de la cuenta (FL-27, paso 4). Recibe las claims con las que la
   * guarda dejó pasar a su página. Va como servidor: la lista sale de una función de la
   * base que solo él ejecuta, y que solo devuelve las de quien actúa.
   */
  async function accountSessions(claims: VerifiedClaims): Promise<AccountSessions> {
    try {
      const rows = await asServer({ claims, reason: "list_sessions" }, (tx) => listSessions(tx));
      const sessions = rows.map((row) => ({
        id: row.id,
        openedAt: row.openedAt,
        lastActiveAt: row.lastActiveAt,
        device: describeUserAgent(row.userAgent),
        current: row.id === claims.sessionId,
      }));
      // La guarda ya reconoció la sesión con la que se pide: si no viene en la lista, algo no cuadra.
      if (!sessions.some((session) => session.current)) {
        throw new Error("La sesión que pasó la guarda no está entre las abiertas.");
      }
      return { kind: "ready", sessions };
    } catch {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Cerrar una sesión de la cuenta que no es esta (FL-27, paso 4). La sesión con la que se
   * pide no se cierra por aquí: su cookie quedaría en el navegador apuntando a nada. Para
   * esa está «Salir».
   *
   * No se vuelve a evaluar la cuenta en la transacción, como al cambiar el nombre: cerrar
   * solo quita acceso, y la base busca la sesión entre las de quien actúa.
   */
  async function closeSession(reader: CookieReader, input: { sessionId: string }): Promise<SessionClosing> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };

    // Lo que no tiene forma de identificador no es una sesión de nadie, y no llega a la base.
    if (!isSessionId(input.sessionId)) return { kind: "not_found" };
    const sessionId = input.sessionId.toLowerCase();
    if (sessionId === check.claims.sessionId?.toLowerCase()) return { kind: "current" };

    let state: string;
    try {
      state = await asServer({ claims: check.claims, reason: "close_session" }, (tx) => closeInBase(tx, sessionId));
    } catch {
      state = "failed";
    }
    if (state === "closed" || state === "not_found") return { kind: state };
    await deps.report("account_unavailable");
    return { kind: "unavailable" };
  }

  /**
   * Cerrar todas las sesiones de la cuenta menos esta (FL-27, paso 4). Se van también las
   * que estén vivas en Auth sin que la aplicación las haya abierto. Cuál se queda no llega
   * de fuera: es la de la sesión que pasó la guarda, y la base exige además que sea de quien
   * actúa, esté anotada y siga viva.
   */
  async function closeOtherSessions(reader: CookieReader): Promise<OthersClosing> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };

    const keep = check.claims.sessionId;
    let count: number | null = null;
    if (isSessionId(keep)) {
      try {
        count = await asServer({ claims: check.claims, reason: "close_other_sessions" }, (tx) => closeOthersInBase(tx, keep));
      } catch {
        count = null;
      }
    }
    if (count !== null) return { kind: "closed", count };
    await deps.report("account_unavailable");
    return { kind: "unavailable" };
  }

  return { accountProfile, changeName, accountSessions, closeSession, closeOtherSessions };
}
