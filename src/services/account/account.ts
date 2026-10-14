import "server-only";

import * as adapter from "@/adapters/supabase/auth";
import type { CookieJar, CookieOptions, CookieReader } from "@/adapters/supabase/auth-cookies";
import { asServer, asSystem, type Tx } from "@/adapters/supabase/db";
import { getEnv } from "@/config/env";
import { parseEmail } from "@/domain/access/email";
import {
  decideSignInAttempt,
  settleSignIn,
  type SignInOutcome,
} from "@/domain/access/login-throttle";
import { PASSWORD_MAX_BYTES } from "@/domain/access/password-policy";
import { HOUR_SECONDS, windowStart } from "@/domain/access/rate-window";
import { reportFailure } from "@/services/error-reporting/server";

import {
  authRefusal,
  decideAdmission,
  isSessionId,
  refusalOf,
  sessionCheckOf,
  type Admission,
  type GateView,
  type NoteState,
  type OpenedAttempt,
  type SessionCheck,
  type SignInResult,
} from "./admission";
import { stagingJar, type AccountDependencies } from "./deps";
import { dropEnrolledFactor } from "./enrolled-factor";
import { buckets, fingerprint } from "./fingerprint";
import { evaluateGate } from "./gate";
import { dropTicket, MAILBOX_TICKET_MAX_AGE_LIMIT } from "./mailbox-ticket";
import { createManagement } from "./management";
import { createOnboarding } from "./onboarding";
import { proxyIsTrusted, resolveOrigin, type RequestOrigin } from "./origin";
import { mailboxProofSeconds } from "./records";
import { createTeam } from "./team";
import { createTeamAdmin } from "./team-admin";
import { databaseTeamStore } from "./team-store";
import {
  countHit,
  dbClock,
  loadThrottleParams,
  lockAll,
  noteSession,
  readHits,
  readPair,
  sessionRecognition,
  tagSession,
  uncountHit,
  writePair,
  type PairKeys,
} from "./store";
import { atLeast, SIGN_IN_FLOOR_MS } from "./timing";

// Los servicios de cuenta (RF-101, RF-102, RF-103; TRD §9.2 y §9.9). Aquí están la guarda
// de sesión aplicada, entrar y salir; registrarse, recuperar la contraseña y completar una
// cuenta viven en `onboarding.ts` y se arman aquí. Reciben de quien tiene la petición un
// tarro de cookies y de dónde viene.
//
// Este archivo llega a la base. `session.ts`, que es lo que importa el paso previo, no lo
// importa: quien renueva la sesión antes de cada petición no debe poder abrir una
// transacción.

export type { PendingAccount, SessionCheck, SignInResult } from "./admission";
export type { AccountDependencies, AuthPort } from "./deps";
export type { AccountForm, FieldErrors, RegistrationForm } from "./forms";
export type {
  AccountProfile,
  AccountSecondFactor,
  AccountSessions,
  NameChange,
  OpenSession,
  OthersClosing,
  PasswordChange,
  PasswordChangeErrors,
  SessionClosing,
} from "./management";
export type {
  AccountCompletion,
  AccountFormFacts,
  LegalText,
  MailRequestResult,
  RecoveryCompletion,
  RegistrationCompletion,
} from "./onboarding";
export type { RequestOrigin } from "./origin";
export type { CodeGiven, FactorConfirmation, FactorStart, TeamCheck, TeamStanding, TeamState } from "./team";
export type {
  CapabilityGranted,
  CapabilityRevoked,
  FactorReset,
  FreshCode,
  InvitationRevoked,
  InviteResult,
  ReinviteResult,
  RemovalEffect,
  ResetEffect,
  RosterRead,
  TeamInvitation,
  TeamMember,
  TeamRoster,
} from "./team-admin";
// Qué más pasa al quitar una capacidad o al restablecer a alguien: la pantalla lo dice al
// confirmar, y el servicio comprueba que siga siendo cierto.
export { effectsKey, removalEffects, resetEffects } from "./team-admin";
export type { CookieJar, CookieOptions, CookieReader };
export type { VerifiedClaims } from "@/adapters/supabase/claims";
// De qué navegador y sistema dice ser una sesión: la pantalla de la cuenta lo pone en palabras.
export type { Browser, Device, System } from "@/domain/access/user-agent";
// La forma de un enlace de correo: una página la revisa antes de pintar su formulario.
export { isLinkToken } from "@/adapters/supabase/tokens";

