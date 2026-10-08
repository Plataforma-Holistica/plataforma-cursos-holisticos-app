import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Las páginas `*.dev.tsx` solo existen con `pnpm dev`: son para ver los componentes a ojo
// (src/app/muestra/). En la compilación de producción no son páginas, y no salen.
const PAGE_EXTENSIONS = ["tsx", "ts"];

export default function nextConfig(phase: string): NextConfig {
  return {
    poweredByHeader: false,
    // `next dev` agrega por su cuenta un bloque en inglés a CLAUDE.md. La guía de este
    // repositorio se escribe a mano y sale de la planeación, así que se apaga.
    agentRules: false,
    pageExtensions:
      phase === PHASE_DEVELOPMENT_SERVER ? ["dev.tsx", ...PAGE_EXTENSIONS] : PAGE_EXTENSIONS,
  };
}
