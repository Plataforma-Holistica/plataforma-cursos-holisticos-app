import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Las páginas `*.dev.tsx` solo existen con `pnpm dev`: son para ver los componentes a ojo
// (src/app/muestra/). En la compilación de producción no son páginas, y no salen.
const PAGE_EXTENSIONS = ["tsx", "ts"];

function nextConfig(phase: string): NextConfig {
  return {
    poweredByHeader: false,
    // `next dev` agrega por su cuenta un bloque en inglés a CLAUDE.md. La guía de este
    // repositorio se escribe a mano y sale de la planeación, así que se apaga.
    agentRules: false,
    pageExtensions:
      phase === PHASE_DEVELOPMENT_SERVER ? ["dev.tsx", ...PAGE_EXTENSIONS] : PAGE_EXTENSIONS,
    // Lo poco que el navegador puede saber (src/config/public-env.ts). Se copia de las
    // variables del servidor al compilar, para configurar cada valor una sola vez.
    // Ninguna es secreta: la dirección de Sentry está hecha para ser pública.
    env: {
      NEXT_PUBLIC_APP_ENV: process.env.APP_ENV ?? "",
      NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN ?? "",
    },
  };
}

// Sentry (RNF-16). Al compilar sube los mapas de código, para que un error apunte a
// nuestro código y no al comprimido, y los borra de lo que se publica.
//
// Solo se suben donde se compila lo que se publica: en Vercel, que es donde vive la llave
// (`SENTRY_AUTH_TOKEN`). Una compilación en local o en la integración continua no sube
// nada, aunque alguien tenga la llave en su máquina: esos mapas no son de nada publicado.
const uploadSourceMaps = process.env.VERCEL === "1" && Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: "plataforma-holistica",
  project: "plataforma-holistica",
  authToken: uploadSourceMaps ? process.env.SENTRY_AUTH_TOKEN : undefined,
  sourcemaps: { disable: !uploadSourceMaps },
  // El paso que habla con Sentry al terminar de compilar. Apagar los mapas no basta: aun
  // así registraría una versión, con solo encontrar la llave en el entorno.
  useRunAfterProductionCompileHook: uploadSourceMaps,
  // El complemento de compilación manda sus propias estadísticas de uso a Sentry.
  telemetry: false,
  // Por omisión el SDK mete en el paquete del navegador la lista de todas las rutas de
  // la aplicación, para nombrar sus trazas. No hay trazas, y la lista (con las rutas de
  // administración) no tiene por qué ser pública.
  routeManifestInjection: false,
  silent: !process.env.CI,
});
