import "server-only";

import { checkSession } from "@/services/account/account";
import { proxyIsTrusted, resolveOrigin } from "@/services/account/origin";
import { reportFailure } from "@/services/error-reporting/server";

import { createResourceFiles } from "@/services/media/resource-files";
import { createVideoFiles } from "@/services/media/video-files";
import { createVideoProviders } from "@/services/media/video-provider";

import { createDrafts } from "./drafts";
import { createDraftResources } from "./resources";
import { databaseDraftsStore, databaseResourcesStore, databaseSubmitStore, databaseVideosStore } from "./store";
import { createSubmit } from "./submit";
import { createDraftVideos } from "./videos";

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
  DraftVideo,
  ReturnNote,
  TeacherCourse,
} from "./drafts";
export type { BeginResult, ConfirmResult, RejectReason } from "./resources";
export type { AcceptedAnnex, AnnexText, CourseSubmitted, MissingKind, MissingLine, SubmitPreview, SubmitRead } from "./submit";
export { SUBMIT_ANSWERS } from "./submit";
export { DRAFT_TEXT_LIMITS, missingItems, parseDraftText } from "./field-rules";

const resources = createDraftResources({ store: databaseResourcesStore, files: createResourceFiles(), checkSession, report: reportFailure });
export const { beginResource, confirmResource, removeResource, moveResource } = resources;
const videos = createDraftVideos({ store: databaseVideosStore, files: createVideoFiles(), providers: createVideoProviders(), checkSession, report: reportFailure });
export const { beginVideo, renewVideoUpload, confirmVideo, removeVideo, checkVideos } = videos;

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
} = createDrafts({
  store: databaseDraftsStore,
  afterDelete: async (claims, course) => {
    await resources.cleanUp(claims, course);
    await videos.cleanUp(claims, course);
  },
  checkSession,
  report: reportFailure,
});

export const { submitPreview, acceptedAnnexes, annexText, submitCourse } = createSubmit({
  store: databaseSubmitStore,
  providers: createVideoProviders(),
  checkSession,
  evidence: (origin) => {
    const { address, userAgent } = resolveOrigin(origin, proxyIsTrusted());
    return { address, userAgent };
  },
  report: reportFailure,
});

