import "server-only";

import { getEnv } from "@/config/env";
import type { PasswordSetResult } from "@/domain/access/password-outcome";

import { adminApi, callAuth, oneShotClient, type Fetch } from "./auth-client";
import {
  clearSessionCookie,
  isSecureSite,
  readSessionCookie,
  writeSessionCookie,
  type CookieJar,
  type CookieReader,
  type SessionTokens,
} from "./auth-cookies";
import {
  alreadyClosed,
  failureFromSdk,
  passwordSetFailure,
  recoveryNeedsAdministration,
  recoveryRequestFailure,
  redeemFailure,
  sessionLostOnRefresh,
  sessionRevoked,
  signInFailure,
  signUpFailure,
  unlistedRejection,
  type AuthFailure,
  type AuthOperation,
  type RecoveryRequestFailure,
  type SignInFailure,
  type SignUpFailure,
} from "./auth-errors";
import { ensureIdentityKeys, inspectAccessToken, type TokenInspection, type VerifiedClaims } from "./claims";
import { IdentityUnavailableError } from "./errors";
import { emailClaim, isLinkToken } from "./tokens";

// Lo que los servicios le piden a Supabase Auth (TRD §8.10 y §9.2).
//
// Cada función contesta con una unión cerrada. El mensaje del proveedor nunca sale de
// aquí, y lo que no se reconoce es «no se supo»: ni un éxito ni un motivo para cerrarle la
// sesión a nadie.
//
// Ocho cosas que quien llama tiene que saber, porque el adaptador no las decide:
//
// - `signIn` distingue `banned` y `email_not_confirmed`, y Auth contesta el primero antes
//   de revisar la contraseña y el segundo solo con la contraseña correcta. Mostrarlos tal
//   cual delata el estado de una cuenta: el servicio los aplana.
// - `requestSignUp` contesta `existing_account` cuando el correo ya tiene cuenta, y Auth no
//   pone espera entre dos invitaciones al mismo correo. Las dos cosas son del servicio:
//   contesta lo de siempre, y su propia espera entre correos va antes (TRD §9.9).
// - `mail_rate_limited` también delata al recuperar. Auth lo contesta solo cuando la cuenta
//   existe y recibió un correo hace poco: pedir dos veces seguidas la recuperación de un
//   correo distingue al que tiene cuenta del que no. El servicio contesta lo de siempre.
// - `signIn` no cierra la sesión que el tarro ya traiga. Quien entra con una sesión
//   abierta la cierra antes con `signOut`, o esa queda abierta en Auth sin dueño.
// - `refreshSession` puede contestar `session` con un token al que le quedan segundos: si
//   no logró renovar, devuelve la sesión que hay mientras valga. Una acción larga puede
//   ver vencer esas claims a la mitad (`ExpiredClaimsError`).
// - `confirmSession` va después de `refreshSession`. Con un token vencido Auth no dice si
//   la sesión vive, y la respuesta es `unknown`.
// - `setRecoveredPassword` dice por qué camino guardó. Por administración no sale el
//   aviso «tu contraseña cambió» (CO-26): quien llama lo reporta.
// - `readSession` y `refreshSession` solo miran la firma y la vigencia del token. Una
//   sesión cerrada en otro lado sigue pasando hasta que su token vence (15 minutos): lo
//   que no pueda esperar ese tiempo le pregunta a Auth con `confirmSession`.

/** Cuánto le tiene que quedar a un token para no renovarlo todavía. */
const REFRESH_MARGIN_MS = 90_000;
/** Lo más que espera el paso previo por una renovación: detrás hay una persona esperando. */
const REFRESH_TIMEOUT_MS = 3_000;
/** Tras una renovación fallida por un motivo pasajero, cuánto pasa antes de volver a intentar. */
const REFRESH_PAUSE_MS = 10_000;

// Un token de acceso normal mide menos de la mitad. Uno más largo que esto no cabría en la
// cookie, y pasado cierto tamaño ni siquiera se le puede mandar a Auth en una cabecera.
const MAX_USABLE_TOKEN_LENGTH = 3_000;

export type SessionRead =
  | { kind: "none" }
  /** `email`: el correo que dice el token, para mostrarlo. Nulo si no lo trae. */
  | { kind: "session"; claims: VerifiedClaims; email: string | null }
  /** La cookie es de una sesión de verdad, pero su token ya venció y aquí no se renueva. */
  | { kind: "expired" }
  | { kind: "unknown" };

