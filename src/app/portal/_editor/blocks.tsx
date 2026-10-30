"use client";

import { GripVertical } from "lucide";
import Link from "next/link";
import { type DragEvent, type KeyboardEvent, useActionState, useEffect, useRef, useState } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";
import { BlockResult, useAnswerFocus } from "@/app/admin/_lib/answer";
import { portal } from "@/messages/es/portal";
import { plural, t } from "@/messages/format";
import { DRAFT_TEXT_LIMITS, type DraftTextKind } from "@/services/drafts/field-rules";
import { Button } from "@/ui/button";
import { CourseCover } from "@/ui/course-cover";
import { FormErrorSummary, type FormError } from "@/ui/form-error-summary";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { Select } from "@/ui/select";

import { CountedField } from "../_lib/counted-field";
import { failureText, problemText } from "../_lib/words";
import { editorAction } from "./actions";
import { DATA_ID, LESSON_ID, MODULE_ID, STRUCTURE_ID } from "./anchors";
import { editorButton, type BlockState, type Problems, type Values } from "./outcomes";
import { dropButton, stepTo, type Dragged } from "./reorder";
import type { EditorView, ModuleRow, Option, Selected } from "./rows";
import { STRUCTURE_KEY, useUnsaved } from "./unsaved";

// Los bloques del editor de curso (PA-43; T-402). Cada uno es su sección, con sus formularios ligados a
// la misma acción y a su propio estado, y su resultado se dice en el bloque. Todo funciona sin
// JavaScript: el tercer argumento de `useActionState` es la dirección con lo elegido y el ancla del
// bloque, y ahí vuelve el navegador.
//
//   · Un bloque con un campo de texto pone primero su botón de guardar: con Enter el navegador envía el
//     formulario con su primer botón.
//   · Un campo se vuelve a armar solo con la respuesta de su propio formulario (`useResponses`): pulsar
//     «Subir» en un módulo no borra lo que se escribía en otro.
//   · Lo que contestó el último envío deja de decirse mientras hay otro en camino y en cuanto la persona
//     vuelve a escribir: «Guardado» junto a un texto que no se ha guardado miente.
//   · Si otra pestaña cambió lo mismo, se pinta lo que hay ahora, no lo escrito: un segundo clic lo pisaría
//     sin que nadie lo viera.

const text = portal.editor;
const IDLE: BlockState = { kind: "idle" };

/** Los avisos: al título del curso al pasar de 48 (03 §4.1); a los demás, cerca del tope. */
const WARN_AT: Record<DraftTextKind, number> = { courseTitle: 48, summary: 450, moduleTitle: 108, lessonTitle: 108, description: 1900 };

function CourseField({ course }: { course: string }) {
  return <input type="hidden" name="course" value={course} />;
}

function attemptOf(state: BlockState): number {
  return state.kind === "idle" ? 0 : state.attempt;
}

interface Remembered {
  attempt: number;
  /** Lo escrito que volvió con la respuesta, o nulo si se pinta lo leído. */
  values: Values | null;
}

/**
 * La última respuesta de cada formulario del bloque: con ella se arma de nuevo su campo (su llave) y se
 * pinta lo escrito. Se anota al pintar, cuando llega un intento nuevo (el estado de React de la respuesta
 * anterior, como manda React para lo que se deriva de lo que cambió).
 */
function useResponses(state: BlockState) {
  // Se compara la respuesta misma y no su número de intento: después de «Cancelar» el número vuelve a
  // empezar en la acción, y la respuesta siguiente no se anotaría.
  const [memory, setMemory] = useState<{ last: BlockState; byTarget: Readonly<Record<string, Remembered>> }>({ last: IDLE, byTarget: {} });
  if (state.kind !== "idle" && state !== memory.last) {
    const byTarget = { ...memory.byTarget };
    if (state.kind === "invalid") byTarget[state.target] = { attempt: state.attempt, values: state.values };
    if (state.kind === "failed") byTarget[state.target] = { attempt: state.attempt, values: state.values };
    if (state.kind === "done") byTarget[state.target] = { attempt: state.attempt, values: null };
    // Preguntar antes de borrar no vuelve a armar los campos: solo cambia su valor por omisión.
    if (state.kind === "confirming" || state.kind === "kept") byTarget.item = { attempt: memory.byTarget.item?.attempt ?? 0, values: state.values };
    setMemory({ last: state, byTarget });
  }
  return {
    keyOf: (target: string) => `${target}-${memory.byTarget[target]?.attempt ?? 0}`,
    valueOf: (target: string, name: string, read: string) => memory.byTarget[target]?.values?.[name] ?? read,
  };
}

