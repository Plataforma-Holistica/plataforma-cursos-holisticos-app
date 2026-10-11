import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

// Para llamar a una acción de servidor sin pasar por su pantalla, como haría quien la
// busca directo: con los campos ocultos con que React nombra la acción, y con lo que se
// quiera mandar en lugar de lo que el formulario mandaría.

const decode = (text: string) => text.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&#x27;", "'");

/** Los campos ocultos del primer formulario de una página que tenga una acción de servidor. */
export function actionFields(html: string): Record<string, string> {
  for (const [, form = ""] of html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
    const hidden: Record<string, string> = {};
    for (const [input] of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]*)"/.exec(input)?.[1];
      if (name) hidden[decode(name)] = decode(/value="([^"]*)"/.exec(input)?.[1] ?? "");
    }
    if (Object.keys(hidden).some((name) => name.startsWith("$ACTION"))) return hidden;
  }
  throw new Error("La página no trae ningún formulario con una acción de servidor.");
}

export type Field = string | { name: string; mimeType: string; buffer: Buffer };

/** Envía un formulario a una acción, tal cual, sin seguir redirecciones. */
export function postAction(
  request: APIRequestContext,
  path: string,
  fields: Record<string, Field>,
  origin = "http://localhost:3000",
): Promise<APIResponse> {
  return request.post(path, { multipart: fields, headers: { Origin: origin }, maxRedirects: 0 });
}

/**
 * Espera a que React haya tomado el formulario de la pantalla. Antes de eso un envío sale
 * como el de cualquier formulario, sin JavaScript: funciona igual, pero una prueba de lo
 * que solo hace el navegador (revisar antes de enviar, validar al salir del campo) tiene
 * que esperar a que el navegador ya esté a cargo.
 */
export async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const form = document.querySelector("form");
    return form !== null && Object.keys(form).some((key) => key.startsWith("__reactFiber"));
  });
}
