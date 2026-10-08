import "server-only";

import type { PoolConfig } from "pg";

import type { Env } from "@/config/env";

import { SUPABASE_ROOT_CA } from "./root-ca";

// Cómo entra la aplicación a la base (TRD §8.10). Función pura, para poder probarla sin
// abrir una conexión.

export interface DatabasePoolConfig extends PoolConfig {
  connectionString: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

// El error nombra la variable y nunca su valor: va a dar a los registros.
function reject(problem: string): never {
  throw new Error(`DATABASE_URL ${problem}`);
}

export function buildPoolConfig(env: Pick<Env, "APP_ENV" | "DATABASE_URL">): DatabasePoolConfig {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    return reject("no es una URL.");
  }

  // Una sola credencial para la aplicación. Por el concentrador el usuario lleva además
  // la referencia del proyecto: app_service.<ref>.
  const user = decodeURIComponent(url.username);
  if (user !== "app_service" && !user.startsWith("app_service.")) {
    reject("debe entrar como app_service. Con otro rol la base no filtra igual.");
  }

  // `pg` deja que la cadena mande sobre la configuración: un `sslmode` ahí reemplaza el
  // certificado de abajo, y `no-verify` o `disable` apagan la verificación.
  for (const name of url.searchParams.keys()) {
    const key = name.toLowerCase();
    if (key.startsWith("ssl") || key === "uselibpqcompat") {
      reject("no puede traer parámetros de TLS: la aplicación verifica el certificado por su cuenta.");
    }
  }

  return {
    connectionString: env.DATABASE_URL,
    // La base local no habla TLS. Fuera de local se verifica contra la raíz de Supabase.
    ssl: env.APP_ENV === "local" ? false : { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
    // Pocas conexiones: en Vercel hay una instancia por función y el proyecto tiene un
    // tope. Se afina con la primera ruta que use la base.
    max: 3,
    // Una conexión ociosa se suelta pronto, para no retener lugares del concentrador.
    idleTimeoutMillis: 5_000,
    // Si no hay conexión libre a tiempo, lanza en vez de colgar la petición. También es
    // lo que corta un anidamiento de transacciones que agote el grupo.
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    application_name: "plataforma",
  };
}
