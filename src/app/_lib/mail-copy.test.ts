import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mailCopy } = await import("./mail-copy");

// El recibo (CO-03; T-303): la cifra en pesos y la fecha en la zona del producto, que da quien arma los textos.

describe("el recibo", () => {
  it("dice la cifra en pesos, el plan y el día del cobro en la Ciudad de México", () => {
    expect(mailCopy.receipt.paid(34900, "monthly", "2026-10-01T05:30:00Z")).toBe("Recibimos tu pago de $349.00 por tu plan mensual, el 30 de septiembre de 2026.");
    expect(mailCopy.receipt.paid(299000, "annual", "2026-10-01T16:00:00+00:00")).toBe("Recibimos tu pago de $2,990.00 por tu plan anual, el 1 de octubre de 2026.");
  });
});

describe("el aviso a finanzas (CO-22)", () => {
  it("dice cuántos, el tipo en palabras y la hora del primero en la Ciudad de México", () => {
    expect(mailCopy.billingAlert.failed(1, "invoice.paid", "2026-11-07T18:00:00Z")).toBe(
      "1 aviso de cobro no se pudo procesar. Llegó el 7 de noviembre de 2026 a las 12:00 p.m., y es: Factura pagada.",
    );
    expect(mailCopy.billingAlert.failed(3, "customer.created", "2026-11-07T18:00:00Z")).toMatch(/^3 avisos de cobro no se pudieron procesar\. El primero llegó el 7 de noviembre de 2026 .*, y es: Otro tipo \(customer\.created\)\.$/);
  });
});
