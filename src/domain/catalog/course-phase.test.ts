import { describe, expect, it } from "vitest";

import { COURSE_STATES, isEditable, isInReview, PENDING_VERSIONS } from "./course-phase";

// Qué se edita y qué se revisa (T-405, versiones), por estado del curso y de su versión pendiente. La misma regla que `private.course_editable` y
// `private.course_reviewing` en la base: una versión de un curso publicado vive como `changes_pending`, nunca como `in_review`.

describe("en qué fase está un curso", () => {
  const cases = [
    ["draft", null, true, false],
    ["in_review", null, false, true],
    ["published", null, false, false],
    ["withdrawn", null, false, false],
    ["changes_pending", "draft", true, false],
    ["changes_pending", "in_review", false, true],
    ["changes_pending", null, false, false],
    ["draft", "draft", true, false],
    ["published", "draft", false, false],
    ["in_review", "in_review", false, true],
  ] as const;

  it.each(cases)("%s con versión %s: se edita %s, se revisa %s", (state, pending, editable, reviewing) => {
    expect(isEditable(state, pending)).toBe(editable);
    expect(isInReview(state, pending)).toBe(reviewing);
  });

  it("nunca se edita y se revisa a la vez", () => {
    for (const state of COURSE_STATES) {
      for (const pending of [...PENDING_VERSIONS, null]) expect(isEditable(state, pending) && isInReview(state, pending)).toBe(false);
    }
  });
});
