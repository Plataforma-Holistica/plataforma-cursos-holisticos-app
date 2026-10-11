// Lo que se puede decir de un token de Auth mirando solo su texto, sin red y sin claves.
// Nada de aquí verifica una firma ni dice que un enlace sirva: eso lo hacen `claims.ts` y
// el canje. Son funciones puras, para poder probarlas con tablas.

const TOKEN_HASH = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Si un texto puede ser la huella del enlace de un correo. No dice que el enlace sirva: eso
 * solo se sabe al canjearlo. Sirve para no pintar un formulario, ni preguntarle a Auth, por
 * una dirección que nadie pudo haber recibido.
 */
export function isLinkToken(value: string): boolean {
  return TOKEN_HASH.test(value);
}

/** Lo más que mide un correo (RFC 5321). */
const EMAIL_MAX_LENGTH = 254;

/**
 * El correo que dice un token de acceso. **Solo se llama con un token cuya firma ya se
 * verificó**: de uno sin verificar, el correo lo escribe quien lo arma.
 *
 * Es para mostrárselo a su dueña («Entraste como…»): nada se decide con él. La identidad
 * sigue siendo el identificador de las claims verificadas. Nulo si el token no lo trae.
 */
export function emailClaim(accessToken: string): string | null {
  try {
    const body: unknown = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    const email = typeof body === "object" && body !== null ? (body as { email?: unknown }).email : undefined;
    return typeof email === "string" && email !== "" && email.length <= EMAIL_MAX_LENGTH ? email : null;
  } catch {
    return null;
  }
}
