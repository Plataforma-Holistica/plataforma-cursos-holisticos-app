"use client";

import { type FormEvent, useActionState, useEffect, useRef, useState } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";
import { BlockResult, useAnswerFocus } from "@/app/admin/_lib/answer";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { DRAFT_TEXT_LIMITS, RESOURCE_EXTENSIONS, resourceTypeOf } from "@/services/drafts/field-rules";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";
import { ProgressBar } from "@/ui/progress-bar";

import { CountedField } from "../_lib/counted-field";
import { failureText } from "../_lib/words";
import { RESOURCES_ID } from "./anchors";
import { beginResourceAction, cancelResourceAction, confirmResourceAction, resourceAction } from "./resource-actions";
import { checkFile, progressStep, resourceButton, titleFromFile, type ResourceState, type UploadProblem } from "./resource-outcomes";
import type { ResourceRow } from "./rows";
import { useUnsaved } from "./unsaved";

// Los recursos de una lección o del curso, en el editor (PA-43; T-404). La lista va por su formulario y su propio
// estado, y funciona sin JavaScript. Adjuntar no: el archivo sube del navegador a la cubeta, porque Vercel corta todo
// envío a una función en 4.5 MB, así que sin JavaScript se dice y no se ofrece.
//
//   · Mientras un archivo sube, salir pregunta: la barra dice «Cambios sin guardar» y el aviso del navegador salta.
//   · El avance se anuncia cada 25 % (diseño, `FileUpload`), y no con cada evento.
//   · Lo que se revisa aquí antes de subir (tipo y tamaño) es comodidad: lo que manda es la base y la cubeta.

const text = portal.editor.resources;
const IDLE: ResourceState = { kind: "idle" };
const UPLOAD_KEY = "recurso-subiendo";

const attemptOf = (state: ResourceState) => (state.kind === "idle" ? 0 : state.attempt);

/** Sube el archivo a la dirección firmada, con su avance. El tipo es el que fijó el servidor. */
function putFile(url: string, file: File, mime: string, onProgress: (loaded: number, total: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("content-type", mime);
    request.upload.onprogress = (event) => onProgress(event.loaded, event.total);
    request.onload = () => resolve(request.status >= 200 && request.status < 300);
    request.onerror = () => resolve(false);
    request.onabort = () => resolve(false);
    request.send(file);
  });
}

type Upload = { phase: "idle" } | { phase: "sending"; percent: number } | { phase: "finishing" };

function AttachForm({ course, lesson, maxBytes, maxText, full }: { course: string; lesson: string | null; maxBytes: number | null; maxText: string; full: boolean }) {
  const { mark } = useUnsaved();
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  const [problem, setProblem] = useState<UploadProblem | null>(null);
  const [done, setDone] = useState(false);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const busy = upload.phase !== "idle";
  useEffect(() => () => mark(UPLOAD_KEY, false), [mark]);

  function onPick() {
    const file = input.current?.files?.[0];
    setDone(false);
    setProblem(file === undefined ? null : checkFile(file, resourceTypeOf(file.name) !== null, maxBytes));
    setTitle(file === undefined ? "" : titleFromFile(file.name));
    setPicked((count) => count + 1);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    const typed = String(new FormData(event.currentTarget).get("resource-title") ?? "").trim();
    if (busy || file === undefined) return;
    const checked = checkFile(file, resourceTypeOf(file.name) !== null, maxBytes) ?? (typed === "" ? "noTitle" : null);
    setProblem(checked);
    setDone(false);
    if (checked !== null) return;
    setUpload({ phase: "sending", percent: 0 });
    mark(UPLOAD_KEY, true);
    try {
      const begun = await beginResourceAction({ course, lesson, title: typed, fileName: file.name, size: file.size });
      if (begun.kind === "problem") {
        setProblem(begun.problem);
        return;
      }
      const sent = await putFile(begun.url, file, begun.mime, (loaded, total) => setUpload({ phase: "sending", percent: progressStep(loaded, total) }));
      if (!sent) {
        await cancelResourceAction({ course, resource: begun.resource });
        setProblem("unavailable");
        return;
      }
      setUpload({ phase: "finishing" });
      const confirmed = await confirmResourceAction({ course, lesson, resource: begun.resource });
      if (confirmed.kind === "problem") {
        setProblem(confirmed.problem);
        return;
      }
      setDone(true);
      setTitle("");
      setPicked((count) => count + 1);
      if (input.current !== null) input.current.value = "";
    } catch {
      setProblem("unavailable");
    } finally {
      setUpload({ phase: "idle" });
      mark(UPLOAD_KEY, false);
    }
  }

  if (full) return <p className="text-body-s text-text-3">{text.full}</p>;
  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3" aria-label={text.attach}>
      <input type="hidden" name="course" value={course} />
      <div className="flex flex-col gap-2">
        <label htmlFor={`recurso-archivo-${lesson ?? "curso"}`} className="text-label">
          {text.fileLabel}
        </label>
        <input
          ref={input}
          id={`recurso-archivo-${lesson ?? "curso"}`}
          type="file"
          accept={RESOURCE_EXTENSIONS.join(",")}
          onChange={onPick}
          disabled={busy}
          aria-describedby={`recurso-nota-${lesson ?? "curso"}`}
          className="min-h-touch text-body-s text-text-2"
        />
        <p id={`recurso-nota-${lesson ?? "curso"}`} className="text-caption text-text-3">
          {t(text.fileHint, { max: maxText })}
        </p>
      </div>
      <CountedField
        key={picked}
        id={`recurso-titulo-${lesson ?? "curso"}`}
        name="resource-title"
        label={text.titleLabel}
        max={DRAFT_TEXT_LIMITS.lessonTitle}
        warnAt={108}
        defaultValue={title}
        error={problem === "noTitle" ? text.problems.noTitle : null}
        readOnly={busy}
      />
      {upload.phase === "sending" && <ProgressBar value={upload.percent} max={100} label={text.progressLabel} text={t(text.progress, { percent: upload.percent })} />}
      {/* Existe desde antes: una región que nace con su texto no siempre se anuncia. */}
      <p role="status" className="text-body-s text-text-2">
        {upload.phase === "sending" ? t(text.progress, { percent: upload.percent }) : upload.phase === "finishing" ? text.finishing : done ? text.attached : null}
      </p>
      {problem !== null && problem !== "noTitle" && <InlineAlert tone="danger">{text.problems[problem]}</InlineAlert>}
      <div>
        <Button type="submit" variant="secondary" disabled={busy}>
          {text.attach}
        </Button>
      </div>
    </form>
  );
}

