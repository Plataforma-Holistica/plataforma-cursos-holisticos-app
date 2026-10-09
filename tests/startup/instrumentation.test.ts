import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El arranque (`src/instrumentation.ts`) hace dos cosas con reglas opuestas. Sin sus
// variables de entorno, la aplicación no inicia. Sin su registro de errores, sí: una
// falla del proveedor que avisa de las caídas no debe ser una caída.

const reporting = vi.hoisted(() => ({ startErrorReporting: vi.fn() }));
vi.mock("@/services/error-reporting/server", () => reporting);
vi.mock("@/services/error-reporting/request-error", () => ({ reportRequestError: vi.fn() }));

const config = vi.hoisted(() => {
  class EnvError extends Error {}
  return { EnvError, getEnv: vi.fn() };
});
vi.mock("@/config/env", () => config);

import { register } from "@/instrumentation";

let logged: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  logged.mockRestore();
  exit.mockRestore();
});

describe("el arranque", () => {
  it("valida las variables y enciende el registro de errores", async () => {
    await register();

    expect(config.getEnv).toHaveBeenCalledOnce();
    expect(reporting.startErrorReporting).toHaveBeenCalledOnce();
    expect(logged).not.toHaveBeenCalled();
  });

  it("si falta una variable, termina el proceso y no enciende nada", async () => {
    config.getEnv.mockImplementationOnce(() => {
      throw new config.EnvError("La aplicación no puede iniciar.");
    });

    await expect(register()).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logged).toHaveBeenCalledExactlyOnceWith("La aplicación no puede iniciar.");
    expect(reporting.startErrorReporting).not.toHaveBeenCalled();
  });

  it("si el registro de errores no enciende, la aplicación atiende igual, y queda dicho", async () => {
    reporting.startErrorReporting.mockImplementationOnce(() => {
      throw new Error("el SDK no pudo encender");
    });

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[0])).toContain("El registro de errores no encendió");
  });

  it("fuera de Node (el entorno Edge) no hace nada de eso", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(config.getEnv).not.toHaveBeenCalled();
    expect(reporting.startErrorReporting).not.toHaveBeenCalled();
  });
});
