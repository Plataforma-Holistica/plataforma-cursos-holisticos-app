import { denialOf, paywallCopy } from "@/app/_catalog/paywall";
import { resources as text } from "@/messages/es/resources";
import type { ResourceGrant } from "@/services/media/media";

import { DOWNLOAD_CHANNEL_FIELD, DOWNLOAD_CHANNEL_JS } from "./channel";

// Bajar un recurso (RF-308; FL-14; T-404): qué pide el formulario y qué hace la pantalla con cada respuesta de la puerta de
// medios. Es puro. Del formulario solo sale qué recurso y si hay JavaScript; quién pide lo dice la sesión.
//
// Dos canales, medidos en un navegador. Con JavaScript, una acción que redirige a otro origen deja al enrutador esperando una
// página, y un adjunto no la trae: por eso la dirección vuelve en el estado y la abre el navegador. Sin JavaScript no hay
// enrutador: la acción redirige, el navegador baja el adjunto y se queda donde estaba, y la dirección no viaja en ningún
// estado, que React mandaría dentro de todo formulario ligado a la acción.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DO = "download:";

export const downloadButton = (resource: string) => `${DO}${resource}`;

export type DownloadRequest = { kind: "none" } | { kind: "download"; resource: string; javascript: boolean };

/** Qué botón se pulsó. Sin uno, con más de uno, o con algo que no es eso, cuenta como vacío. */
export function readDownloadForm(form: unknown): DownloadRequest {
  if (!(form instanceof FormData)) return { kind: "none" };
  const pressed = form.getAll("do");
  const [only] = pressed;
  if (pressed.length !== 1 || typeof only !== "string" || !only.startsWith(DO)) return { kind: "none" };
  const resource = only.slice(DO.length);
  if (!ID.test(resource)) return { kind: "none" };
  return { kind: "download", resource, javascript: form.get(DOWNLOAD_CHANNEL_FIELD) === DOWNLOAD_CHANNEL_JS };
}

/** Lo que pinta una fila después de un envío. */
export type DownloadState =
  | { kind: "idle" }
  /** Solo con JavaScript: la abre el navegador. */
  | { kind: "granted"; url: string; attempt: number }
  /** PA-33, ya en palabras: junto al recurso. */
  | { kind: "denied"; title: string; text: string; attempt: number }
  | { kind: "gone" | "throttled" | "unavailable"; attempt: number }
  /** La sesión ya no pasa: se vuelve a pedir la página, donde decide su guarda. */
  | { kind: "reload"; attempt: number };

export type DownloadOutcome = DownloadState | { kind: "redirect"; url: string };

export function downloadOutcome(grant: ResourceGrant, javascript: boolean, attempt: number): DownloadOutcome {
  switch (grant.kind) {
    case "granted":
      return javascript ? { kind: "granted", url: grant.url, attempt } : { kind: "redirect", url: grant.url };
    case "not_found":
      return { kind: "gone", attempt };
    case "throttled":
    case "unavailable":
      return { kind: grant.kind, attempt };
    case "suspended":
    case "refused":
      return { kind: "reload", attempt };
    case "denied": {
      const denial = denialOf(grant.account);
      if (denial === null) return { kind: "reload", attempt };
      const [title, reason] = paywallCopy(denial);
      return { kind: "denied", title: denial.reason === "never_subscribed" ? text.neverSubscribed : title, text: reason, attempt };
    }
  }
}
