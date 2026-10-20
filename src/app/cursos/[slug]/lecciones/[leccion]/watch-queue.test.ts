import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCourier, SEND_TIMEOUT_MS, type CourierDeps, type FlushSender } from "./watch-queue";

// El cartero de los tramos vistos (T-205), con un `localStorage`, un `LockManager` y relojes
// simulados: qué se guarda, quién manda la cola de quién, cuándo se reintenta y cuándo se dice
// «Sin conexión». Lo que decide cada respuesta lo prueba el dominio (`queue.test.ts`); la
// pantalla entera, `tests/ui/lesson-screen.test.tsx` y el extremo a extremo.

const P1 = "d0000000-0000-4000-8000-000000000001";
const P2 = "d0000000-0000-4000-8000-000000000002";
const P3 = "d0000000-0000-4000-8000-000000000003";
const NOW = Date.UTC(2026, 9, 20, 12);
const SEGMENT = { from: 0, to: 30, rate: 1, visible: true };
const segments = (count: number, start = 0) => Array.from({ length: count }, (_, index) => ({ ...SEGMENT, from: (start + index) * 30, to: (start + index) * 30 + 30 }));
const key = (id: string) => `plataforma-latidos:${id}`;

/** Un `localStorage` de mentira, que se puede romper. */
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  broken = false;
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(name: string) {
    return this.data.get(name) ?? null;
  }
  setItem(name: string, value: string) {
    if (this.broken) throw new Error("QuotaExceededError");
    this.data.set(name, value);
  }
  removeItem(name: string) {
    this.data.delete(name);
  }
  clear() {
    this.data.clear();
  }
}

/** Candados compartidos entre «pestañas»: los que se tienen, por nombre. */
class MemoryLocks {
  held = new Set<string>();
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown): Promise<unknown> {
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => this.held.delete(name));
  }
}

let storage: MemoryStorage;
let locks: MemoryLocks;
let clock: number;

function depsWith(more: Partial<CourierDeps> = {}): CourierDeps {
  return {
    storage: () => storage,
    locks: () => locks as unknown as LockManager,
    now: () => clock,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer),
    ...more,
  };
}

/** Un cartero con un vaciado que contesta lo que se le diga, y anota lo que manda. */
function tab(answer: FlushSender = (_, events) => Promise.resolve({ kind: "settled", seqs: events.map((event) => event.seq) }), more: Partial<CourierDeps> = {}) {
  const sent: { id: string; seqs: number[] }[] = [];
  const courier = createCourier(depsWith(more));
  const send = vi.fn<FlushSender>((id, events) => {
    sent.push({ id, seqs: events.map((event) => event.seq) });
    return answer(id, events);
  });
  courier.configure({ send, heartbeatSeconds: 30 });
  return { courier, sent, send };
}

