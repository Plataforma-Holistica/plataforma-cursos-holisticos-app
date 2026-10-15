import "server-only";

import { teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createReviewQueue } from "./queue";
import { databaseReviewStore } from "./store";

// La cola de revisión y aprobar, ya armados con la guarda del equipo, la base y el registro de
// errores. Lo que importan las pantallas. Dar el código otra vez es el del catálogo
// (`giveCatalogCode`): comprueba la misma puerta de Contenido.

export type { ApproveAnswer, CourseApproved, LessonVideo, QueueRead, ReviewCourse, ReviewLesson, ReviewQueue } from "./queue";
export { APPROVE_ANSWERS, LESSON_VIDEOS } from "./queue";

export const { reviewQueue, approveCourse } = createReviewQueue({ report: reportFailure }, { teamStanding, store: databaseReviewStore });
