import fc from "fast-check";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localOwnerUrl } from "./helpers/local";

// El reparto contra un oráculo escrito aparte (T-407; RF-502, RN-03, RN-05 a RN-07, RNF-04). La
// regla vive en la base (`private.compute_payout()`, decisión de Sergio del 2026-10-23) y la
// prueban `supabase/tests/33_reparto` y `34_reparto_alerta_y_propiedades`; aquí se compara línea
// por línea con una implementación independiente en TypeScript, en `BigInt`, sobre miles de
// periodos al azar, y fast-check encoge el caso si alguna difiere. La función es pura: no lee ni
// escribe tablas, así que se llama como el dueño de la base y no deja nada.

interface Base {
  profile: string;
  base: bigint;
}

interface Points {
  profile: string;
  teacher: string;
  rank: bigint;
  half: number;
}

interface Period {
  bps: number;
  carried: bigint;
  bases: Base[];
  points: Points[];
}

/** Una línea como la devuelve la base: los montos y los órdenes como texto. */
interface Line {
  kind: "student_pool" | "share" | "unconsumed_share" | "carried_over";
  profile: string | null;
  teacher: string | null;
  rank: string | null;
  cents: string;
  base: string | null;
  half: number | null;
}

const KIND_ORDER = ["student_pool", "share", "unconsumed_share", "carried_over"] as const;

