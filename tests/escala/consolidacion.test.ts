import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { actAs, clearPeriodsBefore, connect, financePerson, retire, SEEN, SHOWN } from "../integration/helpers/finance";
import { localOwnerUrl } from "../integration/helpers/local";
import { assertPlainWindow } from "../integration/helpers/periods";

// La prueba de escala de la consolidación (T-611; RNF-06, RNF-07; 05 §14.4), en la base local, a
// `HORIZONTE_ESCALA`: 13 000 alumnos con suscripción y cobro, 100 maestros con 900 lecciones, una
// reproducción por par (260 000) y 36 latidos por par, intercalados como llegan (9.36 M). Mide con su
// propio reloj cada paso del recálculo completo (RF-408) con el consolidado vacío y lleno, sin
// `analyze` y con él, sin `vacuum` y con él; la selección de antes, en una muestra del cursor; la
// selección sin el blindaje del plan, con plan genérico; una noche normal con 10 000 pares marcados
// (`nightly_rollup()` entero) y `detect_anomalies`. Y comprueba que el recálculo completo deja el mismo
// consolidado que pasar todos los pares por el modo marcado. Al final, sobre ese mes, el reparto (que
// tiene que caber en el tope de una sentencia del servidor) y el ensayo y el cierre (que se miden).
//
// No corre en la integración continua ni con `pnpm test:int`: escribe y confirma millones de filas en
// un libro que no se borra. La corre `pnpm test:escala`, que pide el turno de la base y la rehace al
// terminar, pase o falle (`scripts/test-escala.mjs`). Ocupa la base de 10 a 20 minutos y unos 3 GB.
//
// El periodo es el mes en curso, puesto en cierre a mano con su foto, como lo dejaría el paso a
// cierre (las pruebas del cierre hacen lo mismo): el anterior no sirve, porque en una base nueva los
// umbrales rigen desde el arranque. Los identificadores de las cuentas, las suscripciones y las
// reproducciones son fijos; los de las lecciones los pone la carga del curso.

const STUDENTS = 13_000;
const LESSONS_PER_STUDENT = 20;
const BEATS_PER_PAIR = 36;
const STEP = 50;
const MARKED = 10_000;
const SAMPLE = 20;

// 05 §14.4 y TRD §14.5: el recálculo completo, en menos de 30 minutos; y una corrida que no late en
// 15 minutos se da por muerta (T-207), así que ningún paso puede pasar de ahí.
const FULL_LIMIT_MS = 30 * 60_000;
const BEAT_LIMIT_MS = 15 * 60_000;

// Dónde dejar las cifras: lo pasa `scripts/test-escala.mjs`.
const REPORT_PATH = process.env.ESCALA_REPORT;

let owner: Client;
let period: number;
const report: Record<string, unknown> = {};

type Walk = { pairs: number; steps: number; total_ms: number; worst_ms: number };
type Step = { read: number; written: number; last_profile: string | null; last_lesson: string | null };
type Run = { run: string; pairs: number; steps: number; written: number; total_ms: number; worst_ms: number; p99_ms: number };

const q = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await owner.query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await q<T>(sql, values))[0]!;
const ms = (start: number) => Math.round(performance.now() - start);

/** Una transacción que se deshace si algo lanza: la sesión no se queda abortada para lo que sigue. */
async function tx(fn: () => Promise<void>): Promise<void> {
  await owner.query("begin");
  try {
    await fn();
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  owner = new Client({ connectionString: localOwnerUrl() });
  await owner.connect();
  // A las 03:00 de la Ciudad de México corre el `pg_cron` local, y consolidaría a la mitad.
  const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  if (minute >= 8 * 60 + 15 && minute <= 9 * 60 + 30) throw new Error("a esta hora corre la consolidación de pg_cron: espera a las 09:30 UTC");
  await assertPlainWindow(owner);
  period = (await one<{ p: number }>("select private.period_of(now())::integer as p")).p;
  const used = await one<{ used: boolean }>(
    `select exists (select 1 from public.watch_events where period_id = $1)
         or exists (select 1 from public.watch_rollup where period_id = $1)
         or exists (select 1 from public.payout_periods where period_id = $1)
         or exists (select 1 from private.rollup_dirty)
         or exists (select 1 from public.published_courses where slug like 'escala-%') as used`,
    [period],
  );
  if (used.used) throw new Error("la base local ya tiene datos de este mes: pnpm db:reset");
});

