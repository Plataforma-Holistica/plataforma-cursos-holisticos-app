import "server-only";

import { checkSession } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createDrafts } from "./drafts";
import { databaseDraftsStore } from "./store";

// El borrador de los cursos, ya armado con la guarda de sesión, la base y el registro de errores.
// Lo que importan las pantallas.

export type {
  CatalogChoice,
  CourseState,
  DraftChange,
  DraftChoices,
  DraftCourse,
  DraftLesson,
  DraftModule,
  DraftRead,
  TeacherCourse,
} from "./drafts";
export { DRAFT_TEXT_LIMITS, missingItems, parseDraftText } from "./field-rules";

export const {
  teacherCourses,
  draftCourse,
  draftChoices,
  createCourse,
  saveCourse,
  addModule,
  renameModule,
  deleteModule,
  moveModule,
  addLesson,
  saveLesson,
  deleteLesson,
  moveLesson,
  deleteCourse,
} = createDrafts({ store: databaseDraftsStore, checkSession, report: reportFailure });
