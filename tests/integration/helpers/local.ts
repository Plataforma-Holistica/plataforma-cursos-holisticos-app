// Las pruebas de integración escriben como dueño de la base y usan la llave secreta de
// Auth: borran personas, vacían el freno y los contadores, y desactivan un guardián para
// limpiar. Nada de eso puede correr contra algo que no sea la pila local.
//
// `assertLocalStack` corre una vez, antes de la primera prueba (`global-setup.ts`): es lo
// único que cuida a quien usa la llave secreta de Auth o entra como la aplicación, y ahí
// mira solo a dónde apunta cada dirección. La conexión como dueño de la base se cuida
// además cada vez que se abre (`localOwnerUrl`), y también por su usuario y su contraseña.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} para las pruebas de integración.`);
  return value;
}

function localUrl(name: string): URL {
  let url: URL;
  try {
    url = new URL(env(name));
  } catch {
    throw new Error(`${name} no es una URL.`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${name} no apunta a la pila local. Las pruebas de integración solo corren contra 127.0.0.1 o localhost.`);
  }
  return url;
}

function localDatabaseUrl(name: string): URL {
  const url = localUrl(name);
  // `pg` deja que los parámetros de la cadena manden sobre lo demás: con `?host=` la
  // dirección pasaría por local y la conexión iría a una base remota.
  if ([...url.searchParams.keys()].length > 0) throw new Error(`${name} no puede traer parámetros.`);
  return url;
}

/** La dirección del dueño de la base, después de comprobar que es la base local. */
export function localOwnerUrl(): string {
  const url = localDatabaseUrl("DATABASE_URL_DIRECT");
  // Un túnel a una base remota también pasa por 127.0.0.1. La base local de Supabase tiene
  // un usuario y una contraseña de fábrica que ninguna base remota tiene.
  if (decodeURIComponent(url.username) !== "postgres" || decodeURIComponent(url.password) !== "postgres") {
    throw new Error("DATABASE_URL_DIRECT debe entrar como postgres, con la contraseña de fábrica de la base local.");
  }
  return env("DATABASE_URL_DIRECT");
}

/** Todo lo que las pruebas van a tocar es local: la base, por sus dos entradas, y Auth. */
export function assertLocalStack(): void {
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    throw new Error("Las pruebas de integración no corren en un despliegue de Vercel.");
  }
  localOwnerUrl();
  localDatabaseUrl("DATABASE_URL");
  localUrl("NEXT_PUBLIC_SUPABASE_URL");
}
