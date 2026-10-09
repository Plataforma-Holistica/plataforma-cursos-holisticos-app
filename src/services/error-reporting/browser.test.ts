import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  captureBrowserError: vi.fn(),
  startBrowserErrorReporting: vi.fn(),
}));
vi.mock("@/adapters/sentry/browser", () => adapter);

import { reportCaughtError } from "./browser";

beforeEach(() => vi.clearAllMocks());

describe("reportCaughtError", () => {
  it("reporta un error que nació en el navegador", () => {
    const error = new Error("falló el reproductor");

    reportCaughtError(error);

    expect(adapter.captureBrowserError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("no repite un error del servidor, que llega con su código y ya se reportó allá", () => {
    const error = Object.assign(new Error("An error occurred in the Server Components render."), {
      digest: "4f2a91",
    });

    reportCaughtError(error);

    expect(adapter.captureBrowserError).not.toHaveBeenCalled();
  });
});
