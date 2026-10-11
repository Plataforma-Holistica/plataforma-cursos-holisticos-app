import { describe, expect, it } from "vitest";

import { atLeast } from "./timing";

// El tiempo mínimo de respuesta (TRD §9.2, fila «Registro»). Supabase contesta más rápido
// cuando el correo no existe: la respuesta se alarga hasta un piso fijo para que el tiempo
// no lo delate, también en el camino frenado y también cuando la operación falla.

/** Un reloj que avanza solo cuando el trabajo o la espera lo mueven. */
function fakeTime() {
  let now = 1_000;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: (ms: number) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe("atLeast", () => {
  it("si el trabajo termina antes del piso, espera lo que falta", async () => {
    const time = fakeTime();
    const result = await atLeast(500, () => {
      time.advance(120);
      return Promise.resolve("listo");
    }, time);
    expect(result).toBe("listo");
    expect(time.slept).toEqual([380]);
  });

  it("si termina al instante, espera el piso entero", async () => {
    const time = fakeTime();
    await atLeast(500, () => Promise.resolve(1), time);
    expect(time.slept).toEqual([500]);
  });

  it("si tarda justo el piso, no espera más", async () => {
    const time = fakeTime();
    await atLeast(500, () => {
      time.advance(500);
      return Promise.resolve(1);
    }, time);
    expect(time.slept).toEqual([]);
  });

  // Por encima del piso la diferencia volvería a verse tal cual. Redondear al siguiente
  // múltiplo la deja en escalones.
  it.each([
    [501, 499],
    [750, 250],
    [1000, 0],
    [1001, 499],
    [2499, 1],
  ])("si tarda %i ms con un piso de 500, espera %i más: el siguiente múltiplo", async (took, extra) => {
    const time = fakeTime();
    await atLeast(500, () => {
      time.advance(took);
      return Promise.resolve(1);
    }, time);
    expect(time.slept).toEqual(extra === 0 ? [] : [extra]);
  });

  it("si el trabajo falla, espera igual y después deja salir el error", async () => {
    const time = fakeTime();
    const failure = new Error("falló");
    await expect(
      atLeast(500, () => {
        time.advance(40);
        return Promise.reject(failure);
      }, time),
    ).rejects.toBe(failure);
    expect(time.slept).toEqual([460]);
  });

  it("con el reloj y la espera de verdad, tarda al menos el piso", async () => {
    const started = Date.now();
    await atLeast(40, () => Promise.resolve(1));
    expect(Date.now() - started).toBeGreaterThanOrEqual(38);
  });

  it.each([0, -1, 1.5, Number.NaN])("un piso de %s no es un piso: se rechaza", async (floor) => {
    await expect(atLeast(floor, () => Promise.resolve(1))).rejects.toThrow(/piso/);
  });
});