const utf8 = new TextEncoder();

/**
 * Se lleva de ese navegador el resguardo del buzón y el factor a medias. Lo llama quien
 * saca a la persona de ese navegador porque ella lo pidió: «Salir», y cerrar la sesión
 * propia desde la cuenta. El resguardo es lo que distingue a quien abrió el correo de quien
 * solo sabe la contraseña: si se quedara, en un equipo compartido le serviría al siguiente.
 *
 * No va dentro de `signOut`: completar una recuperación deja el resguardo y, en la misma
 * respuesta, cierra por ahí la sesión que ese navegador tuviera.
 */
export function forgetBrowserProofs(jar: CookieJar): void {
  dropTicket(jar);
  dropEnrolledFactor(jar);
}

export function createAccountServices(overrides: Partial<AccountDependencies> = {}) {
  const deps: AccountDependencies = {
    auth: adapter,
    proxyTrusted: proxyIsTrusted,
    isLocal: () => getEnv().APP_ENV === "local",
    timing: undefined,
    report: reportFailure,
    defer: (work) => work(),
    ticketLifetime: () => asSystem({ reason: "mailbox_proof" }, (tx) => mailboxProofSeconds(tx, MAILBOX_TICKET_MAX_AGE_LIMIT)),
    teamStore: databaseTeamStore,
    ...overrides,
  };
  const { auth } = deps;

  /**
   * La guarda de sesión, para una página o una acción. Además de lo que decide el dominio
   * (cuenta activa, marca apagada, textos, edad y nombre), comprueba en la base que la
   * sesión sea de las que abrió la aplicación y que siga viva en Auth: una sesión cerrada
   * en otro lado, o abierta directo en Auth, no pasa aunque su token verifique.
   *
   * No renueva: quien puede escribir cookies llama antes a `refreshSession`.
   */
  async function checkSession(reader: CookieReader): Promise<SessionCheck> {
    const read = await auth.readSession(reader);
    if (read.kind === "none") return { kind: "anonymous" };
    // Vencida o ilegible: no se sabe. No es «sin sesión».
    if (read.kind !== "session") return { kind: "unavailable" };
    const { claims } = read;
    if (!isSessionId(claims.sessionId)) return { kind: "must_sign_out", then: "sign_in" };
    const sessionId = claims.sessionId;

    let seen: { recognition: string; view: GateView | null };
    try {
      seen = await asServer({ claims, reason: "session_gate" }, async (tx) => {
        const recognition = await sessionRecognition(tx, sessionId);
        if (recognition !== "recognized") return { recognition, view: null };
        return { recognition, view: await evaluateGate(tx, claims.userId, deps.isLocal()) };
      });
    } catch {
      await deps.report("gate_unavailable");
      return { kind: "unavailable" };
    }
    const { check, report } = sessionCheckOf(seen.recognition, seen.view, claims);
    if (report) await deps.report(report);
    return check;
  }

  // `standingAtEntry` es de aquí dentro: lo usan los tres servicios que dejan a alguien
  // dentro, con claims recién verificadas. No sale con los servicios armados.
  const { standingAtEntry, ...team } = createTeam(deps, { checkSession, store: deps.teamStore });
  const teamAdmin = createTeamAdmin(deps, {
    teamStanding: team.teamStanding,
    giveSecondFactorCode: team.giveSecondFactorCode,
    store: deps.teamStore,
  });

  /** La primera transacción de una entrada: cuenta el intento antes de preguntarle a Auth. */
  async function openAttempt(tx: Tx, keys: PairKeys): Promise<OpenedAttempt> {
    await lockAll(tx, [keys.ip, keys.account]);
    const clock = await dbClock(tx);
    const params = await loadThrottleParams(tx);
    const window = windowStart(clock.date, HOUR_SECONDS);
    // Sin ventana no hay dónde contar: no pasa nadie.
    if (!window.ok) throw new Error("La hora de la base no cae en ninguna ventana.");
    const ipBucket = buckets.signInIp(keys.ip);
    const accountBucket = buckets.signInAccount(keys.account);
    const decision = decideSignInAttempt(
      {
        pair: await readPair(tx, keys),
        ipHitsThisHour: await readHits(tx, ipBucket, window.start),
        accountHitsThisHour: await readHits(tx, accountBucket, window.start),
      },
      clock.date,
      params,
    );
    if (decision.proceed) {
      await writePair(tx, keys, decision.pair);
      await countHit(tx, ipBucket, window.start);
      await countHit(tx, accountBucket, window.start);
    }
    return { decision, startedText: clock.text, window: window.start };
  }

  /** La segunda: cierra el intento con lo que pasó. Nunca con un estado leído antes. */
  async function settleAttempt(
    keys: PairKeys,
    opened: OpenedAttempt,
    outcome: SignInOutcome,
    knownOrigin: boolean,
  ): Promise<void> {
    const window = opened.window;
    await asSystem({ reason: "sign_in_settle" }, async (tx) => {
      await lockAll(tx, [keys.ip, keys.account]);
      const clock = await dbClock(tx);
      const settlement = settleSignIn(outcome, clock.date);
      if (settlement.pair) {
        // Una dirección que no se conoce es un cubo compartido: nadie queda de confianza ahí.
        await writePair(tx, keys, knownOrigin ? settlement.pair : { ...settlement.pair, lastSuccessAt: null });
      }
      if (settlement.uncount) {
        await uncountHit(tx, buckets.signInIp(keys.ip), window);
        await uncountHit(tx, buckets.signInAccount(keys.account), window);
      }
    });
  }

  /**
   * Una entrada que Auth aceptó: corre la guarda y, si deja entrar, anota la sesión, con el
   * navegador desde el que se abrió para que su dueña la reconozca después en su lista.
   */
  async function admit(
    claims: adapter.SignInResult & { ok: true },
    startedText: string,
    userAgent: string | null,
  ): Promise<Admission> {
    const verified = claims.claims;
    try {
      const seen = await asServer({ claims: verified, reason: "sign_in" }, async (tx) => {
        const view = await evaluateGate(tx, verified.userId, deps.isLocal());
        if (view.kind !== "pass" && view.kind !== "incomplete") return { view, noted: null };
        if (!isSessionId(verified.sessionId)) return { view, noted: null };
        return { view, noted: (await noteSession(tx, verified.sessionId, startedText)) as NoteState };
      });
      if (seen.noted === "noted") await labelSession(verified, userAgent);
      return decideAdmission(seen.view, seen.noted);
    } catch {
      return { result: { kind: "unavailable" }, outcome: "unknown", admit: false, report: "gate_unavailable" };
    }
  }

  /**
   * Deja dicho desde qué navegador se abrió una sesión recién anotada. Va en su propia
   * transacción y nunca lanza: la etiqueta no decide nada, y que falle no puede impedir que
   * alguien entre. Si falla, la sesión se lista como de un navegador desconocido, y se reporta.
   */
  async function labelSession(verified: (adapter.SignInResult & { ok: true })["claims"], userAgent: string | null): Promise<void> {
    const sessionId = verified.sessionId;
    if (!isSessionId(sessionId)) return;
    try {
      await asServer({ claims: verified, reason: "tag_session" }, (tx) => tagSession(tx, sessionId, userAgent));
    } catch {
      await deps.report("session_not_tagged");
    }
  }

  async function attemptSignIn(
    jar: CookieJar,
    input: { email: string; password: string },
    origin: RequestOrigin,
  ): Promise<SignInResult> {
    const parsed = parseEmail(input.email);
    // Un correo sin forma no tiene cuenta ni huella: para quien pide, es no acertar.
    if (!parsed.ok) return { kind: "invalid_credentials" };
    // Más larga de lo que la Plataforma deja fijar: no es la contraseña de nadie, y no hace
    // falta mandársela a Auth para saberlo.
    if (utf8.encode(input.password).length > PASSWORD_MAX_BYTES) return { kind: "invalid_credentials" };

    const from = resolveOrigin(origin, deps.proxyTrusted());
    if (!from.known && !deps.isLocal()) await deps.report("client_ip_unknown");
    const keys: PairKeys = { account: fingerprint("account", parsed.email), ip: from.ip };

    let opened: OpenedAttempt;
    try {
      opened = await asSystem({ reason: "sign_in_attempt" }, (tx) => openAttempt(tx, keys));
    } catch {
      await deps.report("throttle_unavailable");
      return { kind: "unavailable" };
    }
    if (!opened.decision.proceed) {
      const refusal = refusalOf(opened.decision);
      if (refusal.report) await deps.report(refusal.report);
      return refusal.result;
    }

    // La cookie se escribe aquí, no en el tarro de verdad: no llega al navegador hasta que
    // la guarda dejó entrar y la sesión quedó anotada.
    const staging = stagingJar();
    const entered = await auth.signIn(staging, parsed.email, input.password);

    let admission = entered.ok ? await admit(entered, opened.startedText, from.userAgent) : authRefusal(entered.reason);

    // Lo que el navegador traía antes de esta entrada, guardado aparte: la cookie nueva se
    // escribe encima con el mismo nombre.
    const before = new Map(staging.writes.map((write) => [write.name, jar.get(write.name)]));
    if (admission.admit) {
      try {
        for (const write of staging.writes) jar.set(write.name, write.value, write.options);
      } catch {
        // El tarro no dejó escribir: alguien llamó desde donde no se pueden escribir
        // cookies. Sin cookie no hay entrada.
        admission = { result: { kind: "unavailable" }, outcome: "unknown", admit: false, report: "session_cookie_not_written" };
      }
    }
    if (admission.report) await deps.report(admission.report);

    // Auth abrió una sesión que no se queda: se cierra. Nadie tiene sus tokens, pero si no
    // se pudo cerrar, alguien tiene que saberlo.
    if (entered.ok && !admission.admit && (await auth.signOut(staging)) !== "closed") {
      await deps.report("session_not_closed");
    }

    try {
      await settleAttempt(keys, opened, admission.outcome, from.known);
    } catch {
      // El intento quedó contado como fallo. Quien ya entró, entra igual.
      await deps.report("sign_in_settle_failed");
    }

    if (admission.admit) {
      // La sesión que el navegador traía se cierra hasta el final, cuando la nueva ya entró,
      // su cookie ya está en el tarro y el intento ya se cerró en el freno: una contraseña
      // mal tecleada no deja a nadie sin la sesión que tenía, y un Auth que falla al cerrar
      // no deja la entrada a medias.
      const previous = { get: (name: string) => (before.has(name) ? before.get(name) : jar.get(name)), set: () => undefined };
      if ((await auth.signOut(previous)) !== "closed") await deps.report("session_not_closed");
    }
    // Quedó dentro y sin pendientes: se lee su estado en el equipo, para llevarla a la
    // pantalla que le toca. A quien le falta algo de su cuenta se le pide eso primero.
    const { result } = admission;
    if (admission.admit && entered.ok && result.kind === "entered" && result.pending === null) {
      return { ...result, team: await standingAtEntry(entered.claims, jar) };
    }
    return result;
  }

  /**
   * Entrar con correo y contraseña (FL-05). El intento se cuenta antes de preguntarle a
   * Auth, como si fuera a fallar, y se cierra después con lo que pasó. Frenado o topado, ni
   * se le pregunta. La respuesta nunca sale antes del piso de tiempo.
   */
  function signIn(
    jar: CookieJar,
    input: { email: string; password: string },
    origin: RequestOrigin,
  ): Promise<SignInResult> {
    return atLeast(SIGN_IN_FLOOR_MS, () => attemptSignIn(jar, input, origin), deps.timing);
  }

  /**
   * El correo de la sesión de esta petición, para mostrárselo a su dueña. Nulo si no hay
   * sesión que verifique. No autoriza nada: quien lo pinta ya pasó por `checkSession`.
   */
  async function sessionEmail(reader: CookieReader): Promise<string | null> {
    const read = await auth.readSession(reader);
    return read.kind === "session" ? read.email : null;
  }

  /**
   * «Salir»: borra la cookie y cierra en Auth solo esta sesión. Lo anotado no hace falta
   * borrarlo: sin sesión en Auth deja de reconocerse.
   */
  async function signOut(jar: CookieJar): Promise<adapter.Closing> {
    const closing = await auth.signOut(jar);
    // La cookie ya se borró, pero en Auth la sesión sigue: quien tenga una copia la conserva.
    if (closing !== "closed") await deps.report("session_not_closed");
    return closing;
  }

  /**
   * Cierra la sesión de esta petición solo si la guarda la rechaza, y dice qué pasó. Es lo
   * que hay detrás de la ruta a la que una página manda cuando la guarda contesta «esta
   * sesión no vale»: una página no puede borrar una cookie.
   *
   * No le cree nada a quien llama. Con una sesión que sí vale, o cuando no se supo, no
   * cierra nada: así un enlace puesto en otro sitio no le cierra la sesión a nadie.
   *
   * @returns `recover` o `sign_in`: se cerró, y a dónde manda la guarda. `none`: no había
   *   sesión. `kept`: la sesión se quedó como estaba.
   */
  async function closeRejectedSession(jar: CookieJar): Promise<"recover" | "sign_in" | "none" | "kept"> {
    const check = await checkSession(jar);
    if (check.kind === "anonymous") return "none";
    if (check.kind !== "must_sign_out") return "kept";
    await signOut(jar);
    return check.then;
  }

  return {
    checkSession,
    closeRejectedSession,
    sessionEmail,
    signIn,
    signOut,
    ...createOnboarding(deps, { checkSession, admit, standingAtEntry }),
    ...createManagement(deps, {
      checkSession,
      admit,
      // Comprobar la contraseña actual es un intento de entrada como cualquier otro: pasa
      // por el mismo freno, con el mismo par, y se cuenta antes de preguntarle a Auth.
      openAttempt: (keys) => asSystem({ reason: "password_change_attempt" }, (tx) => openAttempt(tx, keys)),
      settleAttempt,
    }),
    ...team,
    ...teamAdmin,
  };
}

const services = createAccountServices();

// `requestRegistration` y `requestRecovery` no salen ya armados a propósito: sin un
// `defer` que mande la llamada a Auth detrás de la respuesta, el tiempo que tarda delata si
// el correo tiene cuenta. Quien tiene la petición arma los suyos con `createAccountServices`
// y le pasa lo que su plataforma dé para eso.
export const {
  checkSession,
  closeRejectedSession,
  sessionEmail,
  signIn,
  signOut,
  accountFormFacts,
  completeRegistration,
  completeRecovery,
  completeAccount,
  accountProfile,
  changeName,
  accountSessions,
  closeSession,
  closeOtherSessions,
  accountSecondFactor,
  changePassword,
  teamStanding,
  startSecondFactor,
  confirmSecondFactor,
  giveSecondFactorCode,
  teamRoster,
  inviteAdmin,
  reinviteAdmin,
  revokeInvitation,
  grantCapability,
  revokeCapability,
  resetSecondFactor,
  giveFreshCode,
} = services;
