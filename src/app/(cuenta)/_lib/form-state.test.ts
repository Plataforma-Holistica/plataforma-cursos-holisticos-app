import { describe, expect, it } from "vitest";

import { nextAttempt } from "./form-state";

// Lo único que una acción lee del estado anterior, que viaja por el navegador.

describe("el número del intento que sigue", () => {
  it.each([
    [{ kind: "idle" }, 1],
    [{ attempt: 0 }, 1],
    [{ attempt: 1 }, 2],
    [{ attempt: 3, kind: "invalid" }, 4],
    [{ attempt: 999_999 }, 1_000_000],
  ])("%j: %i", (previous, expected) => {
    expect(nextAttempt(previous)).toBe(expected);
  });

  it.each([null, undefined, "3", 3, [], {}, { attempt: "1" }, { attempt: -1 }, { attempt: 1.5 }, { attempt: Number.NaN }, { attempt: Infinity }, { attempt: 1_000_000 }, { attempt: null }])(
    "con un estado que no se entiende es el primero: %j",
    (previous) => {
      expect(nextAttempt(previous)).toBe(1);
    },
  );
});
