"use client";

import { unstable_rethrow } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Upload } from "tus-js-client";

import { isObjectAlreadyThere, videoTusOptions, type VideoTarget } from "./tus-upload";
import { VIDEO_KEY, useUnsaved } from "./unsaved";
import { beginVideoAction, checkVideosAction, confirmVideoAction, removeVideoAction, renewVideoAction } from "./video-actions";
import { canRetryConfirm, type VideoBlockedKind, type VideoProblem } from "./video-outcomes";

// Las subidas de video de un curso en el editor (PA-43; T-403). Viven por encima del detalle: se puede cambiar de lección en el mismo
// curso y la subida sigue (decisión de Sergio del 2026-10-31). Salir del editor pregunta, y al volver se elige el mismo archivo: lo que
// ya subió está en Storage y el navegador recuerda dónde iba.
//
//   · Una por video, a lo más, también entre pestañas (`navigator.locks`). Quien no alcanza el candado no toca nada y lo dice.
//   · La firma dura 2 h y se pide otra a los 90 minutos, o al reanudar a mano, por si fue lo que cortó.
//   · Si al reanudar el archivo ya estaba completo (se perdió la respuesta de confirmar), confirma primero: sin eso se volverían a
//     subir hasta 5 GB para que Storage los rechazara al final.
//   · Una lección borrada se lleva su subida: no se gasta más subiendo lo que ya no tiene fila.
//   · Lo que dispara una subida cancelada o pausada llega tarde: cada evento mira que la suya siga siendo la vigente de esa lección, y
//     una subida solo arranca si no está corriendo (un doble clic en «Reanudar» arrancaría dos).
//   · Lo que ya llegó se pregunta al cargar, al terminar de confirmar y cada tanto mientras haya algo en camino y la pantalla se vea: sin webhook, es
//     lo único que lo mueve (T-403, tercera solicitud). Una pregunta a la vez. El servidor limita por fila, y cuánto esperar lo dice la página.

const RENEW_AFTER_MS = 90 * 60 * 1000;

export type LessonUpload =
  | { phase: "starting"; fileName: string }
  | { phase: "sending" | "paused" | "cut"; video: string; fileName: string; loaded: number; total: number }
  | { phase: "checking"; video: string; fileName: string }
  /** Quitando: hasta que la base conteste no se ofrece elegir, porque reanudaría una fila que se está borrando. */
  | { phase: "removing"; video: string; fileName: string }
  /** Confirmar no se pudo saber: se reintenta solo eso. */
  | { phase: "unchecked"; video: string; fileName: string };

export type LessonNotice = { problem: VideoProblem; attempt: number } | { pendingFile: string; attempt: number } | { done: true; attempt: number };

interface Live {
  video: string;
  file: File;
  target: VideoTarget;
  upload: Upload | null;
  /** Si le toca correr: falso en pausa o después de un corte. */
  running: boolean;
  token: string;
  tokenAt: number;
  /** Suelta el candado entre pestañas. */
  release: () => void;
}

interface VideoUploads {
  uploads: ReadonlyMap<string, LessonUpload>;
  notices: ReadonlyMap<string, LessonNotice>;
  /** Por qué un video recibido no se está procesando, por video. */
  blocked: Readonly<Record<string, VideoBlockedKind>>;
  start: (lesson: string, file: File) => void;
  pause: (lesson: string) => void;
  resume: (lesson: string) => void;
  retryConfirm: (lesson: string) => void;
  /** Cancela una subida de esta pestaña o una a medias de antes, o quita lo ya subido. */
  remove: (lesson: string, video: string) => void;
}

const Context = createContext<VideoUploads | null>(null);

export function useVideoUploads(): VideoUploads {
  const value = useContext(Context);
  if (value === null) throw new Error("useVideoUploads fuera de su proveedor");
  return value;
}

/** Corre `work` con el candado de ese video. Falso si otra pestaña lo tiene. Sin `navigator.locks`, corre: Storage no deja escribir a dos a la vez. */
function withVideoLock(video: string, work: (release: () => void) => void): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    work(() => undefined);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    void navigator.locks.request(`video-upload:${video}`, { ifAvailable: true }, async (lock) => {
      if (lock === null) {
        resolve(false);
        return;
      }
      resolve(true);
      await new Promise<void>((release) => work(release));
    });
  });
}