export interface ResourcesBlockProps {
  course: string;
  /** Nula: los del curso. */
  lesson: string | null;
  items: ResourceRow[];
  editable: boolean;
  self: string;
  limits: { maxBytes: number | null; maxText: string; perPlace: number | null };
}

export function ResourcesBlock({ course, lesson, items, editable, self, limits }: ResourcesBlockProps) {
  const [state, action, pending] = useActionState(resourceAction, IDLE, `${self}#${RESOURCES_ID}`);
  const hydrated = useHydrated();
  let message: string | null = null;
  if (!pending && state.kind === "done") message = state.what === "moved" ? text.moved : text.removed;
  if (!pending && state.kind === "failed") message = failureText(state.reason);
  const { block, answer, spoken } = useAnswerFocus(pending, attemptOf(state), message);
  const full = limits.perPlace !== null && items.length >= limits.perPlace;

  return (
    <section
      id={RESOURCES_ID}
      ref={block}
      tabIndex={-1}
      aria-labelledby="editor-recursos-titulo"
      className="flex flex-col gap-4 rounded-md border border-border bg-surface-1 p-4 outline-none sm:p-6"
    >
      <h3 id="editor-recursos-titulo" className="text-h3">
        {lesson === null ? text.courseTitle : text.lessonTitle}
      </h3>
      <BlockResult message={message} tone={state.kind === "failed" ? "danger" : "success"} pending={pending} pendingText={portal.editor.working} answer={answer} spoken={spoken} />
      {items.length === 0 ? (
        <p className="text-body-s text-text-3">{text.none}</p>
      ) : (
        <form action={action}>
          <input type="hidden" name="course" value={course} />
          {lesson !== null && <input type="hidden" name="lesson" value={lesson} />}
          <ul className="flex flex-col divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 flex-auto">
                    <span className="block break-words text-text">{item.title}</span>
                    <span className="block text-caption text-text-3">{item.detail}</span>
                  </span>
                  {editable && state.kind !== "confirming" && (
                    <span className="flex flex-wrap gap-2">
                      {item.up !== null && (
                        <Button type="submit" name="do" value={item.up} variant="secondary" size="md">
                          <span aria-hidden="true">{portal.editor.up}</span>
                          <span className="sr-only">{t(portal.editor.upNamed, { title: item.title })}</span>
                        </Button>
                      )}
                      {item.down !== null && (
                        <Button type="submit" name="do" value={item.down} variant="secondary" size="md">
                          <span aria-hidden="true">{portal.editor.down}</span>
                          <span className="sr-only">{t(portal.editor.downNamed, { title: item.title })}</span>
                        </Button>
                      )}
                      <Button type="submit" name="do" value={resourceButton.ask(item.id)} variant="secondary" size="md">
                        <span aria-hidden="true">{text.remove}</span>
                        <span className="sr-only">{t(text.removeNamed, { title: item.title })}</span>
                      </Button>
                    </span>
                  )}
                </div>
                {editable && state.kind === "confirming" && state.resource === item.id && (
                  <div className="flex flex-col gap-3 rounded-md border border-danger p-3">
                    <p className="text-body">{t(text.confirmRemove, { title: item.title })}</p>
                    <div className="flex flex-wrap gap-3">
                      <Button type="submit" name="do" value={resourceButton.cancel()} variant="secondary" size="md">
                        {portal.editor.cancel}
                      </Button>
                      <Button type="submit" name="do" value={resourceButton.remove(item.id, item.revision)} variant="danger" size="md">
                        {text.remove}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </form>
      )}
      {editable &&
        (hydrated ? (
          <AttachForm course={course} lesson={lesson} maxBytes={limits.maxBytes} maxText={limits.maxText} full={full} />
        ) : (
          <p className="text-body-s text-text-3">{text.needsJavascript}</p>
        ))}
    </section>
  );
}
