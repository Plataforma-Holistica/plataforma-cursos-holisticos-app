import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, asSystem, asUser, type Tx } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";

import { withLockRetry } from "@/services/account/team";

import {
  ADD_ANSWERS,
  CREATE_ANSWERS,
  DELETE_ANSWERS,
  MOVE_ANSWERS,
  SAVE_ANSWERS,
  SAVE_COURSE_ANSWERS,
  type DraftsStore,
} from "./drafts";
import {
  answerOf,
  askAddLesson,
  askAddModule,
  askCreate,
  askResourceBegin,
  askResourceConfirm,
  askResourceFile,
  askResourceMove,
  askResourceRemove,
  askDeleteCourse,
  askDeleteLesson,
  askDeleteModule,
  askMoveLesson,
  askMoveModule,
  askRenameModule,
  askSaveCourse,
  askSaveLesson,
  createdOf,
  readDraftChoices,
  readDraftCourse,
  readTeacherCourses,
  readUnusedResources,
  askVideoBegin,
  askVideoClaim,
  askVideoConfirm,
  askVideoCreated,
  askVideoCreateFailed,
  askVideoDue,
  askVideoFile,
  askVideoRemove,
  askVideoSettle,
  askVideoTrashDone,
  askVideoTrashDue,
} from "./records";
import {
  VIDEO_BEGIN_ANSWERS,
  VIDEO_CLAIM_ANSWERS,
  VIDEO_CONFIRM_ANSWERS,
  VIDEO_CREATE_FAILED_ANSWERS,
  VIDEO_CREATED_ANSWERS,
  VIDEO_FILE_ANSWERS,
  VIDEO_REJECT_REASONS,
  VIDEO_REMOVE_ANSWERS,
  VIDEO_SETTLE_ANSWERS,
  VIDEO_TRASH_DONE_ANSWERS,
  type VideosStore,
} from "./videos";
import { BEGIN_ANSWERS, CONFIRM_ANSWERS, FILE_ANSWERS, MOVE_ANSWERS as RESOURCE_MOVE_ANSWERS, REJECT_REASONS, REMOVE_ANSWERS, type ResourcesStore } from "./resources";

// Lo que el servicio del borrador le pregunta a la base, a nombre de las claims que verificó. Leer
// va como la persona; cada cambio abre su transacción como servidor, con quién actúa y con qué
// sesión tomados de esas claims.

/** `run` es `asServer`, `read` es `asUser` y `system` es `asSystem`. Solo las pruebas pasan otros. */
export function createDraftsStore(
  run: typeof asServer = asServer,
  read: typeof asUser = asUser,
  system: typeof asSystem = asSystem,
): DraftsStore {
  /**
   * Un cambio. Toman el candado del curso (y los de las listas, al guardar los datos) y ninguno
   * escribe antes de rechazar: un choque de candados revierte la transacción entera, y se intenta
   * una vez más. Lo que contestó se entiende ya confirmada.
   */
  function change<Result>(claims: VerifiedClaims, reason: string, work: (tx: Tx) => Promise<Result>): Promise<Result> {
    return withLockRetry(() => run({ claims, reason }, work), isLockConflict);
  }

  return {
    teacherCourses: (claims) => read(claims, (tx) => readTeacherCourses(tx)),
    draftCourse: (claims, course) => read(claims, (tx) => readDraftCourse(tx, course)),
    create: async (claims, token, title) =>
      createdOf(CREATE_ANSWERS, await change(claims, "draft_create", (tx) => askCreate(tx, token, title))),
    saveCourse: async (claims, course, seen, fields) =>
      answerOf(SAVE_COURSE_ANSWERS, (await change(claims, "draft_save_course", (tx) => askSaveCourse(tx, course, seen, fields))).answer),
    addModule: async (claims, course, seen, title) =>
      createdOf(ADD_ANSWERS, await change(claims, "draft_add_module", (tx) => askAddModule(tx, course, seen, title))),
    renameModule: async (claims, course, module, seen, title) =>
      answerOf(SAVE_ANSWERS, (await change(claims, "draft_rename_module", (tx) => askRenameModule(tx, course, module, seen, title))).answer),
    deleteModule: async (claims, course, module, seen) =>
      answerOf(DELETE_ANSWERS, (await change(claims, "draft_delete_module", (tx) => askDeleteModule(tx, course, module, seen))).answer),
    moveModule: async (claims, course, module, seenPosition, toPosition) =>
      answerOf(
        MOVE_ANSWERS,
        (await change(claims, "draft_move_module", (tx) => askMoveModule(tx, course, module, seenPosition, toPosition))).answer,
      ),
    addLesson: async (claims, course, module, seen, title) =>
      createdOf(ADD_ANSWERS, await change(claims, "draft_add_lesson", (tx) => askAddLesson(tx, course, module, seen, title))),
    saveLesson: async (claims, course, lesson, seen, fields) =>
      answerOf(
        SAVE_ANSWERS,
        (await change(claims, "draft_save_lesson", (tx) => askSaveLesson(tx, course, lesson, seen, fields.title, fields.description))).answer,
      ),
    deleteLesson: async (claims, course, lesson, seen) =>
      answerOf(DELETE_ANSWERS, (await change(claims, "draft_delete_lesson", (tx) => askDeleteLesson(tx, course, lesson, seen))).answer),
    moveLesson: async (claims, course, lesson, seen, to) =>
      answerOf(MOVE_ANSWERS, (await change(claims, "draft_move_lesson", (tx) => askMoveLesson(tx, course, lesson, seen, to))).answer),
    deleteCourse: async (claims, course, seen) =>
      answerOf(DELETE_ANSWERS, (await change(claims, "draft_delete_course", (tx) => askDeleteCourse(tx, course, seen))).answer),
    choices: (practiceId, levelId) => system({ reason: "draft_choices" }, (tx) => readDraftChoices(tx, practiceId, levelId)),
  };
}