const stored = (id: string) => {
  const text = storage.getItem(key(id));
  return text === null ? null : (JSON.parse(text) as { next: number; events: { seq: number }[] });
};
const settleAll = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  locks = new MemoryLocks();
  clock = NOW;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("la cola propia", () => {
  it("se guarda en cada cambio, con su candado tomado, y se borra cuando queda vacía", async () => {
    const { courier } = tab();
    courier.own(P1);
    await settleAll();
    expect(locks.held.has(key(P1))).toBe(true);
    courier.add(P1, segments(2));
    expect(stored(P1)?.events.map((event) => event.seq)).toEqual([0, 1]);
    const batch = courier.take(P1);
    expect(batch.map((event) => event.seq)).toEqual([0, 1]);
    // Lo que va en camino no sale en otro envío.
    expect(courier.take(P1)).toEqual([]);
    courier.settle(P1, batch, { kind: "settled", seqs: [0, 1] });
    expect(stored(P1)).toBeNull();
    // Es la reproducción en curso: el candado se queda aunque esté vacía.
    expect(locks.held.has(key(P1))).toBe(true);
  });

  it("sin respuesta, lo enviado vuelve a la cola y sale en el siguiente envío", () => {
    const { courier } = tab();
    courier.own(P1);
    courier.add(P1, segments(2));
    const batch = courier.take(P1);
    courier.settle(P1, batch, null);
    expect(courier.take(P1).map((event) => event.seq)).toEqual([0, 1]);
  });

  it("al dejar de ser la actual, vacía, suelta su candado", async () => {
    const { courier } = tab();
    courier.own(P1);
    courier.add(P1, segments(1));
    await settleAll();
    courier.retire(P1);
    expect(locks.held.has(key(P1))).toBe(true);
    await courier.flush();
    expect(stored(P1)).toBeNull();
    await settleAll();
    expect(locks.held.has(key(P1))).toBe(false);
  });

  it("abrir otra reproducción deja de hacer actual a la anterior; vacía, se suelta", async () => {
    const { courier } = tab();
    courier.own(P1);
    await settleAll();
    courier.own(P2);
    await settleAll();
    expect(locks.held.has(key(P1))).toBe(false);
    expect(locks.held.has(key(P2))).toBe(true);
  });

  it("encolar nada, o en una reproducción que no es propia, no hace nada", () => {
    const { courier } = tab();
    courier.add(P1, segments(1));
    expect(stored(P1)).toBeNull();
    courier.own(P1);
    courier.add(P1, []);
    expect(stored(P1)).toBeNull();
    expect(courier.take(P2)).toEqual([]);
    courier.settle(P2, [], null);
    courier.retire(P2);
  });

  it("sin almacenamiento, o si guardar falla, la cola sigue en memoria y se manda igual", async () => {
    storage.broken = true;
    const { courier, sent } = tab();
    courier.own(P1);
    courier.add(P1, segments(2));
    expect(stored(P1)).toBeNull();
    await courier.flush();
    expect(sent).toEqual([{ id: P1, seqs: [0, 1] }]);
    const none = tab(undefined, { storage: () => null });
    none.courier.own(P2);
    none.courier.add(P2, segments(1));
    await none.courier.flush();
    expect(none.sent).toEqual([{ id: P2, seqs: [0] }]);
    await none.courier.sweep();
  });
});

describe("vaciar sin presencia", () => {
  it("de a 50, uno a la vez, hasta que no quede nada", async () => {
    const { courier, sent } = tab();
    courier.own(P1);
    courier.add(P1, segments(60));
    await courier.flush();
    await settleAll();
    expect(sent.map((each) => each.seqs.length)).toEqual([50, 10]);
    expect(stored(P1)).toBeNull();
  });

  it("un vaciado a la vez: otro pedido mientras uno va en camino no manda nada más", async () => {
    let answer: (verdict: { kind: "settled"; seqs: number[] }) => void = () => undefined;
    const { courier, send, sent } = tab(() => new Promise((resolve) => (answer = resolve)));
    courier.own(P1);
    courier.add(P1, segments(1));
    void courier.flush();
    // Llega otro tramo mientras el primero va en camino: espera su turno.
    courier.add(P1, segments(1, 1));
    void courier.flush();
    await settleAll();
    expect(send).toHaveBeenCalledTimes(1);
    answer({ kind: "settled", seqs: [0] });
    await settleAll();
    expect(sent).toEqual([
      { id: P1, seqs: [0] },
      { id: P1, seqs: [1] },
    ]);
    answer({ kind: "settled", seqs: [1] });
    await settleAll();
    expect(stored(P1)).toBeNull();
  });

  it("lo que lleva el latido no sale también en un vaciado", async () => {
    const { courier, sent } = tab();
    courier.own(P1);
    courier.add(P1, segments(2));
    const batch = courier.take(P1);
    courier.add(P1, segments(1, 2));
    await courier.flush();
    expect(sent).toEqual([{ id: P1, seqs: [2] }]);
    courier.settle(P1, batch, { kind: "settled", seqs: [0, 1] });
    expect(stored(P1)).toBeNull();
  });

  it("«tirar» se lleva lo enviado; sin vaciado configurado no se manda nada", async () => {
    const { courier } = tab(() => Promise.resolve({ kind: "discard" }));
    courier.own(P1);
    courier.add(P1, segments(2));
    await courier.flush();
    expect(stored(P1)).toBeNull();
    const idle = createCourier(depsWith());
    idle.own(P2);
    idle.add(P2, segments(1));
    await idle.flush();
    expect(stored(P2)?.events).toHaveLength(1);
  });

  it("si falla, se reintenta a los 5, 10 y 20 s y luego cada latido; al llegar se vuelve a 5", async () => {
    let fail = true;
    const { courier, send } = tab((_, events) => (fail ? Promise.reject(new Error("sin red")) : Promise.resolve({ kind: "settled", seqs: events.map((event) => event.seq) })));
    courier.own(P1);
    courier.add(P1, segments(1));
    await courier.flush();
    expect(send).toHaveBeenCalledTimes(1);
    for (const [wait, calls] of [
      [5_000, 2],
      [10_000, 3],
      [20_000, 4],
      [30_000, 5],
      [30_000, 6],
    ] as const) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(send).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(calls);
    }
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stored(P1)).toBeNull();
    // Otra falla empieza de nuevo en 5 s.
    fail = true;
    courier.add(P1, segments(1, 1));
    await courier.flush();
    const before = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(before + 1);
  });

  it("«reintenta» también espera, pero no es «sin conexión»: contestó", async () => {
    const { courier, send } = tab(() => Promise.resolve({ kind: "retry" }));
    courier.own(P1);
    courier.add(P1, segments(1));
    await courier.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(courier.offline()).toBe(false);
    expect(stored(P1)?.events).toHaveLength(1);
  });
});

