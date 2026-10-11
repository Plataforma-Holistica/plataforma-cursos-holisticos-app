import "server-only";

import { getEnv } from "@/config/env";
import { resolveClientIp } from "@/domain/access/client-ip";

import { fingerprint, type Fingerprint } from "./fingerprint";

// De dónde viene una petición (TRD §9.2, fila «Dirección de quien pide», y §9.9).
//
// Quien tiene la petición en la mano le pasa al servicio dos cabeceras, tal cual llegaron.
// Aquí se decide qué se les cree.

/** Lo que el servicio recibe de la petición. Las dos cosas las controla quien pide. */
export interface RequestOrigin {
  /** La cabecera `x-real-ip`, sin tocar. */
  realIp: string | null;
  /** La cabecera `user-agent`, sin tocar. */
  userAgent: string | null;
}

export interface ResolvedOrigin {
  /** La huella de la dirección, o la del cubo compartido de las desconocidas. */
  readonly ip: Fingerprint;
  /**
   * La dirección se leyó de una cabecera de fiar. Una desconocida comparte cubo con todas
   * las demás desconocidas: cuenta para los topes, pero nunca queda como dispositivo de
   * confianza de nadie.
   */
  readonly known: boolean;
  /** La dirección canónica, para la evidencia de un consentimiento. Nula si no se conoce. */
  readonly address: string | null;
  /** El navegador, recortado y sin caracteres de control. Nulo si no vino. */
  readonly userAgent: string | null;
}

/** Lo más que se guarda del navegador: es un texto de fuera y va a dar a un libro. */
export const USER_AGENT_MAX_LENGTH = 512;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const UNKNOWN_IP = "unknown";

function cleanUserAgent(value: string | null): string | null {
  const clean = (value ?? "").replace(CONTROL, "").trim().slice(0, USER_AGENT_MAX_LENGTH);
  return clean === "" ? null : clean;
}

/**
 * Hay delante un alojamiento que pone `x-real-ip` y pisa la que mande quien pide. Solo en
 * un despliegue de Vercel: `VERCEL_ENV` la pone Vercel, no una persona. En local no hay
 * nadie delante, y la cabecera es de quien pide.
 */
export function proxyIsTrusted(): boolean {
  const vercelEnv = getEnv().VERCEL_ENV;
  return vercelEnv === "production" || vercelEnv === "preview";
}

export function resolveOrigin(origin: RequestOrigin, proxyTrusted: boolean): ResolvedOrigin {
  const client = resolveClientIp(origin.realIp, { proxyTrusted });
  const userAgent = cleanUserAgent(origin.userAgent);
  if (client.kind === "ip") {
    return { ip: fingerprint("ip", client.key), known: true, address: client.address, userAgent };
  }
  return { ip: fingerprint("ip", UNKNOWN_IP), known: false, address: null, userAgent };
}

/** Lo que contesta la medición de la cabecera de la dirección. Nunca trae una dirección. */
export interface OriginDrill {
  /** La cabecera llegó. */
  present: boolean;
  /** Lo que llegó es una dirección. Si no, toda petición iría al cubo de las desconocidas. */
  readable: boolean;
  /** Lo que llegó es la dirección que mandó quien hizo la prueba: la cabecera se puede falsificar. */
  matchesProbe: boolean;
  /** Este despliegue le cree a la cabecera (`proxyIsTrusted`). */
  trusted: boolean;
}

/**
 * La medición de la cabecera de la dirección (TRD §9.2, fila «Dirección de quien pide»).
 * Quien prueba manda una petición con la cabecera falsificada y esa misma dirección como
 * sonda. Si el alojamiento pisa la cabecera, lo que llega es otra dirección; si llega la
 * falsificada, los topes por dirección y el dispositivo de confianza no valen nada.
 *
 * Compara direcciones ya leídas, no textos: la misma dirección escrita de otra forma
 * cuenta como la misma. Nulo si la sonda no es una dirección.
 */
export function drillOrigin(origin: RequestOrigin, probe: string): OriginDrill | null {
  const expected = resolveClientIp(probe, { proxyTrusted: true });
  if (expected.kind !== "ip") return null;
  const seen = resolveClientIp(origin.realIp, { proxyTrusted: true });
  return {
    present: origin.realIp !== null && origin.realIp !== "",
    readable: seen.kind === "ip",
    matchesProbe: seen.kind === "ip" && seen.address === expected.address,
    trusted: proxyIsTrusted(),
  };
}