export const databaseDraftsStore = createDraftsStore();

// Los recursos (T-404). Que la respuesta sea de la lista se revisa ya confirmada la transacción: `rejected` y
// `expired` borran la fila, y lanzar adentro la devolvería, para confirmarse otra vez. Su forma se revisa adentro:
// una respuesta sin forma es que la función cambió, y ahí revertir es lo seguro.
export function createResourcesStore(run: typeof asServer = asServer): ResourcesStore {
  function change<Result>(claims: VerifiedClaims, reason: string, work: (tx: Tx) => Promise<Result>): Promise<Result> {
    return withLockRetry(() => run({ claims, reason }, work), isLockConflict);
  }
  return {
    begin: async (claims, input) => {
      const result = await change(claims, "resource_begin", (tx) => askResourceBegin(tx, input));
      return { answer: answerOf(BEGIN_ANSWERS, result.answer), resource: result.resource ?? null, path: result.path ?? null };
    },
    file: async (claims, input) => {
      const result = await change(claims, "resource_file", (tx) => askResourceFile(tx, input));
      return { answer: answerOf(FILE_ANSWERS, result.answer), path: result.path ?? null, mime: result.mime ?? null };
    },
    confirm: async (claims, input) => {
      const result = await change(claims, "resource_confirm", (tx) => askResourceConfirm(tx, input));
      return {
        answer: answerOf(CONFIRM_ANSWERS, result.answer),
        reason: result.reason === undefined ? null : answerOf(REJECT_REASONS, result.reason),
      };
    },
    move: async (claims, input) => answerOf(RESOURCE_MOVE_ANSWERS, (await change(claims, "resource_move", (tx) => askResourceMove(tx, input))).answer),
    remove: async (claims, input) => answerOf(REMOVE_ANSWERS, (await change(claims, "resource_remove", (tx) => askResourceRemove(tx, input))).answer),
    unused: (claims, course) => run({ claims, reason: "resource_unused" }, (tx) => readUnusedResources(tx, course)),
  };
}

export const databaseResourcesStore = createResourcesStore();

// Los videos (T-403), con la misma regla: un rechazo borra la fila, así que la respuesta se revisa ya confirmada la transacción.
export function createVideosStore(run: typeof asServer = asServer): VideosStore {
  function change<Result>(claims: VerifiedClaims, reason: string, work: (tx: Tx) => Promise<Result>): Promise<Result> {
    return withLockRetry(() => run({ claims, reason }, work), isLockConflict);
  }
  return {
    begin: async (claims, input) => {
      const result = await change(claims, "video_begin", (tx) => askVideoBegin(tx, input));
      return { answer: answerOf(VIDEO_BEGIN_ANSWERS, result.answer), video: result.video ?? null, path: result.path ?? null, fileName: result.file_name ?? null };
    },
    file: async (claims, input) => {
      const result = await change(claims, "video_file", (tx) => askVideoFile(tx, input));
      return { answer: answerOf(VIDEO_FILE_ANSWERS, result.answer), path: result.path ?? null, mime: result.mime ?? null };
    },
    confirm: async (claims, input) => {
      const result = await change(claims, "video_confirm", (tx) => askVideoConfirm(tx, input));
      return {
        answer: answerOf(VIDEO_CONFIRM_ANSWERS, result.answer),
        reason: result.reason === undefined ? null : answerOf(VIDEO_REJECT_REASONS, result.reason),
      };
    },
    remove: async (claims, input) => answerOf(VIDEO_REMOVE_ANSWERS, (await change(claims, "video_remove", (tx) => askVideoRemove(tx, input))).answer),
    due: (claims, course) => change(claims, "video_due", (tx) => askVideoDue(tx, course)),
    claim: async (claims, input) => {
      const result = await change(claims, "video_claim", (tx) => askVideoClaim(tx, input));
      return { answer: answerOf(VIDEO_CLAIM_ANSWERS, result.answer), path: result.path ?? null, claim: result.claim ?? null, retry: result.retry === true, since: result.since ?? null };
    },
    createFailed: async (claims, input) => answerOf(VIDEO_CREATE_FAILED_ANSWERS, (await change(claims, "video_create_failed", (tx) => askVideoCreateFailed(tx, input))).answer),
    created: async (claims, input) => answerOf(VIDEO_CREATED_ANSWERS, (await change(claims, "video_created", (tx) => askVideoCreated(tx, input))).answer),
    settle: async (claims, input) => answerOf(VIDEO_SETTLE_ANSWERS, (await change(claims, "video_settle", (tx) => askVideoSettle(tx, input))).answer),
    trashDue: (claims, course) => change(claims, "video_trash_due", (tx) => askVideoTrashDue(tx, course)),
    trashDone: async (claims, input) => answerOf(VIDEO_TRASH_DONE_ANSWERS, (await change(claims, "video_trash_done", (tx) => askVideoTrashDone(tx, input))).answer),
  };
}

export const databaseVideosStore = createVideosStore();
