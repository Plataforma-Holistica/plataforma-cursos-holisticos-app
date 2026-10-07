import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // `next dev` agrega por su cuenta un bloque en inglés a CLAUDE.md. La guía de este
  // repositorio se escribe a mano y sale de la planeación, así que se apaga.
  agentRules: false,
};

export default nextConfig;
