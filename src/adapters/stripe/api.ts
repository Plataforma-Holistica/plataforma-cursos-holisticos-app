// Stripe, con `fetch` y sin su SDK (T-303), como Mux y Resend. La lectura (`createStripeApi`) basta con una llave restringida de solo lectura (`rk_`); la escritura
// (`createStripeWriter`, T-302) solo crea el cliente y la sesión de pago y vence una sesión, con su propia llave: el servidor nunca le cobra a nadie, cobra la página de
// Stripe. La versión de la API va fija, porque de ella depende la forma de lo que contesta (la de la cuenta al 2026-11-06). Nada lanza. Cada respuesta dice lo que
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

/**
 * Lo que contesta una escritura. `rejected` es «no se creó» (un 4xx que no es de idempotencia: repetirla no la arregla); `unknown` es «pudo haberse creado» (un 409,
 * un 400 de idempotencia, un 429, un 5xx, la red o el tiempo): se repite la misma petición con la misma llave, y Stripe devuelve lo que ya hizo.
 */
export type StripeWriteAnswer =
  | { status: "ok"; body: unknown }
  | { status: "rejected" }
  | { status: "not_found" }
  | { status: "unauthorized" }
  | { status: "unknown" };

/** Una escritura: la ruta, el formulario y la llave de idempotencia, que hace que repetirla devuelva lo mismo. */
export type StripePost = (path: string, form: Readonly<Record<string, string>>, idempotencyKey: string) => Promise<StripeWriteAnswer>;

/** Las únicas escrituras: crear el cliente, crear la sesión de pago y vencer una sesión. */
const WRITABLE = /^\/v1\/(customers|checkout\/sessions|checkout\/sessions\/cs_(test|live)_[A-Za-z0-9]{1,250}\/expire)$/;
/** La llave de idempotencia: un verbo, el identificador de la fila que la origina y, si hace falta, el modo. Sin datos personales. */
const IDEMPOTENCY_KEY = /^[a-z_]{1,20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[a-z_]{1,20})?$/;

export function createStripeWriter(deps: { secretKey: string; fetch?: typeof fetch }): StripePost {
  const send = deps.fetch ?? fetch;
  return async (path, form, idempotencyKey) => {
    if (!WRITABLE.test(path) || !IDEMPOTENCY_KEY.test(idempotencyKey)) return { status: "rejected" };
    try {
      const response = await send(`${API}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": idempotencyKey,
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 200) return { status: "ok", body: (await response.json()) as unknown };
      if (response.status === 404) return { status: "not_found" };
      if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
      if (response.status === 400 || response.status === 402) {
        // Del error solo se lee su tipo: sus mensajes pueden traer datos de la cuenta.
        const type = await errorType(response);
        return type === "idempotency_error" ? { status: "unknown" } : { status: "rejected" };
      }
      return { status: "unknown" };
    } catch {
      return { status: "unknown" };
    }
  };
}

async function errorType(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { type?: unknown } };
    return typeof body?.error?.type === "string" ? body.error.type : null;
  } catch {
    return null;
  }
}
