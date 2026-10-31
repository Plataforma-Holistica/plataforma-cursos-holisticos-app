import "server-only";

import { asServer, asUser } from "@/adapters/supabase/db";

import type { MediaStore } from "./grant";
import {
  openPlayback,
  readDraftResourceFile,
  readLessonVideo,
  readPlaybackSpeeds,
  readResourceFacts,
  readWatchFacts,
  recordDownloadHit,
  recordHeartbeat,
} from "./records";

// Lo que la función única de medios le pregunta a la base.
//   · Para revisar, la lección se lee como la persona (`asUser`): la política de Contenido es
//     una segunda barrera.
//   · Para ver, como servidor: una cuenta no lee el video de nada (`video_assets` es de
//     Contenido y del maestro), y quien actúa sale de las claims verificadas. Ahí la segunda
//     barrera es `private.lesson_playback()`, que no suelta el playback id fuera de lo
//     publicado y listado, lo del maestro dueño o lo de Contenido.
//   · Las velocidades, como servidor: son parámetros, que una cuenta no lee.
//   · Abrir una reproducción y latir (T-204), como servidor, a nombre de quien actúa y con la
//     sesión de Auth de sus claims: la base cuenta contra el cupo las de otras sesiones. El
//     latido lleva desde T-205 los tramos vistos: la presencia, los hechos y el registro van en
//     una sola transacción.
//   · Bajar un recurso (T-404), como servidor: la ruta no la lee nadie más, y la segunda barrera
//     es `private.resource_object()`. El freno cuenta en su propia transacción: si contara junto a
//     los hechos, quien no tiene acceso gastaría su cupo.

export const databaseMediaStore: MediaStore = {
  lessonVideo: (claims, lessonId) => asUser(claims, (tx) => readLessonVideo(tx, lessonId)),
  watchFacts: (claims, lessonId) => asServer({ claims, reason: "media_grant" }, (tx) => readWatchFacts(tx, lessonId)),
  playbackSpeeds: (claims) => asServer({ claims, reason: "media_grant" }, (tx) => readPlaybackSpeeds(tx)),
  openPlayback: (claims, opening) => asServer({ claims, reason: "media_grant" }, (tx) => openPlayback(tx, opening)),
  heartbeat: (claims, beat) => asServer({ claims, reason: "playback_heartbeat" }, (tx) => recordHeartbeat(tx, beat)),
  resourceFacts: (claims, resourceId) => asServer({ claims, reason: "media_grant" }, (tx) => readResourceFacts(tx, resourceId)),
  draftResourceFile: (claims, courseId, resourceId) => asServer({ claims, reason: "media_grant" }, (tx) => readDraftResourceFile(tx, courseId, resourceId)),
  downloadHit: (claims) => asServer({ claims, reason: "resource_download" }, (tx) => recordDownloadHit(tx)),
};
