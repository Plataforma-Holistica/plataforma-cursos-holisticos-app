"use client";

import { unstable_rethrow } from "next/navigation";
import { type FormEvent, useActionState, useEffect, useRef, useState } from "react";

import { useHydrated } from "@/app/(cuenta)/_lib/hooks";
import { DOWNLOAD_CHANNEL_FIELD, DOWNLOAD_CHANNEL_JS } from "@/app/_catalog/resources/channel";
import { openFileInFrame } from "@/app/_catalog/resources/open-file";
import { BlockResult, useAnswerFocus } from "@/app/admin/_lib/answer";
import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { DRAFT_TEXT_LIMITS, RESOURCE_EXTENSIONS, resourceTypeOf } from "@/services/drafts/field-rules";
import { Button } from "@/ui/button";
import { InlineAlert } from "@/ui/inline-alert";
import { ProgressBar } from "@/ui/progress-bar";

import { CountedField } from "../_lib/counted-field";
import { checkDraftText } from "../_lib/text";
import { failureText, problemText } from "../_lib/words";
import { RESOURCES_ID } from "./anchors";
import { beginResourceAction, cancelResourceAction, confirmResourceAction, resourceAction } from "./resource-actions";
import { checkFile, progressStep, resourceButton, titleFromFile, type ResourceState, type UploadProblem } from "./resource-outcomes";
import type { ResourceRow } from "./rows";
import { UPLOAD_KEY, useUnsaved } from "./unsaved";

// Los recursos de una lección o del curso, en el editor (PA-43; T-404). La lista va por su formulario y su propio
// estado, y funciona sin JavaScript. Adjuntar no: el archivo sube del navegador a la cubeta, porque Vercel corta todo
// envío a una función en 4.5 MB, así que sin JavaScript se dice y no se ofrece.
//
//   · Mientras un archivo sube, salir pregunta: la barra dice «Cambios sin guardar» y el aviso del navegador salta.
//   · El avance se anuncia cada 25 % (diseño, `FileUpload`), y no con cada evento; la barra sí va exacta.
//   · Lo que se revisa aquí antes de subir (tipo y tamaño) es comodidad: lo que manda es la base y la cubeta.
//   · Si la subida llegó y confirmar no se pudo saber, se reintenta solo confirmar: subir otra vez gastaría otra fila,
//     otro objeto y otro cupo del freno. Si se elige otro archivo, se cancela la fila que quedó.
//   · El botón no se deshabilita mientras sube: perdería el foco, y un rechazo no tendría a quién decírselo. El aviso
//     del problema es una región viva, y un problema del título lleva el foco a su campo.

const text = portal.editor.resources;
const IDLE: ResourceState = { kind: "idle" };
/** Una subida colgada no deja la pantalla ocupada para siempre: 50 MB caben de sobra en este tiempo. */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const attemptOf = (state: ResourceState) => (state.kind === "idle" ? 0 : state.attempt);

/** Sube el archivo a la dirección firmada, con su avance. El tipo es el que fijó el servidor. */
function putFile(url: string, file: File, mime: string, started: (request: XMLHttpRequest) => void, onProgress: (loaded: number, total: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    started(request);
    request.open("PUT", url);
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.setRequestHeader("content-type", mime);
    request.upload.onprogress = (event) => onProgress(event.loaded, event.total);
    request.onload = () => resolve(request.status >= 200 && request.status < 300);
    request.onerror = () => resolve(false);
    request.onabort = () => resolve(false);
    request.ontimeout = () => resolve(false);
    request.send(file);
  });
}

type Upload = { phase: "idle" } | { phase: "sending"; loaded: number; total: number } | { phase: "finishing" };

interface AttachProps {
  course: string;
  lesson: string | null;
  maxBytes: number | null;
  maxText: string;
  /** El lugar está lleno: el formulario se queda, para que el «Listo» del último y su foco no se vayan. */
  full: boolean;
}