export function VideoUploadsProvider({ course, lessons, checkEverySeconds, children }: { course: string; lessons: readonly string[]; checkEverySeconds: number | null; children: ReactNode }) {
  const { mark } = useUnsaved();
  const [uploads, setUploads] = useState<ReadonlyMap<string, LessonUpload>>(new Map());
  const [notices, setNotices] = useState<ReadonlyMap<string, LessonNotice>>(new Map());
  const [blocked, setBlocked] = useState<Readonly<Record<string, VideoBlockedKind>>>({});
  const live = useRef(new Map<string, Live>());
  const attempts = useRef(0);
  const checking = useRef(false);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const answer = await checkVideosAction({ course });
      setBlocked(answer.blocked);
    } catch (error) {
      unstable_rethrow(error);
    } finally {
      checking.current = false;
    }
  }, [course]);

  const setUpload = useCallback((lesson: string, value: LessonUpload | null) => {
    setUploads((current) => {
      const next = new Map(current);
      if (value === null) next.delete(lesson);
      else next.set(lesson, value);
      return next;
    });
  }, []);
  const notify = useCallback((lesson: string, notice: { problem: VideoProblem } | { pendingFile: string } | { done: true } | null) => {
    attempts.current += 1;
    const attempt = attempts.current;
    setNotices((current) => {
      const next = new Map(current);
      if (notice === null) next.delete(lesson);
      else next.set(lesson, { ...notice, attempt });
      return next;
    });
  }, []);

  const forget = useCallback(
    (lesson: string) => {
      live.current.get(lesson)?.release();
      live.current.delete(lesson);
      setUpload(lesson, null);
    },
    [setUpload],
  );

  const confirm = useCallback(
    async (lesson: string, video: string, fileName: string, fallback?: () => void) => {
      setUpload(lesson, { phase: "checking", video, fileName });
      try {
        const answer = await confirmVideoAction({ course, lesson, video });
        if (answer.kind === "uploaded") {
          forget(lesson);
          notify(lesson, { done: true });
          void check();
          return;
        }
        if (fallback !== undefined && answer.problem === "notUploaded") {
          fallback();
          return;
        }
        if (canRetryConfirm(answer.problem)) {
          setUpload(lesson, { phase: "unchecked", video, fileName });
        } else {
          forget(lesson);
        }
        notify(lesson, { problem: answer.problem });
      } catch (error) {
        // Una acción que redirige llega aquí como una falla, y no lo es: la navegación sigue.
        unstable_rethrow(error);
        setUpload(lesson, { phase: "unchecked", video, fileName });
        notify(lesson, { problem: "unavailable" });
      }
    },
    [check, course, forget, notify, setUpload],
  );

  const send = useCallback(
    async (lesson: string, file: File, target: VideoTarget, entry: Live) => {
      const { Upload: TusUpload } = await import("tus-js-client");
      const { video } = target;
      const fileName = file.name;
      const current = () => live.current.get(lesson) === entry;
      const upload = new TusUpload(
        file,
        videoTusOptions(target, {
          token: async () => {
            // La de una subida ya cancelada no pide otra: lo que manda es su último «borrar», y si falla no importa.
            if (!current() || Date.now() - entry.tokenAt < RENEW_AFTER_MS) return entry.token;
            const renewed = await renewVideoAction({ course, lesson, video });
            if (renewed.kind !== "renewed") {
              if (renewed.problem === "gone") {
                void upload.abort();
                forget(lesson);
                notify(lesson, { problem: "gone" });
              }
              throw new Error("sin firma");
            }
            entry.token = renewed.token;
            entry.tokenAt = Date.now();
            return entry.token;
          },
          onProgress: (loaded, total) => {
            if (current() && entry.running) setUpload(lesson, { phase: "sending", video, fileName, loaded, total });
          },
          onSuccess: () => {
            if (current()) void confirm(lesson, video, fileName);
          },
          onError: (error) => {
            if (!current()) return;
            entry.running = false;
            if (isObjectAlreadyThere(error)) {
              void confirm(lesson, video, fileName);
              return;
            }
            setUploads((current) => {
              const now = current.get(lesson);
              if (now === undefined) return current;
              const next = new Map(current);
              const loaded = now.phase === "sending" || now.phase === "paused" || now.phase === "cut" ? now.loaded : 0;
              next.set(lesson, { phase: "cut", video, fileName, loaded, total: file.size });
              return next;
            });
          },
        }),
      );
      entry.upload = upload;
      entry.running = true;
      setUpload(lesson, { phase: "sending", video, fileName, loaded: 0, total: file.size });
      const previous = await upload.findPreviousUploads().catch(() => []);
      const last = previous[0];
      if (last !== undefined) upload.resumeFromPreviousUpload(last);
      // Se pudo pausar o cancelar mientras buscaba por dónde iba.
      if (current() && entry.running) upload.start();
    },
    [confirm, course, forget, notify, setUpload],
  );

  /** Arma la subida; si ni eso pudo (no cargó la biblioteca), queda como un corte y «Reanudar» vuelve a armarla. */
  const run = useCallback(
    (lesson: string, entry: Live) => {
      void send(lesson, entry.file, entry.target, entry).catch(() => {
        entry.running = false;
        entry.upload = null;
        if (live.current.get(lesson) === entry) setUpload(lesson, { phase: "cut", video: entry.video, fileName: entry.file.name, loaded: 0, total: entry.file.size });
      });
    },
    [send, setUpload],
  );

  const start = useCallback(
    (lesson: string, file: File) => {
      if (live.current.has(lesson)) return;
      notify(lesson, null);
      setUpload(lesson, { phase: "starting", fileName: file.name });
      void (async () => {
        try {
          const begun = await beginVideoAction({ course, lesson, fileName: file.name, size: file.size });
          if (begun.kind === "pending") {
            setUpload(lesson, null);
            notify(lesson, { pendingFile: begun.fileName });
            return;
          }
          if (begun.kind === "problem") {
            setUpload(lesson, null);
            notify(lesson, { problem: begun.problem });
            return;
          }
          const { target, token, resumed } = begun;
          const locked = await withVideoLock(target.video, (release) => {
            const entry: Live = { video: target.video, file, target, upload: null, running: false, token, tokenAt: Date.now(), release };
            live.current.set(lesson, entry);
            const go = () => run(lesson, entry);
            if (resumed) void confirm(lesson, target.video, file.name, go);
            else go();
          });
          if (!locked) {
            setUpload(lesson, null);
            notify(lesson, { problem: "otherTab" });
          }
        } catch (error) {
          unstable_rethrow(error);
          setUpload(lesson, null);
          notify(lesson, { problem: "unavailable" });
        }
      })();
    },
    [confirm, course, notify, run, setUpload],
  );

  const pause = useCallback(
    (lesson: string) => {
      const entry = live.current.get(lesson);
      if (entry?.upload == null) return;
      entry.running = false;
      void entry.upload.abort();
      setUploads((current) => {
        const now = current.get(lesson);
        if (now?.phase !== "sending") return current;
        return new Map(current).set(lesson, { ...now, phase: "paused" });
      });
    },
    [],
  );

  const resume = useCallback((lesson: string) => {
    const entry = live.current.get(lesson);
    if (entry === undefined || entry.running) return;
    // Si lo que la cortó fue la firma, reanudar pide otra.
    entry.tokenAt = 0;
    if (entry.upload === null) {
      run(lesson, entry);
    } else {
      entry.running = true;
      entry.upload.start();
    }
    setUploads((current) => {
      const now = current.get(lesson);
      if (now?.phase !== "paused" && now?.phase !== "cut") return current;
      return new Map(current).set(lesson, { ...now, phase: "sending" });
    });
    setNotices((current) => {
      if (!current.has(lesson)) return current;
      const next = new Map(current);
      next.delete(lesson);
      return next;
    });
  }, [run]);

  const retryConfirm = useCallback(
    (lesson: string) => {
      const now = uploads.get(lesson);
      if (now?.phase === "unchecked") void confirm(lesson, now.video, now.fileName);
    },
    [confirm, uploads],
  );

  const remove = useCallback(
    (lesson: string, video: string) => {
      const entry = live.current.get(lesson);
      // Lo que ya está en Storage a medias se termina de borrar solo: la dirección de subida vive 24 h.
      if (entry?.upload != null) void entry.upload.abort(true).catch(() => undefined);
      forget(lesson);
      notify(lesson, null);
      setUpload(lesson, { phase: "removing", video, fileName: entry?.file.name ?? "" });
      void (async () => {
        try {
          const answer = await removeVideoAction({ course, lesson, video });
          if (answer.kind === "problem") notify(lesson, { problem: answer.problem });
        } catch (error) {
          unstable_rethrow(error);
          notify(lesson, { problem: "unavailable" });
        } finally {
          setUpload(lesson, null);
        }
      })();
    },
    [course, forget, notify, setUpload],
  );

  useEffect(() => {
    const first = setTimeout(() => void check(), 0);
    return () => clearTimeout(first);
  }, [check]);
  useEffect(() => {
    if (checkEverySeconds === null) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, checkEverySeconds * 1000);
    return () => clearInterval(timer);
  }, [check, checkEverySeconds]);

  // Mientras algo sube o falta confirmarlo, salir lo perdería. Cambiar de lección no.
  const busy = uploads.size > 0;
  useEffect(() => {
    mark(VIDEO_KEY, busy);
  }, [busy, mark]);

  // Una lección que ya no existe no sigue subiendo.
  useEffect(() => {
    for (const [lesson, entry] of live.current) {
      if (!lessons.includes(lesson)) {
        void entry.upload?.abort();
        forget(lesson);
      }
    }
  }, [forget, lessons]);

  // Salir del editor por otra ruta: se detiene, y lo subido se retoma al volver.
  useEffect(() => {
    const running = live.current;
    return () => {
      mark(VIDEO_KEY, false);
      for (const entry of running.values()) {
        void entry.upload?.abort();
        entry.release();
      }
      running.clear();
    };
  }, [mark]);

  const value = useMemo(() => ({ uploads, notices, blocked, start, pause, resume, retryConfirm, remove }), [uploads, notices, blocked, start, pause, resume, retryConfirm, remove]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
