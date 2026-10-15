import "server-only";

import { z } from "zod";

import type { SignInResult as AuthSignIn } from "@/adapters/supabase/auth";
import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asUser } from "@/adapters/supabase/db";
import { sql } from "@/adapters/supabase/sql";
import { parseDisplayName, type DisplayNameResult } from "@/domain/access/display-name";
import { parseEmail } from "@/domain/access/email";
import type { SignInOutcome } from "@/domain/access/login-throttle";
import { checkPasswordChange, PASSWORD_MAX_BYTES } from "@/domain/access/password-policy";
import { describeUserAgent, type Device } from "@/domain/access/user-agent";

import { authRefusal, isSessionId, refusalOf, type Admission, type OpenedAttempt, type SessionCheck } from "./admission";
import { stagingJar, type AccountDependencies } from "./deps";
import { fingerprint } from "./fingerprint";
import { evaluateGate } from "./gate";
import { resolveOrigin, type RequestOrigin } from "./origin";
import { readCaptions, saveCaptions, saveName } from "./records";
import {
  closeOtherSessions as closeOthersInBase,
  closeSession as closeInBase,
  dbClock,
  hasVerifiedFactor,
  listSessions,
  notePasswordChange,
  type PairKeys,
} from "./store";

// Administrar la cuenta (RF-109; flujo de la app FL-27; diseño PA-25): lo que una persona
// con sesión cambia de su propia cuenta: el nombre, las sesiones abiertas y la contraseña.
// El cambio de correo espera a que haya correo propio (T-310).
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

/** Si la persona dejó los subtítulos encendidos (RF-310). */
export type CaptionsChoice = { kind: "ready"; on: boolean } | { kind: "unavailable" };

export type CaptionsChange =
  | { kind: "saved"; on: boolean }
  /** La sesión no llega hasta aquí: no se guardó nada. */
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

/** Una sesión abierta de la cuenta, como la pinta la lista. Las horas, en UTC y en formato ISO. */
export interface OpenSession {
  id: string;
  openedAt: string;
  /** La última vez que renovó su acceso, que es lo que se sabe de su actividad. Nulo si no se sabe. */
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

/** Lo que no dejó cambiar la contraseña, campo por campo. */
export interface PasswordChangeErrors {
  /** `mismatch`: no es la contraseña de esta cuenta. Cuenta como un intento fallido de entrada. */
  current?: "required" | "mismatch";
  /** `same`: es la que ya tenía. `weak`: Auth la rechazó aunque cumpla la regla de aquí. */
  next?: "too_short" | "too_long" | "malformed" | "same" | "weak";
}

/** Si la cuenta tiene un segundo factor verificado. De eso depende cómo cambia su contraseña. */
export type AccountSecondFactor = { kind: "ready"; verified: boolean } | { kind: "unavailable" };

export type PasswordChange =
  /** Cambió, las demás sesiones se cerraron, y este navegador quedó con una sesión nueva. */
  | { kind: "changed" }
  /**
   * La cuenta tiene segundo factor: no cambia su contraseña desde aquí, la recupera desde
   * su correo. No se intentó nada.
   */
  | { kind: "second_factor" }
  | { kind: "invalid"; fields: PasswordChangeErrors }
  /** Frenado, como al entrar: son los mismos intentos. */
  | { kind: "throttled"; retryAt: Date }
  | { kind: "capped" }
  /**
   * Este navegador quedó sin sesión, y la cuenta sin ninguna: hay que entrar. `password`
   * dice si la contraseña ya es la nueva, o si no se supo.
   */
  | { kind: "signed_out"; password: "changed" | "unknown" }
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" }> }
  | { kind: "unavailable" };

/** Lo que estos servicios usan de los de entrada. */
export interface ManagementCore {
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  /** Corre la guarda sobre una entrada que Auth aceptó y, si deja entrar, anota la sesión. */
  admit: (entered: AuthSignIn & { ok: true }, startedText: string, userAgent: string | null) => Promise<Admission>;
  /** Cuenta un intento de entrada en el freno, antes de preguntarle a Auth. */
  openAttempt: (keys: PairKeys) => Promise<OpenedAttempt>;
  /** Cierra ese intento con lo que pasó. */
  settleAttempt: (keys: PairKeys, opened: OpenedAttempt, outcome: SignInOutcome, knownOrigin: boolean) => Promise<void>;
}

const utf8 = new TextEncoder();

const nameRow = z.object({ display_name: z.string().nullable() });

export function createManagement(
  deps: Pick<AccountDependencies, "auth" | "proxyTrusted" | "report" | "isLocal">,
  core: ManagementCore,
) {
  const { auth } = deps;

  /** Una sesión que ya no debía seguir. Si no se pudo cerrar, alguien tiene que saberlo. */
  async function expectClosed(closing: Promise<"closed" | "unknown">): Promise<void> {
    if ((await closing) !== "closed") await deps.report("session_not_closed");
  }

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
      const asking = claims.sessionId;
      if (!isSessionId(asking)) throw new Error("Las claims que dio la guarda no traen una sesión.");
      const rows = await asServer({ claims, reason: "list_sessions" }, (tx) => listSessions(tx, asking));
      const sessions = rows.map((row) => ({
        id: row.id,
        openedAt: row.openedAt,
        lastActiveAt: row.lastActiveAt,
        device: describeUserAgent(row.userAgent),
        current: row.current,
      }));
      // La sesión con la que se pide se cerró desde otro lado entre la guarda y esta lectura.
      // No es una caída y no se reporta: no se pinta una lista sin ella, y lo siguiente que
      // la persona pida pasa otra vez por la guarda, que la manda a entrar.
      if (!sessions.some((session) => session.current)) return { kind: "unavailable" };
      return { kind: "ready", sessions };
    } catch {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Algo que la base o Auth no hicieron, con una sesión que había pasado la guarda. Antes de
   * darlo por caída se le vuelve a preguntar a la guarda de sesión: si la sesión con la que
   * se pide dejó de valer a media operación (otro cierre iba delante, la cuenta cambió), no
   * es una falla, y se contesta lo que la guarda dice ahora. Si insiste en que pasa, o
   * tampoco supo, eso no explica el fallo: se reporta.
   */
  async function refusedNow(reader: CookieReader): Promise<Extract<SessionClosing, { kind: "session" | "unavailable" }>> {
    const now = await core.checkSession(reader);
    if (now.kind !== "pass" && now.kind !== "unavailable") return { kind: "session", check: now };
    await deps.report("account_unavailable");
    return { kind: "unavailable" };
  }

  /**
   * Cerrar una sesión de la cuenta que no es esta (FL-27, paso 4). La sesión con la que se
   * pide no se cierra por aquí: su cookie quedaría en el navegador apuntando a nada. Para
   * esa está «Salir». Cuál es la propia lo decide la base, que compara identificadores y no
   * textos: se escriba como se escriba, contesta `current`.
   *
   * No se vuelve a evaluar la cuenta en la transacción, como al cambiar el nombre: cerrar
   * solo quita acceso, y la base busca la sesión entre las de quien actúa. Lo que la base sí
   * vuelve a mirar, con su candado puesto, es que la sesión con la que se pide siga
   * reconocida: dos cierres a la vez van uno tras otro, y el segundo no cierra nada.
   */
  async function closeSession(reader: CookieReader, input: { sessionId: string }): Promise<SessionClosing> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };

