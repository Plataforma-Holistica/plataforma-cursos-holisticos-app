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
import { HOUR_SECONDS, windowStart } from "@/domain/access/rate-window";
import { reportFailure, type FailureCode } from "@/services/error-reporting/server";

import {
  decideAdmission,
  sessionCheckOf,
  type Admission,
  type GateView,
  type NoteState,
  type SessionCheck,
  type SignInResult,
} from "./admission";
import { buckets, fingerprint } from "./fingerprint";
import { evaluateGate } from "./gate";
import { proxyIsTrusted, resolveOrigin, type RequestOrigin } from "./origin";
import {
  countHit,
  dbClock,
  isSessionId,
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
import { atLeast, SIGN_IN_FLOOR_MS, type Timing } from "./timing";

// Los servicios de cuenta (RF-102; TRD §9.2 y §9.9): la guarda de sesión aplicada, entrar y
// salir. Reciben de quien tiene la petición un tarro de cookies y de dónde viene.
//
// Este archivo llega a la base. `session.ts`, que es lo que importa el paso previo, no lo
// importa: quien renueva la sesión antes de cada petición no debe poder abrir una
// transacción.

export type { PendingAccount, SessionCheck, SignInResult } from "./admission";
export type { RequestOrigin } from "./origin";
export type { CookieJar, CookieOptions, CookieReader };

/** Lo que estos servicios usan del adaptador de Auth. */
export type AuthPort = Pick<typeof adapter, "signIn" | "signOut" | "readSession">;

export interface AccountDependencies {
  auth: AuthPort;
  /** Hay delante un alojamiento que pone la cabecera de la dirección y pisa la de quien pide. */
  proxyTrusted: () => boolean;
  /** Un borrador (versión 0) vale como texto legal vigente. Solo en local. */
  draftsAllowed: () => boolean;
  /** El reloj y la espera del piso de tiempo de respuesta. */
  timing: Timing | undefined;
  report: (code: FailureCode) => Promise<void>;
}

interface OpenedAttempt {
  decision: SignInDecision;
  /** La hora de la base en que empezó el intento, antes de preguntarle a Auth. */
  startedText: string;
  /** La ventana en la que se sumó, para descontar en la misma. */
  window: Date | null;
}

/** Un tarro que solo recuerda lo que se le escribe: la cookie no llega al navegador. */
function stagingJar(): CookieJar & { writes: { name: string; value: string; options: CookieOptions }[] } {
  const values = new Map<string, string>();
  const writes: { name: string; value: string; options: CookieOptions }[] = [];
  return {
    writes,
    get: (name) => values.get(name),
    set(name, value, options) {
      writes.push({ name, value, options });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

export function createAccountServices(overrides: Partial<AccountDependencies> = {}) {
  const deps: AccountDependencies = {
    auth: adapter,
    proxyTrusted: proxyIsTrusted,
    draftsAllowed: () => getEnv().APP_ENV === "local",
    timing: undefined,
    report: reportFailure,
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
        return { recognition, view: await evaluateGate(tx, claims.userId, deps.draftsAllowed()) };
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
    if (!window.ok) {
      return { decision: { proceed: false, reason: "invalid_input" }, startedText: clock.text, window: null };
    }
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
      if (settlement.uncount && window) {
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
        const view = await evaluateGate(tx, verified.userId, deps.draftsAllowed());
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

    const from = resolveOrigin(origin, deps.proxyTrusted());
    if (!from.known && getEnv().APP_ENV !== "local") await deps.report("client_ip_unknown");
    const keys: PairKeys = { account: fingerprint("account", parsed.email), ip: from.ip };

    let opened: OpenedAttempt;
    try {
      opened = await asSystem({ reason: "sign_in_attempt" }, (tx) => openAttempt(tx, keys));
    } catch {
      await deps.report("throttle_unavailable");
      return { kind: "unavailable" };
    }
    if (!opened.decision.proceed) {
      switch (opened.decision.reason) {
        case "throttled":
          return { kind: "throttled", retryAt: opened.decision.retryAt };
        case "ip_hourly_cap":
        case "account_hourly_cap":
          return { kind: "capped" };
        case "invalid_input":
          await deps.report("throttle_unavailable");
          return { kind: "unavailable" };
      }
    }

    // La cookie se escribe aquí, no en el tarro de verdad: no llega al navegador hasta que
    // la guarda dejó entrar y la sesión quedó anotada.
    const staging = stagingJar();
    const entered = await auth.signIn(staging, parsed.email, input.password);

    let admission: Admission;
    if (entered.ok) {
      admission = await admit(entered, opened.startedText);
      if (!admission.admit) await auth.signOut(staging);
    } else {
      switch (entered.reason) {
        // Auth distingue los tres. Mostrarlos delataría el estado de la cuenta.
        case "invalid_credentials":
        case "email_not_confirmed":
        case "banned":
          admission = { result: { kind: "invalid_credentials" }, outcome: "failure", admit: false, report: null };
          break;
        // La contraseña era correcta, pero la sesión no cabe en la cookie. Recuperar borra
        // lo que la infla.
        case "oversized_session":
          admission = { result: { kind: "must_recover" }, outcome: "unknown", admit: false, report: "session_oversized" };
          break;
        default:
          admission = { result: { kind: "unavailable" }, outcome: "unknown", admit: false, report: null };
      }
    }
    if (admission.report) await deps.report(admission.report);

    if (admission.admit) {
      // La sesión que el navegador traía se cierra hasta ahora: una contraseña mal tecleada
      // no deja a nadie sin la sesión que tenía. Se cierra leyendo el tarro de verdad, sin
      // escribirle: lo que sigue le pone la cookie nueva encima.
      await auth.signOut({ get: (name) => jar.get(name), set: () => undefined });
      for (const write of staging.writes) jar.set(write.name, write.value, write.options);
    }

    try {
      await settleAttempt(keys, opened, admission.outcome, from.known);
    } catch {
      // El intento quedó contado como fallo. Quien ya entró, entra igual.
      await deps.report("sign_in_settle_failed");
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

  return { checkSession, signIn, signOut };
}

const services = createAccountServices();

export const { checkSession, signIn, signOut } = services;
