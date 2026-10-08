import { z } from "zod";

// Las variables de entorno se leen y se validan aquí, y en ningún otro lado (TRD §11.4).
// Cada tarea que integra un proveedor agrega sus variables a este esquema y a
// `.env.example`. Los parámetros de negocio no van aquí: viven en la base (RF-707).

const httpUrl = z.url({ protocol: /^https?$/ });
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

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
  // A dónde se mandan los errores (RNF-16). No es secreta: también llega al navegador.
  SENTRY_DSN: httpUrl.optional(),
});

export type Env = z.infer<typeof schema>;

type EnvName = keyof Env;
const names = Object.keys(schema.shape) as EnvName[];

// En local se puede trabajar sin ellas. Donde se atiende a personas, no: arrancar sin
// registro de errores sería quedarse a ciegas.
const requiredOutsideLocal: EnvName[] = ["SENTRY_DSN"];

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

  const result = schema.safeParse(present);
  const failed = new Set<PropertyKey | undefined>(
    result.success ? [] : result.error.issues.map((issue) => issue.path[0]),
  );
  if (present.APP_ENV === "staging" || present.APP_ENV === "production") {
    for (const name of requiredOutsideLocal) {
      if (present[name] === undefined) failed.add(name);
    }
  }
  if (result.success && failed.size === 0) return result.data;

  throw new EnvError(
    names
      .filter((name) => failed.has(name))
      .map((name) =>
        present[name] === undefined ? `${name}: falta` : `${name}: tiene un valor inválido`,
      ),
  );
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