function uuid(prefix: string, n: number): string {
  return `${prefix}0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

/** RN-07: cada parte hacia abajo, y los centavos que sobran al mayor residuo; en empate, al orden menor. */
function largestRemainder(total: bigint, parts: { id: string; weight: bigint; rank: bigint }[]): Map<string, bigint> {
  const sum = parts.reduce((acc, part) => acc + part.weight, 0n);
  const result = new Map<string, bigint>();
  if (parts.length === 0) return result;
  const exact = parts.map((part) => ({ ...part, floor: (total * part.weight) / sum, rest: (total * part.weight) % sum }));
  let left = total - exact.reduce((acc, part) => acc + part.floor, 0n);
  const order = [...exact].sort((a, b) => (a.rest === b.rest ? (a.rank < b.rank ? -1 : 1) : a.rest > b.rest ? -1 : 1));
  for (const part of order) {
    result.set(part.id, part.floor + (left > 0n ? 1n : 0n));
    if (left > 0n) left -= 1n;
  }
  return result;
}

function compare(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function compareRank(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return BigInt(a) < BigInt(b) ? -1 : 1;
}

/** El reparto de un periodo, como lo dicen el PRD (§6.2) y el plan de T-407. */
function oracle({ bps, carried, bases, points }: Period): Line[] {
  const lines: Line[] = [];
  const withBase = new Set(bases.map((b) => b.profile));
  const counted = points.filter((p) => withBase.has(p.profile));
  const assigned = new Map<string, { rank: bigint; cents: bigint }>();
  let unconsumed = carried;
  let total = carried;
  for (const { profile, base } of bases) {
    const pool = (base * BigInt(bps)) / 10_000n;
    const mine = counted.filter((p) => p.profile === profile);
    const half = mine.reduce((acc, p) => acc + p.half, 0);
    total += pool;
    lines.push({ kind: "student_pool", profile, teacher: null, rank: null, cents: String(pool), base: String(base), half });
    if (mine.length === 0) {
      unconsumed += pool;
      continue;
    }
    const shares = largestRemainder(pool, mine.map((p) => ({ id: p.teacher, weight: BigInt(p.half), rank: p.rank })));
    for (const p of mine) {
      const cents = shares.get(p.teacher)!;
      lines.push({ kind: "share", profile, teacher: p.teacher, rank: String(p.rank), cents: String(cents), base: null, half: p.half });
      const soFar = assigned.get(p.teacher) ?? { rank: p.rank, cents: 0n };
      assigned.set(p.teacher, { rank: p.rank, cents: soFar.cents + cents });
    }
  }
  const takers = [...assigned].filter(([, a]) => a.cents > 0n).map(([id, a]) => ({ id, weight: a.cents, rank: a.rank }));
  if (takers.length > 0) {
    for (const [teacher, cents] of largestRemainder(unconsumed, takers)) {
      if (cents === 0n) continue;
      const rank = assigned.get(teacher)!.rank;
      lines.push({ kind: "unconsumed_share", profile: null, teacher, rank: String(rank), cents: String(cents), base: null, half: null });
    }
  } else if (total > 0n) {
    lines.push({ kind: "carried_over", profile: null, teacher: null, rank: null, cents: String(total), base: null, half: null });
  }
  return lines.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compare(a.profile, b.profile) || compareRank(a.rank, b.rank),
  );
}

// Hasta 10 alumnos con base (y dos más sin base, con puntos), hasta 6 maestros con un orden al
// azar, bases chicas y a veces enormes, medios puntos de 1 a 20, porcentaje y arrastre al azar.
const period: fc.Arbitrary<Period> = fc
  .record({ students: fc.integer({ min: 0, max: 10 }), teachers: fc.integer({ min: 1, max: 6 }) })
  .chain(({ students, teachers }) =>
    fc.record({
      bps: fc.oneof(fc.constant(10_000), fc.constant(1), fc.integer({ min: 1, max: 10_000 })),
      carried: fc.oneof(fc.constant(0n), fc.bigInt({ min: 0n, max: 10n ** 7n })),
      ranks: fc.uniqueArray(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: teachers, maxLength: teachers }),
      bases: fc.array(
        fc.option(fc.oneof(fc.bigInt({ min: 1n, max: 60n }), fc.bigInt({ min: 1n, max: 400_000n }), fc.bigInt({ min: 1n, max: 10n ** 15n }))),
        { minLength: students, maxLength: students },
      ),
      halves: fc.array(fc.array(fc.option(fc.integer({ min: 1, max: 20 }), { freq: 2 }), { minLength: teachers, maxLength: teachers }), {
        minLength: students + 2,
        maxLength: students + 2,
      }),
    }),
  )
  .map(({ bps, carried, ranks, bases, halves }) => ({
    bps,
    carried,
    bases: bases.flatMap((base, i) => (base === null ? [] : [{ profile: uuid("a", i + 1), base }])),
    points: halves.flatMap((row, s) =>
      row.flatMap((half, t) => (half === null ? [] : [{ profile: uuid("a", s + 1), teacher: uuid("f", t + 1), rank: ranks[t]!, half }])),
    ),
  }));

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: localOwnerUrl() });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

async function computePayout({ bps, carried, bases, points }: Period): Promise<Line[]> {
  // Los montos viajan como texto: un `number` pierde precisión pasado 2^53.
  const result = await client.query<Line>(
    `select kind::text as kind, profile_id::text as profile, teacher_id::text as teacher, tiebreak_rank::text as rank,
            cents::text as cents, base_cents::text as base, half_points as half
     from private.compute_payout($1::integer, $2::bigint,
       array(select jsonb_populate_recordset(null::private.payout_base, $3::jsonb)),
       array(select jsonb_populate_recordset(null::private.payout_points, $4::jsonb)))`,
    [
      bps,
      String(carried),
      JSON.stringify(bases.map((b) => ({ profile_id: b.profile, base_cents: String(b.base) }))),
      JSON.stringify(
        points.map((p) => ({ profile_id: p.profile, teacher_id: p.teacher, tiebreak_rank: String(p.rank), half_points: p.half })),
      ),
    ],
  );
  return result.rows;
}

describe("el reparto de la base contra un oráculo independiente", () => {
  it("da los cuatro ejemplos del PRD (§6.3), igual que el oráculo", async () => {
    const m = [1n, 2n, 3n];
    const example: Period = {
      bps: 6000,
      carried: 0n,
      bases: [28581n, 28581n, 20405n, 28581n].map((base, i) => ({ profile: uuid("a", i + 1), base })),
      points: (
        [
          [1, 1, 8],
          [1, 2, 5],
          [2, 2, 1],
          [3, 1, 6],
          [3, 2, 2],
          [3, 3, 2],
        ] as const
      ).map(([s, t, half]) => ({ profile: uuid("a", s), teacher: uuid("f", t), rank: m[t - 1]!, half })),
    };
    const lines = await computePayout(example);
    expect(lines).toEqual(oracle(example));
    const total = (teacher: string) =>
      lines.filter((l) => l.teacher === teacher && l.kind !== "student_pool").reduce((acc, l) => acc + BigInt(l.cents), 0n);
    expect([total(uuid("f", 1)), total(uuid("f", 2)), total(uuid("f", 3))]).toEqual([24494n, 35843n, 3350n]);
  });

  it("coincide línea por línea en miles de periodos al azar", async () => {
    await fc.assert(
      fc.asyncProperty(period, async (p) => {
        expect(await computePayout(p)).toEqual(oracle(p));
      }),
      { numRuns: 2000 },
    );
  }, 120_000);
});