    // Lo que no tiene forma de identificador no es una sesión de nadie, y no llega a la base.
    if (!isSessionId(input.sessionId)) return { kind: "not_found" };
    const sessionId = input.sessionId;
    const asking = check.claims.sessionId;

    let state = "failed";
    if (isSessionId(asking)) {
      try {
        state = await asServer({ claims: check.claims, reason: "close_session" }, (tx) => closeInBase(tx, sessionId, asking));
      } catch {
        state = "failed";
      }
    }
    if (state === "closed" || state === "not_found" || state === "current") return { kind: state };
    return refusedNow(reader);
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
    return refusedNow(reader);
  }

  /**
   * Si la cuenta tiene un segundo factor verificado (RF-106). Recibe las claims con las que
   * la guarda dejó pasar a su página. Va como servidor: lo contesta una función de la base
   * que solo él ejecuta, y que solo mira a quien actúa.
   */
  async function accountSecondFactor(claims: VerifiedClaims): Promise<AccountSecondFactor> {
    try {
      return { kind: "ready", verified: await asServer({ claims, reason: "account_second_factor" }, hasVerifiedFactor) };
    } catch {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Fecha el cambio de contraseña en la base y borra lo anotado de la cuenta. Devuelve la
   * hora de la base de después, que es desde cuándo puede empezar la entrada con la
   * contraseña nueva; o nulo si no se pudo.
   */
  async function datePasswordChange(claims: VerifiedClaims): Promise<string | null> {
    try {
      return await asServer({ claims, reason: "change_password" }, async (tx) => {
        if ((await notePasswordChange(tx)) !== "noted") throw new Error("El cambio de contraseña no se pudo fechar.");
        return (await dbClock(tx)).text;
      });
    } catch {
      return null;
    }
  }

  /** Borra la cookie de una sesión que ya no existe. Nunca lanza: de aquí solo queda irse. */
  async function dropCookie(jar: CookieJar): Promise<void> {
    try {
      await auth.signOut(jar);
    } catch {
      // El tarro no deja escribir: quien llamó no puede borrar cookies, y ya se reportó.
    }
  }

  /**
   * Cambiar la contraseña (FL-27, paso 3). El orden es la regla, y no se cambia sin leer el
   * TRD §9.2, fila «Cambio de contraseña desde la cuenta»:
   *
   * 1. La guarda, y lo que se puede revisar sin preguntarle a nadie.
   * 2. El freno de intentos, con el par de la cuenta y la dirección: comprobar la contraseña
   *    actual es un intento de entrada. Sin él, esta pantalla serviría para adivinarla.
   * 3. La contraseña actual se comprueba entrando con ella. Auth no la pide para fijar otra:
   *    con la sesión del navegador, a quien se llevara una cookie le bastaría eso.
   * 4. Esa entrada pasa por la guarda y se anota, como cualquier otra: si empezó antes del
   *    último cambio de contraseña (una recuperación reciente), no sigue.
   * 5. Auth guarda la nueva con la sesión de esa entrada: cierra las demás y manda CO-26.
   * 6. La base fecha el cambio y borra lo anotado: una entrada en vuelo con la contraseña
   *    de antes ya no se anota.
   * 7. Se cierra la sesión de la comprobación y se entra con la contraseña nueva: es la
   *    sesión que se queda en este navegador.
   *
   * Después del paso 5 ya no hay vuelta: si algo falla, la cuenta se queda sin sesiones y
   * la persona entra de nuevo. Nunca queda una sesión abierta con la contraseña de antes.
   *
   * Una cuenta con segundo factor no pasa de la guarda: Auth le exige una sesión de segundo
   * nivel para cambiar la contraseña, y la de la comprobación es de primer nivel. Esa cuenta
   * la cambia recuperándola desde su correo (decisión del 2026-10-12).
   */
  async function changePassword(
    jar: CookieJar,
    input: { current: string; next: string },
    origin: RequestOrigin,
  ): Promise<PasswordChange> {
    const check = await core.checkSession(jar);
    if (check.kind !== "pass") return { kind: "session", check };

    // Antes de mirar lo escrito: la respuesta no depende de eso, y no se cuenta un intento.
    const factor = await accountSecondFactor(check.claims);
    if (factor.kind === "unavailable") return { kind: "unavailable" };
    if (factor.verified) return { kind: "second_factor" };

    const problems = checkPasswordChange(input.current, input.next);
    if (problems !== null) return { kind: "invalid", fields: problems };
    // Más larga de lo que la Plataforma deja fijar: no es la contraseña de nadie, y no hace
    // falta mandársela a Auth para saberlo.
    if (utf8.encode(input.current).length > PASSWORD_MAX_BYTES) return { kind: "invalid", fields: { current: "mismatch" } };

    // El correo con el que se entra es el de la sesión que pasó la guarda. No llega de fuera.
    const read = await auth.readSession(jar);
    const email = read.kind === "session" ? parseEmail(read.email ?? "") : null;
    if (email === null || !email.ok) {
      await deps.report("account_unavailable");
      return { kind: "unavailable" };
    }

    // Que la dirección no se conozca fuera de local ya lo reporta cada entrada (`signIn`): aquí
    // no se repite. Desconocida, va al cubo compartido y el par no queda de confianza.
    const from = resolveOrigin(origin, deps.proxyTrusted());
    const keys: PairKeys = { account: fingerprint("account", email.email), ip: from.ip };
    let opened: OpenedAttempt;
    try {
      opened = await core.openAttempt(keys);
    } catch {
      await deps.report("throttle_unavailable");
      return { kind: "unavailable" };
    }
    if (!opened.decision.proceed) {
      const refusal = refusalOf(opened.decision);
      if (refusal.report) await deps.report(refusal.report);
      if (refusal.result.kind === "throttled") return { kind: "throttled", retryAt: refusal.result.retryAt };
      return refusal.result.kind === "capped" ? { kind: "capped" } : { kind: "unavailable" };
    }

    const proof = await auth.provePassword(email.email, input.current);
    let admission: Admission;
    if (!proof.ok) admission = authRefusal(proof.reason);
    // La entrada tiene que ser de la cuenta de la sesión que pide: con otra, no acertó.
    else if (proof.claims.userId !== check.claims.userId) admission = authRefusal("invalid_credentials");
    else admission = await core.admit(proof, opened.startedText, from.userAgent);
    if (admission.report) await deps.report(admission.report);
    try {
      await core.settleAttempt(keys, opened, admission.outcome, from.known);
    } catch {
      await deps.report("sign_in_settle_failed");
    }

    // Entrar con algo pendiente no alcanza: la guarda pidió una cuenta a la que no le falta nada.
    const whole = admission.result.kind === "entered" && admission.result.pending === null;
    if (!proof.ok || !admission.admit || !whole) {
      if (proof.ok) await expectClosed(auth.discardProof(proof.proven));
      if (admission.result.kind === "invalid_credentials") return { kind: "invalid", fields: { current: "mismatch" } };
      if (admission.result.kind === "unavailable") return { kind: "unavailable" };
      // La contraseña era la suya, pero la cuenta dejó de pasar a media operación (se
      // suspendió, se le prendió la marca, cambió un texto): se contesta lo que la guarda
      // dice ahora.
      return refusedNow(jar);
    }

    const saved = await auth.changeProvenPassword(proof.proven, input.next);
    if (saved === "same_password" || saved === "weak_password") {
      await expectClosed(auth.discardProof(proof.proven));
      return { kind: "invalid", fields: { next: saved === "same_password" ? "same" : "weak" } };
    }
    if (saved === "rejected") {
      // Auth dijo que no, y no cambió nada. Puede ser que la sesión de la comprobación ya no
      // exista: desde otro navegador cerraron las demás, o recuperaron la contraseña. Entonces
      // la de este navegador tampoco vale, y eso no es una caída: lo dice la guarda.
      await expectClosed(auth.discardProof(proof.proven));
      return refusedNow(jar);
    }

    // Desde aquí la contraseña cambió, o no se sabe. En los dos casos el cambio se fecha: si
    // sí cambió, es lo que impide que una entrada vieja quede reconocida.
    const startedText = await datePasswordChange(proof.claims);
    if (saved !== "ok" || startedText === null) {
      await deps.report(saved === "ok" ? "password_change_incomplete" : "password_change_unconfirmed");
      await expectClosed(auth.closeAllWithProof(proof.proven));
      await dropCookie(jar);
      return { kind: "signed_out", password: saved === "ok" ? "changed" : "unknown" };
    }
    await expectClosed(auth.discardProof(proof.proven));

    // La entrada con la contraseña nueva. Su cookie no llega al navegador hasta que la
    // guarda dejó entrar y la sesión quedó anotada.
    const staging = stagingJar();
    const entered = await auth.signIn(staging, email.email, input.next);
    const admitted = entered.ok ? await core.admit(entered, startedText, from.userAgent) : null;
    let failure = admitted?.report ?? null;
    if (admitted?.admit === true) {
      try {
        for (const write of staging.writes) jar.set(write.name, write.value, write.options);
        return { kind: "changed" };
      } catch {
        failure = "session_cookie_not_written";
      }
    }
    if (failure !== null) await deps.report(failure);
    if (entered.ok) await expectClosed(auth.signOut(staging));
    await dropCookie(jar);
    return { kind: "signed_out", password: "changed" };
  }

  /**
   * Si la persona dejó los subtítulos encendidos (RF-310; diseño, sección 5.4): el reproductor
   * de la lección arranca así. Recibe las claims con las que la guarda dejó pasar a la página,
   * y lee como esa persona. Si no se supo, se reporta y la página los deja apagados: es una
   * preferencia, y no vale una página caída.
   */
  async function captionsChoice(claims: VerifiedClaims): Promise<CaptionsChoice> {
    try {
      const on = await asUser(claims, (tx) => readCaptions(tx, claims.userId));
      if (on === null) throw new Error("Una sesión que pasó la guarda no tiene perfil.");
      return { kind: "ready", on };
    } catch {
      await deps.report("captions_choice_unavailable");
      return { kind: "unavailable" };
    }
  }

  /**
   * Recordar si deja los subtítulos encendidos, porque los encendió o los apagó en el
   * reproductor. Exige una sesión que pase la guarda, y escribe en la cuenta de esa sesión: lo
   * único que llega de fuera es encendidos o apagados. No vuelve a evaluar la cuenta dentro de
   * la transacción, como al cambiar el nombre: no da ni quita nada, y una cuenta que se
   * suspendió en ese instante solo deja anotada su elección.
   */
  async function rememberCaptions(reader: CookieReader, on: boolean): Promise<CaptionsChange> {
    const check = await core.checkSession(reader);
    if (check.kind !== "pass") return { kind: "session", check };
    try {
      await asServer({ claims: check.claims, reason: "remember_captions" }, async (tx) => {
        if (!(await saveCaptions(tx, check.claims.userId, on))) throw new Error("Una sesión que pasó la guarda no tiene perfil.");
      });
    } catch {
      await deps.report("captions_choice_unavailable");
      return { kind: "unavailable" };
    }
    return { kind: "saved", on };
  }

  return {
    accountProfile,
    changeName,
    captionsChoice,
    rememberCaptions,
    accountSessions,
    closeSession,
    closeOtherSessions,
    accountSecondFactor,
    changePassword,
  };
}
