import type { ErrorEvent } from "@sentry/nextjs";

// El filtro por el que pasa todo error antes de salir hacia Sentry (TRD §9.10 y §10.5: a
// Sentry llegan errores sin datos personales).
//
// No quita lo malo de un evento: arma uno nuevo, de cero, y solo copia lo que conoce. Lo
// que no está en sus listas no sale, sea lo que sea. La primera versión hacía lo
// contrario (enmascarar y filtrar por nombre de clave) y las revisiones mostraron que a
// una lista de cosas prohibidas siempre le falta una: una clave que nadie previó, un
// campo que agrega una versión nueva del SDK, un objeto lanzado como error que llega
// entero en `extra`.
//
// Conocer la clave tampoco basta: cada valor se copia solo si tiene su forma (un número
// donde va un número, un identificador con forma de identificador), y todo texto pasa por
// las reglas de abajo. Nada se copia tal cual llegó.
//
// Las reglas reconocen formas (un correo, un RFC, una llave), no significados: un nombre
// propio pasa. Por eso la regla de la guía no cambia: el mensaje de un error no lleva el
// dato de una persona.
//
// Corre igual en el servidor y en el navegador: no importa nada de Node.

const TRIMMED = "[recortado]";

// Cuánto de un texto sale, y cuánto se revisa. Lo que sirve de un mensaje de error está
// al principio. Se revisa una ventana más grande que lo que sale para que el recorte no
// parta un dato a la mitad y deje un trozo a la vista.
const MAX_TEXT = 2_000;
export const SCAN_WINDOW = 4_000;
// Lo que se desecha al final de una ventana que cortó el texto: ahí puede haber quedado
// la mitad de un dato, sin su forma completa para reconocerlo. Cubre el dato más largo
// que una regla necesita ver entero: las credenciales de una cadena de conexión.
const CUT_MARGIN = 450;

type Rule = readonly [RegExp, string];

