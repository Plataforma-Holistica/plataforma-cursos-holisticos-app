import "server-only";

import { asServer, asUser } from "@/adapters/supabase/db";

import type { MediaStore } from "./grant";
import { readLessonVideo, readMinimumSpeed, readWatchFacts } from "./records";

// Lo que la función única de medios le pregunta a la base.
//   · Para revisar, la lección se lee como la persona (`asUser`): la política de Contenido es
//     una segunda barrera.
//   · Para ver, como servidor: una cuenta no lee el video de nada (`video_assets` es de
//     Contenido y del maestro), y quien actúa sale de las claims verificadas. Ahí la segunda
//     barrera es `private.lesson_playback()`, que no suelta el playback id fuera de lo
//     publicado y listado, lo del maestro dueño o lo de Contenido.
//   · La velocidad mínima, como servidor: es un parámetro, que una cuenta no lee.

export const databaseMediaStore: MediaStore = {
  lessonVideo: (claims, lessonId) => asUser(claims, (tx) => readLessonVideo(tx, lessonId)),
  watchFacts: (claims, lessonId) => asServer({ claims, reason: "media_grant" }, (tx) => readWatchFacts(tx, lessonId)),
  minimumSpeed: (claims) => asServer({ claims, reason: "media_grant" }, (tx) => readMinimumSpeed(tx)),
};
