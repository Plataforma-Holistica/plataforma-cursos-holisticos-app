import "server-only";

import type { PoolConfig } from "pg";

import type { Env } from "@/config/env";

import { SUPABASE_ROOT_CA } from "./root-ca";

// Cómo entra la aplicación a la base (TRD §8.10). Función pura, para poder probarla sin
// abrir una conexión.

export interface DatabasePoolConfig extends PoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

// El error nombra la variable y nunca su valor: va a dar a los registros.
function reject(problem: string): never {
  throw new Error(`DATABASE_URL ${problem}`);
}

// La propia máquina. `URL` deja la dirección IPv6 entre corchetes.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const DEFAULT_PORT = 5432;

// `env.APP_ENV` ya no decide nada aquí: el TLS depende de a dónde se conecta. Se conserva
// en la firma para que quien llama no tenga que saberlo.
export function buildPoolConfig(env: Pick<Env, "APP_ENV" | "DATABASE_URL">): DatabasePoolConfig {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    return reject("no es una URL.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    reject("no es una URL de Postgres.");
  }

  // Un `%` suelto hace lanzar a la decodificación con un error que no nombra la variable.
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return reject("tiene el usuario, la contraseña o la base mal codificados.");
  }

  // Una sola credencial para la aplicación. Por el concentrador el usuario lleva además
  // la referencia del proyecto: app_service.<ref>.
  if (user !== "app_service" && !user.startsWith("app_service.")) {
    reject("debe entrar como app_service. Con otro rol la base no filtra igual.");
  }

  // Ningún parámetro. `pg` deja que los de la cadena manden sobre todo lo demás: con
  // `?user=postgres` se entraría como dueño, con `?host=` a otro servidor, y con
  // `?sslmode=disable` sin verificar el certificado. Por lo mismo a `pg` no se le pasa la
  // cadena, sino sus partes ya revisadas.
  if ([...url.searchParams.keys()].length > 0) {
    reject("no puede traer parámetros: ni de TLS ni de ningún otro tipo.");
  }

  if (url.hostname === "" || database === "") {
    reject("debe traer el servidor y el nombre de la base.");
  }
  // Sin contraseña en la URL, `pg` tomaría la de la variable PGPASSWORD del proceso.
  if (password === "") reject("debe traer la contraseña.");

  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port === "" ? DEFAULT_PORT : Number(url.port),
    user,
    password,
    database,
    // Sin TLS solo contra la propia máquina, que es la base local. A cualquier otro
    // servidor se entra verificando su certificado contra la raíz de Supabase, diga lo
    // que diga APP_ENV: un entorno mal nombrado no manda la contraseña en claro.
    ssl: LOOPBACK_HOSTS.has(url.hostname)
      ? false
      : { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
    // Pocas conexiones: en Vercel hay una instancia por función y el proyecto tiene un
    // tope. Se afina con la primera ruta que use la base.
    max: 3,
    // Una conexión ociosa se suelta pronto, para no retener lugares del concentrador.
    idleTimeoutMillis: 5_000,
    // Si no hay conexión libre a tiempo, lanza en vez de colgar la petición.
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    application_name: "plataforma",
  };
}
