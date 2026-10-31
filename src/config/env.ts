import { z } from "zod";

// Las variables de entorno se leen y se validan aquí, y en ningún otro lado (TRD §11.4).
// Cada tarea que integra un proveedor agrega sus variables a este esquema y a
// `.env.example`. Los parámetros de negocio no van aquí: viven en la base (RF-707).

const httpUrl = z.url({ protocol: /^https?$/ });
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

// La dirección de Sentry: llave de letras y números, servidor y número de proyecto. Es la
// forma que el SDK acepta. Con cualquier otra no falla: avisa en la consola y se queda
// sin mandar nada, y la aplicación arrancaría «con» registro de errores y sin él.
const sentryDsn = /^https?:\/\/[0-9a-z]+@[^\s/@]+\/(?:[^\s/@]+\/)*\d+$/i;

// Las llaves de los datos fiscales: `versión:base64:comprobación`, separadas por comas (T-409). Aquí solo se revisa su forma (este
// archivo también se compila para Edge y no importa `node:crypto`); que abran lo dice el cifrado al usarlas.
const piiKeyEntry = "[1-9][0-9]{0,4}:[A-Za-z0-9+/]{43}=:[0-9a-f]{8}";
const piiKeys = new RegExp(`^${piiKeyEntry}(?:,${piiKeyEntry})*$`);

const schema = z.object({
  APP_ENV: z.enum(["local", "staging", "production"]),
  NEXT_PUBLIC_SITE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string(),
  SUPABASE_SECRET_KEY: z.string(),
  // Por el concentrador de conexiones: la que usa la aplicación.
  DATABASE_URL: postgresUrl,
  // Directa: solo para migraciones.
  DATABASE_URL_DIRECT: postgresUrl,
  // Secreta, solo en el servidor. Con ella se calculan las huellas del correo y de la
  // dirección de quien pide, para el freno y los topes (TRD §9.9): la base no guarda ni
  // el correo ni la dirección. Uno corto se adivina probando.
  RATE_LIMIT_HMAC_SECRET: z.string().min(32),
  // A dónde se mandan los errores (RNF-16). No es secreta: también llega al navegador.
  SENTRY_DSN: z.string().regex(sentryDsn).optional(),
  // La pone Vercel, no una persona: `production`, `preview` o `development`. Sirve de
  // segunda opinión sobre APP_ENV, que sí se escribe a mano en el panel.
  VERCEL_ENV: z.string().optional(),
  // También de Vercel: el nombre del servidor de la vista previa de la rama, sin
  // protocolo. De ahí sale la dirección del sitio en una vista previa (abajo).
  VERCEL_BRANCH_URL: z.string().optional(),
  // La llave con que se firman las direcciones de los videos de Mux (T-108; TRD §7.2 y
  // §9.4). Secreta, solo en el servidor. Opcionales: sin ellas no hay video, y lo demás
  // funciona igual. Van juntas. El token de la API de Mux no va aquí: solo lo usa el guion
  // local que sube los videos de prueba.
  MUX_SIGNING_KEY_ID: z.string().regex(/^[A-Za-z0-9]{8,64}$/).optional(),
  MUX_SIGNING_PRIVATE_KEY: z.string().refine(looksLikePrivateKey).optional(),
  // Las llaves con que se cifran los datos fiscales del maestro (T-409; TRD §9.7), y cuál cifra hoy. Secretas, solo en el servidor,
  // y con una copia fuera de línea: sin la llave, lo cifrado no se vuelve a leer. Opcionales: sin ellas lo fiscal no está
  // disponible y lo demás funciona igual. Van juntas. Antes de salir a producción son obligatorias (06 §8).
  PII_ENCRYPTION_KEYS: z.string().regex(piiKeys).optional(),
  PII_ENCRYPTION_ACTIVE_VERSION: z.string().regex(/^[1-9][0-9]{0,4}$/).optional(),
});

// La llave privada de firma, en PEM o en base64, como la entrega Mux. Aquí solo se revisa su
// forma (no se importa `node:crypto`: este archivo también se compila para Edge); que sea
// una llave que firma lo dice el adaptador al usarla.
function looksLikePrivateKey(value: string): boolean {
  const privatePem = /-----BEGIN (RSA )?PRIVATE KEY-----/;
  if (privatePem.test(value)) return true;
  try {
    return privatePem.test(atob(value.replace(/\s+/g, "")));
  } catch {
    return false;
  }
}

// El nombre de un servidor y nada más: sin protocolo, sin ruta, sin usuario.
const hostName = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

