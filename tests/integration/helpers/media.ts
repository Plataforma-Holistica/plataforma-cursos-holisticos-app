import type { Client } from "pg";

import { readVerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import type { MediaStore } from "@/services/media/grant";
import { readLessonVideo, readMinimumSpeed, readWatchFacts } from "@/services/media/records";

import { asOwner, asServer } from "./team";

/**
 * El almacén de la función única de medios sobre una transacción del dueño: las mismas
 * consultas que usa la aplicación (para revisar, la lección como la persona, con el rol
 * `authenticated` y sus claims; para ver, los hechos como servidor; y la velocidad como
 * servidor), pero sin confirmar. Así lo que la prueba cargó en esa transacción se ve, y nada
 * queda en la auditoría.
 */
export function mediaStoreOn(owner: Client): MediaStore {
  const tx: Tx = {
    query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
    execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
  };
  return {
    lessonVideo: async (claims, lessonId) => {
      await asOwner(owner);
      await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [
        readVerifiedClaims(claims).json,
      ]);
      try {
        return await readLessonVideo(tx, lessonId);
      } finally {
        await asOwner(owner);
      }
    },
    watchFacts: async (claims, lessonId) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await readWatchFacts(tx, lessonId);
      } finally {
        await asOwner(owner);
      }
    },
    minimumSpeed: async (claims) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await readMinimumSpeed(tx);
      } finally {
        await asOwner(owner);
      }
    },
  };
}
