import "server-only";

import { asServer, asUser } from "@/adapters/supabase/db";

import type { MediaStore } from "./grant";
import { readLessonVideo, readMinimumSpeed } from "./records";

// Lo que la función única de medios le pregunta a la base. La lección se lee como la persona
// (`asUser`): la política de Contenido es una segunda barrera. La velocidad mínima, como
// servidor: es un parámetro, que una cuenta no lee.

export const databaseMediaStore: MediaStore = {
  lessonVideo: (claims, lessonId) => asUser(claims, (tx) => readLessonVideo(tx, lessonId)),
  minimumSpeed: (claims) => asServer({ claims, reason: "media_grant" }, (tx) => readMinimumSpeed(tx)),
};
