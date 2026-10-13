import "server-only";

import type { SignInResult as AuthSignIn } from "@/adapters/supabase/auth";
import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asSystem } from "@/adapters/supabase/db";
import { parseEmail, type EmailResult } from "@/domain/access/email";
import { pairAfterRecovery } from "@/domain/access/login-throttle";
import { resolvePasswordOutcome } from "@/domain/access/password-outcome";
import { checkPassword, type PasswordCheck } from "@/domain/access/password-policy";
import { decideMailSend, decideRegistration, HOUR_SECONDS, windowStart } from "@/domain/access/rate-window";
import type { FailureCode } from "@/services/error-reporting/server";

import type { Admission, PendingAccount, SessionCheck } from "./admission";
import { stagingJar, type AccountDependencies } from "./deps";
import { buckets, fingerprint, type Fingerprint } from "./fingerprint";
import {
  accountClaimed,
  checkAccountForm,
  checkRegistrationForm,
  linkOpensRegistration,
  matchAccepted,
  type AccountForm,
  type CurrentText,
  type FieldErrors,
  type RegistrationForm,
} from "./forms";
import { evaluateGate, REQUIRED_DOC_TYPES } from "./gate";
import { issueTicket, keepTicket, type MailboxTicket } from "./mailbox-ticket";
import { resolveOrigin, type RequestOrigin } from "./origin";
import {
  claimAccount,
  currentTexts,
  grantConsents,
  loadFormParams,
  markRegistrationStarted,
  profileState,
  readableTexts,
  saveIdentity,
  type ReadableText,
} from "./records";
import {
  countHit,
  dbClock,
  loadMailParams,
  lockAll,
  noteSend,
  readHits,
  readLastSent,
  trustAfterRecovery,
  unnoteSend,
  type PairKeys,
} from "./store";
import { atLeast, MAIL_REQUEST_FLOOR_MS } from "./timing";

// Registrarse, recuperar la contraseña y completar una cuenta (RF-101, RF-103, RF-108,
// RF-109; TRD §9.2 y §9.9; flujo de la app FL-02, FL-03 y FL-06).
//
// Dos reglas que valen para todo el archivo. Una: lo que se le contesta a quien pide un
// correo no depende de si ese correo tiene cuenta, ni en el texto, ni en lo que se cuenta,
// ni en el tiempo. Dos: canjear el enlace de un correo lo gasta, así que todo lo que se
// pueda revisar se revisa antes, y después de canjear toda salida cierra la sesión del
// canje y le dice a la persona qué hacer con un enlace que ya no sirve.

export type MailRequestResult =
  /** Lo de siempre: «si ese correo puede recibirlo, ya va en camino». Se haya mandado o no. */
  | { kind: "accepted" }
  | { kind: "invalid_email"; reason: Extract<EmailResult, { ok: false }>["reason"] }
  /** El tope por dirección. Sí se dice: no delata nada de ningún correo. */
  | { kind: "wait" }
  /** No se supo. No depende del correo. */
  | { kind: "unavailable" };

/** Un texto vigente, con lo que una pantalla necesita para mostrarlo y dejarlo aceptar. */
export type LegalText = ReadableText;

export type AccountFormFacts =
  | {
      kind: "ready";
      /** Los textos vigentes que la persona tiene que aceptar, en su orden. */
      texts: LegalText[];
      /** `EDAD_MINIMA`. */
      minimumAge: number;
      /** `VIGENCIA_ENLACE_CONTRASENA`, en minutos. */
      linkLifetimeMinutes: number;
      /** `ESPERA_REENVIO`, en segundos. */
      resendWaitSeconds: number;
    }
  /** Falta el texto vigente de un tipo obligatorio: no hay qué aceptar, y nadie completa su cuenta. */
  | { kind: "no_current_text" }
  /** No se supo. */
  | { kind: "unavailable" };

