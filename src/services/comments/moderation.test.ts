import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const env = vi.hoisted(() => ({ MODERATION_PROVIDER: undefined as string | undefined }));
vi.mock("@/config/env", () => ({ getEnv: () => env }));

import { activeModeration, testModeration } from "./moderation";

describe("el proveedor de prueba del filtro (T-502)", () => {
  it("decide por las marcas del texto, sin red", async () => {
    expect(await testModeration.classify("Hola a todos")).toBe("pass");
    expect(await testModeration.classify("Esto [revisar]")).toBe("flagged");
    expect(await testModeration.classify("Esto [riesgo]")).toBe("risk");
    expect(await testModeration.classify("Esto [sin-filtro]")).toBeNull();
  });

  it("solo con MODERATION_PROVIDER=test; sin ella no hay proveedor", () => {
    env.MODERATION_PROVIDER = undefined;
    expect(activeModeration()).toBeNull();
    env.MODERATION_PROVIDER = "test";
    expect(activeModeration()).toBe(testModeration);
  });
});
