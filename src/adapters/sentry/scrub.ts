import type { ErrorEvent } from "@sentry/nextjs";

// El filtro por el que pasa todo error antes de salir hacia Sentry (TRD §9.10 y §10.5: a
// Sentry llegan errores sin datos personales).
//
// Es la segunda barrera. La primera es no recolectar (`options.ts`). Esta existe porque
// un dato puede venir dentro de un texto que nadie controla: el mensaje de un error de la
// base trae el valor que chocó, y una dirección trae su token.
//
// No es perfecta ni puede serlo: reconoce formas (un correo, un RFC, una llave), no
// significados. Un nombre propio escrito en un mensaje pasa. Por eso la regla de la guía
// no cambia: el mensaje de un error no lleva el dato de una persona.
//
// Corre igual en el servidor y en el navegador: no importa nada de Node.

const FILTERED = "[filtrado]";
const TRIMMED = "[recortado]";

// Antes de revisar un texto se recorta. Lo que sirve de un mensaje de error está al
// principio, y un texto enorme (la base repite lo que no pudo leer) haría tardar segundos
// a las expresiones de abajo, con el servidor detenido mientras tanto.
const MAX_TEXT = 2_000;

// Sentry ya normaliza el evento a esta profundidad o menos. Es un tope, por si acaso.
const MAX_DEPTH = 12;

