import "server-only";

// La cookie de sesión (TRD §8.10 y §9.2, fila «Cookies»).
//
// La lleva el adaptador, no una biblioteca: una sola cookie con los dos tokens de la
// sesión y nada más. Así una lectura no puede renovar a escondidas, y lo que se borra y
// cuándo lo decide `auth.ts` con una lista cerrada de motivos.
//
// Este archivo no conoce a Next ni a Auth: recibe un tarro (`CookieJar`) que le arma quien
// sí tiene la petición, y trabaja con textos.

/** De dónde se lee una cookie. Una página solo tiene esto: no puede escribir. */
export interface CookieReader {
  get(name: string): string | undefined;
}

export interface CookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: "/";
  /** Segundos. Cero borra la cookie. */
  readonly maxAge: number;
}

/** De dónde se lee y dónde se escribe: el paso previo y las acciones de servidor. */
export interface CookieJar extends CookieReader {
  set(name: string, value: string, options: CookieOptions): void;
}

export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

// Lo más que un navegador promete guardar: la sesión de la persona no tiene tope propio
// (TRD §9.2, fila «Token de acceso»), y la cookie se vuelve a escribir en cada renovación.
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

// Un navegador guarda hasta 4096 bytes por cookie, contando el nombre. La sesión normal
// mide una cuarta parte. Lo que no cabe no se parte en varias: no se escribe, y quien la
// iba a escribir lo trata como un fallo.
export const SESSION_COOKIE_MAX_LENGTH = 3800;

const VERSION = "v1";
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** El sitio va por https: ahí la cookie es `Secure` y lleva el prefijo `__Host-`. */
export function isSecureSite(siteUrl: string): boolean {
  return URL.canParse(siteUrl) && new URL(siteUrl).protocol === "https:";
}

/**
 * Con https, el prefijo `__Host-` hace que el navegador solo acepte la cookie si viene del
 * propio sitio, con `Secure` y `Path=/`: otro subdominio no la puede plantar. En local no
 * hay https, y un navegador rechazaría el prefijo.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-plataforma-sesion" : "plataforma-sesion";
}

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_COOKIE_MAX_AGE_SECONDS };
}

/**
 * El valor de la cookie: la versión, el token de acceso tal cual y el token de renovación
 * en base64url. Todo con caracteres que ningún servidor escapa. `null` si los tokens no
 * tienen forma o el resultado no cabe.
 */
export function encodeSessionCookie(tokens: SessionTokens): string | null {
  const segments = tokens.accessToken.split(".");
  if (segments.length !== 3 || !segments.every((segment) => JWT_SEGMENT.test(segment))) return null;
  if (tokens.refreshToken === "" || !tokens.refreshToken.isWellFormed()) return null;
  const refresh = Buffer.from(tokens.refreshToken, "utf8").toString("base64url");
  const value = `${VERSION}.${tokens.accessToken}.${refresh}`;
  return value.length <= SESSION_COOKIE_MAX_LENGTH ? value : null;
}

/**
 * Lo contrario. `null` si el texto no es exactamente lo que `encodeSessionCookie` habría
 * escrito: de otra versión, con otra forma, o con una codificación que no es la canónica.
 * No dice nada de la firma del token: eso lo verifica `claims.ts`.
 */
export function decodeSessionCookie(value: string): SessionTokens | null {
  if (value.length > SESSION_COOKIE_MAX_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, header, payload, signature, refresh] = parts as [string, string, string, string, string];
  if (![header, payload, signature].every((segment) => JWT_SEGMENT.test(segment))) return null;
  if (!BASE64URL.test(refresh)) return null;
  const refreshToken = Buffer.from(refresh, "base64url").toString("utf8");
  const tokens = { accessToken: `${header}.${payload}.${signature}`, refreshToken };
  // Solo vale la forma canónica: así un mismo par de tokens tiene una sola cookie.
  return encodeSessionCookie(tokens) === value ? tokens : null;
}

export type SessionCookie =
  | { kind: "absent" }
  /** Hay cookie, pero no la escribió este código: se borra y no se le pregunta a nadie. */
  | { kind: "malformed" }
  | { kind: "tokens"; tokens: SessionTokens };

export function readSessionCookie(reader: CookieReader, secure: boolean): SessionCookie {
  const value = reader.get(sessionCookieName(secure));
  if (value === undefined || value === "") return { kind: "absent" };
  const tokens = decodeSessionCookie(value);
  return tokens ? { kind: "tokens", tokens } : { kind: "malformed" };
}

/** Escribe la sesión. `false` si no cabe: no se escribió nada. */
export function writeSessionCookie(jar: CookieJar, tokens: SessionTokens, secure: boolean): boolean {
  const value = encodeSessionCookie(tokens);
  if (value === null) return false;
  jar.set(sessionCookieName(secure), value, sessionCookieOptions(secure));
  return true;
}

/**
 * Borrar es escribir vacío con los mismos atributos y vida cero. Con el prefijo `__Host-`
 * un borrado sin `Secure` y sin `Path=/` el navegador lo ignora.
 */
export function clearSessionCookie(jar: CookieJar, secure: boolean): void {
  jar.set(sessionCookieName(secure), "", { ...sessionCookieOptions(secure), maxAge: 0 });
}
