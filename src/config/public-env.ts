// Lo poco de la configuración que el navegador puede saber. Ninguna es secreta.
//
// No se validan aquí: salen de las variables del servidor, que `env.ts` valida al
// arrancar, y `next.config.ts` las copia al compilar. Así cada valor se configura una
// sola vez. Este archivo no importa `env.ts`: eso metería en la descarga los nombres de
// todas las variables del servidor.
//
// Tienen que leerse así, una por una y con su nombre completo: Next sustituye cada
// lectura por su valor al compilar, y no reconoce otra forma.

const orUndefined = (value: string | undefined) => (value === "" ? undefined : value);

export const publicEnv = {
  /** `local`, `staging` o `production`. */
  appEnv: orUndefined(process.env.NEXT_PUBLIC_APP_ENV),
  /** A dónde manda el navegador sus errores. Sin ella, no manda nada. */
  sentryDsn: orUndefined(process.env.NEXT_PUBLIC_SENTRY_DSN),
};