export type Env = z.infer<typeof schema>;

type EnvName = keyof Env;
const names = Object.keys(schema.shape) as EnvName[];

// En local se puede trabajar sin ellas. Donde se atiende a personas, no: arrancar sin
// registro de errores sería quedarse a ciegas.
const requiredOutsideLocal: EnvName[] = ["SENTRY_DSN"];

// Variables que no se admiten. El SDK de Sentry lee esta por su cuenta, sin pasar por
// aquí, y con ella prende las trazas: otra recolección, que no pasa por el filtro de los
// errores. Eso se decide en el código y con su revisión, no desde el panel de Vercel. Las
// otras que el SDK lee (SENTRY_SPOTLIGHT, SENTRY_TRACE_LIFECYCLE) no hace falta
// prohibirlas: el adaptador las deja sin efecto al fijar su opción (TRD §10.5).
const forbidden = ["SENTRY_TRACES_SAMPLE_RATE"];

// El error nombra las variables y nunca sus valores: va a dar a los registros.
export class EnvError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `La aplicación no puede iniciar. Variables de entorno con problema:\n${problems
        .map((problem) => `  - ${problem}`)
        .join("\n")}\nLa lista completa está en .env.example.`,
    );
    this.name = "EnvError";
    this.problems = problems;
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  // Una variable vacía cuenta como ausente.
  const present: Partial<Record<EnvName, string>> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== "") present[name] = value;
  }

  // Cada rama tiene su vista previa, con su propia dirección: una variable fija habría
  // que ponerla a mano en Vercel, rama por rama. En una vista previa se deduce de la que
  // Vercel le da a la rama. Solo ahí: producción tiene una sola dirección, la del
  // dominio, y se escribe, porque de ella salen los enlaces de los correos.
  if (
    present.NEXT_PUBLIC_SITE_URL === undefined &&
    present.VERCEL_ENV === "preview" &&
    present.VERCEL_BRANCH_URL !== undefined &&
    hostName.test(present.VERCEL_BRANCH_URL)
  ) {
    present.NEXT_PUBLIC_SITE_URL = `https://${present.VERCEL_BRANCH_URL}`;
  }

  const result = schema.safeParse(present);
  const failed = new Set<PropertyKey | undefined>(
    result.success ? [] : result.error.issues.map((issue) => issue.path[0]),
  );
  if (present.APP_ENV === "staging" || present.APP_ENV === "production") {
    for (const name of requiredOutsideLocal) {
      if (present[name] === undefined) failed.add(name);
    }
    // Y cifrada. Sin cifrar solo en local, para probar contra un receptor en la máquina.
    if (present.SENTRY_DSN?.startsWith("http://")) failed.add("SENTRY_DSN");
  }
  // La llave de firma va completa o no va: con una sola de las dos no se firma nada, y eso
  // se diría como «no hay video» cuando es configuración.
  if ((present.MUX_SIGNING_KEY_ID === undefined) !== (present.MUX_SIGNING_PRIVATE_KEY === undefined)) {
    failed.add(present.MUX_SIGNING_KEY_ID === undefined ? "MUX_SIGNING_KEY_ID" : "MUX_SIGNING_PRIVATE_KEY");
  }
  // Las llaves de los datos fiscales van juntas, y la que cifra tiene que estar en la lista.
  if ((present.PII_ENCRYPTION_KEYS === undefined) !== (present.PII_ENCRYPTION_ACTIVE_VERSION === undefined)) {
    failed.add(present.PII_ENCRYPTION_KEYS === undefined ? "PII_ENCRYPTION_KEYS" : "PII_ENCRYPTION_ACTIVE_VERSION");
  } else if (
    result.success &&
    present.PII_ENCRYPTION_KEYS !== undefined &&
    !present.PII_ENCRYPTION_KEYS.split(",").some((entry) => entry.split(":")[0] === present.PII_ENCRYPTION_ACTIVE_VERSION)
  ) {
    failed.add("PII_ENCRYPTION_ACTIVE_VERSION");
  }
  const unwelcome = forbidden.filter((name) => source[name] !== undefined && source[name] !== "");
  if (result.success && failed.size === 0 && unwelcome.length === 0) return result.data;

  throw new EnvError([
    ...names
      .filter((name) => failed.has(name))
      .map((name) =>
        present[name] === undefined ? `${name}: falta` : `${name}: tiene un valor inválido`,
      ),
    ...unwelcome.map((name) => `${name}: no se admite`),
  ]);
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
