import { describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";

import type { ContinueRowData } from "./continue";
import { createProgress } from "./progress";

vi.mock("@/adapters/supabase/db", () => ({ asUser: vi.fn() }));
vi.mock("@/services/error-reporting/server", () => ({ reportFailure: vi.fn() }));

// El servicio de «continuar viendo», con su almacén simulado. Contra la base de verdad, en
// tests/integration/40-leccion.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const ROW: ContinueRowData = {
  courseSlug: "respirar",
  courseTitle: "Respirar",
  teacherName: "Ana",
  lastWatchedAt: new Date("2026-10-20T12:00:00Z"),
  lastLessonId: "l1",
  lessonId: "l1",
  lessonTitle: "Primera",
  modulePosition: 1,
  lessonPosition: 1,
  completed: false,
};

function progressWith(rows: ContinueRowData[] | "throws") {
  const reported: string[] = [];
  const asked: VerifiedClaims[] = [];
  const service = createProgress({
    store: {
      continueRows: (who) => {
        asked.push(who);
        return rows === "throws" ? Promise.reject(new Error("sin base")) : Promise.resolve(rows);
      },
    },
    report: (code) => {
      reported.push(code);
      return Promise.resolve();
    },
  });
  return { ...service, reported, asked };
}

describe("continuar viendo", () => {
  it("lee con las claims de quien mira y arma la lista", async () => {
    const service = progressWith([ROW]);
    expect(await service.continueWatching(claims)).toEqual({
      kind: "ready",
      courses: [{ courseSlug: "respirar", courseTitle: "Respirar", teacherName: "Ana", completed: 0, total: 1, lesson: { id: "l1", title: "Primera", number: 1 } }],
    });
    expect(service.asked).toEqual([claims]);
    expect(service.reported).toEqual([]);
  });

  it("sin cursos empezados, la lista vacía", async () => {
    expect(await progressWith([]).continueWatching(claims)).toEqual({ kind: "ready", courses: [] });
  });

  it("si no se supo, se reporta y no hay lista", async () => {
    const service = progressWith("throws");
    expect(await service.continueWatching(claims)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["continue_watching_unavailable"]);
  });
});
