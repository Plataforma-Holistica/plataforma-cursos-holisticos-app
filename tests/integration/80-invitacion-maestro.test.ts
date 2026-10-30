import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { claimedUser } from "./helpers/account";
import { authVisitor, type KnownUser } from "./helpers/auth";
import { answer, asOwner, asServer, asSystem, print, reverted } from "./helpers/team";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// La invitación del maestro (T-401, RF-104, FL-30) contra lo que Supabase Auth escribe de verdad. Las
// pruebas de base (`58_invitacion_maestro.test.sql`) rompen cada condición con filas puestas a mano;
// aquí la sesión con la que se acepta la abre Auth.
//
// Como en las del equipo, cada caso corre dentro de una transacción del dueño que se revierte: la
// auditoría no admite borrado. Lo que no se puede probar sin dejar residuo es una carrera que confirme
// (dos aceptaciones a la vez). En su lugar se prueba lo que la impide: invitar, reenviar, revocar y
// aceptar esperan el mismo candado. Que la segunda ya no encuentra invitación lo prueba la base.

const emails: string[] = [];

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

interface Entered {
  person: KnownUser;
  client: SupabaseClient;
  sessionId: string;
}

/** Una persona con su cuenta reclamada, que entró con su contraseña directo en Auth. */
async function entered(): Promise<Entered> {
  const person = await claimedUser();
  emails.push(person.email);
  const client = authVisitor();
  const signedIn = await client.auth.signInWithPassword({ email: person.email, password: person.password });
  if (signedIn.error) throw new Error(`La persona de prueba no entró: ${signedIn.error.code}`);
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("El cliente de prueba no tiene sesión.");
  const json = Buffer.from(data.session.access_token.split(".")[1] ?? "", "base64url").toString("utf8");
  return { person, client, sessionId: (JSON.parse(json) as { session_id: string }).session_id };
}

