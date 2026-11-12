import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { a11yViolations } from "../setup/a11y";

import { PaywallState } from "@/app/_catalog/paywall-state";

// PA-33 con el lenguaje del sistema visual (T-616, solicitud 3): un estado con la flor, en su tamaño chico para el lugar del
// reproductor, con el motivo y el botón a los planes con la lección como destino (T-302). Qué dice cada motivo lo prueba
// la regla de `paywall.ts`; aquí, que el estado lo pinte.

const BACK = "/cursos/respirar/lecciones/b0000000-0000-4000-8000-000000000002";

describe("PaywallState (PA-33)", () => {
  it("quien nunca se suscribió: el título, la frase y «Ver planes» con la lección como destino", async () => {
    const { container } = render(<PaywallState denial={{ reason: "never_subscribed" }} back={BACK} />);
    expect(screen.getByText("Esta lección pide una suscripción")).toBeVisible();
    expect(screen.getByText("Con una suscripción ves todo el catálogo.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Ver planes" })).toHaveAttribute("href", `/planes?volver=${encodeURIComponent(BACK)}`);
    // La semilla de la flor, decorativa, en su tamaño chico.
    const seed = container.querySelector("svg");
    expect(seed).toHaveAttribute("aria-hidden", "true");
    expect(seed).toHaveClass("size-12");
    expect(await a11yViolations(container)).toEqual([]);
  });

  it("a quien se le terminó: la fecha en el título y «Volver a suscribirme»", () => {
    render(<PaywallState denial={{ reason: "expired", date: "3 de noviembre de 2026" }} back={BACK} />);
    expect(screen.getByText("Tu acceso terminó el 3 de noviembre de 2026")).toBeVisible();
    expect(screen.getByRole("link", { name: "Volver a suscribirme" })).toHaveAttribute("href", `/planes?volver=${encodeURIComponent(BACK)}`);
  });

  it("sin destino, los planes a secas", () => {
    render(<PaywallState denial={{ reason: "refunded", date: "3 de noviembre de 2026" }} back={null} />);
    expect(screen.getByRole("link", { name: "Ver planes" })).toHaveAttribute("href", "/planes");
  });
});
