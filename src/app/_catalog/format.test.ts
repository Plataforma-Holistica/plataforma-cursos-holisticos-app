import { describe, expect, it, vi } from "vitest";

import { courseDuration, lessonMinutes } from "./format";

vi.mock("server-only", () => ({}));

describe("cómo se escribe una duración", () => {
  it.each([
    [10, "1 min"],
    [89, "1 min"],
    [91, "2 min"],
    [356, "6 min"],
  ])("una lección de %i s: %s", (seconds, expected) => {
    expect(lessonMinutes(seconds)).toBe(expected);
  });

  it.each([
    [765, "13 min"],
    [3540, "59 min"],
    [3600, "1 hora"],
    [7200, "2 horas"],
    [5100, "1 h 25 min"],
  ])("un curso de %i s: %s", (seconds, expected) => {
    expect(courseDuration(seconds)).toBe(expected);
  });
});
