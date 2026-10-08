import type { ErrorEvent } from "@sentry/nextjs";

// El filtro por el que pasa todo error antes de salir hacia Sentry (TRD §9.10 y §10.5: a
// Sentry llegan errores sin datos personales).
//
// Es la segunda barrera. La primera es no recolectar (`options.ts`). Esta existe porque
// un dato puede venir dentro de un texto que nadie controla: el mensaje de un error de la
// base trae el valor que chocó, y una dirección trae su token.
//
// Corre igual en el servidor y en el navegador: no importa nada de Node.

const MASKED_EMAIL = "[correo]";
const FILTERED = "[filtrado]";
const TRIMMED = "[recortado]";

// El dominio tiene que terminar en letras: así `sentry+core@11.5.0` no pasa por correo.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Una dirección completa dentro de un texto, con sus parámetros o su ancla.
const URL_WITH_QUERY = /(https?:\/\/[^\s?#"'<>)]+)[?#][^\s"'<>)]*/g;

// Claves cuyo valor es una dirección entera: las de la petición y las de las migas de
// navegación y de red.
const URL_KEYS = new Set(["url", "to", "from", "href"]);

// Nombres de clave cuyo valor no sale nunca, diga lo que diga. Pecar de más no cuesta: lo
// que se pierde es un dato de diagnóstico, no un dato de una persona.
const SENSITIVE_KEY =
  /pass|contrase[nñ]a|secret|token|authorization|cookie|api[-_]?key|e-?mail|correo|tel[eé]fono|phone|nombre|full[-_]?name|rfc|curp|direcci[oó]n/i;

// Sentry ya normaliza el evento a esta profundidad o menos. Es un tope, por si acaso.
const MAX_DEPTH = 12;

function maskText(text: string): string {
  return text.replace(URL_WITH_QUERY, "$1").replace(EMAIL, MASKED_EMAIL);
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

  // De la persona, solo su identificador, que es opaco.
  delete clean.user;
  if (event.user?.id !== undefined) clean.user = { id: event.user.id };

  // De la petición, qué se pidió. Ni cookies, ni cabeceras, ni cuerpo, ni parámetros.
  if (event.request) {
    clean.request = {
      ...(event.request.method === undefined ? {} : { method: event.request.method }),
      ...(event.request.url === undefined ? {} : { url: stripQuery(event.request.url) }),
    };
  }

  if (event.message !== undefined) clean.message = maskText(event.message);
  if (event.transaction !== undefined) clean.transaction = maskText(event.transaction);
  if (event.logentry) clean.logentry = text(event.logentry);

  if (event.exception?.values) {
    clean.exception = {
      ...event.exception,
      // El tipo y la pila se quedan como están: son lo que sirve para diagnosticar.
      values: event.exception.values.map((exception) => ({
        ...exception,
        ...(exception.value === undefined ? {} : { value: maskText(exception.value) }),
        ...(exception.mechanism ? { mechanism: text(exception.mechanism) } : {}),
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
  if (event.contexts) clean.contexts = data(event.contexts);
  if (event.tags) clean.tags = data(event.tags);

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

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  try {
    return scrub(event);
  } catch {
    return minimal(event);
  }
}