function AttachForm({ course, lesson, maxBytes, maxText, full }: AttachProps) {
  const { mark } = useUnsaved();
  const [upload, setUpload] = useState<Upload>({ phase: "idle" });
  const [problem, setProblem] = useState<UploadProblem | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState(0);
  // Cuenta los intentos: el aviso se vuelve a armar, y el mismo problema dos veces se anuncia dos veces.
  const [attempt, setAttempt] = useState(0);
  // Cuenta los errores del título: el foco llega al campo cuando su error ya está pintado.
  const [titleFailed, setTitleFailed] = useState(0);
  // El último título que puso el nombre de un archivo: lo demás lo escribió la persona, y no se pisa.
  const autoTitle = useRef("");
  const sending = useRef<XMLHttpRequest | null>(null);
  // La subida que llegó y que falta confirmar: «Reintentar» solo confirma.
  const [waiting, setWaiting] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleField = useRef<HTMLDivElement>(null);
  const place = lesson ?? "curso";
  const busy = upload.phase !== "idle";
  // Mientras sube, y mientras falte confirmar lo que ya subió, salir lo perdería.
  useEffect(() => {
    mark(UPLOAD_KEY, busy || waiting !== null);
  }, [busy, waiting, mark]);
  useEffect(
    () => () => {
      mark(UPLOAD_KEY, false);
      // Salir sin guardar: la subida no sigue sola, y su fila se cancela con lo que contesta `putFile`.
      sending.current?.abort();
    },
    [mark],
  );
  useEffect(() => {
    if (titleFailed !== 0) titleField.current?.querySelector("input")?.focus();
  }, [titleFailed]);

  function onPick() {
    // Un selector que ya estaba abierto puede entregar el archivo durante una subida: no se toca nada.
    if (busy) return;
    const file = input.current?.files?.[0];
    if (waiting !== null) {
      void cancelResourceAction({ course, resource: waiting }).catch(() => undefined);
      setWaiting(null);
    }
    setDone(false);
    setTitleError(null);
    setAttempt((count) => count + 1);
    setProblem(file === undefined ? null : checkFile(file, resourceTypeOf(file.name) !== null, maxBytes));
    const typed = titleField.current?.querySelector("input")?.value.trim() ?? "";
    if (typed !== "" && typed !== autoTitle.current) {
      setTitle(typed);
    } else {
      autoTitle.current = file === undefined ? "" : titleFromFile(file.name);
      setTitle(autoTitle.current);
    }
    setPicked((count) => count + 1);
  }

  async function finish(resource: string) {
    setUpload({ phase: "finishing" });
    const confirmed = await confirmResourceAction({ course, lesson, resource });
    if (confirmed.kind === "problem") {
      // Lo que no se supo, o lo que todavía no aparece, se puede intentar otra vez; lo demás ya no tiene fila.
      setWaiting(confirmed.problem === "unavailable" || confirmed.problem === "notUploaded" ? resource : null);
      setProblem(confirmed.problem);
      return;
    }
    setWaiting(null);
    setDone(true);
    autoTitle.current = "";
    setTitle("");
    setPicked((count) => count + 1);
    if (input.current !== null) input.current.value = "";
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const file = input.current?.files?.[0];
    const typed = String(new FormData(event.currentTarget).get("resource-title") ?? "");
    setDone(false);
    setProblem(null);
    setTitleError(null);
    setAttempt((count) => count + 1);
    if (waiting === null && full) {
      setProblem("tooMany");
      return;
    }
    setUpload({ phase: "finishing" });
    try {
      if (waiting !== null) {
        await finish(waiting);
        return;
      }
      if (file === undefined) {
        setProblem("noFile");
        return;
      }
      const checked = checkFile(file, resourceTypeOf(file.name) !== null, maxBytes);
      if (checked !== null) {
        setProblem(checked);
        return;
      }
      const titleProblem = checkDraftText("lessonTitle", typed);
      if (titleProblem !== null) {
        setTitleError(problemText("lessonTitle", titleProblem));
        setTitleFailed((count) => count + 1);
        return;
      }
      setUpload({ phase: "sending", loaded: 0, total: file.size });
      const begun = await beginResourceAction({ course, lesson, title: typed, fileName: file.name, size: file.size });
      if (begun.kind === "problem") {
        setProblem(begun.problem);
        return;
      }
      const sent = await putFile(
        begun.url,
        file,
        begun.mime,
        (request) => {
          sending.current = request;
        },
        (loaded, total) => setUpload({ phase: "sending", loaded, total }),
      );
      sending.current = null;
      if (!sent) {
        await cancelResourceAction({ course, resource: begun.resource });
        setProblem("unavailable");
        return;
      }
      setWaiting(begun.resource);
      await finish(begun.resource);
    } catch (error) {
      // Una acción que redirige llega aquí como una falla, y no lo es: la navegación sigue.
      unstable_rethrow(error);
      setProblem("unavailable");
    } finally {
      setUpload({ phase: "idle" });
    }
  }

  const step = upload.phase === "sending" ? progressStep(upload.loaded, upload.total) : 0;
  const exact = upload.phase === "sending" && upload.total > 0 ? Math.floor((Math.min(upload.loaded, upload.total) / upload.total) * 100) : 0;
  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3" aria-label={text.attach}>
      <input type="hidden" name="course" value={course} />
      <div className="flex flex-col gap-2">
        <label htmlFor={`recurso-archivo-${place}`} className="text-label">
          {text.fileLabel}
        </label>
        <input
          ref={input}
          id={`recurso-archivo-${place}`}
          type="file"
          accept={RESOURCE_EXTENSIONS.join(",")}
          onChange={onPick}
          disabled={busy || full}
          aria-describedby={`recurso-nota-${place}`}
          className="min-h-touch text-body-s text-text-2"
        />
        <p id={`recurso-nota-${place}`} className="text-caption text-text-3">
          {maxText === "" ? text.fileHintNoLimit : t(text.fileHint, { max: maxText })}
        </p>
      </div>
      <div ref={titleField}>
        <CountedField
          key={picked}
          id={`recurso-titulo-${place}`}
          name="resource-title"
          label={text.titleLabel}
          max={DRAFT_TEXT_LIMITS.lessonTitle}
          warnAt={108}
          defaultValue={title}
          error={titleError}
          readOnly={busy || waiting !== null}
        />
      </div>
      {upload.phase === "sending" && <ProgressBar value={upload.loaded} max={upload.total} label={text.progressLabel} text={t(text.progress, { percent: String(exact) })} />}
      {/* Existe desde antes: una región que nace con su texto no siempre se anuncia. El avance, en pasos y sin verse: la barra ya lo dice. */}
      <p role="status" className="text-body-s text-text-2">
        {upload.phase === "sending" ? <span className="sr-only">{t(text.progress, { percent: String(step) })}</span> : upload.phase === "finishing" ? text.finishing : done ? text.attached : null}
      </p>
      {problem !== null && (
        <InlineAlert key={attempt} tone="danger" live>
          {text.problems[problem]}
        </InlineAlert>
      )}
      <div>
        <Button type="submit" variant="secondary" pending={busy} loadingLabel={text.working}>
          {waiting !== null ? text.retry : text.attach}
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
  const opened = useRef(0);
  // Qué intento de bajar no trajo un archivo. Lo dice el marco, después de contestar.
  const [missed, setMissed] = useState(0);
  // Una vez por intento: la respuesta vieja sigue en el estado mientras la pantalla se vuelve a pintar. En un marco oculto: aquí
  // puede haber algo sin guardar, y la página no debe irse si Storage no contesta con el archivo.
  useEffect(() => {
    if (state.kind !== "granted" || state.attempt === opened.current) return;
    const { attempt, url } = state;
    opened.current = attempt;
    openFileInFrame(url, () => setMissed(attempt));
  }, [state]);
  const missedFile = state.kind === "granted" && missed === state.attempt;
  let message: string | null = null;
  if (!pending && state.kind === "done") message = state.what === "moved" ? text.moved : text.removed;
  if (!pending && state.kind === "failed") message = failureText(state.reason);
  if (!pending && state.kind === "granted") message = missedFile ? text.downloadMaybeMissed : text.downloadStarted;
  if (!pending && state.kind === "download_throttled") message = text.downloadThrottled;
  // Se pregunta solo por lo que sigue en la lista: si otra pestaña ya lo quitó, se ofrecen los botones de siempre.
  const asking = state.kind === "confirming" && items.some((item) => item.id === state.resource) ? state.resource : null;
  // Cancelar quita la pregunta y el botón pulsado con ella: como intento 0, el foco vuelve al bloque. Lo mismo si lo
  // que se preguntaba ya no está.
  const toBlock = state.kind === "kept" || (state.kind === "confirming" && asking === null);
  const { block, answer, spoken, away } = useAnswerFocus(pending, toBlock ? 0 : attemptOf(state), message);
  const question = useRef<HTMLDivElement>(null);
  const askingAttempt = asking !== null && state.kind === "confirming" ? state.attempt : 0;
  // La pregunta toma el foco: el botón «Quitar» que se pulsó se fue con ella. A quien se fue a otra cosa no se lo quita.
  useEffect(() => {
    if (askingAttempt !== 0 && !away.current) question.current?.focus();
  }, [askingAttempt, away]);
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
      <BlockResult message={message} tone={state.kind === "failed" || state.kind === "download_throttled" || missedFile ? "danger" : "success"} pending={pending} pendingText={portal.editor.working} answer={answer} spoken={spoken} />
      {items.length === 0 ? (
        <p className="text-body-s text-text-3">{text.none}</p>
      ) : (
        <form
          action={action}
          onSubmit={(event) => {
            // Con un envío en camino, la respuesta de otro taparía la primera: una dirección se perdería sin decir nada.
            if (pending) event.preventDefault();
          }}
        >
          <input type="hidden" name="course" value={course} />
          {lesson !== null && <input type="hidden" name="lesson" value={lesson} />}
          {hydrated && <input type="hidden" name={DOWNLOAD_CHANNEL_FIELD} value={DOWNLOAD_CHANNEL_JS} />}
          <ul className="flex flex-col divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 flex-auto">
                    <span className="block break-words text-text">{item.title}</span>
                    <span className="block text-caption text-text-3">{item.detail}</span>
                  </span>
                  {asking === null && (
                    <Button type="submit" name="do" value={resourceButton.download(item.id)} variant="secondary" size="md">
                      <span aria-hidden="true">{text.download}</span>
                      <span className="sr-only">{t(text.downloadNamed, { title: item.title })}</span>
                    </Button>
                  )}
                  {editable && asking === null && (
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
                {editable && asking === item.id && (
                  <div ref={question} tabIndex={-1} className="flex flex-col gap-3 rounded-md border border-danger p-3 outline-none">
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
          <>
            {full && <p className="text-body-s text-text-3">{text.full}</p>}
            <AttachForm course={course} lesson={lesson} maxBytes={limits.maxBytes} maxText={limits.maxText} full={full} />
          </>
        ) : (
          <p className="text-body-s text-text-3">{text.needsJavascript}</p>
        ))}
    </section>
  );
}
