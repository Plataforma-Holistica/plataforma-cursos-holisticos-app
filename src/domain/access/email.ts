// La forma de un correo y su forma normalizada (TRD §5.1, RF-101).
//
// La normalizada es la que el servicio manda a Supabase Auth y de la que calcula la huella
// con secreto del freno y de los topes. Tiene que coincidir con lo que Auth considera la
// misma cuenta, o un mismo buzón tendría dos huellas (y el freno se evadiría cambiando una
// mayúscula). Auth pasa el correo a minúsculas y no recorta espacios; aquí se hacen las dos
// cosas. No se tocan los puntos ni las etiquetas con `+`: para Auth son cuentas distintas.

/** El máximo que admite un correo. Auth corta en 255 bytes. */
export const EMAIL_MAX_LENGTH = 254;

const LOCAL_MAX_LENGTH = 64;

// Solo ASCII visible, sin espacios. La validación de Auth tampoco admite otra cosa: un
// correo con eñe o con acento no se puede registrar.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
// Grupos de caracteres permitidos separados por un punto: ni al inicio, ni al final, ni dos
// seguidos. Sin comillas ni comentarios.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// Una etiqueta del dominio: letras, dígitos y guiones, sin guion en los extremos, hasta 63.
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type EmailResult =
  | {
      ok: true;
      /** Sin espacios en los extremos y en minúsculas: la identidad de la cuenta. */
      email: string;
      /**
       * El buzón al que llega: el correo sin la etiqueta que sigue al `+`. Solo para el
       * tope de correos por dirección, para que `ana+1@…`, `ana+2@…` no sirvan para
       * inundar un mismo buzón. No es la identidad de la cuenta.
       */
      mailbox: string;
    }
  | { ok: false; reason: "empty" | "too_long" | "malformed" };

export function parseEmail(input: string): EmailResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > EMAIL_MAX_LENGTH) return { ok: false, reason: "too_long" };
  // Antes de pasar a minúsculas: el signo de Kelvin (U+212A) se convierte en «k», y dos
  // textos distintos darían el mismo correo.
  if (!VISIBLE_ASCII.test(trimmed)) return { ok: false, reason: "malformed" };

  const email = trimmed.toLowerCase();
  // La primera arroba parte el correo. Una segunda caería en el dominio, donde ninguna
  // etiqueta la admite, y una parte local vacía no pasa su propia revisión: no hace falta
  // buscar ninguna de las dos aparte.
  const at = email.indexOf("@");
  if (at === -1) return { ok: false, reason: "malformed" };

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > LOCAL_MAX_LENGTH || !LOCAL_PART.test(local)) return { ok: false, reason: "malformed" };

  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) {
    return { ok: false, reason: "malformed" };
  }

  const plus = local.indexOf("+");
  const mailbox = plus > 0 ? `${local.slice(0, plus)}@${domain}` : email;
  return { ok: true, email, mailbox };
}
