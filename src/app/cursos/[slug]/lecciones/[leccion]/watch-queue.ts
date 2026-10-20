import {
  batchOf,
  emptyQueue,
  enqueue,
  isOffline,
  parseQueue,
  QUEUE_PREFIX,
  queueKey,
  queueSessionOf,
  resolveBatch,
  retryDelaySeconds,
  type BatchVerdict,
  type HeartbeatEvent,
  type Segment,
  type WatchQueue,
} from "@/services/media/watch-rules";

// Las colas de tramos vistos de este navegador (RF-401, RNF-05; T-205). Lo puro (qué se guarda,
// qué sale en cada lote, qué se quita con cada respuesta, cuánto se espera) vive en el dominio;
// aquí está la cáscara: `localStorage`, los candados entre pestañas y los temporizadores.
//
// Vive en el módulo y no en la pantalla: un documento tiene un solo cartero, y navegar dentro de
// la aplicación (el temario, «Sigue», «Volver») desmonta la pantalla sin descargar la página. La
// pantalla siguiente encuentra aquí las colas que la anterior dejó.
//
// Lo que no se ve leyendo un solo lugar:
//   · La memoria manda; `localStorage` es el respaldo, para cuando la página se va. Una cola
//     propia se escribe entera en cada cambio, y solo con su candado (Web Locks): la pestaña lo
//     toma al abrir su reproducción y lo suelta cuando la cola queda vacía y ya no es la actual,
//     o cuando la página se va (lo suelta el navegador). Otra pestaña solo adopta una cola cuyo
//     candado consigue. Sin Web Locks (Safari antes de 15.4) adopta las que no se escriben hace
//     un rato: lo peor es un reenvío, que la base contesta repetido.
//   · Un vaciado a la vez. Next despacha las acciones de servidor una tras otra por navegador: un
//     plazo no adelanta nada, así que solo cuenta para «Sin conexión» (`SEND_TIMEOUT_MS`).
//   · «Sin conexión. Reintentando…» sale con dos envíos seguidos que lanzan o no contestan a
//     tiempo, sean latido o vaciado, y se quita con el primero que contesta.

/** Pasado esto sin respuesta, un envío cuenta como fallido para la nota (no se cancela). */
export const SEND_TIMEOUT_MS = 15_000;

/** Sin Web Locks, una cola ajena se adopta si no se escribe hace este múltiplo del latido. */
const STALE_BEATS = 3;

/**
 * Pasados tantos envíos seguidos sin resolver, el cartero deja de reintentar solo (unos cuatro
 * minutos): sin sesión, `flushHeartbeats` contesta «reintenta» para siempre. Lo pendiente sigue
 * guardado y sale con el siguiente latido, vaciado o lección.
 */
const RETRY_LIMIT = 10;

export type FlushSender = (sessionId: string, events: HeartbeatEvent[]) => Promise<BatchVerdict>;

interface Owned {
  queue: WatchQueue;
  /** Los consecutivos que van en un envío sin respuesta. */
  sending: Set<number>;
  /** La reproducción en curso de esta pestaña: su candado no se suelta aunque se vacíe. */
  current: boolean;
  /** Suelta el candado; nulo si no se tiene (o no hay Web Locks). */
  release: (() => void) | null;
  /** Ya se soltó: un candado que llegue tarde se devuelve en el acto. */
  abandoned: boolean;
}

/** Cómo salió pedir un candado: se tiene, otra pestaña lo tiene, o no se puede pedir. */
type LockResult = "held" | "busy" | "unsupported";

