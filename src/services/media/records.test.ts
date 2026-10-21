import { describe, expect, it } from "vitest";

import type { Tx } from "@/adapters/supabase/db";
import { DatabaseError } from "@/adapters/supabase/errors";

import { recordHeartbeat, type HeartbeatBeat } from "./records";

// El latido con sus tramos sobre una transacción simulada: solo lo que la integración no puede
// provocar, que la lectura de los hechos falle, o que la base conteste un progreso con otra forma. Lo demás lo prueba
// tests/integration/40-reproducciones.test.ts contra la base de verdad.

const PLAYBACK = "d0000000-0000-4000-8000-000000000004";
const LESSON = "b0000000-0000-4000-8000-000000000002";

/** Contesta la presencia y el blanco, y con los hechos hace lo que se le diga. */
function txWith(facts: () => never): Tx & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    query: (query, row) => {
      const text = query.text;
      if (text.includes("touch_playback")) {
        asked.push("presencia");
        return Promise.resolve([row.parse({ answer: { outcome: "ok" } })]);
      }
      if (text.includes("heartbeat_target")) {
        asked.push("blanco");
        return Promise.resolve([row.parse({ answer: { outcome: "found", lesson_id: LESSON, at: "2026-10-20T07:00:00.123456+00:00" } })]);
      }
      if (text.includes("media_facts")) {
        asked.push("hechos");
        return Promise.reject(facts());
      }
      asked.push("registro");
      return Promise.reject(new Error(`consulta inesperada: ${text}`));
    },
    execute: () => Promise.reject(new Error("no se usa")),
  };
}

const beat: HeartbeatBeat = {
  sessionId: PLAYBACK,
  presence: true,
  events: [{ seq: 0, from: 0, to: 30, rate: 1, visible: true }],
  decide: () => "counts",
};

describe("leer los hechos antes de registrar (T-205)", () => {
  it("un error de la base no se atrapa: la transacción ya está abortada, y el servicio repite la presencia sola", async () => {
    const tx = txWith(() => {
      throw new DatabaseError({ code: "57014", severity: "ERROR" } as ConstructorParameters<typeof DatabaseError>[0]);
    });
    await expect(recordHeartbeat(tx, beat)).rejects.toBeInstanceOf(DatabaseError);
    expect(tx.asked).toEqual(["presencia", "blanco", "hechos"]);
  });

  it("una forma inesperada sí: no se supo, no se registra, y la presencia se queda", async () => {
    const tx = txWith(() => {
      throw new TypeError("forma inesperada");
    });
    expect(await recordHeartbeat(tx, beat)).toEqual({ presence: { kind: "ok" }, batch: { kind: "unknown" } });
    expect(tx.asked).toEqual(["presencia", "blanco", "hechos"]);
  });
});

describe("el progreso que contesta la base (T-206)", () => {
  /** Todo contesta bien, y el registro trae ese progreso. */
  function txRecording(progress: unknown): Tx {
    return {
      query: (query, row) => {
        const text = query.text;
        if (text.includes("touch_playback")) return Promise.resolve([row.parse({ answer: { outcome: "ok" } })]);
        if (text.includes("heartbeat_target")) {
          return Promise.resolve([row.parse({ answer: { outcome: "found", lesson_id: LESSON, at: "2026-10-20T07:00:00.123456+00:00" } })]);
        }
        if (text.includes("media_facts")) {
          return Promise.resolve([
            row.parse({
              facts: {
                now: "2026-10-20T07:00:01Z",
                viewer: { suspended: false, email_verified: true, teacher_id: null, email: "ana@correo.com" },
                subscription: null,
                courtesy: [],
                lesson: null,
              },
              playback_id: null,
            }),
          ]);
        }
        return Promise.resolve([row.parse({ answer: { outcome: "recorded", accepted: [0], duplicate: [], rejected: [], progress } })]);
      },
      execute: () => Promise.reject(new Error("no se usa")),
    };
  }

  it("lo que dice, tal cual", async () => {
    const tracked = { outcome: "tracked", lesson_id: LESSON, covered_seconds: 30, completed: false, just_completed: false };
    expect((await recordHeartbeat(txRecording(tracked), beat))?.batch).toMatchObject({
      progress: { kind: "tracked", lessonId: LESSON, coveredSeconds: 30, completed: false, justCompleted: false },
    });
    expect((await recordHeartbeat(txRecording({ outcome: "failed", code: "P0001" }), beat))?.batch).toMatchObject({
      progress: { kind: "failed", code: "P0001" },
    });
    expect((await recordHeartbeat(txRecording(null), beat))?.batch).toMatchObject({ progress: null });
  });

  it("una forma que no se conoce no tumba el lote, que ya está en el libro: cuenta como progreso fallido", async () => {
    const answer = await recordHeartbeat(txRecording({ outcome: "tracked", lesson_id: LESSON, covered_seconds: "treinta" }), beat);
    expect(answer?.batch).toEqual({ kind: "recorded", accepted: [0], duplicate: [], rejected: [], progress: { kind: "failed", code: "unexpected_shape" } });
  });
});