export type SessionRefresh =
  | { kind: "none" }
  | { kind: "session"; claims: VerifiedClaims }
  /** La sesión ya no existe en Auth. La cookie quedó borrada. */
  | { kind: "lost" }
  /** No se pudo saber. La cookie no se tocó. */
  | { kind: "unknown" };

export type SignInResult =
  | { ok: true; claims: VerifiedClaims }
  /** `oversized_session`: Auth dio la sesión, pero no cabe en la cookie. Se cerró. */
  | { ok: false; reason: SignInFailure | "oversized_session" };

export type SignUpRequest = "accepted" | SignUpFailure;
export type RecoveryRequest = "accepted" | RecoveryRequestFailure;

export interface RecoveredPassword {
  result: PasswordSetResult;
  /**
   * Con qué se guardó, o se intentó guardar. `session`: la sesión del canje, que es lo que
   * hace salir el aviso «tu contraseña cambió» y cierra las demás sesiones. `administration`:
   * la API de administración, que no manda el aviso y borra todas las sesiones.
   */
  via: "session" | "administration";
}
export type Closing = "closed" | "unknown";
export type SessionLiveness = "alive" | "revoked" | "unknown";

declare const redeemedLink: unique symbol;

/**
 * Lo que queda después de canjear el enlace de un correo. Solo lo produce este módulo: el
 * identificador de cuenta que recibe la API de administración sale de aquí y de ningún
 * otro lado. Un objeto con la misma forma, armado en otro lugar, no sirve.
 */
export interface RedeemedLink {
  /** Sin valor: existe para que un objeto armado a mano no pase por uno de estos ni al compilar. */
  readonly [redeemedLink]: never;
  readonly flow: "signup" | "recovery";
  /** Las claims de la sesión del canje. Esa sesión nunca llega al navegador. */
  readonly claims: VerifiedClaims;
  /** El correo de la cuenta, como lo tiene Auth. */
  readonly email: string;
}

export type RedeemResult =
  | { ok: true; redeemed: RedeemedLink }
  /**
   * `invalid_or_expired`: el enlace no sirve. `unknown`: no se supo, y el enlace sigue
   * sirviendo. `spent`: Auth lo canjeó, pero su sesión no se pudo usar y se cerró: el
   * enlace ya no sirve, y a la persona hay que darle otra salida.
   */
  | { ok: false; reason: "invalid_or_expired" | "unknown" | "spent" };

interface Redemption {
  /** La cuenta, guardada aparte: no se lee del objeto que anda por fuera. */
  userId: string;
  accessToken: string;
  /** Las claves de los metadatos de la cuenta al canjear: se borran al fijar la contraseña. */
  metadataKeys: string[];
  /** Un canje alcanza para un solo intento de fijar la contraseña. */
  spent: boolean;
}

const redemptions = new WeakMap<object, Redemption>();

export interface AuthDependencies {
  /** Solo para pruebas: simular un servidor de identidad que no contesta o que limita. */
  fetch?: Fetch;
  /** Solo para pruebas: un reloj adelantado, para tener un token «por vencer» sin esperar. */
  now?: () => number;
  /** Solo para pruebas: unas claves públicas que no se pueden bajar, o una recién rotada. */
  inspectToken?: (accessToken: string, now: () => number) => Promise<TokenInspection>;
  /** Solo para pruebas: lo mismo, para la comprobación que va antes de canjear un enlace. */
  keysReady?: () => Promise<void>;
}

// «No se pudo saber» junta dos casos: las claves públicas no se pudieron bajar, o el token
// dice una clave que todavía no se ha vuelto a preguntar. En ninguno de los dos se trata a
// la persona como si no tuviera sesión, ni se borra su cookie.
type Inspection = Exclude<TokenInspection, { state: "unknown_key" }> | { state: "unavailable" };

// Lo que le pasa a todos, no a una sesión: Auth no contesta, o su límite de peticiones.
const isOutage = (failure: AuthFailure): boolean => failure.kind === "unreachable" || failure.status === 429;

type Renewal = { ok: true; tokens: SessionTokens } | { ok: false; failure: AuthFailure };

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Clasifica un fallo con la lista de su operación. Si Auth contestó que no con un código
 * que la lista no conoce, la respuesta sigue siendo «no se supo», y queda dicho en el
 * registro del servidor: es lo único que distingue un código nuevo de una caída.
 */