// Secretos, direcciones y correos. Se aplican a todo texto que sale, también a lo que
// anota el SDK: ninguna da un falso positivo que estorbe para diagnosticar.
//
// El orden importa: lo primero le quita material a lo que sigue. Todas las repeticiones
// tienen tope, para que un texto armado con mala intención no haga tardar al filtro.
const SECRET_RULES: readonly Rule[] = [
  // Una llave privada, hasta el final del texto.
  [/-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*/g, "[llave]"],
  // El usuario y la contraseña que van antes de la arroba en una cadena de conexión. La
  // contraseña puede traer arrobas: se toma hasta la última antes de la primera diagonal.
  [/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/:@]{0,100}:[^\s/]{1,300}@/gi, "$1[credenciales]@"],
  // Un secreto escrito con su nombre: `password=...`, `refresh_token: ...`, o dentro de
  // un JSON. El nombre se queda; el valor no.
  [
    /([\w-]{0,40}(?:password|passwd|pwd|contrase[nñ]a|token|apikey|api_key|secret|clave)[\w-]{0,40})["']?\s*[=:]\s*["']?[^\s&"',}]{1,200}["']?/gi,
    "$1=[filtrado]",
  ],
  // Una dirección completa, con sus parámetros o su ancla.
  [/((?:https?|wss?):\/\/[^\s?#"'<>]{1,2000})[?#][^\s"'<>]*/g, "$1"],
  // Una ruta relativa, con sus parámetros: «GET /cuenta/verificar?token_hash=...».
  [/(^|[\s"'(=:`[,{])(\/[^\s?#"'<>)`]{0,500})[?#][^\s"'<>)`]*/g, "$1$2"],
  // Lo que la base repite cuando rechaza una fila: el valor que chocó (hasta el fin de la
  // línea) y la fila entera (hasta el fin del texto, porque puede traer saltos de línea).
  // En inglés y en español, que es como responde según su configuración.
  [/((?:Key|llave) \([^\n]{0,200}?\)=)[^\n]*/gi, "$1([valor])"],
  [/((?:Failing row contains|La fila que falla contiene) )\([\s\S]*/gi, "$1([fila])"],
  // Un token: con su palabra delante, o con la forma de uno de sesión (dos o tres partes).
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [token]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}/g, "[token]"],
  // Llaves de proveedores, por su prefijo. Las que no son secretas (un identificador de
  // sesión de cobro, una llave publicable) no se tocan.
  [
    /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|(?:sb_secret|sbp|sntry[a-z]|gh[pousr]|github_pat)_[A-Za-z0-9_=-]{8,}|re_[A-Za-z0-9]{6,}_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|[a-z]{2,8}_[A-Za-z0-9]{4,}_secret_[A-Za-z0-9]{4,})/g,
    "[llave]",
  ],
  // Un correo, con letras de cualquier alfabeto, y también codificado en una dirección
  // (%40, o %2540 si se codificó dos veces). El dominio termina en letras: así
  // `sentry+core@11.5.0` no pasa por correo.
  [
    /[\p{L}\p{N}._%+-]{1,64}(?:@|%(?:25){0,3}40)[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}/gu,
    "[correo]",
  ],
];

// Una fecha de seis dígitos (año, mes, día), que es lo que llevan en medio el RFC y la
// CURP. Exigirla quita casi todos los falsos positivos de esas dos reglas.
const DATE = "\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])";

const IDENTITY_RULES: readonly Rule[] = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  // Una IP de las largas: cuatro grupos o más, con su abreviatura de dos puntos dobles.
  // Una hora (10:15:30) tiene tres.
  [/(?<![\w:])(?:[0-9a-f]{1,4}:{1,2}){3,7}[0-9a-f]{1,4}(?![\w:])/gi, "[ip]"],
  // La CURP antes que el RFC: empieza igual.
  [new RegExp(`\\b[A-Z]{4}${DATE}[HM][A-Z]{5}[A-Z0-9]\\d\\b`, "gi"), "[curp]"],
  [new RegExp(`\\b[A-ZÑ&]{3,4}-?${DATE}-?[A-Z0-9]{3}\\b`, "gi"), "[rfc]"],
];

// Lo que solo se busca en el mensaje de un error. En lo que anota el SDK (versiones,
// fechas, identificadores) estas formas dan falsos positivos y destruyen el diagnóstico.
const MESSAGE_RULES: readonly Rule[] = [
  ...IDENTITY_RULES,
  // Diez dígitos o más, con hasta tres separadores entre uno y otro: un teléfono, una
  // cuenta, una tarjeta. No pegado a otro dígito, ni a un decimal, ni a un tramo de un
  // identificador (un UUID), para no romperlos.
  [/(?<!\d|\d\.|[0-9a-f]{4}-)\+?\(?\d(?:[\s().-]{0,3}\d){9,}(?!\d)/gi, "[número]"],
];

// Lo que se busca en una ruta o en el nombre de un archivo. El número solo cuenta si va
// suelto, entre separadores: pegado a letras es el nombre de un archivo compilado, y
// cambiarlo le impediría a Sentry traducir la pila al código original.
const PATH_RULES: readonly Rule[] = [
  ...IDENTITY_RULES,
  [/(?<![\w.-])\d{10,}(?![\w-])/g, "[número]"],
];

type Kind = "note" | "path" | "message";

const EXTRA_RULES: Record<Kind, readonly Rule[]> = {
  note: [],
  path: PATH_RULES,
  message: MESSAGE_RULES,
};

function applyRules(text: string, rules: readonly Rule[]): string {
  let clean = text;
  for (const [pattern, replacement] of rules) clean = clean.replace(pattern, replacement);
  return clean;
}

function mask(text: string, kind: Kind): string {
  const cut = text.length > SCAN_WINDOW;
  const clean = applyRules(
    applyRules(cut ? text.slice(0, SCAN_WINDOW) : text, SECRET_RULES),
    EXTRA_RULES[kind],
  );

  const limit = cut ? Math.min(MAX_TEXT, Math.max(0, clean.length - CUT_MARGIN)) : MAX_TEXT;
  return clean.length > limit || cut ? `${clean.slice(0, limit)}…${TRIMMED}` : clean;
}

// --- Las formas -------------------------------------------------------------------------
//
// Cada una recibe lo que venga y devuelve el valor si tiene su forma, o `undefined`.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Shape = (value: unknown) => unknown;

/** Un texto escrito por alguien: el mensaje de un error, o lo que salió de él. */
const asMessage: Shape = (value) => (typeof value === "string" ? mask(value, "message") : undefined);
/** Un texto que anotó el SDK: se le quitan secretos y correos, no números ni fechas. */
const asNote: Shape = (value) => (typeof value === "string" ? mask(value, "note") : undefined);
/** Una dirección, una ruta o el nombre de un archivo: sin parámetros ni ancla. */
const asPath: Shape = (value) =>
  typeof value === "string" ? mask(value.replace(/[?#].*$/s, ""), "path") : undefined;
const asNumber: Shape = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asBoolean: Shape = (value) => (typeof value === "boolean" ? value : undefined);

const matching =
  (pattern: RegExp): Shape =>
  (value) =>
    typeof value === "string" && pattern.test(value) ? value : undefined;

const asEventId = matching(/^[0-9a-f]{32}$/i);
const asDebugId = matching(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i);
const asLevel = matching(/^(fatal|error|warning|log|info|debug)$/);
const asMethod = matching(/^[A-Za-z]{1,10}$/);
const asWord = matching(/^[\w.:@/+-]{1,100}$/);
// El identificador de una persona es el de su perfil: opaco. Un correo puesto ahí no pasa.
const asUuid = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** Copia `key` de `source` a `target` solo si está y tiene la forma que pide `shape`. */
function carry(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  shape: Shape,
): void {
  const value = shape(source[key]);
  if (value !== undefined) target[key] = value;
}

/** Un objeto nuevo, con las claves de `shapes` que `source` traiga con su forma. */
function pick(source: unknown, shapes: Record<string, Shape>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(source)) return out;
  for (const [key, shape] of Object.entries(shapes)) carry(out, source, key, shape);
  return out;
}

const isEmpty = (value: Record<string, unknown>) => Object.keys(value).length === 0;

/** Una lista nueva con lo que quede de cada elemento, sin los que quedaron vacíos. */
const listOf =
  (shapes: Record<string, Shape>): Shape =>
  (value) =>
    Array.isArray(value)
      ? value.map((item) => pick(item, shapes)).filter((item) => !isEmpty(item))
      : undefined;

// --- La pila ----------------------------------------------------------------------------

// Lo que se conserva de cada punto de la pila: dónde. Ni las variables (`vars`) ni las
// líneas de código de alrededor: el SDK las leía del disco, de cualquier archivo que la
// pila nombrara, y la pila sale del texto del error. Sentry muestra el código a partir de
// los mapas que se suben al compilar.
//
// El SDK arma la pila leyendo ese texto, y toma por un punto cada línea del mensaje que
// se le parezca. Por eso el nombre de la función pasa por las reglas del mensaje, y el
// del archivo y el del módulo (que sale del archivo) por las de una ruta.
const FRAME: Record<string, Shape> = {
  filename: asPath,
  abs_path: asPath,
  module: asPath,
  function: asMessage,
  lineno: asNumber,
  colno: asNumber,
  in_app: asBoolean,
};

// Si el filtro falló: dónde, y nada que pueda venir del mensaje.
const MINIMAL_FRAME: Record<string, Shape> = {
  filename: asPath,
  lineno: asNumber,
  colno: asNumber,
  in_app: asBoolean,
};

// Qué atrapó el error y si se atrapó, más lo que dice cuál excepción es causa de cuál
// cuando vienen varias. No los datos que el SDK le cuelgue (`data`).
const MECHANISM: Record<string, Shape> = {
  type: asNote,
  handled: asBoolean,
  synthetic: asBoolean,
  exception_id: asNumber,
  parent_id: asNumber,
  is_exception_group: asBoolean,
  source: asNote,
};

const framesOf =
  (shapes: Record<string, Shape>): Shape =>
  (stacktrace) =>
    isRecord(stacktrace) && Array.isArray(stacktrace.frames)
      ? { frames: stacktrace.frames.map((frame: unknown) => pick(frame, shapes)) }
      : undefined;

const EXCEPTION: Record<string, Shape> = {
  // El nombre del error también lo escribe alguien: `error.name = ...`.
  type: asMessage,
  value: asMessage,
  mechanism: (value) => (isRecord(value) ? pick(value, MECHANISM) : undefined),
  stacktrace: framesOf(FRAME),
};

const MINIMAL_EXCEPTION: Record<string, Shape> = {
  type: asMessage,
  stacktrace: framesOf(MINIMAL_FRAME),
};

const exceptionsOf =
  (shapes: Record<string, Shape>): Shape =>
  (exception) =>
    isRecord(exception) && Array.isArray(exception.values)
      ? { values: exception.values.map((value: unknown) => pick(value, shapes)) }
      : undefined;

// --- El rastro --------------------------------------------------------------------------

// Del rastro de lo que pasó antes del error solo sirve, y solo sale, por dónde se navegó
// y qué se pidió. Lo demás (la consola, los clics, lo que se tecleó) puede traer lo que
// la persona veía o escribía.
const BREADCRUMB_CATEGORIES = new Set(["navigation", "fetch", "xhr", "http"]);

const BREADCRUMB: Record<string, Shape> = {
  type: asWord,
  category: asWord,
  level: asLevel,
  timestamp: asNumber,
  data: (value) =>
    isRecord(value)
      ? pick(value, { method: asMethod, status_code: asNumber, url: asPath, from: asPath, to: asPath })
      : undefined,
};

const asBreadcrumbs: Shape = (value) => {
  if (!Array.isArray(value)) return undefined;
  const kept = value
    .filter(
      (item) =>
        isRecord(item) &&
        typeof item.category === "string" &&
        BREADCRUMB_CATEGORIES.has(item.category),
    )
    .map((item) => pick(item, BREADCRUMB));
  return kept.length > 0 ? kept : undefined;
};

// --- El entorno -------------------------------------------------------------------------

// Los contextos que el propio SDK anota: qué máquina, qué programa, qué ruta. Cualquier
// otro lo puso alguien más, y no sale. `culture` (el idioma y la zona horaria de la
// persona) tampoco.
const SDK_CONTEXTS = [
  "app",
  "browser",
  "cloud_resource",
  "device",
  "nextjs",
  "os",
  "react",
  "runtime",
  "trace",
];

// Dentro de un contexto, las claves cuyo valor es una ruta: pierden sus parámetros.
const PATH_KEYS = new Set(["request_path", "router_path", "url", "path", "pathname"]);

// Un contexto del SDK es plano. Lo que venga anidado no es suyo: no sale.
const asContext: Shape = (context) => {
  if (!isRecord(context)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(context)) {
    carry(out, context, key, (value) =>
      typeof value === "string"
        ? (PATH_KEYS.has(key) ? asPath : asNote)(value)
        : (asNumber(value) ?? asBoolean(value)),
    );
  }
  return out;
};

const asContexts: Shape = (contexts) => {
  const out = pick(contexts, Object.fromEntries(SDK_CONTEXTS.map((name) => [name, asContext])));
  return isEmpty(out) ? undefined : out;
};

// Las etiquetas que pueden salir. Una etiqueta nueva se agrega aquí, a la vista de quien
// revisa, y su valor nunca es el dato de una persona.
const ALLOWED_TAGS = ["turbopack", "filtro_fallido"];

const asTagValue: Shape = (value) => asNote(value) ?? asNumber(value) ?? asBoolean(value);

const asTags: Shape = (tags) => {
  const out = pick(tags, Object.fromEntries(ALLOWED_TAGS.map((name) => [name, asTagValue])));
  return isEmpty(out) ? undefined : out;
};

// --- El evento --------------------------------------------------------------------------

const PACKAGE: Record<string, Shape> = { name: asWord, version: asWord };

// Con qué se mandó. `settings.infer_ip` es lo que le dice a Sentry que no deduzca la IP.
const SDK: Record<string, Shape> = {
  name: asWord,
  version: asWord,
  integrations: (value) =>
    Array.isArray(value) ? value.filter((name) => asWord(name) !== undefined) : undefined,
  packages: listOf(PACKAGE),
  settings: (value) => (isRecord(value) ? pick(value, { infer_ip: asWord }) : undefined),
};

// Lo que le permite a Sentry traducir la pila al código original.
const IMAGE: Record<string, Shape> = { type: asWord, code_file: asPath, debug_id: asDebugId };

// Lo que identifica al evento y lo que Sentry necesita para procesarlo.
const STRUCTURAL: Record<string, Shape> = {
  event_id: asEventId,
  timestamp: asNumber,
  level: asLevel,
  platform: asWord,
  // Estos tres salen de variables de entorno o de la compilación. No llevan las reglas
  // de números: el nombre de una versión es un identificador, y puede traer diez dígitos.
  environment: asNote,
  release: asNote,
  dist: asNote,
  sdk: (value) => (isRecord(value) ? pick(value, SDK) : undefined),
  debug_meta: (value) => (isRecord(value) ? pick(value, { images: listOf(IMAGE) }) : undefined),
};

const EVENT: Record<string, Shape> = {
  ...STRUCTURAL,
  // De la persona, solo su identificador, y solo si es opaco.
  user: (value) => {
    const user = pick(value, { id: asUuid });
    return isEmpty(user) ? undefined : user;
  },
  // De la petición, qué se pidió. Ni cookies, ni cabeceras, ni cuerpo, ni parámetros.
  request: (value) => (isRecord(value) ? pick(value, { method: asMethod, url: asPath }) : undefined),
  transaction: asPath,
  message: asMessage,
  exception: exceptionsOf(EXCEPTION),
  breadcrumbs: asBreadcrumbs,
  contexts: asContexts,
  tags: asTags,
  // `extra` no está: ahí llega, entero, cualquier objeto que se lance como error.
};

const asEvent = (out: Record<string, unknown>) =>
  ({ type: undefined, ...out }) as unknown as ErrorEvent;

// Si el filtro falla, el error se manda igual, pero sin un solo texto libre: qué tipo de
// error fue y dónde. Callarlo sería quedarse a ciegas; mandarlo entero, arriesgar un dato.
function minimal(event: unknown): ErrorEvent {
  const out = pick(event, STRUCTURAL);
  out.level = "error";
  out.tags = { filtro_fallido: "si" };
  try {
    if (isRecord(event)) carry(out, event, "exception", exceptionsOf(MINIMAL_EXCEPTION));
  } catch {
    // Sin la pila, entonces: lo que identifica al evento ya está.
  }
  return asEvent(out);
}

/** Treinta y dos dígitos hexadecimales al azar: la forma del identificador de un evento. */
function newEventId(): string {
  let id = "";
  for (let i = 0; i < 32; i += 1) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  try {
    return asEvent(pick(event, EVENT));
  } catch {
    try {
      return minimal(event);
    } catch {
      // Ni eso se pudo armar: un aviso que no toma nada del evento. Lleva identificador y
      // hora propios, porque sin ellos Sentry podría no aceptarlo.
      return {
        type: undefined,
        event_id: newEventId(),
        timestamp: Date.now() / 1000,
        level: "error",
        message: "El filtro de datos personales falló dos veces: el evento se descartó.",
        tags: { filtro_fallido: "dos veces" },
      };
    }
  }
}