afterAll(async () => {
  // Vitest calla la consola de un archivo que pasa: las cifras van a un archivo, y las imprime
  // `scripts/test-escala.mjs` al terminar, pase o falle.
  const text = `Prueba de escala, periodo ${period}:\n${JSON.stringify(report, null, 2)}\n`;
  if (REPORT_PATH) writeFileSync(REPORT_PATH, text);
  else console.log(text);
  await owner?.end();
});

/** La selección de pares de punta a punta, sin consolidar: la mide la base, paso por paso. */
async function walk(fn: string): Promise<Walk> {
  return (await one<{ w: Walk }>(`select pg_temp.walk($1::public.period_id, $2, '${fn}') as w`, [period, STEP])).w;
}

/** Un paso de la selección en cada una de las posiciones de la muestra; el promedio, el peor y lo que sumarían todos los pasos. */
async function sample(fn: string): Promise<{ mean_ms: number; worst_ms: number; estimated_total_s: number }> {
  const times = (await q<{ ms: string }>(`select pg_temp.sample($1::public.period_id, $2, '${fn}') as ms`, [period, STEP])).map(
    (row) => Number(row.ms),
  );
  const mean = times.reduce((sum, time) => sum + time, 0) / times.length;
  const steps = Math.ceil((STUDENTS * LESSONS_PER_STUDENT) / STEP);
  return { mean_ms: Math.round(mean * 100) / 100, worst_ms: Math.max(...times), estimated_total_s: Math.round((mean * steps) / 1000) };
}

/** Una corrida del modo dado, paso por paso como la hace `nightly_rollup()`: cada paso confirma solo. */
async function drive(mode: "full" | "dirty"): Promise<Run> {
  const run = (await one<{ id: string }>("select private.open_job_run('nightly_rollup', $1, $2) as id", [period, mode])).id;
  expect(run).not.toBeNull();
  const before = (await one<{ now: string }>("select clock_timestamp()::text as now")).now;
  const times: number[] = [];
  let pairs = 0;
  let written = 0;
  let afterProfile: string | null = null;
  let afterLesson: string | null = null;
  const start = performance.now();
  for (;;) {
    const t = performance.now();
    const step: Step = (
      await one<{ r: Step }>(
        "select private.rollup_step($1, $2::timestamptz, $3, $4, $5) as r",
        [run, before, afterProfile, afterLesson, STEP],
      )
    ).r;
    times.push(performance.now() - t);
    if (step.read === 0) break;
    pairs += step.read;
    written += step.written;
    afterProfile = step.last_profile;
    afterLesson = step.last_lesson;
  }
  const total = ms(start);
  await owner.query("select private.close_job_run($1, null)", [run]);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    run,
    pairs,
    steps: times.length - 1,
    written,
    total_ms: total,
    worst_ms: Math.round(sorted.at(-1)!),
    p99_ms: Math.round(sorted[Math.floor(sorted.length * 0.99)]!),
  };
}

async function runStatus(run: string): Promise<{ status: string; error: string | null; failed: string | null }> {
  return one("select status::text, error, details ->> 'pairs_failed' as failed from public.job_runs where id = $1", [run]);
}

/** El consolidado del periodo, sin las columnas de cuándo y de qué corrida. */
const rollup = () => `select profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds, covered_seconds,
                              half_points from public.watch_rollup where period_id = ${period}`;

