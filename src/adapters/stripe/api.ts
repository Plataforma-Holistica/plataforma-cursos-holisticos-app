// Stripe, con `fetch` y sin su SDK (T-303), como Mux y Resend. Solo lee: el servidor nunca le cobra a nadie desde aquí, y basta una llave restringida de solo lectura
// (`rk_`). La versión de la API va fija, porque de ella depende la forma de lo que contesta (la de la cuenta al 2026-11-06). Nada lanza. Cada respuesta dice lo que
// se puede hacer con ella: `not_found` (no está), `rejected` (un 400: la petición no sirve, y repetirla no la arregla), `unauthorized` (la llave no sirve: es
// configuración) y `unavailable` (no se supo: se vuelve a intentar). De lo que contesta solo se lee el JSON de un 200: sus mensajes de error pueden traer datos de la
// cuenta.

export const STRIPE_API_VERSION = "2026-10-28.endive";

const API = "https://api.stripe.com";
const TIMEOUT_MS = 5_000;

export type StripeAnswer =
  | { status: "ok"; body: unknown }
  | { status: "not_found" }
  | { status: "rejected" }
  | { status: "unauthorized" }
  | { status: "unavailable" };

/** Una lectura de la API: la ruta (`/v1/...`) y sus parámetros, con `expand[]` repetido si hace falta. */
export type StripeGet = (path: string, query?: Readonly<Record<string, string | readonly string[]>>) => Promise<StripeAnswer>;

export function createStripeApi(deps: { secretKey: string; fetch?: typeof fetch }): StripeGet {
  const send = deps.fetch ?? fetch;
  return async (path, query = {}) => {
    if (!/^\/v1\/[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) return { status: "rejected" };
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      for (const each of typeof value === "string" ? [value] : value) params.append(name, each);
    }
    const url = `${API}${path}${params.size > 0 ? `?${params.toString()}` : ""}`;
    try {
      const response = await send(url, {
        method: "GET",
        headers: { authorization: `Bearer ${deps.secretKey}`, "stripe-version": STRIPE_API_VERSION },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404) return { status: "not_found" };
      if (response.status === 400) return { status: "rejected" };
      if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
      if (response.status !== 200) return { status: "unavailable" };
      return { status: "ok", body: (await response.json()) as unknown };
    } catch {
      return { status: "unavailable" };
    }
  };
}
