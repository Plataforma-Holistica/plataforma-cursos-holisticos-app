import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reporting = vi.hoisted(() => ({ reportCaughtError: vi.fn() }));
vi.mock("@/services/error-reporting/browser", () => reporting);

import ErrorPage from "@/app/error";
import { states } from "@/messages/es/states";

beforeEach(() => vi.clearAllMocks());

describe("la pantalla de error (PA-18)", () => {
  it("le pasa al registro de errores el error que atrapó, una vez", () => {
    const error = new Error("falló el reproductor");
    const { rerender } = render(<ErrorPage error={error} retry={() => {}} />);

    rerender(<ErrorPage error={error} retry={() => {}} />);

    expect(reporting.reportCaughtError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("nunca muestra el mensaje del error", () => {
    render(<ErrorPage error={new Error("columna email duplicada")} retry={() => {}} />);

    expect(screen.queryByText(/columna email duplicada/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(states.error.title);
  });

  it("reintentar llama a lo que Next le dio para eso", async () => {
    const retry = vi.fn();
    render(<ErrorPage error={new Error("x")} retry={retry} />);

    await userEvent.click(screen.getByRole("button", { name: states.error.retry }));

    expect(retry).toHaveBeenCalledOnce();
  });
});
