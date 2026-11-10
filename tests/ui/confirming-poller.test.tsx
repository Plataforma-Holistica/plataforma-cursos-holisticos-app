import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PA-32 (T-302): con JavaScript vuelve a pedir la página cada 3 s, y a los 20 s dice que está tardando. «Actualizar» queda siempre,
// que es lo que hay sin JavaScript.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { ConfirmingPoller } from "@/app/suscripcion/confirmando/poller";

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PA-32, la espera", () => {
  it("pregunta cada 3 s, y a los 20 s dice que está tardando y que no vuelva a pagar", () => {
    render(<ConfirmingPoller self="/suscripcion/confirmando?sesion=cs_test_1" />);
    expect(screen.getByRole("heading", { name: "Estamos confirmando tu pago" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Actualizar" })).toHaveAttribute("href", "/suscripcion/confirmando?sesion=cs_test_1");

    act(() => vi.advanceTimersByTime(2_999));
    expect(router.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(router.refresh).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(17_000));
    expect(router.refresh).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("heading", { name: "Está tardando más de lo normal" })).toBeInTheDocument();
    expect(screen.getByText(/No vuelvas a pagar/)).toBeInTheDocument();
  });

  it("al irse deja de preguntar", () => {
    const { unmount } = render(<ConfirmingPoller self="/suscripcion/confirmando?sesion=cs_test_1" />);
    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