function classify<T extends string>(operation: AuthOperation, failure: AuthFailure, table: (failure: AuthFailure) => T): T {
  const reason = table(failure);
  if (reason === "unknown") {
    const notice = unlistedRejection(operation, failure);
    if (notice) console.warn(notice);
  }
  return reason;
}

export function createAuth(dependencies: AuthDependencies = {}) {
  // Sin dependencias, el `fetch` y el reloj se buscan en cada llamada, no al cargar.
  const baseFetch = dependencies.fetch;
  const now = dependencies.now ?? (() => Date.now());
  const secure = () => isSecureSite(getEnv().NEXT_PUBLIC_SITE_URL);

  // Estado de esta instancia del servidor, no una garantía: en otra instancia no existe.
  let refreshPausedUntil = 0;
  const renewing = new Map<string, Promise<Renewal>>();

  const inspectToken = dependencies.inspectToken ?? inspectAccessToken;
  const keysReady = dependencies.keysReady ?? ensureIdentityKeys;

  async function inspect(accessToken: string): Promise<Inspection> {
    try {
      const inspection = await inspectToken(accessToken, now);
      return inspection.state === "unknown_key" ? { state: "unavailable" } : inspection;
    } catch (error) {
      if (error instanceof IdentityUnavailableError) return { state: "unavailable" };
      throw error;
    }
  }

  async function logout(accessToken: string, scope: "local" | "global"): Promise<Closing> {
    const call = await callAuth({
      method: "POST",
      path: `/logout?scope=${scope}`,
      accessToken,
      fetch: baseFetch,
    });
    return call.ok || alreadyClosed(call.failure) ? "closed" : "unknown";
  }

  // Un solo intento, y las renovaciones simultáneas del mismo token comparten la salida.
  function renew(refreshToken: string): Promise<Renewal> {
    const pending = renewing.get(refreshToken);
    if (pending) return pending;
    const attempt = (async (): Promise<Renewal> => {
      const call = await callAuth({
        method: "POST",
        path: "/token?grant_type=refresh_token",
        body: { refresh_token: refreshToken },
        timeoutMs: REFRESH_TIMEOUT_MS,
        fetch: baseFetch,
      });
      if (!call.ok) return { ok: false, failure: call.failure };
      const body = isRecord(call.body) ? call.body : {};
      const accessToken = text(body.access_token);
      const next = text(body.refresh_token);
      // Un 200 sin los dos tokens no se entiende: no es un motivo para perder la sesión.
      if (!accessToken || !next) return { ok: false, failure: { kind: "unreachable" } };
      return { ok: true, tokens: { accessToken, refreshToken: next } };
    })().finally(() => renewing.delete(refreshToken));
    renewing.set(refreshToken, attempt);
    return attempt;
  }

  /**
   * Pide el registro de un correo. Es una invitación, por la API de administración: Auth
   * no acepta altas de nadie más. La cuenta nace sin confirmar y sin contraseña, y Auth
   * manda el enlace de verificación; la contraseña la fija quien abre el enlace
   * (`setFirstPassword`). Así nadie puede plantar una contraseña en el correo de otro.
   *
   * A Auth solo se le manda el correo. Para uno nuevo y para uno que no ha confirmado
   * contesta `accepted`, y a este último le manda otro enlace: el anterior deja de servir.
   * Para uno que ya tiene cuenta contesta `existing_account` y Auth no manda nada: quien
   * llama no lo muestra.
   */
  async function requestSignUp(email: string): Promise<SignUpRequest> {
    try {
      const { error } = await adminApi(baseFetch).inviteUserByEmail(email);
      return error ? classify("sign_up", failureFromSdk(error), signUpFailure) : "accepted";
    } catch (error) {
      return classify("sign_up", failureFromSdk(error), signUpFailure);
    }
  }

  /**
   * Pide el correo de recuperación. Contesta `accepted` exista o no la cuenta, salvo
   * `mail_rate_limited`, que solo sale para una cuenta que existe y recibió un correo hace
   * poco: quien llama no lo muestra.
   */
  async function requestPasswordRecovery(email: string): Promise<RecoveryRequest> {
    try {
      const { error } = await oneShotClient(baseFetch).resetPasswordForEmail(email);
      return error ? classify("recovery_request", failureFromSdk(error), recoveryRequestFailure) : "accepted";
    } catch (error) {
      return classify("recovery_request", failureFromSdk(error), recoveryRequestFailure);
    }
  }

  // El tipo con el que Auth canjea el enlace de cada flujo. El de verificación sale de una
  // invitación.
  const LINK_TYPE = { signup: "invite", recovery: "recovery" } as const;

  async function redeem(tokenHash: string, flow: RedeemedLink["flow"]): Promise<RedeemResult> {
    // Lo que no tiene forma de huella no se le manda a Auth.
    if (!isLinkToken(tokenHash)) return { ok: false, reason: "invalid_or_expired" };

    // El enlace sirve una sola vez. Sin las claves públicas a la mano no se podría
    // verificar la sesión que devuelve: se pregunta antes de gastarlo.
    try {
      await keysReady();
    } catch (error) {
      if (error instanceof IdentityUnavailableError) return { ok: false, reason: "unknown" };
      throw error;
    }

    let accessToken: string | null = null;
    try {
      const { data, error } = await oneShotClient(baseFetch).verifyOtp({
        token_hash: tokenHash,
        type: LINK_TYPE[flow],
      });
      if (error) return { ok: false, reason: classify("redeem", failureFromSdk(error), redeemFailure) };
      accessToken = text(data.session?.access_token);
      const email = text(data.user?.email);
      // Desde aquí Auth ya canjeó el enlace: lo que falle es `spent`, no `unknown`.
      if (!accessToken || !email || !data.user) {
        if (accessToken) await logout(accessToken, "local");
        return { ok: false, reason: "spent" };
      }

      const inspection = await inspect(accessToken);
      // Si su sesión no se puede verificar, no se usa: se cierra.
      if (inspection.state !== "valid" || inspection.claims.userId !== data.user.id) {
        await logout(accessToken, "local");
        return { ok: false, reason: "spent" };
      }

      const metadata: unknown = data.user.user_metadata;
      let session = {
        accessToken,
        claims: inspection.claims,
        metadataKeys: isRecord(metadata) ? Object.keys(metadata) : [],
      };
      if (accessToken.length > MAX_USABLE_TOKEN_LENGTH) {
        const slim = await slimDown(session, text(data.session?.refresh_token));
        if (!slim) {
          await logout(accessToken, "local");
          return { ok: false, reason: "spent" };
        }
        session = slim;
        accessToken = slim.accessToken;
      }

      const redeemed = Object.freeze({ flow, claims: session.claims, email }) as RedeemedLink;
      redemptions.set(redeemed, {
        userId: session.claims.userId,
        accessToken: session.accessToken,
        metadataKeys: session.metadataKeys,
        spent: false,
      });
      return { ok: true, redeemed };
    } catch (error) {
      if (accessToken) {
        await logout(accessToken, "local");
        return { ok: false, reason: "spent" };
      }
      return { ok: false, reason: classify("redeem", failureFromSdk(error), redeemFailure) };
    }
  }

  /**
   * La sesión de un canje cuyo token carga tantos metadatos que no se puede usar: ni cabe
   * en una cookie ni, pasado cierto tamaño, llega a Auth en una cabecera. Los metadatos se
   * borran con la API de administración (la cuenta sale de un canje recién hecho, no de
   * quien llama) y la sesión se renueva, para tener un token que ya no los cargue.
   *
   * Solo ocurre con una cuenta que traiga ese relleno de antes, de cuando Auth aceptaba
   * altas de cualquiera: sin esto, quien abre el enlace de su buzón no podría recuperarla.
   */
  async function slimDown(
    session: { claims: VerifiedClaims; metadataKeys: string[] },
    refreshToken: string | null,
  ): Promise<{ accessToken: string; claims: VerifiedClaims; metadataKeys: string[] } | null> {
    if (!refreshToken || session.metadataKeys.length === 0) return null;
    try {
      const { error } = await adminApi(baseFetch).updateUserById(session.claims.userId, {
        user_metadata: Object.fromEntries(session.metadataKeys.map((key) => [key, null])),
      });
      if (error) return null;
    } catch {
      return null;
    }
    const renewal = await renew(refreshToken);
    if (!renewal.ok || renewal.tokens.accessToken.length > MAX_USABLE_TOKEN_LENGTH) return null;
    const inspection = await inspect(renewal.tokens.accessToken);
    if (inspection.state !== "valid" || inspection.claims.userId !== session.claims.userId) return null;
    return { accessToken: renewal.tokens.accessToken, claims: inspection.claims, metadataKeys: [] };
  }

  /**
   * Canjea el enlace de verificación (CO-01). Solo acepta uno de ese tipo: Auth rechaza
   * aquí un enlace de recuperación. Al canjear, Auth le pone a la cuenta una contraseña al
   * azar que no le entrega a nadie: `setFirstPassword` la reemplaza.
   */
  const redeemSignupLink = (tokenHash: string) => redeem(tokenHash, "signup");

  /** Canjea el enlace de recuperación (CO-07). Auth rechaza aquí uno de verificación. */
  const redeemRecoveryLink = (tokenHash: string) => redeem(tokenHash, "recovery");

  // La aplicación no usa los metadatos de la cuenta, y una cuenta puede traerlos de antes,
  // de cuando Auth aceptaba altas de cualquiera. Viajan dentro del token de acceso: unos
  // pocos kilobytes harían que la sesión no cupiera en la cookie. Se borran al fijar la
  // contraseña, que es cuando la cuenta pasa a ser de quien controla el buzón.
  const withoutMetadata = (redemption: Redemption): Record<string, null> | undefined =>
    redemption.metadataKeys.length === 0
      ? undefined
      : Object.fromEntries(redemption.metadataKeys.map((key) => [key, null]));

  function take(redeemed: RedeemedLink, flow: RedeemedLink["flow"]): Redemption | null {
    const redemption = redemptions.get(redeemed);
    if (!redemption || redeemed.flow !== flow || redemption.spent) return null;
    redemption.spent = true;
    return redemption;
  }

  /**
   * Fija la primera contraseña de una cuenta, al completar el registro. Va por la API de
   * administración de Auth: no manda el aviso «tu contraseña cambió» a quien apenas se
   * registra, y borra toda sesión de la cuenta, también la del canje.
   *
   * Solo acepta un canje de verificación, y una sola vez.
   */
  async function setFirstPassword(redeemed: RedeemedLink, password: string): Promise<PasswordSetResult> {
    const redemption = take(redeemed, "signup");
    if (!redemption) return "rejected";
    try {
      const { error } = await adminApi(baseFetch).updateUserById(redemption.userId, {
        password,
        user_metadata: withoutMetadata(redemption),
      });
      return error ? classify("set_password", failureFromSdk(error), passwordSetFailure) : "ok";
    } catch (error) {
      return classify("set_password", failureFromSdk(error), passwordSetFailure);
    }
  }

  /**
   * Guarda la contraseña nueva de quien recupera su cuenta. Primero con la sesión del
   * canje: Auth manda el aviso «tu contraseña cambió» (CO-26) y cierra las demás sesiones.
   *
   * Hay dos casos en que eso no sirve y la persona sí controla el buzón. Uno: la sesión
   * del canje ya no existe, porque quien tiene otra sesión de la cuenta las cerró todas;
   * puede hacerlo en bucle, y sin otro camino la dueña no recuperaría nunca. Dos: la
   * contraseña es la que ya tenía, y entonces Auth no cambia ni cierra nada. En los dos se
   * fija por la API de administración, que la guarda y borra todas las sesiones en un solo
   * paso. Por ese camino el aviso no sale: `via` lo dice.
   *
   * Solo acepta un canje de recuperación, y una sola vez.
   */
  async function setRecoveredPassword(redeemed: RedeemedLink, password: string): Promise<RecoveredPassword> {
    const redemption = take(redeemed, "recovery");
    if (!redemption) return { result: "rejected", via: "session" };
    const call = await callAuth({
      method: "PUT",
      path: "/user",
      accessToken: redemption.accessToken,
      body: { password, data: withoutMetadata(redemption) },
      fetch: baseFetch,
    });
    if (call.ok) return { result: "ok", via: "session" };
    if (!recoveryNeedsAdministration(call.failure)) {
      return { result: classify("set_password", call.failure, passwordSetFailure), via: "session" };
    }
    try {
      const { error } = await adminApi(baseFetch).updateUserById(redemption.userId, {
        password,
        user_metadata: withoutMetadata(redemption),
      });
      const result = error ? classify("set_password", failureFromSdk(error), passwordSetFailure) : "ok";
      return { result, via: "administration" };
    } catch (error) {
      return { result: classify("set_password", failureFromSdk(error), passwordSetFailure), via: "administration" };
    }
  }

  async function close(redeemed: RedeemedLink, scope: "local" | "global"): Promise<Closing> {
    const redemption = redemptions.get(redeemed);
    if (!redemption) return "unknown";
    // Cerrado o no, este canje ya no fija ninguna contraseña.
    redemption.spent = true;
    return logout(redemption.accessToken, scope);
  }

  /**
   * Cierra todas las sesiones de la cuenta, con la del canje. Se puede volver a llamar si
   * contestó `unknown`, mientras el token del canje no haya vencido.
   *
   * Si la sesión del canje ya no existe (la borró fijar la contraseña por administración,
   * o alguien más), contesta `closed` sin haber cerrado nada: ya no hay con qué. Y no
   * alcanza a una entrada que Auth tenía a medias y que nace después (TRD §9.2).
   */
  const closeAllSessions = (redeemed: RedeemedLink) => close(redeemed, "global");

  /**
   * Cierra solo la sesión del canje, sin tocar las demás: para el enlace de una cuenta que
   * ya está reclamada, donde no se cambia nada.
   */
  const discardRedemption = (redeemed: RedeemedLink) => close(redeemed, "local");

  /**
   * Entra con correo y contraseña, y escribe la cookie de sesión en el tarro. No cierra la
   * sesión que el tarro ya traiga: eso lo hace antes quien llama, con `signOut`.
   */
  async function signIn(jar: CookieJar, email: string, password: string): Promise<SignInResult> {
    let accessToken: string | null = null;
    try {
      const { data, error } = await oneShotClient(baseFetch).signInWithPassword({ email, password });
      if (error) return { ok: false, reason: classify("sign_in", failureFromSdk(error), signInFailure) };
      accessToken = text(data.session?.access_token);
      const refreshToken = text(data.session?.refresh_token);
      if (!accessToken || !refreshToken) return { ok: false, reason: "unknown" };

      const inspection = await inspect(accessToken);
      if (inspection.state !== "valid") {
        await logout(accessToken, "local");
        return { ok: false, reason: "unknown" };
      }
      if (!writeSessionCookie(jar, { accessToken, refreshToken }, secure())) {
        // Si el token es tan largo que ni llega a Auth, la sesión queda sin cerrar; nadie
        // tiene sus tokens, y solo la cuenta puede inflar así sus propios metadatos.
        await logout(accessToken, "local");
        return { ok: false, reason: "oversized_session" };
      }
      return { ok: true, claims: inspection.claims };
    } catch (error) {
      if (accessToken) await logout(accessToken, "local");
      return { ok: false, reason: classify("sign_in", failureFromSdk(error), signInFailure) };
    }
  }

  /**
   * Lee la sesión de la cookie y verifica su token. No renueva y no escribe: no recibe
   * dónde. Es lo que usa una página, que no puede guardar una cookie.
   */
  async function readSession(reader: CookieReader): Promise<SessionRead> {
    const cookie = readSessionCookie(reader, secure());
    if (cookie.kind !== "tokens") return { kind: "none" };
    const inspection = await inspect(cookie.tokens.accessToken);
    if (inspection.state === "valid") {
      return { kind: "session", claims: inspection.claims, email: emailClaim(cookie.tokens.accessToken) };
    }
    if (inspection.state === "expired") return { kind: "expired" };
    return inspection.state === "unavailable" ? { kind: "unknown" } : { kind: "none" };
  }

  /**
   * Renueva la sesión si a su token le queda poco, y escribe la cookie nueva. La llaman el
   * paso previo y las acciones de servidor, que son quienes pueden escribirla.
   *
   * La cookie se borra en tres casos y solo en esos: no se entiende, su token no lo firmó
   * el proyecto, o Auth dijo que la sesión ya no existe. Un fallo pasajero no la toca, y
   * tampoco un token firmado con una clave por la que todavía no se ha vuelto a preguntar.
   *
   * `session` no promete un token recién renovado: si la renovación falló por algo
   * pasajero, es la sesión que había, con lo que le quede de vida.
   */
  async function refreshSession(jar: CookieJar): Promise<SessionRefresh> {
    const isSecure = secure();
    const cookie = readSessionCookie(jar, isSecure);
    if (cookie.kind === "absent") return { kind: "none" };
    if (cookie.kind === "malformed") {
      clearSessionCookie(jar, isSecure);
      return { kind: "none" };
    }

    const current = await inspect(cookie.tokens.accessToken);
    if (current.state === "unavailable") return { kind: "unknown" };
    // Un token que el proyecto no firmó no llega a Auth: una cookie inventada no le cuesta
    // una petición a nadie.
    if (current.state === "invalid") {
      clearSessionCookie(jar, isSecure);
      return { kind: "none" };
    }
    if (current.state === "valid" && current.expiresAt - now() > REFRESH_MARGIN_MS) {
      return { kind: "session", claims: current.claims };
    }

    // Lo que se contesta si no se logra renovar: la sesión que hay, mientras su token valga.
    const fallback: SessionRefresh =
      current.state === "valid" ? { kind: "session", claims: current.claims } : { kind: "unknown" };
    if (now() < refreshPausedUntil) return fallback;

    const renewal = await renew(cookie.tokens.refreshToken);
    if (!renewal.ok) {
      if (sessionLostOnRefresh(renewal.failure)) {
        clearSessionCookie(jar, isSecure);
        return { kind: "lost" };
      }
      // La pausa es de toda la instancia: solo la pone lo que le pasa a todos. El fallo
      // de una sola sesión no detiene la renovación de las demás.
      if (isOutage(renewal.failure)) refreshPausedUntil = now() + REFRESH_PAUSE_MS;
      return fallback;
    }

    const next = await inspect(renewal.tokens.accessToken);
    if (next.state !== "valid") return fallback;
    // La renovación de una sesión no puede traer la de otra cuenta ni la de otra sesión.
    const before = current.state === "valid" ? current.claims : current;
    if (next.claims.userId !== before.userId || next.claims.sessionId !== before.sessionId) return fallback;
    if (!writeSessionCookie(jar, renewal.tokens, isSecure)) return fallback;
    return { kind: "session", claims: next.claims };
  }

  /**
   * Le pregunta a Auth si la sesión de la cookie sigue viva. Es una petición por llamada:
   * se usa donde un token ya emitido no puede seguir valiendo, no en cada pantalla, y
   * después de `refreshSession`: con un token vencido Auth no dice nada de la sesión y la
   * respuesta es `unknown`. Sin cookie, o con una que no se entiende, es `revoked`.
   *
   * No detecta una sesión cuya familia de tokens Auth revocó por reutilización: ahí la
   * sesión sigue en su tabla y lo que falla es la siguiente renovación.
   */
  async function confirmSession(reader: CookieReader): Promise<SessionLiveness> {
    const cookie = readSessionCookie(reader, secure());
    if (cookie.kind !== "tokens") return "revoked";
    const call = await callAuth({
      method: "GET",
      path: "/user",
      accessToken: cookie.tokens.accessToken,
      fetch: baseFetch,
    });
    if (call.ok) return "alive";
    return sessionRevoked(call.failure) ? "revoked" : "unknown";
  }

  /**
   * «Salir»: borra la cookie, pase lo que pase, y cierra en Auth solo esta sesión. Las de
   * otros dispositivos siguen.
   */
  async function signOut(jar: CookieJar): Promise<Closing> {
    const isSecure = secure();
    const cookie = readSessionCookie(jar, isSecure);
    if (cookie.kind === "absent") return "closed";
    clearSessionCookie(jar, isSecure);
    if (cookie.kind === "malformed") return "closed";

    let accessToken = cookie.tokens.accessToken;
    const current = await inspect(accessToken);
    if (current.state === "invalid") return "closed";
    if (current.state === "expired") {
      // Con el token vencido Auth no deja cerrar la sesión: hace falta uno vigente.
      const renewal = await renew(cookie.tokens.refreshToken);
      if (!renewal.ok) return sessionLostOnRefresh(renewal.failure) ? "closed" : "unknown";
      accessToken = renewal.tokens.accessToken;
    }
    return logout(accessToken, "local");
  }

  return {
    requestSignUp,
    requestPasswordRecovery,
    redeemSignupLink,
    redeemRecoveryLink,
    setFirstPassword,
    setRecoveredPassword,
    closeAllSessions,
    discardRedemption,
    signIn,
    readSession,
    refreshSession,
    confirmSession,
    signOut,
  };
}

const auth = createAuth();

export const {
  requestSignUp,
  requestPasswordRecovery,
  redeemSignupLink,
  redeemRecoveryLink,
  setFirstPassword,
  setRecoveredPassword,
  closeAllSessions,
  discardRedemption,
  signIn,
  readSession,
  refreshSession,
  confirmSession,
  signOut,
} = auth;