describe("la consolidación a HORIZONTE_ESCALA", () => {
  it("carga 13 000 alumnos con cobro, 900 lecciones, 260 000 reproducciones y 9.36 M latidos", async () => {
    const start = performance.now();
    // Las herramientas de la medición viven en la sesión: la selección de antes (t602_congelado), la
    // de ahora sin su blindaje del plan, la caminata y la muestra.
    await owner.query(`
      create function pg_temp.old_pairs(v_period public.period_id, p_after_profile uuid, p_after_lesson uuid, p_limit integer)
      returns integer language plpgsql as $f$
      declare v_profiles uuid[];
      begin
        select pg_catalog.array_agg(m.profile_id order by m.profile_id, m.lesson_id) into v_profiles
        from (select p.profile_id, p.lesson_id
              from (select e.profile_id, e.lesson_id from public.watch_events e where e.period_id = v_period
                    union
                    select w.profile_id, w.lesson_id from public.watch_rollup w where w.period_id = v_period) p
              where p_after_profile is null or (p.profile_id, p.lesson_id) > (p_after_profile, p_after_lesson)
              order by p.profile_id, p.lesson_id limit p_limit) m;
        return coalesce(pg_catalog.array_length(v_profiles, 1), 0);
      end $f$`);
    const definition = (
      await one<{ d: string }>("select pg_get_functiondef('private.rollup_full_pairs(public.period_id, uuid, uuid, integer)'::regprocedure) as d")
    ).d;
    const unguarded = definition
      .replace(/^CREATE OR REPLACE FUNCTION private\.rollup_full_pairs/, "CREATE FUNCTION pg_temp.unguarded_pairs")
      .replace(/^ SET plan_cache_mode TO 'force_custom_plan'\n/m, "");
    expect(unguarded).not.toContain("plan_cache_mode");
    await owner.query(unguarded);
    await owner.query(`
      create function pg_temp.walk(p_period public.period_id, p_limit integer, p_fn text) returns jsonb
      language plpgsql as $f$
      declare pp uuid; pl uuid; r record; k integer; n integer := 0; steps integer := 0;
              t0 timestamptz := clock_timestamp(); t1 timestamptz; worst interval := '0'; d interval;
      begin
        loop
          k := 0; t1 := clock_timestamp();
          for r in execute format('select * from %s($1, $2, $3, $4)', p_fn) using p_period, pp, pl, p_limit loop
            k := k + 1; pp := r.profile_id; pl := r.lesson_id;
          end loop;
          d := clock_timestamp() - t1;
          if d > worst then worst := d; end if;
          exit when k = 0;
          n := n + k; steps := steps + 1;
        end loop;
        return jsonb_build_object('pairs', n, 'steps', steps, 'total_ms', round(extract(epoch from clock_timestamp() - t0) * 1000),
                                  'worst_ms', round(extract(epoch from worst) * 1000, 2));
      end $f$`);
    await owner.query(`
      create function pg_temp.sample(p_period public.period_id, p_limit integer, p_fn text) returns setof numeric
      language plpgsql as $f$
      declare c record; t1 timestamptz;
      begin
        for c in select x.profile_id, x.lesson_id from pg_temp.positions x order by x.n loop
          t1 := clock_timestamp();
          if p_fn = 'pg_temp.old_pairs' then
            perform pg_temp.old_pairs(p_period, c.profile_id, c.lesson_id, p_limit);
          else
            execute format('select count(*) from %s($1, $2, $3, $4)', p_fn) using p_period, c.profile_id, c.lesson_id, p_limit;
          end if;
          return next round(extract(epoch from clock_timestamp() - t1) * 1000, 2);
        end loop;
      end $f$`);

    // El catálogo, como lo carga el sistema: 100 maestros con un curso de 9 lecciones de 18 minutos.
    await tx(async () => {
      await owner.query("select set_config('app.actor_kind', 'system', true), set_config('app.local_courses', 'on', true)");
      await owner.query("select private.system_catalog_add('practices', 'Escala'), private.system_catalog_add('levels', 'Escala')");
      await owner.query(`
      select count(private.system_load_course(private.system_add_teacher('Maestra escala ' || t, 'maestra-escala-' || t, null),
        jsonb_build_object('slug', 'escala-' || lpad(t::text, 3, '0'), 'title', 'Curso escala ' || t,
          'summary', 'Un curso de la prueba de escala.', 'practice', 'escala', 'level', 'escala',
          'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo', 'lessons', (
            select jsonb_agg(jsonb_build_object('title', 'Lección ' || l, 'video', jsonb_build_object(
              'provider', 'mux', 'asset_id', 'AssetEscala' || t || 'x' || l, 'playback_id', 'PlaybackEscala' || t || 'x' || l,
              'duration_seconds', 1080)) order by l)
            from generate_series(1, 9) l))))))
      from generate_series(1, 100) t`);
    });

    // Las cuentas (Auth crea el perfil), su suscripción y su cobro del mes, por la función del libro.
    await owner.query(
      `insert into auth.users (id, email)
       select ('e5ca1a00-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid, 'escala-' || s || '@prueba.test' from generate_series(1, $1) s`,
      [STUDENTS],
    );
    await owner.query(
      `insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
       select ('e5ca1a00-0000-4000-9000-' || lpad(s::text, 12, '0'))::uuid, ('e5ca1a00-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid,
              'manual', 'sus-escala-' || s, 'monthly', 'pending', 'MXN'
       from generate_series(1, $1) s`,
      [STUDENTS],
    );
    const charges = await one<{ recorded: string }>(
      `select count(*) filter (where r ->> 'outcome' = 'recorded') as recorded
       from (select private.record_charge(('e5ca1a00-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid,
                                          ('e5ca1a00-0000-4000-9000-' || lpad(s::text, 12, '0'))::uuid, 'manual',
                                          'cobro-escala-' || s, null, 'monthly', now() - interval '1 hour', 'MXN', 34900,
                                          null, null, 'card', 'MX', null) r
             from generate_series(1, $1) s) x`,
      [STUDENTS],
    );
    expect(Number(charges.recorded)).toBe(STUDENTS);

    // Cada alumno ve 20 lecciones seguidas del catálogo: de unos tres maestros (05 §14.1).
    await owner.query(`
      create temporary table lessons as
      select (row_number() over (order by c.slug, l.position) - 1)::integer as i, l.id, l.course_id, l.teacher_id, l.video_asset_id
      from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug like 'escala-%'`);
    await owner.query(
      `create temporary table pairs as
       select ('e5ca1a00-0000-4000-8000-' || lpad(s::text, 12, '0'))::uuid as profile_id, l.id as lesson_id, l.course_id,
              l.teacher_id, l.video_asset_id, ('e5ca1a00-0000-4000-a000-' || lpad((s * $2 + k)::text, 12, '0'))::uuid as session_id
       from generate_series(1, $1) s cross join generate_series(0, $2 - 1) k join lessons l on l.i = (s * 261 + k) % 900`,
      [STUDENTS, LESSONS_PER_STUDENT],
    );
    const counted = await one<{ pairs: string; distinct_pairs: string; teachers: string }>(
      "select count(*) as pairs, count(distinct (profile_id, lesson_id)) as distinct_pairs, count(distinct teacher_id) as teachers from pairs",
    );
    expect(Number(counted.distinct_pairs)).toBe(STUDENTS * LESSONS_PER_STUDENT);
    expect(Number(counted.pairs)).toBe(STUDENTS * LESSONS_PER_STUDENT);
    await owner.query(`
      create temporary table positions as
      select n, profile_id, lesson_id from (
        select row_number() over (order by profile_id, lesson_id) as n, profile_id, lesson_id, count(*) over () as c from pairs) x
      where n % (c / ${SAMPLE}) = 0`);

    // Sin la limpieza automática, para medir lo que se mide: sin `analyze` y sin `vacuum`, hasta que la
    // prueba los corre. La base se rehace al terminar.
    for (const table of [`public.watch_events_${period}`, "public.watch_rollup", "public.playback_sessions"]) {
      await owner.query(`alter table ${table} set (autovacuum_enabled = off)`);
    }
    await owner.query(
      `insert into public.playback_sessions (id, profile_id, auth_session_id, course_id, lesson_id, video_asset_id, teacher_id,
         access_basis, counts_for_payout, lesson_duration_seconds, started_at, last_heartbeat_at, accepted_media_seconds,
         revoked_at, revoke_reason)
       select session_id, profile_id, gen_random_uuid(), course_id, lesson_id, video_asset_id, teacher_id, 'subscription', true, 1080,
              now() - interval '2 hours', now() - interval '1 hour', 1080, now() - interval '1 hour', 'closed_by_user'
       from pairs`,
    );
    // Los latidos, de 30 s cada uno, en el orden en que llegan: todos los primeros tramos, después los
    // segundos. Un bloque por tramo, para que la transacción no crezca sin fin.
    for (let seq = 0; seq < BEATS_PER_PAIR; seq++) {
      await owner.query(
        `insert into public.watch_events (period_id, playback_session_id, seq, profile_id, lesson_id, from_second, to_second,
           playback_rate, was_visible, qualifies, counts_for_payout)
         select $1, x.session_id, $2, x.profile_id, x.lesson_id, $2 * 30, $2 * 30 + 30, 1, true, true, true
         from pairs x order by hashtext(x.session_id::text)`,
        [period, seq],
      );
    }
    expect(Number((await one<{ n: string }>("select count(*) as n from public.watch_events where period_id = $1", [period])).n)).toBe(
      STUDENTS * LESSONS_PER_STUDENT * BEATS_PER_PAIR,
    );

    // El mes, en cierre desde ayer y con su foto, como lo deja el paso a cierre.
    await tx(async () => {
      // El cambio se audita: lo hace el sistema.
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      await owner.query("alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced");
      await owner.query(
        `update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '1 day', active_students = $2,
                pool_bps = 6000
         where period_id = $1`,
        [period, STUDENTS],
      );
      await owner.query("alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced");
    });
    expect((await q("select * from private.schema_violations()")).length).toBe(0);
    report.load_s = Math.round(ms(start) / 1000);
    report.teachers = Number(counted.teachers);
  });

  it("la selección de antes, en una muestra de 20 posiciones del cursor: sin vacuum, recorre el periodo en cada paso", async () => {
    report.before_selection = await sample("pg_temp.old_pairs");
  });

  it("la selección nueva, de punta a punta y sin estadísticas: unos milisegundos por paso", async () => {
    const walked = await walk("private.rollup_full_pairs");
    expect(walked.pairs).toBe(STUDENTS * LESSONS_PER_STUDENT);
    report.selection_no_analyze = walked;
    report.selection_no_analyze_sample = await sample("private.rollup_full_pairs");
  });

  it("sin el blindaje, un plan genérico vuelve a recorrer la partición; con él, la sesión no lo puede imponer", async () => {
    await owner.query("set plan_cache_mode = force_generic_plan");
    try {
      report.selection_generic_unguarded_sample = await sample("pg_temp.unguarded_pairs");
      report.selection_generic_guarded_sample = await sample("private.rollup_full_pairs");
    } finally {
      await owner.query("reset plan_cache_mode");
    }
  });

  let first: Run;
  it("el recálculo completo con el consolidado vacío: cabe en 30 minutos, y ningún paso deja la corrida sin latir", async () => {
    first = await drive("full");
    report.full_empty = first;
    expect(await runStatus(first.run)).toEqual({ status: "succeeded", error: null, failed: null });
    expect(first.pairs).toBe(STUDENTS * LESSONS_PER_STUDENT);
    expect(first.written).toBe(STUDENTS * LESSONS_PER_STUDENT);
    expect(first.total_ms).toBeLessThan(FULL_LIMIT_MS);
    expect(first.worst_ms).toBeLessThan(BEAT_LIMIT_MS);
    // Cada par vio sus 1 080 segundos: dos medios puntos.
    const totals = await one<{ rows: string; points: string }>(
      "select count(*) as rows, sum(half_points) as points from public.watch_rollup where period_id = $1",
      [period],
    );
    expect([Number(totals.rows), Number(totals.points)]).toEqual([STUDENTS * LESSONS_PER_STUDENT, 2 * STUDENTS * LESSONS_PER_STUDENT]);
    await owner.query(`create temporary table rollup_full as ${rollup()}`);
  });

  it("otra vez, con el consolidado lleno (la primera noche en cierre): lee lo mismo y no escribe nada", async () => {
    const again = await drive("full");
    report.full_filled = again;
    expect(await runStatus(again.run)).toEqual({ status: "succeeded", error: null, failed: null });
    expect([again.pairs, again.written]).toEqual([STUDENTS * LESSONS_PER_STUDENT, 0]);
    expect(again.total_ms).toBeLessThan(FULL_LIMIT_MS);
    expect(again.worst_ms).toBeLessThan(BEAT_LIMIT_MS);
  });

  it("con analyze, la selección sigue en milisegundos, y el blindaje sigue haciendo falta", async () => {
    await owner.query("analyze public.watch_events, public.watch_rollup, public.playback_sessions");
    report.selection_analyze = await walk("private.rollup_full_pairs");
    report.before_selection_analyze = await sample("pg_temp.old_pairs");
    await owner.query("set plan_cache_mode = force_generic_plan");
    try {
      report.selection_analyze_generic_unguarded_sample = await sample("pg_temp.unguarded_pairs");
      report.selection_analyze_generic_guarded_sample = await sample("private.rollup_full_pairs");
    } finally {
      await owner.query("reset plan_cache_mode");
    }
  });

  it("con vacuum: la selección, la de antes y el recálculo completo", async () => {
    await owner.query("vacuum (analyze) public.watch_events, public.watch_rollup, public.playback_sessions");
    report.selection_vacuum = await walk("private.rollup_full_pairs");
    report.before_selection_vacuum = await sample("pg_temp.old_pairs");
    const vacuumed = await drive("full");
    report.full_vacuum = vacuumed;
    expect(await runStatus(vacuumed.run)).toEqual({ status: "succeeded", error: null, failed: null });
    expect([vacuumed.pairs, vacuumed.written]).toEqual([STUDENTS * LESSONS_PER_STUDENT, 0]);
    expect(vacuumed.total_ms).toBeLessThan(FULL_LIMIT_MS);
  });

  it("el recálculo completo deja el mismo consolidado que pasar todos los pares por el modo marcado", async () => {
    await owner.query("delete from public.watch_rollup where period_id = $1", [period]);
    await owner.query(
      "insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at) select $1, profile_id, lesson_id, clock_timestamp() from pairs",
      [period],
    );
    const marked = await drive("dirty");
    report.dirty_all_pairs = marked;
    expect(await runStatus(marked.run)).toEqual({ status: "succeeded", error: null, failed: null });
    expect(marked.pairs).toBe(STUDENTS * LESSONS_PER_STUDENT);
    expect(Number((await one<{ n: string }>("select count(*) as n from private.rollup_dirty")).n)).toBe(0);
    const differences = await one<{ missing: string; extra: string }>(
      `select (select count(*) from (select * from rollup_full except ${rollup()}) a) as missing,
              (select count(*) from (${rollup()} except select * from rollup_full) b) as extra`,
    );
    expect(differences).toEqual({ missing: "0", extra: "0" });
  });

  it("una noche normal: 10 000 pares marcados, con la foto, el paso a cierre y el sellado", async () => {
    await owner.query(
      `insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
       select $1, profile_id, lesson_id, clock_timestamp() - interval '1 hour' from pairs order by hashtext(session_id::text) limit $2`,
      [period, MARKED],
    );
    const anomalies = performance.now();
    // Abre sus alertas: se mide y se deshace, y la noche la vuelve a correr.
    await tx(async () => {
      await owner.query("select private.detect_anomalies($1, clock_timestamp())", [period]);
      throw new Error("deshacer");
    }).catch((error: Error) => {
      if (error.message !== "deshacer") throw error;
    });
    report.detect_anomalies_ms = ms(anomalies);

    // Otra conexión mira el latido de las corridas mientras el procedimiento corre.
    const watcher = new Client({ connectionString: localOwnerUrl() });
    await watcher.connect();
    const since = (await one<{ now: string }>("select clock_timestamp()::text as now")).now;
    let watching = true;
    let worstGap = 0;
    const seen = new Map<string, number>();
    const watch = (async () => {
      while (watching) {
        const rows = (
          await watcher.query<{ id: string; beat: number }>(
            "select id, extract(epoch from heartbeat_at) * 1000 as beat from public.job_runs where job = 'nightly_rollup' and started_at >= $1::timestamptz",
            [since],
          )
        ).rows;
        for (const row of rows) {
          const last = seen.get(row.id);
          if (last !== undefined && row.beat > last) worstGap = Math.max(worstGap, row.beat - last);
          seen.set(row.id, row.beat);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    const night = performance.now();
    try {
      await owner.query("call private.nightly_rollup()");
    } finally {
      watching = false;
      await watch;
      await watcher.end();
    }
    report.normal_night = { total_ms: ms(night), worst_beat_gap_ms: Math.round(worstGap) };
    const runs = await q<{ period_id: number; status: string; mode: string; rows_read: string; error: string | null }>(
      `select period_id, status::text, details ->> 'mode' as mode, rows_read, error from public.job_runs
       where job = 'nightly_rollup' and started_at >= $1::timestamptz order by period_id`,
      [since],
    );
    const mine = runs.find((run) => run.period_id === period);
    expect(mine).toMatchObject({ status: "succeeded", mode: "dirty", rows_read: String(MARKED), error: null });
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(worstGap).toBeLessThan(BEAT_LIMIT_MS);
    const transition = await one<{ status: string; error: string | null }>(
      "select status::text, error from public.job_runs where job = 'period_transition' and started_at >= $1::timestamptz",
      [since],
    );
    expect(transition).toEqual({ status: "succeeded", error: null });
  });
});

// El reparto y el cierre (T-611, segunda solicitud), sobre el mismo mes ya consolidado. Van al final:
// cerrar congela el periodo. El reparto tiene que caber en el `statement_timeout` del servidor
// (`src/adapters/supabase/db.ts`), seis veces seguidas en la misma sesión, por si Postgres pasa al plan
// genérico. El ensayo y el cierre se corren como los correrá el servidor (finanzas con su sesión, en
// una transacción, con el `commit` aparte, que es donde corre `assert_period_balanced`), y solo se
// mide si caben: cómo corre el cierre lo decide T-605 (decisión de Sergio del 2026-10-26).
const SERVER_STATEMENT_MS = 10_000;

describe("el reparto y el cierre a HORIZONTE_ESCALA", () => {
  it("el reparto del periodo cabe en el tope de una sentencia del servidor, también la sexta vez", async () => {
    const pairs = Number(
      (await one<{ n: string }>("select count(distinct (profile_id, teacher_id)) as n from public.watch_rollup where period_id = $1", [period])).n,
    );
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      await tx(async () => {
        await owner.query("set local statement_timeout = '10s'");
        const start = performance.now();
        const lines = await one<{ pools: string; shares: string }>(
          `select count(*) filter (where l.kind = 'student_pool') as pools, count(*) filter (where l.kind = 'share') as shares
           from private.payout_for_period($1, 0) l`,
          [period],
        );
        times.push(ms(start));
        // Un bote por alumno, y una parte por cada alumno y maestro con medios puntos.
        expect(Number(lines.pools)).toBe(STUDENTS);
        expect(Number(lines.shares)).toBe(pairs);
      });
    }
    // Las piezas, una vez: la entrada, el reparto con ella ya armada, la red sola y los totales.
    let start = performance.now();
    await owner.query("create temporary table close_in as select * from private.close_input($1)", [period]);
    const input = ms(start);
    start = performance.now();
    await owner.query(`
      create temporary table close_lines as
      select array(select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line
                   from close_in i, private.compute_payout(i.pool_bps, i.carried_in_cents, i.bases, i.points) with ordinality x
                   order by x.ordinality) as lines`);
    const compute = ms(start);
    start = performance.now();
    await owner.query("select private.check_payout_lines(i.carried_in_cents, l.lines) from close_in i, close_lines l");
    const check = ms(start);
    start = performance.now();
    await owner.query("select count(*) from close_lines, private.close_teacher_totals(lines)");
    const totals = ms(start);
    report.payout = {
      payout_for_period_ms: times,
      close_input_ms: input,
      compute_payout_ms: compute,
      check_payout_lines_ms: check,
      close_teacher_totals_ms: totals,
      lines: Number((await one<{ n: string }>("select cardinality(lines) as n from close_lines")).n),
    };
    expect(Math.max(...times)).toBeLessThan(SERVER_STATEMENT_MS);
  });

  it("el ensayo y el cierre, como los correrá el servidor: se mide si caben", async () => {
    // El cierre va en orden desde el arranque, y no con alertas abiertas: las que dejó la noche normal
    // se revisan antes, como lo haría finanzas.
    await clearPeriodsBefore(owner, period);
    const emails: string[] = [];
    const finance = await financePerson(emails);
    const client = await connect();
    const timed = async (sql: string): Promise<{ r: Record<string, unknown>; ms: number }> => {
      const start = performance.now();
      const r = (await client.query<{ r: Record<string, unknown> }>(sql, [period])).rows[0]!.r;
      return { r, ms: ms(start) };
    };
    try {
      await client.query("begin");
      await actAs(client, finance);
      const alerts = await client.query<{ r: { outcome: string } }>(
        "select private.review_alert(id, 'Revisada en la prueba de escala.', false, null) as r from public.anomaly_alerts where period_id = $1 and status = 'open'",
        [period],
      );
      expect(alerts.rows.every((row) => row.r.outcome === "reviewed")).toBe(true);
      await retire(client, finance);
      await client.query("commit");

      await client.query("begin");
      await actAs(client, finance);
      const rehearsal = await timed("select private.rehearse_close($1) as r");
      expect(rehearsal.r.outcome).toBe("rehearsed");
      await retire(client, finance);
      let start = performance.now();
      await client.query("commit");
      const rehearsalCommit = ms(start);

      await client.query("begin");
      await actAs(client, finance);
      const close = await timed(`select private.close_period($1, ${SHOWN}) as r`);
      expect(close.r.outcome).toBe("closed");
      await retire(client, finance);
      start = performance.now();
      await client.query("commit");
      const closeCommit = ms(start);

      start = performance.now();
      await owner.query("select private.assert_period_balanced($1)", [period]);
      const balanced = ms(start);
      const written = await one<{ pools: string; shares: string; pairs: string; payouts: string; exported: string }>(
        `select (select count(*) from public.payout_student_pools where period_id = $1) as pools,
                (select count(*) from public.payout_shares where period_id = $1) as shares,
                (select count(distinct (profile_id, teacher_id)) from public.watch_rollup where period_id = $1) as pairs,
                (select count(*) from public.payouts where period_id = $1) as payouts,
                (select row_count from private.close_exports where period_id = $1) as exported`,
        [period],
      );
      report.close = {
        alerts_reviewed: alerts.rowCount,
        rehearse_close_ms: rehearsal.ms,
        rehearse_commit_ms: rehearsalCommit,
        close_period_ms: close.ms,
        close_commit_ms: closeCommit,
        assert_period_balanced_ms: balanced,
        // El tope del servidor es por sentencia, y el `commit` es otra.
        fits_server_statement: [rehearsal.ms, rehearsalCommit, close.ms, closeCommit].every((time) => time < SERVER_STATEMENT_MS),
        student_pools: Number(written.pools),
        shares: Number(written.shares),
        payouts: Number(written.payouts),
        exported_rows: Number(written.exported),
      };
      // Un bote por alumno, y una parte por cada alumno y maestro con medios puntos.
      expect(Number(written.pools)).toBe(STUDENTS);
      expect(Number(written.shares)).toBe(Number(written.pairs));
      expect(Number(written.payouts)).toBe(report.teachers);
      // Y su exportación (T-605), escrita y comprobada en el cierre: una fila por maestro.
      expect(Number(written.exported)).toBe(report.teachers);

      // Liberar (T-605, cuarta solicitud), como lo correrá el servidor desde PA-81: los bonos del fundador
      // decididos antes, la lectura de la pantalla con su huella, y liberar con ella. Toma un candado de saldo
      // por maestro; la comprobación de cada liquidación liberada corre al confirmar, bajo el mismo tope.
      await client.query("begin");
      await actAs(client, finance);
      const founders = await client.query<{ r: { outcome: string } }>(
        "select private.confirm_founder_bonus(id) as r from public.bonuses where period_id = $1 and kind = 'founder' and status = 'proposed'",
        [period],
      );
      expect(founders.rows.every((row) => row.r.outcome === "confirmed")).toBe(true);
      await retire(client, finance);
      await client.query("commit");

      await client.query("begin");
      await actAs(client, finance);
      const read = await timed("select private.finance_payouts($1) as r");
      await client.query("rollback");
      await client.query("begin");
      await actAs(client, finance);
      const release = await timed(`select private.release_payouts($1, ${SEEN}) as r`);
      expect(release.r.outcome).toBe("released");
      await retire(client, finance);
      start = performance.now();
      await client.query("commit");
      const releaseCommit = ms(start);
      const released = await one<{ calculated: string }>(
        "select count(*) filter (where status = 'calculated') as calculated from public.payouts where period_id = $1",
        [period],
      );
      report.release = {
        founder_bonuses_confirmed: founders.rowCount,
        finance_payouts_ms: read.ms,
        release_payouts_ms: release.ms,
        release_commit_ms: releaseCommit,
        fits_server_statement: [read.ms, release.ms, releaseCommit].every((time) => time < SERVER_STATEMENT_MS),
        released: Number(release.r.released),
      };
      expect(Number(release.r.released)).toBe(report.teachers);
      expect(Number(released.calculated)).toBe(0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });
});
