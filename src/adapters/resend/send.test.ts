import { describe, expect, it, vi } from "vitest";

import { createResendSender } from "./send";

const MAIL = { key: "CO-27:a:1", from: "Avisos <avisos@ejemplo.test>", to: "mara@prueba.test", subject: "Asunto", text: "Texto", html: "<p>Texto</p>" };

function senderAnswering(answer: Response | Error) {
  const fetchFn = vi.fn<typeof fetch>(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  return { fetchFn, send: createResendSender({ apiKey: "re_prueba", fetch: fetchFn }) };
}

describe("el adaptador de Resend", () => {
  it("manda el correo con su llave de idempotencia, y sin nada de más", async () => {
    const { fetchFn, send } = senderAnswering(new Response('{"id":"x"}', { status: 200 }));
    expect(await send(MAIL)).toBe("sent");
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_prueba");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("CO-27:a:1");
    expect(JSON.parse(String(init?.body))).toEqual({ from: MAIL.from, to: [MAIL.to], subject: MAIL.subject, text: MAIL.text, html: MAIL.html });
  });

  // La tabla de Resend: 400 y 422 no se reintentan; 401 y 403 son configuración y se arreglan sin perder el correo; 409 es una llave en curso; 429 y 5xx, después.
  it.each([
    [200, "sent"],
    [201, "sent"],
    [400, "rejected"],
    [422, "rejected"],
    [401, "retry"],
    [403, "retry"],
    [409, "retry"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ] as const)("con %i, %s", async (status, expected) => {
    const { send } = senderAnswering(new Response("{}", { status }));
    expect(await send(MAIL)).toBe(expected);
  });

  it("un corte no se trata como enviado, y no lanza", async () => {
    const { send } = senderAnswering(new Error("corte"));
    expect(await send(MAIL)).toBe("retry");
  });

  it("pide un tope de tiempo", async () => {
    const { fetchFn, send } = senderAnswering(new Response("{}", { status: 200 }));
    await send(MAIL);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