export interface CourierDeps {
  storage: () => Storage | null;
  locks: () => LockManager | null;
  now: () => number;
  setTimer: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const browserDeps: CourierDeps = {
  storage: () => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  },
  locks: () => (typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null),
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

export function createCourier(deps: CourierDeps = browserDeps) {
  const owned = new Map<string, Owned>();
  const listeners = new Set<() => void>();
  let sender: FlushSender | null = null;
  let heartbeatSeconds = 30;
  /** Envíos seguidos que lanzaron o no contestaron a tiempo (la nota). */
  let failures = 0;
  /** Envíos seguidos que no resolvieron lo que llevaban (la espera del siguiente reintento). */
  let misses = 0;
  let flushing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function setFailures(next: number) {
    const before = isOffline(failures);
    failures = next;
    if (isOffline(failures) !== before) for (const listener of listeners) listener();
  }

  function write(id: string, entry: Owned) {
    const storage = deps.storage();
    if (storage === null) return;
    try {
      if (entry.queue.events.length === 0) storage.removeItem(queueKey(id));
      else storage.setItem(queueKey(id), JSON.stringify(entry.queue));
    } catch {
      // Sin espacio o sin almacenamiento: la cola sigue en memoria mientras viva la página.
    }
  }

  /**
   * Suelta una cola que ya no es la actual y quedó vacía: su candado y su llave. Lo que va en
   * camino sigue en la cola hasta su respuesta, así que una vacía no tiene envíos pendientes.
   */
  function maybeRelease(id: string, entry: Owned) {
    if (entry.current || entry.queue.events.length > 0) return;
    write(id, entry);
    entry.abandoned = true;
    entry.release?.();
    owned.delete(id);
  }

  /**
   * Pide el candado de una cola. La propia lo espera (solo lo puede tener una petición suya de
   * antes, que lo suelta enseguida); una ajena solo si está libre.
   */
  function lock(id: string, entry: Owned, wait: boolean): Promise<LockResult> {
    const locks = deps.locks();
    if (locks === null) return Promise.resolve("unsupported");
    return new Promise((answer) => {
      locks
        .request(queueKey(id), wait ? {} : { ifAvailable: true }, (held) => {
          if (held === null || entry.abandoned) {
            answer("busy");
            return undefined;
          }
          answer("held");
          return new Promise<void>((done) => {
            entry.release = done;
          });
        })
        .catch(() => answer("unsupported"));
    });
  }

  /** Lo que sale en un envío de esta cola; los marca en camino. */
  function take(id: string): HeartbeatEvent[] {
    const entry = owned.get(id);
    if (entry === undefined) return [];
    const batch = batchOf(entry.queue, entry.sending);
    for (const event of batch) entry.sending.add(event.seq);
    return batch;
  }

  /**
   * La respuesta de un envío de esta cola: lo resuelto sale, lo demás vuelve a la cola. Si algo de
   * lo enviado se quedó (sin respuesta, «reintenta», o una respuesta que no lo resolvió), se
   * programa un reintento: el video puede estar en pausa, sin latido que lo lleve. Contesta si
   * todo lo enviado quedó resuelto.
   */
  function settle(id: string, sent: HeartbeatEvent[], verdict: BatchVerdict | null): boolean {
    const entry = owned.get(id);
    if (entry === undefined) return true;
    for (const event of sent) entry.sending.delete(event.seq);
    const next = resolveBatch(entry.queue, sent, verdict, deps.now());
    if (next !== entry.queue) {
      entry.queue = next;
      write(id, entry);
    }
    const left = new Set(next.events.map((event) => event.seq));
    const resolved = !sent.some((event) => left.has(event.seq));
    if (resolved) misses = 0;
    else {
      misses += 1;
      scheduleRetry();
    }
    maybeRelease(id, entry);
    return resolved;
  }

  /**
   * Corre un envío y anota si contestó a tiempo; el plazo no lo cancela. Lo que `expected` dice
   * (una redirección de Next) no es «sin conexión».
   */
  async function timed<T>(send: Promise<T>, expected: (error: unknown) => boolean = () => false): Promise<T> {
    let late = false;
    const timer = deps.setTimer(() => {
      late = true;
      setFailures(failures + 1);
    }, SEND_TIMEOUT_MS);
    try {
      const answer = await send;
      setFailures(0);
      return answer;
    } catch (error) {
      if (!late && !expected(error)) setFailures(failures + 1);
      throw error;
    } finally {
      deps.clearTimer(timer);
    }
  }

  function scheduleRetry() {
    if (retryTimer !== null || misses > RETRY_LIMIT) return;
    retryTimer = deps.setTimer(
      () => {
        retryTimer = null;
        void flush();
      },
      retryDelaySeconds(misses, heartbeatSeconds) * 1000,
    );
  }

  /** Vacía las colas que tengan algo sin presencia, una tras otra; un vaciado a la vez. */
  async function flush(): Promise<void> {
    if (flushing || sender === null) return;
    flushing = true;
    try {
      for (const id of [...owned.keys()]) {
        const entry = owned.get(id);
        if (entry === undefined) continue;
        const batch = take(id);
        if (batch.length === 0) continue;
        let verdict: BatchVerdict | null = null;
        try {
          verdict = await timed(sender(id, batch));
        } catch {
          verdict = null;
        }
        if (!settle(id, batch, verdict)) return;
      }
    } finally {
      flushing = false;
    }
    // Lo que quedó (más de un lote, o lo que llegó mientras se mandaba) sale en otra vuelta.
    if ([...owned.values()].some((entry) => batchOf(entry.queue, entry.sending).length > 0)) void flush();
  }

  return {
    /**
     * Con qué se vacía y, si ya se sabe, cada cuánto late la reproducción en curso (para la
     * espera). Mientras no se sepa, el valor de arranque de `LATIDO_SEGUNDOS`.
     */
    configure(next: { send: FlushSender; heartbeatSeconds?: number }) {
      sender = next.send;
      if (next.heartbeatSeconds !== undefined) heartbeatSeconds = next.heartbeatSeconds;
    },

    /** La reproducción que se acaba de abrir en esta pestaña: su cola es propia desde el primer tramo. */
    own(id: string) {
      for (const [other, entry] of owned) {
        if (other !== id && entry.current) {
          entry.current = false;
          maybeRelease(other, entry);
        }
      }
      const existing = owned.get(id);
      if (existing !== undefined) {
        existing.current = true;
        return;
      }
      const entry: Owned = { queue: emptyQueue(deps.now()), sending: new Set(), current: true, release: null, abandoned: false };
      owned.set(id, entry);
      void lock(id, entry, true);
    },

    /** Ya no es la reproducción en curso (otra dirección, el reproductor se fue): se vacía y se suelta. */
    retire(id: string) {
      const entry = owned.get(id);
      if (entry === undefined) return;
      entry.current = false;
      maybeRelease(id, entry);
    },

    /** Encola tramos cerrados de una reproducción propia y los guarda. */
    add(id: string, segments: Segment[]) {
      const entry = owned.get(id);
      if (entry === undefined || segments.length === 0) return;
      const next = enqueue(entry.queue, segments, deps.now());
      if (next === entry.queue) return;
      entry.queue = next;
      write(id, entry);
    },

    /** Lo que lleva el latido de presencia de esta reproducción; se marca en camino. */
    take,

    /** La respuesta del latido para su lote (nula si no contestó). */
    settle,

    /** Un latido de presencia, con su plazo para la nota. */
    timed,

    flush,

    /**
     * Al abrir una lección: adopta las colas guardadas de reproducciones que no son de esta
     * pestaña y cuyo candado consigue, borra las vencidas o sin forma, y vacía.
     */
    async sweep() {
      const storage = deps.storage();
      if (storage === null) return;
      let keys: string[];
      try {
        keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key?.startsWith(QUEUE_PREFIX) ?? false);
      } catch {
        return;
      }
      const now = deps.now();
      for (const key of keys) {
        const id = queueSessionOf(key);
        if (id !== null && owned.has(id)) continue;
        let queue: WatchQueue | null = null;
        try {
          queue = id === null ? null : parseQueue(storage.getItem(key), now);
        } catch {
          continue;
        }
        if (id === null || queue === null) {
          try {
            storage.removeItem(key);
          } catch {
            // Se intenta en la siguiente lección.
          }
          continue;
        }
        // Sin Web Locks (o si pedirlo falla), solo las que no se escriben hace un rato.
        const entry: Owned = { queue, sending: new Set(), current: false, release: null, abandoned: false };
        const result = await lock(id, entry, false);
        if (result === "busy" || owned.has(id)) continue;
        if (result === "unsupported" && now - queue.touched < STALE_BEATS * heartbeatSeconds * 1000) continue;
        // Con el candado ya en la mano se relee: la dueña pudo escribir mientras se pedía. Solo
        // entonces entra a las propias, para que un vaciado en curso no la toque antes.
        try {
          entry.queue = parseQueue(storage.getItem(key), deps.now()) ?? emptyQueue(deps.now());
        } catch {
          // Se queda lo leído antes.
        }
        owned.set(id, entry);
        maybeRelease(id, entry);
      }
      await flush();
    },

    /** Si se dice «Sin conexión»; con `subscribe`, para `useSyncExternalStore`. */
    offline: () => isOffline(failures),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type Courier = ReturnType<typeof createCourier>;

/** El cartero de este documento. */
export const courier = createCourier();
