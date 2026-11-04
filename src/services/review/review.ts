import "server-only";

import { teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";
import { createVideoProviders } from "@/services/media/video-provider";

import { createReviewQueue } from "./queue";
import { databaseReviewStore } from "./store";

// La cola de revisión y aprobar, ya armados con la guarda del equipo, la base y el registro de
// errores. Lo que importan las pantallas. Dar el código otra vez es el del catálogo
// (`giveCatalogCode`): comprueba la misma puerta de Contenido.

export type {
  ApproveAnswer,
  CourseApproved,
  CourseReturned,
  LessonVideo,
  QueueRead,
  ReturnAnswer,
  ReviewCourse,
  ReviewLesson,
  ReviewQueue,
  ReviewResource,
  ReviewSubmission,
  SubmissionApproveAnswer,
  SubmissionApproved,
  VersionChanges,
} from "./queue";
export { APPROVE_ANSWERS, LESSON_VIDEOS, RETURN_ANSWERS, SUBMISSION_APPROVE_ANSWERS } from "./queue";

export const { reviewQueue, approveCourse, returnCourse, approveSubmission } = createReviewQueue(
  { report: reportFailure },
  { teamStanding, store: databaseReviewStore, providers: createVideoProviders() },
);
