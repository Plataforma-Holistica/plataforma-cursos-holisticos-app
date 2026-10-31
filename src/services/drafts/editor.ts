import "server-only";

import { checkSession } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createResourceFiles } from "@/services/media/resource-files";

import { createDrafts } from "./drafts";
import { createDraftResources } from "./resources";
import { databaseDraftsStore, databaseResourcesStore } from "./store";

// El borrador de los cursos, ya armado con la guarda de sesión, la base y el registro de errores.
// Lo que importan las pantallas. `draftChoices` lee como sistema y no corre ninguna guarda: los ids que
// recibe salen siempre de un borrador que la persona ya leyó como ella (`draftCourse`).

export type {
  CatalogChoice,
  CourseState,
  DraftChange,
  DraftChoices,
  DraftCourse,
  DraftLesson,
  DraftModule,
  DraftRead,
  DraftResource,
  TeacherCourse,
} from "./drafts";
export type { BeginResult, ConfirmResult, RejectReason } from "./resources";
export { DRAFT_TEXT_LIMITS, missingItems, parseDraftText } from "./field-rules";

const resources = createDraftResources({ store: databaseResourcesStore, files: createResourceFiles(), checkSession, report: reportFailure });
export const { beginResource, confirmResource, removeResource, moveResource } = resources;

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
} = createDrafts({ store: databaseDraftsStore, afterDelete: resources.cleanUp, checkSession, report: reportFailure });
