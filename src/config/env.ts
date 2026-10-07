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
});

export type Env = z.infer<typeof schema>;

type EnvName = keyof Env;
const names = Object.keys(schema.shape) as EnvName[];

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
  const present = Object.fromEntries(
    names.map((name) => [name, source[name] === "" ? undefined : source[name]]),
  );

  const result = schema.safeParse(present);
  if (result.success) return result.data;

  const failed = new Set(result.error.issues.map((issue) => issue.path[0]));
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