export type RegistrationCompletion =
  /** La cuenta quedó completa y la persona, dentro. */
  | { kind: "entered"; pending: PendingAccount | null }
  /** La cuenta quedó lista, pero no se pudo abrir su sesión: que entre con su contraseña. */
  | { kind: "ready_sign_in" }
  | { kind: "invalid"; fields: FieldErrors }
  /** Lo que aceptó ya no es lo vigente: se le vuelve a mostrar. El enlace sigue sirviendo. */
  | { kind: "texts_changed" }
  /** Falta el texto vigente de un tipo obligatorio. El enlace sigue sirviendo. */
  | { kind: "texts_unavailable" }
  /** El enlace no sirve: caducó, ya se usó, o su cuenta ya está reclamada. */
  | { kind: "link_dead" }
  /** El enlace se gastó y el registro no terminó: la salida es recuperar la contraseña. */
  | { kind: "recover_instead" }
  /** No se supo, y el enlace sigue sirviendo. */
  | { kind: "unavailable" };

export type RecoveryCompletion =
  /** La contraseña quedó guardada. Sin sesión: la persona entra con ella. */
  | { kind: "done" }
  | { kind: "invalid"; reason: Extract<PasswordCheck, { ok: false }>["reason"] }
  | { kind: "link_dead" }
  /** El enlace se gastó y la recuperación no terminó: hay que pedir otro. */
  | { kind: "request_new_link" }
  /** No se supo, y el enlace sigue sirviendo. */
  | { kind: "unavailable" };

export type AccountCompletion =
  /** A la cuenta ya no le falta nada. */
  | { kind: "complete" }
  /** Se guardó lo que se mandó, y todavía falta algo (un texto cambió entre tanto). */
  | ({ kind: "incomplete" } & PendingAccount)
  | { kind: "invalid"; fields: FieldErrors }
  | { kind: "texts_changed" }
  /** La sesión no llega hasta aquí: se obedece lo que dijo la guarda. */
  | { kind: "session"; check: Exclude<SessionCheck, { kind: "pass" | "incomplete" }> }
  | { kind: "unavailable" };

/** Lo que estos servicios usan de los de entrada. */
export interface OnboardingCore {
  checkSession: (reader: CookieReader) => Promise<SessionCheck>;
  /**
   * Corre la guarda sobre una entrada que Auth aceptó y, si deja entrar, anota la sesión con
   * el navegador desde el que se abrió.
   */
  admit: (entered: AuthSignIn & { ok: true }, startedText: string, userAgent: string | null) => Promise<Admission>;
}

interface MailFlow {
  reason: string;
  ip: (print: Fingerprint) => string;
  hour: (print: Fingerprint) => string;
  last: (print: Fingerprint) => string;
  failed: FailureCode;
}

const MAIL_FLOWS = {
  registration: {
    reason: "registration_request",
    ip: buckets.signUpIp,
    hour: buckets.signUpMail,
    last: buckets.signUpMailLast,
    failed: "registration_mail_failed",
  },
  recovery: {
    reason: "recovery_request",
    ip: buckets.recoverIp,
    hour: buckets.recoverMail,
    last: buckets.recoverMailLast,
    failed: "recovery_mail_failed",
  },
} as const satisfies Record<string, MailFlow>;

type Counted =
  | { kind: "capped" }
  /** Pasó el tope de la dirección, pero a ese destino no se le manda otro correo ahora. */
  | { kind: "quiet" }
  | { kind: "send"; window: Date; sentText: string };