/** Espera a que esa conexión quede detenida en un candado. Falso si no llegó a estarlo. */
async function waitsOnALock(pid: number): Promise<boolean> {
  // Hasta diez segundos: con la máquina cargada, la espera tarda en verse.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await ownerQuery<{ waiting: boolean }>(
      "select coalesce(wait_event_type = 'Lock', false) as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (row?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Corre `held` en una transacción y, sin terminarla, `waiting` en otra. Dice si la segunda se quedó
 * esperando un candado, y qué contestó cuando la primera terminó (revertida, o confirmada si `held`
 * lo hace). Solo la segunda toma el rol del servidor.
 */
async function secondWaits(
  held: (owner: Client) => Promise<unknown>,
  waiting: (owner: Client) => Promise<string | null>,
  prepare?: (owner: Client) => Promise<unknown>,
): Promise<{ waited: boolean; answered: string | null }> {
  return reverted(async (second) => {
    if (prepare) await prepare(second);
    const [me] = (await second.query<{ pid: number }>("select pg_backend_pid() as pid")).rows;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const isHolding = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const first = reverted(async (owner) => {
      await held(owner);
      holding();
      await released;
    }, false);
    await Promise.race([isHolding, first]);
    const running = waiting(second);
    const waited = await waitsOnALock(me?.pid ?? 0);
    release();
    await first;
    return { waited, answered: await running };
  });
}

/** Un maestro del sistema con su invitación al correo de esa persona, puesta por el dueño declarado sistema. */
async function invitedBySystem(owner: Client, email: string, expected = "invited_existing"): Promise<string> {
  await asSystem(owner);
  const teacher = await answer(owner, "private.system_add_teacher($1, $2, null)::text", ["Maestra de prueba", `m-${randomUUID()}`]);
  if (!teacher) throw new Error("No se creó el maestro de prueba.");
  expect(await answer(owner, "private.system_invite_teacher($1, $2)", [teacher, email])).toBe(expected);
  return teacher;
}

const texts = async (owner: Client) => {
  const result = await owner.query<{ agreement: string; notice: string }>(
    "select private.current_legal_document('teacher_agreement') as agreement, private.current_legal_document('teacher_privacy_notice') as notice",
  );
  const row = result.rows[0];
  if (!row?.agreement || !row.notice) throw new Error("Faltan los borradores del maestro: corre pnpm db:drafts.");
  return row;
};

describe("una invitación de maestro, contra el Auth de verdad", () => {
  it("se acepta con la sesión que abrió Auth, que sigue abierta; las demás de la cuenta se cierran", async () => {
    const nora = await entered();
    const other = await entered();
    // Una segunda sesión de nora, también de Auth.
    const again = authVisitor();
    const signedIn = await again.auth.signInWithPassword({ email: nora.person.email, password: nora.person.password });
    if (signedIn.error) throw new Error(`La segunda sesión no entró: ${signedIn.error.code}`);

    await reverted(async (owner) => {
      const teacher = await invitedBySystem(owner, nora.person.email);
      await asServer(owner, nora.person.id, nora.sessionId);
      expect(await answer(owner, "private.claim_account($1)", [print("nora")])).toBe("already_claimed");
      const { agreement, notice } = await texts(owner);
      await asServer(owner, nora.person.id, nora.sessionId);
      expect(await answer(owner, "private.accept_teacher_invitation($1, $2, $3, $4, $5)", [
        print("nora"), agreement, notice, "203.0.113.9", "vitest"])).toBe("accepted");
      expect(await answer(owner, "(select state from private.teacher_standing(null))")).toBe("active");

      await asOwner(owner);
      const sessions = await owner.query<{ id: string }>("select id::text from auth.sessions where user_id = $1", [nora.person.id]);
      expect(sessions.rows).toEqual([{ id: nora.sessionId }]);
      const bound = await owner.query<{ status: string; profile: string }>(
        "select status::text, profile_id::text as profile from public.teachers where id = $1", [teacher]);
      expect(bound.rows).toEqual([{ status: "active", profile: nora.person.id }]);

      // Otra persona con su propia sesión no la acepta: no es su correo.
      await asServer(owner, other.person.id, other.sessionId);
      expect(await answer(owner, "private.accept_teacher_invitation($1, $2, $3, null, null)", [
        print("x"), agreement, notice])).toBe("no_invitation");
    });
  });
});

describe("la invitación de maestro va una tras otra", () => {
  const holdTheInvitations = async (owner: Client) => {
    await invitedBySystem(owner, `c${randomUUID()}@candado.test`, "invited_new");
  };
  const stranger = randomUUID();
  const calls: [string, string][] = [
    ["invitar", "private.invite_teacher('Nombre', 'x@candado.test')"],
    ["reenviar", `private.reinvite_teacher('${randomUUID()}')`],
    ["revocar", `private.revoke_teacher_invitation('${randomUUID()}')`],
  ];

  it.each(calls)("%s espera a que termine la que va delante", async (_name, call) => {
    const result = await secondWaits(holdTheInvitations, async (second) => {
      await asServer(second, stranger, randomUUID());
      return answer(second, call);
    });
    expect(result).toEqual({ waited: true, answered: "forbidden" });
  });

  it("aceptar también, cuando hay una invitación que aceptar; y quien no tiene ninguna no espera a nadie", async () => {
    const { person, sessionId } = await entered();
    const accept = "private.accept_teacher_invitation($1, gen_random_uuid(), gen_random_uuid(), null, null)";
    const withInvitation = await secondWaits(
      holdTheInvitations,
      async (second) => {
        await asServer(second, person.id, sessionId);
        return answer(second, accept, [print("r")]);
      },
      async (second) => {
        // Puesta a mano, sin la función: así no toma el candado que se va a esperar.
        await asSystem(second);
        const teacher = await answer(second, "private.system_add_teacher('Espera', $1, null)::text", [`e-${randomUUID()}`]);
        await second.query(
          "insert into private.teacher_invitations (teacher_id, email, created_at, expires_at) values ($1, $2, clock_timestamp(), clock_timestamp() + interval '1 day')",
          [teacher, person.email.toLowerCase()],
        );
      },
    );
    expect(withInvitation).toEqual({ waited: true, answered: "needs_mailbox_proof" });

    const without = await secondWaits(holdTheInvitations, async (second) => {
      await asServer(second, person.id, sessionId);
      return answer(second, accept, [print("r")]);
    });
    expect(without).toEqual({ waited: false, answered: "no_invitation" });
  });

});
