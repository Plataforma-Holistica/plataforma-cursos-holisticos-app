import "server-only";

import * as adapter from "@/adapters/supabase/auth";
import type { CookieJar, CookieOptions, CookieReader } from "@/adapters/supabase/auth-cookies";
import { asServer, asSystem, type Tx } from "@/adapters/supabase/db";
import { getEnv } from "@/config/env";
import { parseEmail } from "@/domain/access/email";
import {
  decideSignInAttempt,
  settleSignIn,
  type SignInDecision,
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
  type SessionCheck,
  type SignInResult,
} from "./admission";
import { stagingJar, type AccountDependencies } from "./deps";
import { buckets, fingerprint } from "./fingerprint";
import { evaluateGate } from "./gate";
import { createOnboarding } from "./onboarding";
import { proxyIsTrusted, resolveOrigin, type RequestOrigin } from "./origin";
import {
  countHit,
  dbClock,
  loadThrottleParams,
  lockAll,
  noteSession,
  readHits,
  readPair,
  sessionRecognition,
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
  AccountCompletion,
  AccountFormFacts,
  LegalText,
  MailRequestResult,
  RecoveryCompletion,
  RegistrationCompletion,
} from "./onboarding";
export type { RequestOrigin } from "./origin";
export type { CookieJar, CookieOptions, CookieReader };

interface OpenedAttempt {
  decision: SignInDecision;
  /** La hora de la base en que empezó el intento, antes de preguntarle a Auth. */
  startedText: string;
  /** La ventana en la que se sumó, para descontar en la misma. */
  window: Date;
}

const utf8 = new TextEncoder();

export function createAccountServices(overrides: Partial<AccountDependencies> = {}) {
  const deps: AccountDependencies = {
    auth: adapter,
    proxyTrusted: proxyIsTrusted,
    isLocal: () => getEnv().APP_ENV === "local",
    timing: undefined,
    report: reportFailure,
    defer: (work) => work(),
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

  /** Una entrada que Auth aceptó: corre la guarda y, si deja entrar, anota la sesión. */
  async function admit(claims: adapter.SignInResult & { ok: true }, startedText: string): Promise<Admission> {
    const verified = claims.claims;
    try {
      const seen = await asServer({ claims: verified, reason: "sign_in" }, async (tx) => {
        const view = await evaluateGate(tx, verified.userId, deps.isLocal());
        if (view.kind !== "pass" && view.kind !== "incomplete") return { view, noted: null };
        if (!isSessionId(verified.sessionId)) return { view, noted: null };
        return { view, noted: (await noteSession(tx, verified.sessionId, startedText)) as NoteState };
      });
      return decideAdmission(seen.view, seen.noted);
    } catch {
      return { result: { kind: "unavailable" }, outcome: "unknown", admit: false, report: "gate_unavailable" };
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

    let admission = entered.ok ? await admit(entered, opened.startedText) : authRefusal(entered.reason);

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
    return admission.result;
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
   * «Salir»: borra la cookie y cierra en Auth solo esta sesión. Lo anotado no hace falta
   * borrarlo: sin sesión en Auth deja de reconocerse.
   */
  function signOut(jar: CookieJar): Promise<adapter.Closing> {
    return auth.signOut(jar);
  }

  return { checkSession, signIn, signOut, ...createOnboarding(deps, { checkSession, admit }) };
}

const services = createAccountServices();

export const {
  checkSession,
  signIn,
  signOut,
  requestRegistration,
  requestRecovery,
  accountFormFacts,
  completeRegistration,
  completeRecovery,
  completeAccount,
} = services;
