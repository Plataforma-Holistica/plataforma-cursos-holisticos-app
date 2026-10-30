"use client";

import Link from "next/link";
import { useActionState } from "react";

import { useAnswerFocus, BlockResult } from "@/app/admin/_lib/answer";
import { portal } from "@/messages/es/portal";
import { plural, t } from "@/messages/format";
import { DRAFT_TEXT_LIMITS, type DraftTextKind } from "@/services/drafts/field-rules";
import { Button } from "@/ui/button";
import { CourseCover } from "@/ui/course-cover";
import { FormErrorSummary, type FormError } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { Select } from "@/ui/select";

import { CountedField } from "../_lib/counted-field";
import { failureText, problemText } from "../_lib/words";
import { editorAction } from "./actions";
import type { BlockState, Problems } from "./outcomes";
import type { EditorView, ModuleRow, Selected } from "./rows";

// Los bloques del editor de curso (PA-43; T-402). Cada uno es su sección, con sus formularios ligados a
// la misma acción y a su propio estado, y su resultado se dice en el bloque. Todo funciona sin
// JavaScript: el tercer argumento de `useActionState` es la dirección con lo elegido y el ancla del
// bloque, y ahí vuelve el navegador.
//
// Un bloque con un campo de texto pone primero su botón de guardar: con Enter el navegador envía el
// formulario con su primer botón.

const text = portal.editor;
const IDLE: BlockState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const DATA_ID = "bloque-editor-datos";
const STRUCTURE_ID = "bloque-editor-estructura";
const MODULE_ID = "bloque-editor-modulo";
const LESSON_ID = "bloque-editor-leccion";

/** Los avisos: al título del curso al pasar de 48 (03 §4.1); a los demás, cerca del tope. */
const WARN_AT: Record<DraftTextKind, number> = { courseTitle: 48, summary: 450, moduleTitle: 108, lessonTitle: 108, description: 1900 };

function CourseField({ course }: { course: string }) {
  return <input type="hidden" name="course" value={course} />;
}

function attemptOf(state: BlockState): number {
  return state.kind === "idle" ? 0 : state.attempt;
}

/** Lo escrito si la respuesta lo trae; si no, lo que la página leyó. */
function valueOf(state: BlockState, name: string, read: string, target: string | null = null): string {
  if ((state.kind === "invalid" || state.kind === "failed") && state.target === target) return state.values[name] ?? read;
  return read;
}

function problemOf(state: BlockState, name: string, target: string | null = null): Problems[string] | null {
  return state.kind === "invalid" && state.target === target ? (state.problems[name] ?? null) : null;
}

function fieldError(kind: DraftTextKind, problem: Problems[string] | null): string | null {
  if (problem === null) return null;
  if (problem === "practice_inactive") return portal.failed.practiceInactive;
  if (problem === "level_inactive") return portal.failed.levelInactive;
  return problemText(kind, problem);
}

function resultOf(state: BlockState): { message: string | null; tone: "success" | "warning" | "danger" } {
  if (state.kind === "done") return { message: state.what === "moved" ? text.moved : text.saved, tone: "success" };
  if (state.kind === "failed") return { message: failureText(state.reason), tone: "danger" };
  return { message: null, tone: "success" };
}

// ---------------------------------------------------------------------------------------
// Los datos del curso.

