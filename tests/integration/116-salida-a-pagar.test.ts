import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connect, waitBehind } from "./helpers/finance";
import { asServer } from "./helpers/team";
import { createTestUser, deleteTestUsers, ownerQuery, type TestUser } from "./helpers/users";

// La salida a pagar, con dos peticiones de verdad a la vez (T-302, primera solicitud; RF-201): dos pestañas, o un doble clic, de la misma cuenta. La base las
// pone en fila con el candado de la cuenta, y la segunda recibe la salida que reservó la primera (o, con otro plan, la que hay abierta), sin otro
// consentimiento. Las reglas de cada respuesta las prueba `88_salida_a_pagar`.

const users: TestUser[] = [];
let insertedDocument: string | null = null;

/** Lo vigente: el monto de cada plan y el texto del cobro recurrente. */
let monthly: number;
let annual: number;
let documentId: string;

beforeAll(async () => {
  // Las dos conexiones del dueño toman el rol del servidor, sin heredarlo; se le quita al terminar.
  await ownerQuery("grant app_service to postgres with set true, inherit false");
  const [prices] = await ownerQuery<{ monthly: string; annual: string }>(
    `select private.parameter_value('PRECIO_MENSUAL') #>> '{}' as monthly, private.parameter_value('PRECIO_ANUAL') #>> '{}' as annual`,
  );
  monthly = Number(prices!.monthly);
  annual = Number(prices!.annual);
  // La base puede venir sin los borradores (la primera corrida de la integración continua): entonces la prueba pone un texto y lo quita al terminar.
  const [current] = await ownerQuery<{ id: string | null }>("select private.current_legal_document('recurring_charge_consent')::text as id");
  if (current?.id) documentId = current.id;
  else {
    const owner = await connect();
    try {
      await owner.query("begin");
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      const inserted = await owner.query<{ id: string }>(
        `insert into public.legal_documents (doc_type, version, title, body, effective_from)
         values ('recurring_charge_consent', 1, 'Cobro recurrente', 'Acepto que el cobro se repite hasta que yo cancele.', now() - interval '1 minute')
         returning id::text as id`,
      );
      await owner.query("commit");
      insertedDocument = inserted.rows[0]!.id;
      documentId = insertedDocument;
    } finally {
      await owner.end();
    }
  }
});

afterAll(async () => {
  const ids = users.map((user) => user.id);
  await ownerQuery(
    `do $$ begin
       set local session_replication_role = replica;
       delete from private.checkout_sessions where profile_id = any('{${ids.join(",")}}'::uuid[]);
       delete from private.billing_customers where profile_id = any('{${ids.join(",")}}'::uuid[]);
       delete from public.consents where profile_id = any('{${ids.join(",")}}'::uuid[]);
       ${insertedDocument ? `delete from public.legal_documents where id = '${insertedDocument}';` : ""}
     end $$`,
  );
  await deleteTestUsers(users);
  await ownerQuery("revoke app_service from postgres");
});

/** Empieza la salida de esa persona en esa conexión, dentro de una transacción abierta, sin confirmar. */
async function begin(client: Client, user: TestUser, plan: "monthly" | "annual"): Promise<{ answer: string; checkout?: { id: string } }> {
  const result = await client.query<{ out: { answer: string; checkout?: { id: string } } }>(
    "select private.checkout_begin($1, $2, $3, false, '/inicio', '203.0.113.116'::inet, 'Navegador 116') as out",
    [plan, plan === "monthly" ? monthly : annual, documentId],
  );
  return result.rows[0]!.out;
}

async function counts(user: TestUser): Promise<{ sessions: number; consents: number }> {
  const [row] = await ownerQuery<{ sessions: number; consents: number }>(
    `select (select count(*)::int from private.checkout_sessions where profile_id = $1) as sessions,
            (select count(*)::int from public.consents where profile_id = $1 and origin = 'checkout') as consents`,
    [user.id],
  );
  return row!;
}

/** Dos peticiones de la misma cuenta a la vez: la segunda espera a la primera, y se ve qué contesta cada una. */
async function race(user: TestUser, first: "monthly" | "annual", second: "monthly" | "annual") {
  const owner = await connect();
  const one = await connect();
  const two = await connect();
  try {
    await one.query("begin");
    await asServer(one, user.id, randomUUID());
    const a = await begin(one, user, first);
    await two.query("begin");
    await asServer(two, user.id, randomUUID());
    const waiting = begin(two, user, second);
    await waitBehind(owner, one, 1);
    await one.query("commit");
    const b = await waiting;
    await two.query("commit");
    return { a, b };
  } finally {
    await one.query("rollback").catch(() => undefined);
    await two.query("rollback").catch(() => undefined);
    await Promise.all([owner.end(), one.end(), two.end()]);
  }
}

describe("dos salidas a la vez de la misma cuenta", () => {
  it("el mismo plan: la segunda espera y recibe la misma salida, sin otro consentimiento", async () => {
    const user = await createTestUser({ claimed: true });
    users.push(user);
    const { a, b } = await race(user, "monthly", "monthly");
    expect(a.answer).toBe("reserved");
    expect(b.answer).toBe("reuse");
    expect(b.checkout?.id).toBe(a.checkout?.id);
    expect(await counts(user)).toEqual({ sessions: 1, consents: 1 });
  });

  it("otro plan: la segunda espera y recibe la que quedó abierta, para vencerla antes", async () => {
    const user = await createTestUser({ claimed: true });
    users.push(user);
    const { a, b } = await race(user, "annual", "monthly");
    expect(a.answer).toBe("reserved");
    expect(b.answer).toBe("open_other");
    expect(b.checkout?.id).toBe(a.checkout?.id);
    expect(await counts(user)).toEqual({ sessions: 1, consents: 1 });
  });
});
