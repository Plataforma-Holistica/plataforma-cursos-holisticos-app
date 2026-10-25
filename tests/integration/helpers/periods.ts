import type { Client } from "pg";

// Los periodos que dejan las pruebas de integración (T-601, carril A). La corrida de cada noche
// llama al paso a cierre, que abre las filas del mes en curso y de los dos siguientes y confirma; y
// nada cierra un periodo hasta T-602, así que una fila que se queda entra a la ventana para siempre
// cuando su mes termina. Por eso cada prueba que corre la corrida quita, al terminar, las filas que
// se crearon mientras corría y las corridas del paso a cierre. Las filas no se borran: se quitan con
// su guardián apagado, solo esas y si nada apunta a ellas (un cobro, el consolidado, una alerta o una
// exclusión). La auditoría se queda.

/** La ventana es la de siempre (el mes anterior y el en curso): si no, la base local tiene periodos de otra corrida. */
export async function assertPlainWindow(owner: Client): Promise<void> {
  const result = await owner.query<{ plain: boolean }>(
    `select array(select private.rollup_window()) =
            array[private.period_plus(private.period_of(now()), -1), private.period_of(now())]::public.period_id[] as plain`,
  );
  if (!result.rows[0]?.plain) {
    throw new Error("la ventana tiene periodos que dejó otra corrida en la base local: pnpm db:reset");
  }
}

/**
 * Quita las filas de periodo creadas desde `since` (las que abrió el paso a cierre, dentro o fuera de
 * una corrida, y las que abrió la prueba) y las corridas del paso a cierre desde entonces.
 */
export async function dropTransitionLeftovers(owner: Client, since: string): Promise<void> {
  await owner.query("begin");
  try {
    await owner.query("alter table public.payout_periods disable trigger payout_periods_guard");
    await owner.query(
      `delete from public.payout_periods p where p.created_at >= $1::timestamptz
         and not exists (select 1 from public.charges c where c.allocation_start_period_id = p.period_id)
         and not exists (select 1 from public.watch_rollup w where w.period_id = p.period_id)
         and not exists (select 1 from public.anomaly_alerts a where a.period_id = p.period_id)
         and not exists (select 1 from public.consumption_exclusions x where x.period_id = p.period_id)`,
      [since],
    );
    await owner.query("alter table public.payout_periods enable trigger payout_periods_guard");
    await owner.query("delete from public.job_runs where job = 'period_transition' and started_at >= $1::timestamptz", [since]);
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
}