export function createOnboarding(deps: AccountDependencies, core: OnboardingCore) {
  const { auth } = deps;

  async function expectClosed(closing: Promise<"closed" | "unknown">): Promise<void> {
    if ((await closing) !== "closed") await deps.report("session_not_closed");
  }

  async function askForMail(
    flow: keyof typeof MAIL_FLOWS,
    input: { email: string },
    origin: RequestOrigin,
  ): Promise<MailRequestResult> {
    const spec = MAIL_FLOWS[flow];
    const parsed = parseEmail(input.email);
    if (!parsed.ok) return { kind: "invalid_email", reason: parsed.reason };
    const { email } = parsed;

    const from = resolveOrigin(origin, deps.proxyTrusted());
    if (!from.known && !deps.isLocal()) await deps.report("client_ip_unknown");
    // El cupo del registro va por buzón: las variantes con `+` llegan al mismo. El de la
    // recuperación va por correo exacto: esas variantes no tienen cuenta, Auth no les
    // manda nada, y no deben gastarle el cupo a la cuenta de verdad.
    const target = flow === "registration" ? fingerprint("mailbox", parsed.mailbox) : fingerprint("account", email);
    const cubes = { ip: spec.ip(from.ip), hour: spec.hour(target), last: spec.last(target) };

    let counted: Counted;
    try {
      counted = await asSystem({ reason: spec.reason }, async (tx): Promise<Counted> => {
        await lockAll(tx, [from.ip, target]);
        const clock = await dbClock(tx);
        const params = await loadMailParams(tx);
        const window = windowStart(clock.date, HOUR_SECONDS);
        if (!window.ok) throw new Error("La hora de la base no cae en ninguna ventana.");

        const allowed = decideRegistration(
          { ipHitsThisHour: await readHits(tx, cubes.ip, window.start) },
          { hourlyCap: params.ipHourlyCap },
        );
        if (!allowed.proceed) {
          if (allowed.reason === "invalid_input") throw new Error("Los topes de correo no se pueden evaluar.");
          return { kind: "capped" };
        }
        // Toda petición que pasa este tope cuenta, también la que el destino no deja mandar,
        // y nunca se descuenta: si dependiera de eso, delataría qué correos tienen cuenta.
        await countHit(tx, cubes.ip, window.start);

        const mail = decideMailSend(
          {
            mailboxHitsThisHour: await readHits(tx, cubes.hour, window.start),
            lastSentAt: await readLastSent(tx, cubes.last),
          },
          clock.date,
          { hourlyCap: params.mailHourlyCap, resendWaitSeconds: params.resendWaitSeconds },
        );
        if (!mail.send) {
          if (mail.reason === "invalid_input") throw new Error("Los topes de correo no se pueden evaluar.");
          return { kind: "quiet" };
        }
        await noteSend(tx, cubes, window.start, clock.text);
        return { kind: "send", window: window.start, sentText: clock.text };
      });
    } catch {
      await deps.report("mail_limits_unavailable");
      return { kind: "unavailable" };
    }
    if (counted.kind === "capped") return { kind: "wait" };

    if (counted.kind === "send") {
      const { window, sentText } = counted;
      // La respuesta no espera a Auth, que tarda distinto según exista la cuenta.
      await deps.defer(async () => {
        const delivered =
          flow === "registration"
            ? // A quien ya tiene cuenta Auth no le manda nada, y eso no es una falla.
              ["accepted", "existing_account"].includes(await auth.requestSignUp(email))
            : // La espera de Auth por cuenta no cuenta como mandado: la gasta cualquiera que le
              // pida directo un correo para ese buzón, y el del servicio no salió.
              (await auth.requestPasswordRecovery(email)) === "accepted";
        if (delivered) return;
        // El correo no salió: se borra lo anotado, para que se pueda volver a pedir.
        try {
          await asSystem({ reason: `${spec.reason}_undo` }, async (tx) => {
            await lockAll(tx, [target]);
            await unnoteSend(tx, cubes, window, sentText);
          });
        } catch {
          // Queda anotado. Lo peor que pasa es que ese destino espere de más.
        }
        await deps.report(spec.failed);
      });
    }
    return { kind: "accepted" };
  }

  /**
   * Pedir el registro de un correo, o que se reenvíe su enlace, que es lo mismo (FL-02).
   * Pasado el tope por dirección contesta siempre `accepted`: para un correo nuevo, para
   * uno que no ha confirmado y para uno que ya tiene cuenta, se haya mandado algo o no.
   */
  function requestRegistration(input: { email: string }, origin: RequestOrigin): Promise<MailRequestResult> {
    return atLeast(MAIL_REQUEST_FLOOR_MS, () => askForMail("registration", input, origin), deps.timing);
  }

  /** Pedir el correo de recuperación (FL-06). Contesta igual exista o no la cuenta. */
  function requestRecovery(input: { email: string }, origin: RequestOrigin): Promise<MailRequestResult> {
    return atLeast(MAIL_REQUEST_FLOOR_MS, () => askForMail("recovery", input, origin), deps.timing);
  }

  /** Lo que las pantallas de registro y de «completa tu cuenta» necesitan leer. */
  async function accountFormFacts(): Promise<AccountFormFacts> {
    let facts: { texts: (ReadableText | null)[]; params: Awaited<ReturnType<typeof loadFormParams>> };
    try {
      facts = await asSystem({ reason: "account_form_facts" }, async (tx) => ({
        texts: await readableTexts(tx, deps.isLocal()),
        params: await loadFormParams(tx),
      }));
    } catch {
      await deps.report("gate_unavailable");
      return { kind: "unavailable" };
    }
    const texts: LegalText[] = [];
    for (const text of facts.texts) {
      if (text === null) {
        await deps.report("gate_no_current_text");
        return { kind: "no_current_text" };
      }
      texts.push(text);
    }
    return { kind: "ready", texts, ...facts.params };
  }

  /**
   * Deja el resguardo del buzón en el navegador, ya con la cuenta reclamada. Cuánto dura se
   * lee aparte, después de confirmado el reclamo: nada de lo que aquí falle deshace un
   * registro o una recuperación. Si no se supo cuánto dura, o la cookie no se pudo
   * escribir, la persona prueba su buzón otra vez cuando haga falta, y queda dicho.
   */
  async function keepProof(jar: CookieJar, ticket: MailboxTicket, claims: VerifiedClaims): Promise<void> {
    let seconds: number | null;
    try {
      seconds = await deps.ticketLifetime(claims);
    } catch {
      seconds = null;
    }
    if (seconds === null) {
      await deps.report("mailbox_proof_unavailable");
      return;
    }
    try {
      keepTicket(jar, ticket, seconds);
    } catch {
      await deps.report("mailbox_ticket_not_kept");
    }
  }

  /** La entrada con la que termina un registro: la cookie al tarro, o la sesión cerrada. */
  async function enter(
    jar: CookieJar,
    email: string,
    password: string,
    startedText: string,
    userAgent: string | null,
  ): Promise<RegistrationCompletion> {
    const staging = stagingJar();
    const entered = await auth.signIn(staging, email, password);
    if (!entered.ok) return { kind: "ready_sign_in" };

    const { result, report } = await core.admit(entered, startedText, userAgent);
    const before = new Map(staging.writes.map((write) => [write.name, jar.get(write.name)]));
    // La guarda dejó entrar y la sesión quedó anotada: su cookie pasa al tarro de verdad.
    let failure = report;
    if (result.kind === "entered" && !failure) {
      try {
        for (const write of staging.writes) jar.set(write.name, write.value, write.options);
      } catch {
        failure = "session_cookie_not_written";
      }
    }
    if (result.kind !== "entered" || failure) {
      if (failure) await deps.report(failure);
      await expectClosed(auth.signOut(staging));
      return { kind: "ready_sign_in" };
    }
    // La sesión que el navegador traía, de otra cuenta, se cierra al final.
    const previous = { get: (name: string) => (before.has(name) ? before.get(name) : jar.get(name)), set: () => undefined };
    await expectClosed(auth.signOut(previous));
    return result;
  }

  /**
   * Completar el registro desde el enlace del correo (FL-03): fija la contraseña, guarda
   * nombre, edad y consentimientos, reclama la cuenta y deja a la persona dentro.
   */
  async function completeRegistration(
    jar: CookieJar,
    form: RegistrationForm & { tokenHash: string },
    origin: RequestOrigin,
  ): Promise<RegistrationCompletion> {
    const checked = checkRegistrationForm(form);
    if (!checked.ok) return { kind: "invalid", fields: checked.fields };
    const from = resolveOrigin(origin, deps.proxyTrusted());

    let texts: CurrentText[];
    try {
      texts = await asSystem({ reason: "registration_texts" }, (tx) => currentTexts(tx, deps.isLocal()));
    } catch {
      await deps.report("gate_unavailable");
      return { kind: "unavailable" };
    }
    const match = matchAccepted(texts, REQUIRED_DOC_TYPES, form.accepted);
    if (match.kind === "unavailable") {
      await deps.report("gate_no_current_text");
      return { kind: "texts_unavailable" };
    }
    if (match.kind === "stale") return { kind: "texts_changed" };
    if (match.kind === "missing") return { kind: "invalid", fields: { texts: "required" } };

    const redemption = await auth.redeemSignupLink(form.tokenHash);
    if (!redemption.ok) {
      if (redemption.reason !== "spent") return { kind: redemption.reason === "invalid_or_expired" ? "link_dead" : "unavailable" };
      // Auth canjeó el enlace y su sesión no se pudo usar: el adaptador ya pidió cerrarla.
      await deps.report("registration_incomplete");
      return { kind: "recover_instead" };
    }
    const { redeemed } = redemption;
    const profileId = redeemed.claims.userId;

    // Desde aquí el enlace ya se gastó: reintentar con él no sirve.
    const failed = async (): Promise<RegistrationCompletion> => {
      await expectClosed(auth.closeAllSessions(redeemed));
      await deps.report("registration_incomplete");
      return { kind: "recover_instead" };
    };

    let goesOn: boolean;
    try {
      goesOn = await asServer({ claims: redeemed.claims, reason: "registration_state" }, async (tx) => {
        if (!linkOpensRegistration(await profileState(tx, profileId))) return false;
        // Auth deja pasar dos canjes simultáneos del mismo enlace: solo el primero sigue.
        return markRegistrationStarted(tx, buckets.signUpRedeemed(profileId));
      });
    } catch {
      return failed();
    }
    // La cuenta ya está reclamada, no puede entrar, o este enlace ya lo está usando otro
    // envío: aquí no cambia nada. Se cierra solo la sesión de este canje, sin tocar las demás.
    if (!goesOn) {
      await expectClosed(auth.discardRedemption(redeemed));
      return { kind: "link_dead" };
    }

    const outcome = resolvePasswordOutcome("complete_registration", await auth.setFirstPassword(redeemed, checked.password));
    if (outcome.next !== "done") return failed();
    if (outcome.closeSessions) await expectClosed(auth.closeAllSessions(redeemed));

    // Las claims del canje siguen valiendo aunque su sesión ya se haya borrado. La hora se
    // lee después del reclamo: la entrada que sigue empezó después del cambio de contraseña.
    // Abrir el enlace y fijar la contraseña prueba el buzón: el reclamo guarda la huella de
    // un resguardo, y el secreto se queda en este navegador.
    const ticket = issueTicket();
    const save = () =>
      asServer({ claims: redeemed.claims, reason: "complete_registration" }, async (tx) => {
        await saveIdentity(tx, profileId, { name: checked.name, adult: true });
        await grantConsents(tx, profileId, match.documentIds, "signup", from, deps.isLocal());
        // Si la cuenta no se puede reclamar, no se guarda nada.
        if (!accountClaimed(await claimAccount(tx, ticket.print))) throw new Error("La cuenta no se pudo reclamar.");
        return (await dbClock(tx)).text;
      });
    let startedText: string;
    try {
      startedText = await save();
    } catch {
      try {
        startedText = await save();
      } catch {
        return failed();
      }
    }

    await keepProof(jar, ticket, redeemed.claims);
    return enter(jar, redeemed.email, checked.password, startedText, from.userAgent);
  }

  /**
   * Completar la recuperación desde el enlace del correo (FL-06): guarda la contraseña,
   * reclama la cuenta, deja este dispositivo como de confianza y cierra todas las sesiones.
   * No abre sesión: la persona entra con su contraseña nueva.
   *
   * Con el tarro del navegador que abrió el enlace deja además el resguardo del buzón. Sin
   * tarro no hay resguardo: la recuperación vale igual, pero no sirve para aceptar una
   * invitación de administración.
   */
  async function completeRecovery(
    input: { tokenHash: string; password: string },
    origin: RequestOrigin,
    jar?: CookieJar,
  ): Promise<RecoveryCompletion> {
    const checked = checkPassword(input.password);
    if (!checked.ok) return { kind: "invalid", reason: checked.reason };
    const from = resolveOrigin(origin, deps.proxyTrusted());

    const redemption = await auth.redeemRecoveryLink(input.tokenHash);
    if (!redemption.ok) {
      if (redemption.reason !== "spent") return { kind: redemption.reason === "invalid_or_expired" ? "link_dead" : "unavailable" };
      await deps.report("recovery_incomplete");
      return { kind: "request_new_link" };
    }
    const { redeemed } = redemption;

    // Desde aquí el enlace ya se gastó.
    const saved = await auth.setRecoveredPassword(redeemed, input.password);
    const outcome = resolvePasswordOutcome("recovery", saved.result);
    let done = outcome.next === "done";
    // Por el camino de administración el aviso «tu contraseña cambió» no sale. Para una
    // cuenta con segundo factor ese es su único camino: no es una falla, pero tampoco pasa
    // en silencio. Lleva su propio reporte.
    if (done && saved.via === "administration") {
      await deps.report(saved.secondFactor === true ? "recovery_with_second_factor" : "recovery_notice_not_sent");
    }

    // El resguardo del buzón, solo si hay navegador donde dejarlo. Se genera aquí: nunca
    // sale de lo que mandó quien pide.
    const ticket = jar ? issueTicket() : null;
    let claimed = false;
    if (done && outcome.claimAccount) {
      const account = parseEmail(redeemed.email);
      const keys: PairKeys = { account: fingerprint("account", account.ok ? account.email : redeemed.email), ip: from.ip };
      const settle = () =>
        asServer({ claims: redeemed.claims, reason: "complete_recovery" }, async (tx) => {
          // Los candados del freno van antes que el de la fila del perfil, que toma el reclamo.
          await lockAll(tx, [keys.ip, keys.account]);
          // Una cuenta que no se puede reclamar (suspendida) se queda con su contraseña
          // nueva, sin dispositivo de confianza y sin resguardo.
          if (!accountClaimed(await claimAccount(tx, ticket?.print ?? null))) return false;
          if (!outcome.clearThrottles) return true;
          const trusted = pairAfterRecovery((await dbClock(tx)).date);
          // De una dirección que no se conoce no queda ningún par de confianza.
          await trustAfterRecovery(tx, keys, from.known && trusted.ok ? trusted.pair : null, buckets.signInAccount(keys.account));
          return true;
        });
      try {
        claimed = await settle();
      } catch {
        try {
          claimed = await settle();
        } catch {
          done = false;
        }
      }
    }

    // Siempre, falle lo que falle antes. Lo que esto no alcanza: una entrada que Auth tenía
    // a medias con la contraseña vieja nace después del cierre. La aplicación no la
    // reconoce, pero sigue viva en Auth (TRD §9.2, el sello de la contraseña, sin decidir).
    await expectClosed(auth.closeAllSessions(redeemed));
    if (!done) {
      await deps.report("recovery_incomplete");
      return { kind: "request_new_link" };
    }
    // Solo si el reclamo ocurrió: sin él la base no guardó ninguna huella.
    if (jar && ticket && claimed) await keepProof(jar, ticket, redeemed.claims);
    return { kind: "done" };
  }

  /**
   * Completar una cuenta que ya tiene sesión (PA-15): lo que la guarda dijo que falta, y
   * nada más. Exige una sesión reconocida que llegue hasta «incompleta».
   */
  async function completeAccount(reader: CookieReader, form: AccountForm, origin: RequestOrigin): Promise<AccountCompletion> {
    const check = await core.checkSession(reader);
    if (check.kind === "pass") return { kind: "complete" };
    if (check.kind !== "incomplete") return { kind: "session", check };

    const checked = checkAccountForm(check.missing, form);
    const needed = check.missing.documents.map((document) => document.docType);
    const from = resolveOrigin(origin, deps.proxyTrusted());
    const profileId = check.claims.userId;

    let result: AccountCompletion | { kind: "no_text" };
    try {
      result = await asServer({ claims: check.claims, reason: "complete_account" }, async (tx) => {
        const match = matchAccepted(await currentTexts(tx, deps.isLocal()), needed, form.accepted);
        if (match.kind === "unavailable") return { kind: "no_text" };
        if (match.kind === "stale") return { kind: "texts_changed" };
        const fields: FieldErrors = checked.ok ? {} : { ...checked.fields };
        if (match.kind === "missing") fields.texts = "required";
        if (!checked.ok || match.kind === "missing") return { kind: "invalid", fields };

        await saveIdentity(tx, profileId, { name: checked.name, adult: checked.adult });
        await grantConsents(tx, profileId, match.documentIds, "login_prompt", from, deps.isLocal());
        const view = await evaluateGate(tx, profileId, deps.isLocal());
        if (view.kind === "pass") return { kind: "complete" };
        if (view.kind === "incomplete") return { kind: "incomplete", variant: view.variant, missing: view.missing };
        throw new Error("La guarda no dejó pasar una cuenta que se acababa de completar.");
      });
    } catch {
      await deps.report("gate_unavailable");
      return { kind: "unavailable" };
    }
    if (result.kind === "no_text") {
      await deps.report("gate_no_current_text");
      return { kind: "unavailable" };
    }
    return result;
  }

  return { requestRegistration, requestRecovery, accountFormFacts, completeRegistration, completeRecovery, completeAccount };
}