/**
 * Lo que se dice del último envío: nada mientras hay otro en camino, desde que se volvió a escribir, ni
 * después de elegir otra cosa en la estructura (la dirección `self` cambió).
 */
function useResult(state: BlockState, pending: boolean, self: string) {
  const [typedFor, setTypedFor] = useState<BlockState | null>(null);
  const [seen, setSeen] = useState<{ state: BlockState; self: string }>({ state, self });
  if (seen.state !== state) setSeen({ state, self });
  const silent = pending || typedFor === state || (seen.state === state && seen.self !== self);
  let message: string | null = null;
  let tone: "success" | "warning" | "danger" = "success";
  if (!silent && state.kind === "done") message = state.what === "moved" ? text.moved : text.saved;
  if (!silent && state.kind === "failed") {
    message = failureText(state.reason);
    tone = "danger";
  }
  return { message, tone, onInput: () => setTypedFor(state) };
}

function problemOf(state: BlockState, name: string, target: string): Problems[string] | null {
  return state.kind === "invalid" && state.target === target ? (state.problems[name] ?? null) : null;
}

function fieldError(kind: DraftTextKind, problem: Problems[string] | null): string | null {
  if (problem === null) return null;
  if (problem === "practice_inactive") return portal.failed.practiceInactive;
  if (problem === "level_inactive") return portal.failed.levelInactive;
  return problemText(kind, problem);
}

/**
 * Lo que un formulario le dice a la barra: escribir lo deja sin guardar, y solo la respuesta que lo guardó
 * (o la que dice que otra pestaña cambió lo mismo, que pinta lo de ahora) lo limpia. Un envío que no se
 * hizo deja lo escrito en pantalla, sin guardar. Al irse el bloque (se eligió otra cosa), lo suyo deja de
 * contar. `target` es el formulario en la respuesta (`BlockState`).
 */
function useTyping(key: string, target: string, state: BlockState, onInput: () => void, self: string) {
  const { mark } = useUnsaved();
  // Agregar un módulo o una lección no contesta: lleva a lo agregado (la dirección cambia). Si esta pantalla
  // cambió después de que este formulario se envió, lo suyo se guardó: se limpia, y su campo se vuelve a armar.
  const [sentFrom, setSentFrom] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const [seenSelf, setSeenSelf] = useState(self);
  if (seenSelf !== self) {
    setSeenSelf(self);
    if (sentFrom !== null && sentFrom !== self) {
      setSentFrom(null);
      setFresh((count) => count + 1);
    }
  }
  useEffect(() => () => mark(key, false), [key, mark]);
  useEffect(() => {
    if (fresh !== 0) mark(key, false);
  }, [fresh, key, mark]);
  useEffect(() => {
    const saved = state.kind === "done" && state.target === target;
    const replaced = state.kind === "failed" && state.target === target && state.values === null;
    if (saved || replaced) mark(key, false);
  }, [state, key, target, mark]);
  return {
    onInput: () => {
      onInput();
      mark(key, true);
    },
    form: {
      "data-unsaved-key": key,
      onSubmit: () => setSentFrom(self),
    },
    /** Para la llave del campo: cambia cuando lo agregado se guardó y la pantalla ya es otra. */
    fresh,
  };
}

/** Una elección que volvió con la respuesta, solo si sigue entre las opciones; si no, la leída. */
function chosen(value: string, options: readonly Option[], read: string): string {
  return value === "" || options.some((option) => option.value === value) ? value : read;
}

// ---------------------------------------------------------------------------------------
// Los datos del curso.

