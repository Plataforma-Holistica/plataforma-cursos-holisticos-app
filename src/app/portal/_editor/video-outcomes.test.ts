import { describe, expect, it } from "vitest";

import { canRetryConfirm, checkVideoFile } from "./video-outcomes";

describe("checkVideoFile", () => {
  it("el tipo primero, después el tamaño", () => {
    expect(checkVideoFile({ size: 10 }, false, 100)).toBe("fileType");
    expect(checkVideoFile({ size: 0 }, true, 100)).toBe("fileSize");
    expect(checkVideoFile({ size: 101 }, true, 100)).toBe("fileSize");
    expect(checkVideoFile({ size: 100 }, true, 100)).toBeNull();
  });

  it("sin tope leído decide la base", () => {
    expect(checkVideoFile({ size: 2 ** 40 }, true, null)).toBeNull();
  });
});

describe("canRetryConfirm", () => {
  it("solo lo que no se supo o todavía no aparece: lo demás ya no tiene fila", () => {
    expect(canRetryConfirm("unavailable")).toBe(true);
    expect(canRetryConfirm("notUploaded")).toBe(true);
    for (const problem of ["rejectedContent", "rejectedDuration", "rejectedTooLong", "rejectedType", "rejectedSize", "expired", "gone"] as const) {
      expect(canRetryConfirm(problem)).toBe(false);
    }
  });
});