export function CourseBlock({ view }: { view: EditorView }) {
  const [state, action, pending] = useActionState(editorAction, IDLE, `${view.paths.self}#${DATA_ID}`);
  const result = resultOf(state);
  const { block, answer, spoken } = useAnswerFocus(pending, attemptOf(state), result.message);
  const { data } = view;
  const titleError = fieldError("courseTitle", problemOf(state, "title"));
  const summaryError = fieldError("summary", problemOf(state, "summary"));
  const practiceError = fieldError("courseTitle", problemOf(state, "practice"));
  const levelError = fieldError("courseTitle", problemOf(state, "level"));
  const errors: FormError[] = [
    titleError && { fieldId: "editor-titulo", message: titleError },
    summaryError && { fieldId: "editor-resumen", message: summaryError },
    practiceError && { fieldId: "editor-practica", message: practiceError },
    levelError && { fieldId: "editor-nivel", message: levelError },
  ].filter((error): error is FormError => Boolean(error));

  return (
    <section id={DATA_ID} ref={block} tabIndex={-1} aria-labelledby="editor-datos-titulo" className="flex flex-col gap-6 outline-none">
      <h2 id="editor-datos-titulo" className="text-h2">
        {text.courseData}
      </h2>
      {view.editable ? (
        <form action={action} className="flex flex-col gap-6">
          <FormErrorSummary errors={errors} attempt={attemptOf(state)} />
          <BlockResult message={result.message} tone={result.tone} pending={pending} pendingText={text.saving} answer={answer} spoken={spoken} />
          <CourseField course={view.course} />
          {data.inactive && <InlineAlert tone="warning">{text.inactiveNotice}</InlineAlert>}
          <div key={`datos-${attemptOf(state)}`} className="flex flex-col gap-6">
            <CountedField
              id="editor-titulo"
              name="title"
              label={text.titleLabel}
              max={DRAFT_TEXT_LIMITS.courseTitle}
              warnAt={WARN_AT.courseTitle}
              defaultValue={valueOf(state, "title", data.title)}
              error={titleError}
              readOnly={pending}
            />
            <CountedField
              id="editor-resumen"
              name="summary"
              label={text.summaryLabel}
              max={DRAFT_TEXT_LIMITS.summary}
              warnAt={WARN_AT.summary}
              defaultValue={valueOf(state, "summary", data.summary)}
              error={summaryError}
              optional
              multiline
              readOnly={pending}
            />
            <Select
              id="editor-practica"
              name="practice"
              label={text.practiceLabel}
              options={data.practices}
              prompt={text.choose}
              defaultValue={valueOf(state, "practice", data.practice)}
              error={practiceError}
              optional
            />
            <Select
              id="editor-nivel"
              name="level"
              label={text.levelLabel}
              options={data.levels}
              prompt={text.choose}
              defaultValue={valueOf(state, "level", data.level)}
              error={levelError}
              optional
            />
          </div>
          <div>
            <Button type="submit" name="do" value={data.save} loading={pending} loadingLabel={text.saving}>
              {text.save}
            </Button>
          </div>
        </form>
      ) : (
        <dl className="flex flex-col gap-4">
          <div>
            <dt className="text-body-s font-semibold">{text.titleLabel}</dt>
            <dd className="text-text-2">{data.title}</dd>
          </div>
          <div>
            <dt className="text-body-s font-semibold">{text.summaryLabel}</dt>
            <dd className="whitespace-pre-line text-text-2">{data.summary}</dd>
          </div>
          <div>
            <dt className="text-body-s font-semibold">{text.practiceLabel}</dt>
            <dd className="text-text-2">{data.practices.find((option) => option.value === data.practice)?.label ?? ""}</dd>
          </div>
          <div>
            <dt className="text-body-s font-semibold">{text.levelLabel}</dt>
            <dd className="text-text-2">{data.levels.find((option) => option.value === data.level)?.label ?? ""}</dd>
          </div>
        </dl>
      )}
      <div className="flex flex-col gap-2">
        <p className="text-body-s font-semibold">{text.cover}</p>
        <CourseCover
          title={data.cover.title}
          teacherName={data.cover.teacherName}
          practiceName={data.cover.practiceName}
          tone={data.cover.tone}
          className="w-full max-w-md rounded-sm"
        />
        <p className="text-caption text-text-3">{text.coverHint}</p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// La estructura: los módulos con sus lecciones, agregar, subir, bajar y mover.

function MoveButtons({ up, down, upName, downName, action, course }: { up: string | null; down: string | null; upName: string; downName: string; action: (form: FormData) => void; course: string }) {
  if (up === null && down === null) return null;
  return (
    <form action={action} className="flex gap-2">
      <CourseField course={course} />
      {up !== null && (
        <Button type="submit" name="do" value={up} variant="secondary" size="md">
          <span aria-hidden="true">{text.up}</span>
          <span className="sr-only">{upName}</span>
        </Button>
      )}
      {down !== null && (
        <Button type="submit" name="do" value={down} variant="secondary" size="md">
          <span aria-hidden="true">{text.down}</span>
          <span className="sr-only">{downName}</span>
        </Button>
      )}
    </form>
  );
}

function ModuleItem({ module, view, state, action, pending }: { module: ModuleRow; view: EditorView; state: BlockState; action: (form: FormData) => void; pending: boolean }) {
  const lessonError = fieldError("lessonTitle", problemOf(state, "title", module.id));
  const fieldId = `editor-leccion-nueva-${module.id}`;
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={module.href} aria-current={module.current ? "true" : undefined} className="min-h-touch content-center font-semibold text-text hover:underline">
          {t(text.moduleLink, { label: module.label, title: module.title })}
        </Link>
        {view.editable && (
          <MoveButtons
            up={module.up}
            down={module.down}
            upName={t(text.upNamed, { title: module.title })}
            downName={t(text.downNamed, { title: module.title })}
            action={action}
            course={view.course}
          />
        )}
      </div>
      {module.lessons.length === 0 ? (
        <p className="text-body-s text-text-3">{text.noLessons}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {module.lessons.map((lesson) => (
            <li key={lesson.id} className="flex flex-col gap-2 border-t border-border pt-2">
              <Link href={lesson.href} aria-current={lesson.current ? "true" : undefined} className="min-h-touch content-center text-text hover:underline">
                {lesson.title}
              </Link>
              {view.editable && (
                <div className="flex flex-wrap items-end gap-2">
                  <MoveButtons
                    up={lesson.up}
                    down={lesson.down}
                    upName={t(text.upNamed, { title: lesson.title })}
                    downName={t(text.downNamed, { title: lesson.title })}
                    action={action}
                    course={view.course}
                  />
                  {lesson.move !== null && (
                    <form action={action} className="flex items-end gap-2">
                      <CourseField course={view.course} />
                      <Select id={`editor-mover-${lesson.id}`} name="to" label={t(text.moveToNamed, { title: lesson.title })} options={lesson.targets} prompt={text.moveTo} />
                      <Button type="submit" name="do" value={lesson.move} variant="secondary" size="md">
                        {text.move}
                      </Button>
                    </form>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {view.editable && (
        <form action={action} className="flex flex-col gap-2">
          <CourseField course={view.course} />
          <CountedField
            key={`leccion-${module.id}-${attemptOf(state)}`}
            id={fieldId}
            name="title"
            label={text.newLessonLabel}
            max={DRAFT_TEXT_LIMITS.lessonTitle}
            warnAt={WARN_AT.lessonTitle}
            defaultValue={valueOf(state, "title", "", module.id)}
            error={lessonError}
            readOnly={pending}
          />
          <div>
            <Button type="submit" name="do" value={module.addLesson} variant="secondary">
              {text.addLesson}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function StructureBlock({ view }: { view: EditorView }) {
  const [state, action, pending] = useActionState(editorAction, IDLE, `${view.paths.self}#${STRUCTURE_ID}`);
  const result = resultOf(state);
  const { block, answer, spoken } = useAnswerFocus(pending, attemptOf(state), result.message);
  const moduleError = fieldError("moduleTitle", problemOf(state, "title", "module"));
  const errors: FormError[] = [];
  if (moduleError) errors.push({ fieldId: "editor-modulo-nuevo", message: moduleError });
  for (const row of view.structure.modules) {
    const lessonError = fieldError("lessonTitle", problemOf(state, "title", row.id));
    if (lessonError) errors.push({ fieldId: `editor-leccion-nueva-${row.id}`, message: lessonError });
  }

  return (
    <section id={STRUCTURE_ID} ref={block} tabIndex={-1} aria-labelledby="editor-estructura-titulo" className="flex flex-col gap-4 outline-none">
      <h2 id="editor-estructura-titulo" className="text-h2">
        {text.structure}
      </h2>
      <Link href={view.paths.base} aria-current={view.selected.kind === "course" ? "true" : undefined} className="min-h-touch content-center text-text hover:underline">
        {text.courseData}
      </Link>
      <FormErrorSummary errors={errors} attempt={attemptOf(state)} />
      <BlockResult message={result.message} tone={result.tone} pending={pending} pendingText={text.saving} answer={answer} spoken={spoken} />
      {view.structure.modules.length === 0 ? (
        <p className="text-body-s text-text-3">{text.noModules}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {view.structure.modules.map((module) => (
            <ModuleItem key={module.id} module={module} view={view} state={state} action={action} pending={pending} />
          ))}
        </ol>
      )}
      {view.editable && (
        <form action={action} className="flex flex-col gap-2">
          <CourseField course={view.course} />
          <CountedField
            key={`modulo-${attemptOf(state)}`}
            id="editor-modulo-nuevo"
            name="title"
            label={text.newModuleLabel}
            max={DRAFT_TEXT_LIMITS.moduleTitle}
            warnAt={WARN_AT.moduleTitle}
            defaultValue={valueOf(state, "title", "", "module")}
            error={moduleError}
            readOnly={pending}
          />
          <div>
            <Button type="submit" name="do" value={view.structure.addModule}>
              {text.addModule}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Un módulo o una lección elegidos.

export function ItemBlock({ view, selected }: { view: EditorView; selected: Exclude<Selected, { kind: "course" }> }) {
  const isLesson = selected.kind === "lesson";
  const blockId = isLesson ? LESSON_ID : MODULE_ID;
  const [state, action, pending] = useActionState(editorAction, IDLE, `${view.paths.self}#${blockId}`);
  const result = resultOf(state);
  const { block, answer, spoken } = useAnswerFocus(pending, attemptOf(state), result.message);
  const titleKind: DraftTextKind = isLesson ? "lessonTitle" : "moduleTitle";
  const titleError = fieldError(titleKind, problemOf(state, "title"));
  const descriptionError = isLesson ? fieldError("description", problemOf(state, "description")) : null;
  const errors: FormError[] = [
    titleError && { fieldId: "editor-elegido-titulo", message: titleError },
    descriptionError && { fieldId: "editor-elegido-descripcion", message: descriptionError },
  ].filter((error): error is FormError => Boolean(error));
  const confirmText = isLesson
    ? text.confirmDeleteLesson
    : selected.lessons === 0
      ? text.confirmDeleteEmptyModule
      : t(plural(selected.lessons, text.confirmDeleteModule), { count: selected.lessons });

  return (
    <section id={blockId} ref={block} tabIndex={-1} aria-labelledby="editor-elegido-encabezado" className="flex flex-col gap-6 outline-none">
      <h2 id="editor-elegido-encabezado" className="text-h2">
        {selected.title}
      </h2>
      {view.editable ? (
        <form action={action} className="flex flex-col gap-6">
          <CourseField course={view.course} />
          <FormErrorSummary errors={errors} attempt={attemptOf(state)} />
          <BlockResult message={result.message} tone={result.tone} pending={pending} pendingText={text.saving} answer={answer} spoken={spoken} />
          <div key={`elegido-${attemptOf(state)}`} className="flex flex-col gap-6">
            <CountedField
              id="editor-elegido-titulo"
              name="title"
              label={isLesson ? text.lessonTitleLabel : text.moduleTitleLabel}
              max={DRAFT_TEXT_LIMITS[titleKind]}
              warnAt={WARN_AT[titleKind]}
              defaultValue={valueOf(state, "title", selected.title)}
              error={titleError}
              readOnly={pending}
            />
            {isLesson && (
              <CountedField
                id="editor-elegido-descripcion"
                name="description"
                label={text.descriptionLabel}
                max={DRAFT_TEXT_LIMITS.description}
                warnAt={WARN_AT.description}
                defaultValue={valueOf(state, "description", selected.description ?? "")}
                error={descriptionError}
                optional
                multiline
                readOnly={pending}
              />
            )}
          </div>
          {state.kind === "confirming" ? (
            <div className="flex flex-col gap-3 rounded-md border border-danger p-4">
              <p className="text-body">{confirmText}</p>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" name="do" value="cancel" variant="secondary">
                  {text.cancel}
                </Button>
                <Button type="submit" name="do" value={selected.remove} variant="danger">
                  {isLesson ? text.deleteLesson : text.deleteModule}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button type="submit" name="do" value={selected.save} loading={pending} loadingLabel={text.saving}>
                {text.save}
              </Button>
              <Button type="submit" name="do" value={selected.askDelete} variant="danger">
                {isLesson ? text.deleteLesson : text.deleteModule}
              </Button>
            </div>
          )}
        </form>
      ) : (
        isLesson && <p className="whitespace-pre-line text-text-2">{selected.description}</p>
      )}
    </section>
  );
}