describe("«Sin conexión. Reintentando…»", () => {
  it("no con un envío perdido; sí con dos seguidos; se quita con el primero que contesta", async () => {
    let fail = true;
    const { courier } = tab((_, events) => (fail ? Promise.reject(new Error("sin red")) : Promise.resolve({ kind: "settled", seqs: events.map((event) => event.seq) })));
    const changed = vi.fn();
    courier.subscribe(changed);
    courier.own(P1);
    courier.add(P1, segments(1));
    await courier.flush();
    expect(courier.offline()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(courier.offline()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(courier.offline()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("cuentan los latidos de presencia: los que lanzan y los que no contestan a tiempo; el plazo no los cancela", async () => {
    const { courier } = tab();
    await expect(courier.timed(Promise.reject(new Error("sin red")))).rejects.toThrow();
    expect(courier.offline()).toBe(false);
    let answer: (value: string) => void = () => undefined;
    const slow = courier.timed(new Promise<string>((resolve) => (answer = resolve)));
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
    expect(courier.offline()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(courier.offline()).toBe(true);
    answer("ok");
    await expect(slow).resolves.toBe("ok");
    expect(courier.offline()).toBe(false);
  });

  it("uno que vence el plazo y después lanza cuenta una sola vez", async () => {
    const { courier } = tab();
    let fail: (error: Error) => void = () => undefined;
    const late = courier.timed(new Promise<string>((_, reject) => (fail = reject)));
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    fail(new Error("sin red"));
    await expect(late).rejects.toThrow();
    expect(courier.offline()).toBe(false);
  });

  it("una redirección de Next no es «sin conexión»", async () => {
    const { courier } = tab();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/" });
    const isRedirect = (error: unknown) => (error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT") ?? false;
    for (let index = 0; index < 3; index += 1) await expect(courier.timed(Promise.reject(redirect), isRedirect)).rejects.toThrow();
    expect(courier.offline()).toBe(false);
  });

  it("dejar de escuchar", () => {
    const { courier } = tab();
    const changed = vi.fn();
    const stop = courier.subscribe(changed);
    stop();
  });
});

describe("las colas de otras pestañas y de otras visitas", () => {
  it("al abrir una lección se adopta y se manda lo que dejó una página que se fue", async () => {
    const before = tab();
    before.courier.own(P1);
    await settleAll();
    before.courier.add(P1, segments(3));
    // La página se va: el navegador suelta su candado; la cola se queda guardada.
    locks.held.clear();
    const after = tab();
    await after.courier.sweep();
    await settleAll();
    expect(after.sent).toEqual([{ id: P1, seqs: [0, 1, 2] }]);
    expect(stored(P1)).toBeNull();
    expect(locks.held.has(key(P1))).toBe(false);
  });

  it("la cola de una pestaña viva no se toca: su candado está tomado", async () => {
    const owner = tab();
    owner.courier.own(P1);
    await settleAll();
    owner.courier.add(P1, segments(2));
    const other = tab();
    await other.courier.sweep();
    expect(other.sent).toEqual([]);
    expect(stored(P1)?.events).toHaveLength(2);
  });

  it("con el candado en la mano relee: lo que la dueña escribió mientras se pedía también sale", async () => {
    const before = tab();
    before.courier.own(P1);
    await settleAll();
    before.courier.add(P1, segments(1));
    locks.held.clear();
    const after = tab();
    const original = storage.getItem.bind(storage);
    let reads = 0;
    storage.getItem = (name: string) => {
      reads += 1;
      // La segunda lectura (ya con el candado) ve lo que la dueña agregó entre tanto.
      if (reads === 2) before.courier.add(P1, segments(1, 1));
      return original(name);
    };
    await after.courier.sweep();
    await settleAll();
    expect(after.sent).toEqual([{ id: P1, seqs: [0, 1] }]);
  });

  it("borra lo vencido y lo que no tiene forma; no toca llaves de otros", async () => {
    storage.setItem(key(P1), JSON.stringify({ v: 1, touched: NOW - 8 * 24 * 60 * 60 * 1000, next: 1, events: [{ seq: 0, ...SEGMENT }] }));
    storage.setItem(key(P2), "{");
    storage.setItem("plataforma-latidos:otra-cosa", "x");
    storage.setItem("otra-llave", "x");
    const { courier, sent } = tab();
    await courier.sweep();
    expect(sent).toEqual([]);
    expect([...storage.data.keys()]).toEqual(["otra-llave"]);
  });

  it("una vacía guardada se borra y se suelta sin mandar nada", async () => {
    storage.setItem(key(P3), JSON.stringify({ v: 1, touched: NOW, next: 4, events: [] }));
    const { courier, sent } = tab();
    await courier.sweep();
    await settleAll();
    expect(sent).toEqual([]);
    expect(stored(P3)).toBeNull();
    expect(locks.held.size).toBe(0);
  });

  it("las propias no se adoptan otra vez", async () => {
    const { courier, sent } = tab();
    courier.own(P1);
    await settleAll();
    courier.add(P1, segments(1));
    const flushed = sent.length;
    await courier.sweep();
    // Se vacía como propia, no como adoptada: una sola vez.
    expect(sent.length).toBe(flushed + 1);
  });

  it("sin Web Locks, solo las que no se escriben hace tres latidos", async () => {
    const write = (id: string, touched: number) => storage.setItem(key(id), JSON.stringify({ v: 1, touched, next: 1, events: [{ seq: 0, ...SEGMENT }] }));
    write(P1, NOW - 89_999);
    write(P2, NOW - 90_000);
    const { courier, sent } = tab(undefined, { locks: () => null });
    await courier.sweep();
    await settleAll();
    expect(sent).toEqual([{ id: P2, seqs: [0] }]);
    expect(stored(P1)?.events).toHaveLength(1);
  });

  it("si leer el almacenamiento falla, no pasa nada", async () => {
    storage.setItem(key(P1), JSON.stringify({ v: 1, touched: NOW, next: 1, events: [{ seq: 0, ...SEGMENT }] }));
    const { courier, sent } = tab();
    storage.getItem = () => {
      throw new Error("SecurityError");
    };
    await courier.sweep();
    expect(sent).toEqual([]);
    Object.defineProperty(storage, "length", {
      get() {
        throw new Error("SecurityError");
      },
    });
    await courier.sweep();
  });

  it("si el candado no se puede pedir, no se adopta", async () => {
    storage.setItem(key(P1), JSON.stringify({ v: 1, touched: NOW, next: 1, events: [{ seq: 0, ...SEGMENT }] }));
    const broken = { request: () => Promise.reject(new Error("no")) } as unknown as LockManager;
    const { courier, sent } = tab(undefined, { locks: () => broken });
    await courier.sweep();
    expect(sent).toEqual([]);
  });
});