// Qué se enmascara en un texto libre, en orden: lo primero le quita material a lo que
// sigue (una dirección pierde sus parámetros antes de buscarle correos).
const TEXT_RULES: readonly (readonly [RegExp, string])[] = [
  // El usuario y la contraseña que van antes de la arroba en una cadena de conexión.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[credenciales]@"],
  // Una dirección completa, con sus parámetros o su ancla.
  [/(https?:\/\/[^\s?#"'<>)]+)[?#][^\s"'<>)]*/g, "$1"],
  // Una ruta relativa, con sus parámetros: «GET /cuenta/verificar?token_hash=...».
  [/(^|[\s"'(=])(\/[^\s?#"'<>)]*)[?#][^\s"'<>)]*/g, "$1$2"],
  // Lo que la base repite cuando rechaza una fila: el valor que chocó, y la fila entera.
  [/(Key \([^)]*\)=)\([^)]*\)/g, "$1([valor])"],
  [/(Failing row contains )\(.*\)/g, "$1([fila])"],
  // El token de una sesión.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[token]"],
  // Llaves e identificadores de proveedores: sk_live_..., cs_test_..., sb_secret_...
  [/\b(?:[a-z]{2,6}_(?:live|test)|sb_(?:secret|publishable))_[A-Za-z0-9_-]{8,}/g, "[llave]"],
  // Un correo, con letras de cualquier alfabeto, y también codificado en una dirección
  // (%40). El dominio termina en letras: así `sentry+core@11.5.0` no pasa por correo.
  [/[\p{L}\p{N}._%+-]+(?:@|%40)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu, "[correo]"],
  // La CURP antes que el RFC: empieza igual.
  [/\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/g, "[curp]"],
  [/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g, "[rfc]"],
  // Diez dígitos o más, con o sin separadores: un teléfono, una cuenta, una tarjeta. No
  // pegado a letras ni a un guion, para no romper un identificador (un UUID, una traza).
  [/(?<![\w.-])\+?\d(?:[\s().-]?\d){9,}(?!\w)/g, "[número]"],
];

// Claves cuyo valor es una dirección o una ruta: se les quitan los parámetros enteros.
const URL_KEYS = new Set([
  "url",
  "to",
  "from",
  "href",
  "referrer",
  "referer",
  "path",
  "pathname",
  "request_path",
  "router_path",
]);

// Nombres de clave cuyo valor no sale nunca, diga lo que diga. Pecar de más no cuesta: lo
// que se pierde es un dato de diagnóstico, no un dato de una persona.
const SENSITIVE_KEY =
  /pass|contrase[nñ]a|secret|token|jwt|authorization|cookie|session|api[-_]?key|clave|llave|e-?mail|correo|tel[eé]fono|phone|nombre|apellido|user[-_]?name|full[-_]?name|rfc|curp|clabe|iban|cuenta|card|tarjeta|cvv|direcci[oó]n|domicilio|nacimiento|birth|^name$|^ip$|^ip[-_]|[-_]ip$/i;

// Los contextos que el propio SDK anota del entorno: qué máquina, qué programa, qué ruta.
// Sus claves son suyas (`runtime.name` es «node», no el nombre de nadie), así que no se
// filtran por nombre. Cualquier otro contexto lo puso nuestro código, y sí.
const SDK_CONTEXTS = new Set([
  "app",
  "browser",
  "cloud_resource",
  "culture",
  "device",
  "nextjs",
  "os",
  "react",
  "runtime",
  "trace",
]);

// El identificador de una persona es el de su perfil: opaco. Un correo puesto ahí no pasa.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskText(text: string): string {
  let clean = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…${TRIMMED}` : text;
  for (const [pattern, replacement] of TEXT_RULES) clean = clean.replace(pattern, replacement);
  return clean;
}

function stripQuery(url: string): string {
  return maskText(url.replace(/[?#].*$/s, ""));
}

interface WalkOptions {
  /** Filtrar además por nombre de clave. Solo donde las claves las pone nuestro código. */
  byKey: boolean;
}

function walk(value: unknown, options: WalkOptions, depth = 0): unknown {
  if (typeof value === "string") return maskText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return TRIMMED;

  if (Array.isArray(value)) return value.map((item) => walk(item, options, depth + 1));

  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (options.byKey && SENSITIVE_KEY.test(key)) clean[key] = FILTERED;
    else if (URL_KEYS.has(key) && typeof item === "string") clean[key] = stripQuery(item);
    else clean[key] = walk(item, options, depth + 1);
  }
  return clean;
}

const text = <T>(value: T): T => walk(value, { byKey: false }) as T;
const data = <T>(value: T): T => walk(value, { byKey: true }) as T;

function scrub(event: ErrorEvent): ErrorEvent {
  const clean: ErrorEvent = { ...event };

  // De la persona, solo su identificador, y solo si es opaco.
  delete clean.user;
  const userId = event.user?.id;
  if (typeof userId === "string" && UUID.test(userId)) clean.user = { id: userId };

  // De la petición, qué se pidió. Ni cookies, ni cabeceras, ni cuerpo, ni parámetros.
  if (event.request) {
    clean.request = {
      ...(event.request.method === undefined ? {} : { method: event.request.method }),
      ...(event.request.url === undefined ? {} : { url: stripQuery(event.request.url) }),
    };
  }

  if (event.message !== undefined) clean.message = maskText(event.message);
  if (event.transaction !== undefined) clean.transaction = stripQuery(event.transaction);
  if (event.logentry) clean.logentry = text(event.logentry);

  if (event.exception?.values) {
    clean.exception = {
      ...event.exception,
      // El tipo y la pila se quedan como están: son lo que sirve para diagnosticar. De la
      // pila solo se quitan los valores de las variables, por si una versión del SDK los
      // trajera a pesar de tenerlos apagados.
      values: event.exception.values.map((exception) => ({
        ...exception,
        ...(exception.value === undefined ? {} : { value: maskText(exception.value) }),
        ...(exception.mechanism ? { mechanism: text(exception.mechanism) } : {}),
        ...(exception.stacktrace?.frames
          ? {
              stacktrace: {
                ...exception.stacktrace,
                frames: exception.stacktrace.frames.map((frame) => {
                  if (frame.vars === undefined) return frame;
                  const rest = { ...frame };
                  delete rest.vars;
                  return rest;
                }),
              },
            }
          : {}),
      })),
    };
  }

  if (event.breadcrumbs) {
    clean.breadcrumbs = event.breadcrumbs.map((breadcrumb) => ({
      ...text(breadcrumb),
      ...(breadcrumb.data ? { data: data(breadcrumb.data) } : {}),
    }));
  }

  if (event.extra) clean.extra = data(event.extra);
  if (event.tags) clean.tags = data(event.tags);
  if (event.contexts) {
    clean.contexts = Object.fromEntries(
      Object.entries(event.contexts).map(([name, context]) => [
        name,
        SDK_CONTEXTS.has(name) ? text(context) : data(context),
      ]),
    );
  }

  return clean;
}

// Si el filtro falla, el error se manda igual, pero sin un solo texto libre: qué tipo de
// error fue y dónde. Callarlo sería quedarse a ciegas; mandarlo entero, arriesgar un dato.
function minimal(event: ErrorEvent): ErrorEvent {
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    environment: event.environment,
    release: event.release,
    sdk: event.sdk,
    // Sin esto Sentry no puede traducir la pila al código original.
    debug_meta: event.debug_meta,
    tags: { filtro_fallido: "si" },
    exception: {
      values: (event.exception?.values ?? []).map((exception) => ({
        type: exception.type,
        stacktrace: exception.stacktrace,
      })),
    },
  };
}

// Y si ni eso se pudo armar, un aviso que no toma nada del evento.
const DISCARDED: ErrorEvent = Object.freeze({
  type: undefined,
  level: "error",
  message: "El filtro de datos personales falló dos veces: el evento se descartó.",
  tags: { filtro_fallido: "dos veces" },
}) as ErrorEvent;

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  try {
    return scrub(event);
  } catch {
    try {
      return minimal(event);
    } catch {
      return { ...DISCARDED, tags: { ...DISCARDED.tags } };
    }
  }
}
