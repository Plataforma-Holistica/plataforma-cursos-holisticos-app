import type { Client } from "pg";

import { readVerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import type { MediaStore } from "@/services/media/grant";
import {
  openPlayback,
  readDraftResourceFile,
  readLessonVideo,
  readPlaybackSpeeds,
  readResourceFacts,
  readWatchFacts,
  recordDownloadHit,
  recordHeartbeat,
} from "@/services/media/records";

import { asOwner, asServer } from "./team";

/**
 * El almacén de la función única de medios sobre una transacción del dueño: las mismas
 * consultas que usa la aplicación (para revisar, la lección como la persona, con el rol
 * `authenticated` y sus claims; para ver, los hechos como servidor; y las velocidades como
 * servidor; desde T-204, abrir y latir, y desde T-205 los tramos vistos, como servidor), pero sin confirmar. Así lo que la prueba cargó en esa transacción se ve, y nada
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
    playbackSpeeds: async (claims) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await readPlaybackSpeeds(tx);
      } finally {
        await asOwner(owner);
      }
    },
    openPlayback: async (claims, opening) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await openPlayback(tx, opening);
      } finally {
        await asOwner(owner);
      }
    },
    heartbeat: async (claims, beat) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await recordHeartbeat(tx, beat);
      } finally {
        await asOwner(owner);
      }
    },
    resourceFacts: async (claims, resourceId) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await readResourceFacts(tx, resourceId);
      } finally {
        await asOwner(owner);
      }
    },
    draftResourceFile: async (claims, courseId, resourceId) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await readDraftResourceFile(tx, courseId, resourceId);
      } finally {
        await asOwner(owner);
      }
    },
    downloadHit: async (claims) => {
      await asServer(owner, claims.userId, claims.sessionId ?? "");
      try {
        return await recordDownloadHit(tx);
      } finally {
        await asOwner(owner);
      }
    },
  };
}
