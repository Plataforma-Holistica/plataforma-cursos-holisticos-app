import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { readCappedBody } = await import("./request-body");

// El cuerpo crudo con tope (T-303): los bytes tal como llegaron, y nulo al pasar el tope, sin leer de más.

function streaming(parts: Uint8Array[]) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts[pulled++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
  return { request: new Request("https://x.test/api/webhooks/stripe", { method: "POST", body, duplex: "half" } as RequestInit), pulled: () => pulled };
}

describe("el cuerpo con tope", () => {
  it("junta los bytes como llegaron, también partidos y fuera de ASCII", async () => {
    const text = new TextEncoder().encode('{"name":"Ana Peña"}');
    const { request } = streaming([text.slice(0, 5), text.slice(5)]);
    expect(new TextDecoder().decode((await readCappedBody(request, 1024))!)).toBe('{"name":"Ana Peña"}');
  });

  it("justo en el tope vale; uno más no, y deja de leer", async () => {
    expect((await readCappedBody(streaming([new Uint8Array(8)]).request, 8))?.byteLength).toBe(8);
    const big = streaming([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
    expect(await readCappedBody(big.request, 8)).toBeNull();
    expect(big.pulled()).toBeLessThan(4);
  });

  it("sin cuerpo es vacío", async () => {
    expect((await readCappedBody(new Request("https://x.test", { method: "POST" }), 8))?.byteLength).toBe(0);
  });
});