export function CourseBlock({ view }: { view: EditorView }) {
  const [state, action, pending] = useActionState(editorAction, IDLE, `${view.paths.self}#${DATA_ID}`);
  const responses = useResponses(state);
  const result = useResult(state, pending, view.paths.self);
  const { block, answer, spoken } = useAnswerFocus(pending, attemptOf(state), result.message);
  const typing = useTyping("datos", "course", state, result.onInput, view.paths.self);
  const { data } = view;
  const titleError = fieldError("courseTitle", problemOf(state, "title", "course"));
  const summaryError = fieldError("summary", problemOf(state, "summary", "course"));
  const practiceError = fieldError("courseTitle", problemOf(state, "practice", "course"));
  const levelError = fieldError("courseTitle", problemOf(state, "level", "course"));
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
        <form action={action} onInput={typing.onInput} {...typing.form} className="flex flex-col gap-6">
          <FormErrorSummary errors={errors} attempt={attemptOf(state)} />
          <BlockResult message={result.message} tone={result.tone} pending={pending} pendingText={text.saving} answer={answer} spoken={spoken} />
          <CourseField course={view.course} />
          {data.inactive && <InlineAlert tone="warning">{text.inactiveNotice}</InlineAlert>}
          <div key={responses.keyOf("course")} className="flex flex-col gap-6">
            <CountedField
              id="editor-titulo"
              name="title"
              label={text.titleLabel}
              max={DRAFT_TEXT_LIMITS.courseTitle}
              warnAt={WARN_AT.courseTitle}
              defaultValue={responses.valueOf("course", "title", data.title)}
              error={titleError}
              readOnly={pending}
            />
            <CountedField
              id="editor-resumen"
              name="summary"
              label={text.summaryLabel}
              max={DRAFT_TEXT_LIMITS.summary}
              warnAt={WARN_AT.summary}
              defaultValue={responses.valueOf("course", "summary", data.summary)}
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
              defaultValue={chosen(responses.valueOf("course", "practice", data.practice), data.practices, data.practice)}
              error={practiceError}
              optional
            />
            <Select
              id="editor-nivel"
              name="level"
              label={text.levelLabel}
              options={data.levels}
              prompt={text.choose}
              defaultValue={chosen(responses.valueOf("course", "level", data.level), data.levels, data.level)}
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
// La estructura: los módulos con sus lecciones, agregar, subir, bajar, mover y arrastrar.

interface MoveButtonsProps {
  up: string | null;
  down: string | null;
  upName: string;
  downName: string;
  action: (form: FormData) => void;
  course: string;
}

function MoveButtons({ up, down, upName, downName, action, course }: MoveButtonsProps) {
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

const DRAG_HINT_ID = "editor-arrastrar-ayuda";
const DRAG_TYPE = "application/x-plataforma-fila";

/** La fila que se tomó con el teclado: de qué lista (el curso para los módulos, o su módulo), y dónde va. */
interface Picked extends Dragged {
  title: string;
  list: string;
  from: number;
  current: number;
  total: number;
}

/** Lo que la estructura comparte con cada fila para arrastrar. */
interface DragKit {
  /** Sin JavaScript no hay asas: «Subir», «Bajar» y «Mover a» son lo único. */
  enabled: boolean;
  /** Con un envío en camino las asas siguen ahí (el foco no se pierde), pero no hacen nada. */
  busy: boolean;
  picked: Picked | null;
  setPicked: (picked: Picked | null) => void;
  /**
   * La fila que se arrastra con el ratón. Se lee en el momento de cada evento (una referencia, no estado): los
   * primeros `dragover` llegan antes de que React vuelva a pintar.
   */
  dragging: () => Dragged | null;
  setMouse: (dragged: Dragged | null) => void;
  /** Lo que se dice por la región viva de la estructura. */
  say: (words: string) => void;
  /**
   * Manda un botón por el formulario oculto de la estructura: el mismo camino que «Subir». Con el teclado,
   * lleva además la fila (para devolverle el foco) y lo que se dirá cuando la base conteste.
   */
  send: (value: string, keyboard?: { id: string; words: string }) => void;
  drop: (over: Dragged) => void;
}

interface HandleProps {
  item: Dragged & { title: string; list: string; position: number; total: number };
  kit: DragKit;
}

/**
 * El asa de una fila (diseño, `ReorderList`): con el ratón se arrastra; con el teclado, Espacio la toma,
 * las flechas la mueven dentro de su lista, Espacio la suelta y Escape cancela. La fila no cambia de lugar
 * en el documento mientras se mueve (el foco se perdería): el asa dice el lugar al que va, y cada
 * movimiento se anuncia.
 */
function DragHandle({ item, kit }: HandleProps) {
  const picked = kit.picked !== null && kit.picked.kind === item.kind && kit.picked.id === item.id ? kit.picked : null;
  const words = (template: typeof text.grabbed | typeof text.dropped | typeof text.dragTo, position: number) => t(template, { title: item.title, position, total: item.total });

  /** Tomar o soltar: Espacio, Intro o un clic (un lector de pantalla en modo exploración manda clics). */
  function toggle() {
    if (kit.busy) return;
    if (picked === null) {
        kit.setPicked({ kind: item.kind, id: item.id, title: item.title, list: item.list, from: item.position, current: item.position, total: item.total });
        kit.say(words(text.grabbed, item.position));
        return;
      }
      kit.setPicked(null);
      if (picked.current === picked.from) {
        kit.say(t(text.dragCancelled, { title: item.title }));
        return;
      }
      kit.send(
        item.kind === "module"
          ? editorButton.moduleTo(item.id, picked.from, picked.current)
          : editorButton.lessonTo(item.id, item.list, picked.from, item.list, picked.current),
        { id: item.id, words: words(text.dropped, picked.current) },
      );
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    // Una tecla mantenida no toma, suelta y vuelve a tomar en ráfaga.
    if (event.repeat || kit.busy) {
      if (event.key === " " || event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
      return;
    }
    if (picked === null) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const current = stepTo(item.total, picked.current, event.key === "ArrowUp" ? "up" : "down");
      kit.setPicked({ ...picked, current });
      kit.say(words(text.dragTo, current));
    }
    if (event.key === "Escape") {
      event.preventDefault();
      kit.setPicked(null);
      kit.say(t(text.dragCancelled, { title: item.title }));
    }
  }

  function onDragStart(event: DragEvent<HTMLSpanElement>) {
    if (kit.busy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    // Un tipo propio: soltar el asa sobre un campo de texto no escribe nada en él.
    event.dataTransfer.setData(DRAG_TYPE, item.id);
    kit.setMouse({ kind: item.kind, id: item.id });
  }

  if (!kit.enabled) return null;
  return (
    <span className="flex items-center gap-2">
      {/* Un `<span>` con papel de botón y no un `<button>`: Chrome no empieza a arrastrar desde un botón (medido el
          2026-10-29 en el extremo a extremo: ni un `dragstart`). El teclado lo atiende `onKeyDown`. */}
      <span
        role="button"
        tabIndex={0}
        draggable={!kit.busy}
        data-handle={item.id}
        aria-pressed={picked !== null}
        aria-disabled={kit.busy || undefined}
        aria-describedby={DRAG_HINT_ID}
        onKeyDown={onKeyDown}
        onClick={toggle}
        onBlur={() => {
          if (picked === null) return;
          kit.setPicked(null);
          kit.say(t(text.dragCancelled, { title: item.title }));
        }}
        onDragStart={onDragStart}
        onDragEnd={() => kit.setMouse(null)}
        className="flex size-touch cursor-grab items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text aria-pressed:bg-surface-2 aria-pressed:text-text"
      >
        <Icon icon={GripVertical} />
        <span className="sr-only">{t(text.dragHandle, { title: item.title })}</span>
      </span>
      {picked !== null && <span className="text-caption text-accent">{t(text.dragPlace, { position: picked.current, total: item.total })}</span>}
    </span>
  );
}

/** Lo que deja soltar sobre una fila: la del tipo que acepta, y no sobre sí misma. */
function dropZone(kit: DragKit, over: Dragged, accepts: Dragged["kind"][]) {
  if (!kit.enabled) return {};
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const dragged = kit.dragging();
      if (dragged === null || !accepts.includes(dragged.kind) || (dragged.kind === over.kind && dragged.id === over.id)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const dragged = kit.dragging();
      if (dragged === null || !accepts.includes(dragged.kind)) return;
      event.preventDefault();
      event.stopPropagation();
      kit.drop(over);
    },
  };
}

interface ModuleItemProps {
  module: ModuleRow;
  view: EditorView;
  state: BlockState;
  responses: ReturnType<typeof useResponses>;
  action: (form: FormData) => void;
  onInput: () => void;
  pending: boolean;
  kit: DragKit;
  position: number;
  total: number;
}

function ModuleItem({ module, view, state, responses, action, onInput, pending, kit, position, total }: ModuleItemProps) {
  const lessonError = fieldError("lessonTitle", problemOf(state, "title", module.id));
  const fieldId = `editor-leccion-nueva-${module.id}`;
  const typing = useTyping(`${STRUCTURE_KEY}leccion-${module.id}`, module.id, state, onInput, view.paths.self);
  return (
    <li {...dropZone(kit, { kind: "module", id: module.id }, ["module", "lesson"])} className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          {view.editable && <DragHandle item={{ kind: "module", id: module.id, title: module.title, list: view.course, position, total }} kit={kit} />}
          <Link href={module.href} aria-current={module.current ? "true" : undefined} className="min-h-touch content-center font-semibold text-text hover:underline">
            {t(text.moduleLink, { label: module.label, title: module.title })}
          </Link>
        </span>
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
          {module.lessons.map((lesson, index) => (
            <li key={lesson.id} {...dropZone(kit, { kind: "lesson", id: lesson.id }, ["lesson"])} className="flex flex-col gap-2 border-t border-border pt-2">
              <span className="flex items-center gap-2">
                {view.editable && (
                  <DragHandle
                    item={{ kind: "lesson", id: lesson.id, title: lesson.title, list: module.id, position: index + 1, total: module.lessons.length }}
                    kit={kit}
                  />
                )}
                <Link href={lesson.href} aria-current={lesson.current ? "true" : undefined} className="min-h-touch content-center text-text hover:underline">
                  {lesson.title}
                </Link>
              </span>
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
        <form action={action} onInput={typing.onInput} {...typing.form} data-leaves="detail" className="flex flex-col gap-2">
          <CourseField course={view.course} />
          <CountedField
            key={`${responses.keyOf(module.id)}-${typing.fresh}`}
            id={fieldId}
            name="title"
            label={text.newLessonLabel}
            max={DRAFT_TEXT_LIMITS.lessonTitle}
            warnAt={WARN_AT.lessonTitle}
            defaultValue={responses.valueOf(module.id, "title", "")}
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
  const responses = useResponses(state);
  const result = useResult(state, pending, view.paths.self);
  const { block, answer, spoken, away } = useAnswerFocus(pending, attemptOf(state), result.message);
  const typing = useTyping(`${STRUCTURE_KEY}modulo`, "module", state, result.onInput, view.paths.self);
  const hydrated = useHydrated();
  const dropForm = useRef<HTMLFormElement>(null);
  const dropValue = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const mouse = useRef<Dragged | null>(null);
  const [voice, setVoice] = useState("");
  // Lo que se soltó con el teclado: a qué asa vuelve el foco y qué se dice cuando la base conteste.
  const dropped = useRef<{ id: string; words: string } | null>(null);
  const send = (value: string, keyboard?: { id: string; words: string }) => {
    if (dropForm.current === null || dropValue.current === null) return;
    dropped.current = keyboard ?? null;
    dropValue.current.value = value;
    dropForm.current.requestSubmit();
  };
  useEffect(() => {
    const done = dropped.current;
    if (done === null || state.kind === "idle" || pending) return;
    dropped.current = null;
    // Un fallo lo dice el bloque, que se lleva el foco a su aviso: el asa no se lo quita.
    if (state.kind !== "done" || state.target !== "move") return;
    setVoice(done.words);
    // Quien se fue a otra cosa mientras se guardaba se queda donde está.
    if (away.current) return;
    // Después de que el bloque mueva el foco a su respuesta: el asa lo recupera, para seguir con el teclado.
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>(`[data-handle="${done.id}"]`)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [state, pending, away]);
  const kit: DragKit = {
    enabled: hydrated,
    busy: pending,
    picked,
    setPicked,
    dragging: () => mouse.current,
    setMouse: (dragged) => {
      mouse.current = dragged;
    },
    say: setVoice,
    send,
    drop: (over) => {
      const dragged = mouse.current;
      mouse.current = null;
      if (dragged === null) return;
      const value = dropButton(view.structure.modules, dragged, over);
      if (value !== null) send(value);
    },
  };

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
      {view.editable && hydrated && (
        <>
          <p id={DRAG_HINT_ID} className="sr-only">
            {text.dragHint}
          </p>
          {/* Existe desde antes: una región que nace con su texto no siempre se anuncia. */}
          <p role="status" className="sr-only">
            {voice}
          </p>
          {/* Soltar una fila manda su botón por aquí, con la misma acción y el mismo estado que «Subir». */}
          <form ref={dropForm} action={action} className="hidden">
            <CourseField course={view.course} />
            <input ref={dropValue} type="hidden" name="do" />
          </form>
        </>
      )}
      {view.structure.modules.length === 0 ? (
        <p className="text-body-s text-text-3">{text.noModules}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {view.structure.modules.map((module, index) => (
            <ModuleItem
              key={module.id}
              module={module}
              view={view}
              state={state}
              responses={responses}
              action={action}
              onInput={result.onInput}
              pending={pending}
              kit={kit}
              position={index + 1}
              total={view.structure.modules.length}
            />
          ))}
        </ol>
      )}
      {view.editable && (
        <form action={action} onInput={typing.onInput} {...typing.form} data-leaves="detail" className="flex flex-col gap-2">
          <CourseField course={view.course} />
          <CountedField
            key={`${responses.keyOf("module")}-${typing.fresh}`}
            id="editor-modulo-nuevo"
            name="title"
            label={text.newModuleLabel}
            max={DRAFT_TEXT_LIMITS.moduleTitle}
            warnAt={WARN_AT.moduleTitle}
            defaultValue={responses.valueOf("module", "title", "")}
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
  const responses = useResponses(state);
  const result = useResult(state, pending, view.paths.self);
  // Cancelar quita la pregunta y el botón pulsado con ella: como intento 0, el foco vuelve al bloque.
  const { block, answer, spoken } = useAnswerFocus(pending, state.kind === "kept" ? 0 : attemptOf(state), result.message);
  const typing = useTyping("elegido", "item", state, result.onInput, view.paths.self);
  const confirm = useRef<HTMLDivElement>(null);
  const confirming = state.kind === "confirming" ? state.attempt : 0;
  // La pregunta toma el foco: el botón «Borrar» que se pulsó se fue con ella.
  useEffect(() => {
    if (confirming !== 0) confirm.current?.focus();
  }, [confirming]);

  const titleKind: DraftTextKind = isLesson ? "lessonTitle" : "moduleTitle";
  const titleError = fieldError(titleKind, problemOf(state, "title", "item"));
  const descriptionError = isLesson ? fieldError("description", problemOf(state, "description", "item")) : null;
  const errors: FormError[] = [
    titleError && { fieldId: "editor-elegido-titulo", message: titleError },
    descriptionError && { fieldId: "editor-elegido-descripcion", message: descriptionError },
  ].filter((error): error is FormError => Boolean(error));
  const confirmText = isLesson
    ? text.confirmDeleteLesson
    : selected.lessons === 0
      ? text.confirmDeleteEmptyModule
      : t(plural(selected.lessons, text.confirmDeleteModule), { count: selected.lessons });
  const deleteLabel = isLesson ? text.deleteLesson : text.deleteModule;

  return (
    <section id={blockId} ref={block} tabIndex={-1} aria-labelledby="editor-elegido-encabezado" className="flex flex-col gap-6 outline-none">
      <h2 id="editor-elegido-encabezado" className="text-h2">
        {selected.title}
      </h2>
      {view.editable ? (
        <form action={action} onInput={typing.onInput} {...typing.form} className="flex flex-col gap-6">
          <CourseField course={view.course} />
          <FormErrorSummary errors={errors} attempt={attemptOf(state)} />
          <BlockResult
            message={result.message}
            tone={result.tone}
            pending={pending}
            pendingText={state.kind === "confirming" ? text.working : text.saving}
            answer={answer}
            spoken={spoken}
          />
          <div key={responses.keyOf("item")} className="flex flex-col gap-6">
            <CountedField
              id="editor-elegido-titulo"
              name="title"
              label={isLesson ? text.lessonTitleLabel : text.moduleTitleLabel}
              max={DRAFT_TEXT_LIMITS[titleKind]}
              warnAt={WARN_AT[titleKind]}
              defaultValue={responses.valueOf("item", "title", selected.title)}
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
                defaultValue={responses.valueOf("item", "description", selected.description ?? "")}
                error={descriptionError}
                optional
                multiline
                readOnly={pending}
              />
            )}
          </div>
          {state.kind === "confirming" ? (
            <div ref={confirm} tabIndex={-1} className="flex flex-col gap-3 rounded-md border border-danger p-4 outline-none">
              <p className="text-body">{confirmText}</p>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" name="do" value="cancel" variant="secondary">
                  {text.cancel}
                </Button>
                <Button type="submit" name="do" value={selected.remove} variant="danger">
                  {deleteLabel}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button type="submit" name="do" value={selected.save} loading={pending} loadingLabel={text.saving}>
                {text.save}
              </Button>
              <Button type="submit" name="do" value={selected.askDelete} variant="danger">
                {deleteLabel}
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
