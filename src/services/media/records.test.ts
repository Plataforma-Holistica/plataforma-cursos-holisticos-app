import { describe, expect, it } from "vitest";

import type { Tx } from "@/adapters/supabase/db";
import { DatabaseError } from "@/adapters/supabase/errors";

import { recordHeartbeat, type HeartbeatBeat } from "./records";

// El latido con sus tramos sobre una transacción simulada: solo lo que la integración no puede
// provocar, que la lectura de los hechos falle. Lo demás lo prueba
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
