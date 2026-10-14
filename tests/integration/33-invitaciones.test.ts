import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { claimedUser } from "./helpers/account";
import { authVisitor, type KnownUser } from "./helpers/auth";
import { localOwnerUrl } from "./helpers/local";
import { answer, asOwner, asServer, asSystem, print, reverted } from "./helpers/team";
import { totpCode } from "./helpers/totp";
import { deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// Las invitaciones de administrador (RF-105, RF-106, RF-712; TRD §9.2, fila «Invitaciones»),
// contra lo que Supabase Auth escribe de verdad. Las pruebas de base
// (`13_invitaciones.test.sql`) rompen cada condición con filas puestas a mano; aquí las
// sesiones, los factores y las verificaciones los escribe Auth.
//
// Todo lo que cambia el equipo queda en la auditoría, que no admite borrado, y las pruebas
// de base cuentan sus renglones. Por eso cada caso corre dentro de una transacción del dueño
// que se revierte, con el rol y los ajustes que usa cada camino. Mientras esa transacción
// sigue abierta, Auth trabaja por su cuenta en otras conexiones: lo que confirma se ve en
// la sentencia siguiente, que es como abre sus transacciones el adaptador.
//
// Lo que aquí no se puede probar sin dejar residuo es una carrera que confirme: dos
// revocaciones a la vez. En su lugar se prueba lo que la impide: que toda función que
// cambia el equipo espera a la anterior, y que invitar y reclamar esperan el mismo candado.

const emails: string[] = [];

afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

interface Entered {
  person: KnownUser;
  client: SupabaseClient;
}

/** Una persona con su cuenta reclamada, que entró con su contraseña directo en Auth. */
async function entered(): Promise<Entered> {
  const person = await claimedUser();
  emails.push(person.email);
  const client = authVisitor();
  const signedIn = await client.auth.signInWithPassword({ email: person.email, password: person.password });
  if (signedIn.error) throw new Error(`La persona de prueba no entró: ${signedIn.error.code}`);
  return { person, client };
}

/** Da de alta un factor y lo verifica con esa misma sesión, que sube de nivel. Con su clave. */
async function verifiedFactorWithSecret(client: SupabaseClient, name: string): Promise<{ id: string; secret: string }> {
  const factor = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: name });
  if (factor.error) throw new Error(`El factor de prueba no se dio de alta: ${factor.error.code}`);
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: factor.data.id, code: totpCode(factor.data.totp.secret) });
  if (verified.error) throw new Error(`El factor de prueba no se verificó: ${verified.error.code}`);
  return { id: factor.data.id, secret: factor.data.totp.secret };
}

/** Lo mismo, cuando la prueba solo necesita saber cuál factor es. */
const verifiedFactor = async (client: SupabaseClient, name: string): Promise<string> => (await verifiedFactorWithSecret(client, name)).id;

interface Token {
  /** Las claims del token, tal como las firmó Auth. */
  json: string;
  sessionId: string;
}

async function tokenOf(client: SupabaseClient): Promise<Token> {
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("El cliente de prueba no tiene sesión.");
  const json = Buffer.from(data.session.access_token.split(".")[1] ?? "", "base64url").toString("utf8");
  return { json, sessionId: (JSON.parse(json) as { session_id: string }).session_id };
}

async function passes(owner: Client, call: string): Promise<boolean> {
  const result = await owner.query<{ passes: boolean }>(`select ${call} as passes`);
  return result.rows[0]?.passes === true;
}

/** Deja a alguien como del equipo, con configuración y con su factor de verdad atado. */
async function asTeamMember(owner: Client, person: KnownUser, factor: string, sessionId: string): Promise<void> {
  await asSystem(owner);
  await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'config')", [person.id]);
  await owner.query("insert into private.admin_factors (profile_id, factor_id, bound_email) values ($1, $2, $3)", [
    person.id,
    factor,
    person.email.toLowerCase(),
  ]);
  await owner.query("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [sessionId, person.id]);
  await asOwner(owner);
}

const sessionsOf = (userId: string) =>
  ownerQuery<{ aal: string; factor: string | null }>(
    "select aal::text as aal, factor_id::text as factor from auth.sessions where user_id = $1",
    [userId],
  );

describe("una invitación, de punta a punta, contra el Auth de verdad", () => {
  it("invitar pide un código reciente; aceptar, el resguardo y un factor recién verificado; y la puerta se pasa entrando de nuevo", async () => {
    const inviter = await entered();
    const inviterFactor = await verifiedFactor(inviter.client, "el de quien invita");
    const inviterToken = await tokenOf(inviter.client);
    const invited = await entered();
    const ticket = print("resguardo");

    await reverted(async (owner) => {
      await asTeamMember(owner, inviter.person, inviterFactor, inviterToken.sessionId);

      // La verificación que Auth anotó se hace vieja: la puerta de 12 horas la pasa, la de
      // los cambios al equipo no.
      await owner.query("update auth.mfa_amr_claims set updated_at = now() - interval '16 minutes' where session_id = $1", [
        inviterToken.sessionId,
      ]);
      await asServer(owner, inviter.person.id, inviterToken.sessionId);
      expect(await passes(owner, "private.actor_has_capability('config')")).toBe(true);
      expect(await answer(owner, "private.invite_admin($1, '{support}')", [invited.person.email])).toBe("needs_fresh_code");
      await asOwner(owner);
      await owner.query("update auth.mfa_amr_claims set updated_at = now() where session_id = $1", [inviterToken.sessionId]);
      await asServer(owner, inviter.person.id, inviterToken.sessionId);
      expect(await answer(owner, "private.invite_admin($1, '{support}')", [invited.person.email.toUpperCase()])).toBe(
        "invited_existing",
      );

      // La persona invitada prueba su buzón: el servidor reclama su cuenta con el resguardo.
      const before = await tokenOf(invited.client);
      await asServer(owner, invited.person.id, before.sessionId);
      expect(await answer(owner, "private.claim_account($1)", [ticket])).toBe("already_claimed");
      expect(await answer(owner, "private.accept_admin_invitation($1, $2)", [ticket, randomUUID()])).toBe("needs_code");

      // Auth, de verdad y por su cuenta: da de alta un factor y lo verifica con su sesión.
      const { id: factor, secret } = await verifiedFactorWithSecret(invited.client, "el nuevo");
      const token = await tokenOf(invited.client);
      expect(token.sessionId).toBe(before.sessionId);
      await asOwner(owner);
      await owner.query("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [token.sessionId, invited.person.id]);

      await asServer(owner, invited.person.id, token.sessionId);
      expect(await answer(owner, "private.accept_admin_invitation($1, $2)", [ticket, randomUUID()])).toBe("needs_code");
      expect(await answer(owner, "private.accept_admin_invitation($1, $2)", [print("otro"), factor])).toBe("needs_mailbox_proof");
      expect(await answer(owner, "private.accept_admin_invitation($1, $2)", [ticket, factor])).toBe("accepted");

      // Aceptar cerró la sesión con la que aceptó, en la misma transacción: existía antes de
      // la atadura. Con ella no se pasa la puerta por ningún camino, aunque su token siga
      // diciendo segundo nivel.
      expect(await passes(owner, "private.actor_has_capability('support')")).toBe(false);
      await asOwner(owner);
      const left = await owner.query("select 1 from auth.sessions where user_id = $1", [invited.person.id]);
      expect(left.rows).toEqual([]);
      const noted = await owner.query("select 1 from private.app_sessions where profile_id = $1", [invited.person.id]);
      expect(noted.rows).toEqual([]);
      // Ni sus tokens de renovación ni lo que Auth anotó de su verificación: una copia de su
      // cookie ya no tiene con qué renovarse.
      const leftovers = await owner.query(
        "select 1 from auth.refresh_tokens where session_id = $1 union all select 1 from auth.mfa_amr_claims where session_id = $1",
        [token.sessionId],
      );
      expect(leftovers.rows).toEqual([]);
      await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [token.json]);
      expect(await passes(owner, "private.has_capability('support')")).toBe(false);
      await asOwner(owner);

      // Entra de nuevo y da su código, con Auth de verdad: esa sesión nace después de atar.
      const again = authVisitor();
      const entering = await again.auth.signInWithPassword({ email: invited.person.email, password: invited.person.password });
      if (entering.error) throw new Error(`La persona aceptada no entró de nuevo: ${entering.error.code}`);
      const coded = await again.auth.mfa.challengeAndVerify({ factorId: factor, code: totpCode(secret) });
      if (coded.error) throw new Error(`El código de la persona aceptada no pasó: ${coded.error.code}`);
      const fresh = await tokenOf(again);
      expect(fresh.sessionId).not.toBe(token.sessionId);
      await owner.query("insert into private.app_sessions (session_id, profile_id) values ($1, $2)", [fresh.sessionId, invited.person.id]);

      // Y ahora sí pasa la puerta, por los dos caminos, con lo que recibió y nada más.
      await asServer(owner, invited.person.id, fresh.sessionId);
      expect(await passes(owner, "private.actor_has_capability('support')")).toBe(true);
      expect(await passes(owner, "private.actor_has_capability('config')")).toBe(false);
      await asOwner(owner);
      await owner.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [fresh.json]);
      expect(await passes(owner, "private.has_capability('support')")).toBe(true);
      expect(await passes(owner, "private.has_capability('config')")).toBe(false);
    });

    // Nada de eso quedó: la transacción se revirtió.
    expect(
      await ownerQuery<{ n: number }>("select count(*)::int as n from private.admin_invitations where email = $1", [
        invited.person.email.toLowerCase(),
      ]),
    ).toEqual([{ n: 0 }]);
  });

  it("el factor que la cuenta invitada ya tenía desaparece al probar su buzón; el de una cuenta sin invitación, no", async () => {
    const invited = await entered();
    const planted = await verifiedFactor(invited.client, "el que ya tenía");
    const invitedToken = await tokenOf(invited.client);
    const other = await entered();
    const kept = await verifiedFactor(other.client, "el suyo");
    const otherToken = await tokenOf(other.client);

    await reverted(async (owner) => {
      await asSystem(owner);
      expect(await answer(owner, "private.system_invite_admin($1, '{support}')", [invited.person.email])).toBe("invited_existing");
      await asServer(owner, invited.person.id, invitedToken.sessionId);
      expect(await answer(owner, "private.claim_account($1)", [print("uno")])).toBe("already_claimed");
      await asServer(owner, other.person.id, otherToken.sessionId);
      expect(await answer(owner, "private.claim_account($1)", [print("dos")])).toBe("already_claimed");

      await asOwner(owner);
      const factors = await owner.query<{ id: string }>("select id::text as id from auth.mfa_factors where user_id = any($1::uuid[])", [
        [invited.person.id, other.person.id],
      ]);
      expect(factors.rows).toEqual([{ id: kept }]);
      const sessions = await owner.query<{ aal: string; factor: string | null }>(
        "select aal::text as aal, factor_id::text as factor from auth.sessions where user_id = $1",
        [invited.person.id],
      );
      // Lo que Auth dejó en segundo nivel con ese factor queda como lo deja Auth al quitarlo.
      expect(sessions.rows).toEqual([{ aal: "aal1", factor: null }]);
      const claims = await owner.query("select 1 from auth.mfa_amr_claims where session_id = $1 and authentication_method = 'totp'", [
        invitedToken.sessionId,
      ]);
      expect(claims.rowCount).toBe(0);
    });

    // Revertido: en Auth todo sigue como estaba.
    expect(await sessionsOf(invited.person.id)).toEqual([{ aal: "aal2", factor: planted }]);
  });
});

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
 * Corre `held` en una transacción y, sin terminarla, `waiting` en otra. Dice si la segunda
 * se quedó esperando un candado, y qué contestó cuando la primera se revirtió. Solo la
 * segunda toma el rol del servidor.
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
    // La segunda no sale hasta que la primera ya hizo lo suyo y tiene sus candados. Si la
    // primera falla, se sabe aquí y no se espera para siempre.
    await Promise.race([isHolding, first]);
    const running = waiting(second);
    const waited = await waitsOnALock(me?.pid ?? 0);
    release();
    await first;
    return { waited, answered: await running };
  });
}

describe("los cambios al equipo van uno tras otro", () => {
  const holdTheTeam = async (owner: Client) => {
    await asSystem(owner);
    await answer(owner, "private.system_invite_admin($1, '{support}')", [`${randomUUID()}@candado.test`]);
  };
  const stranger = randomUUID();
  const calls: [string, string][] = [
    ["invitar", "private.invite_admin('x@candado.test', '{support}')"],
    ["revocar una invitación", `private.revoke_admin_invitation('${randomUUID()}')`],
    ["dar una capacidad", `private.grant_capability('${randomUUID()}', 'support')`],
    ["quitar una capacidad", `private.revoke_capability('${randomUUID()}', 'support')`],
    ["restablecer", `private.reset_second_factor('${randomUUID()}', '${print("c")}', '0.0')`],
  ];

  it.each(calls)("%s espera a que termine el cambio que va delante", async (_name, call) => {
    const result = await secondWaits(holdTheTeam, async (second) => {
      await asServer(second, stranger, randomUUID());
      return answer(second, call);
    });
    expect(result).toEqual({ waited: true, answered: "forbidden" });
  });

  it("el arranque y la emergencia también", async () => {
    const invite = await secondWaits(holdTheTeam, async (second) => {
      await asSystem(second);
      return answer(second, "private.system_invite_admin('', '{support}')");
    });
    expect(invite).toEqual({ waited: true, answered: "invalid" });
    const reset = await secondWaits(holdTheTeam, async (second) => {
      await asSystem(second);
      return answer(second, "private.system_reset_second_factor($1, 'x', null)", [randomUUID()]);
    });
    expect(reset).toEqual({ waited: true, answered: "invalid" });
  });

  it("aceptar también, cuando hay una invitación que aceptar; y quien no tiene ninguna no espera a nadie", async () => {
    const { person, client } = await entered();
    const token = await tokenOf(client);
    const withInvitation = await secondWaits(
      holdTheTeam,
      async (second) => {
        await asServer(second, person.id, token.sessionId);
        return answer(second, "private.accept_admin_invitation($1, $2)", [print("r"), randomUUID()]);
      },
      async (second) => {
        // Puesta a mano, sin la función: así no toma el candado que se va a esperar.
        await asSystem(second);
        await second.query(
          "insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at) values ('grant', $1, '{support}', now(), now() + interval '1 day')",
          [person.email.toLowerCase()],
        );
      },
    );
    expect(withInvitation).toEqual({ waited: true, answered: "needs_mailbox_proof" });

    const without = await secondWaits(holdTheTeam, async (second) => {
      await asServer(second, person.id, token.sessionId);
      return answer(second, "private.accept_admin_invitation($1, $2)", [print("r"), randomUUID()]);
    });
    expect(without).toEqual({ waited: false, answered: "no_invitation" });
  });

  it("invitar a una cuenta y que esa cuenta reclame esperan el mismo candado: la invitación queda fechada antes o después", async () => {
    const { person, client } = await entered();
    const token = await tokenOf(client);
    const claim = await secondWaits(
      async (owner) => {
        await asSystem(owner);
        expect(await answer(owner, "private.system_invite_admin($1, '{support}')", [person.email])).toBe("invited_existing");
      },
      async (second) => {
        await asServer(second, person.id, token.sessionId);
        return answer(second, "private.claim_account($1)", [print("t")]);
      },
    );
    expect(claim).toEqual({ waited: true, answered: "already_claimed" });
  });

  it("al revés: una invitación que empezó antes de un reclamo y lo esperó queda fechada después de él", async () => {
    const { person, client } = await entered();
    const token = await tokenOf(client);
    await reverted(async (claiming) => {
      // El reclamo ya tiene el candado del perfil, pero todavía no toma su hora.
      await asOwner(claiming);
      await claiming.query("select 1 from public.profiles where id = $1 for no key update", [person.id]);

      await reverted(async (inviting) => {
        await asSystem(inviting);
        const [me] = (await inviting.query<{ pid: number }>("select pg_backend_pid() as pid")).rows;
        // La invitación empieza ahora: toma una primera hora, busca la cuenta y espera.
        const running = answer(inviting, "private.system_invite_admin($1, '{support}')", [person.email]);
        expect(await waitsOnALock(me?.pid ?? 0)).toBe(true);

        await asServer(claiming, person.id, token.sessionId);
        expect(await answer(claiming, "private.claim_account($1)", [print("t")])).toBe("already_claimed");
        await asOwner(claiming);
        const claimed = await claiming.query<{ at: string }>(
          "select mailbox_proven_at::text as at from private.account_security where profile_id = $1",
          [person.id],
        );
        await claiming.query("rollback");

        expect(await running).toBe("invited_existing");
        const dated = await inviting.query<{ later: boolean }>(
          "select created_at > $2::timestamptz as later from private.admin_invitations where email = $1",
          [person.email.toLowerCase(), claimed.rows[0]?.at],
        );
        // Con la hora de cuando empezó a esperar, ese reclamo contaría como prueba posterior.
        expect(dated.rows).toEqual([{ later: true }]);
      }, false);
    });
  });

  describe("y las que tocan a una persona esperan además el candado de su perfil", () => {
    const lockProfile = (id: string) => async (owner: Client) => {
      await asOwner(owner);
      await owner.query("select 1 from public.profiles where id = $1 for no key update", [id]);
    };
    const cases: [string, (id: string) => string, string][] = [
      ["dar una capacidad", (id) => `private.grant_capability('${id}', 'support')`, "not_member"],
      ["quitar una capacidad", (id) => `private.revoke_capability('${id}', 'support')`, "not_found"],
      ["restablecer", (id) => `private.reset_second_factor('${id}', '${print("c")}', '0.0')`, "not_member"],
    ];

    it.each(cases)("%s", async (_name, call, expected) => {
      const admin = await entered();
      const factor = await verifiedFactor(admin.client, "el de quien cambia el equipo");
      const token = await tokenOf(admin.client);
      const target = await claimedUser();
      emails.push(target.email);
      const result = await secondWaits(
        lockProfile(target.id),
        async (second) => {
          await asServer(second, admin.person.id, token.sessionId);
          return answer(second, call(target.id));
        },
        (second) => asTeamMember(second, admin.person, factor, token.sessionId),
      );
      expect(result).toEqual({ waited: true, answered: expected });
    });

    it("aceptar, el de quien acepta", async () => {
      const { person, client } = await entered();
      const token = await tokenOf(client);
      const result = await secondWaits(
        lockProfile(person.id),
        async (second) => {
          await asServer(second, person.id, token.sessionId);
          return answer(second, "private.accept_admin_invitation($1, $2)", [print("r"), randomUUID()]);
        },
        async (second) => {
          await asSystem(second);
          await second.query(
            "insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at) values ('grant', $1, '{support}', now(), now() + interval '1 day')",
            [person.email.toLowerCase()],
          );
        },
      );
      expect(result).toEqual({ waited: true, answered: "needs_mailbox_proof" });
    });
  });

  it("y con una foto fija de la base el candado del equipo se niega, y con él todas las que lo toman", async () => {
    const owner = new Client({ connectionString: localOwnerUrl() });
    await owner.connect();
    try {
      await owner.query("begin isolation level repeatable read");
      await asSystem(owner);
      await expect(owner.query("select private.system_invite_admin('x@candado.test', '{support}')")).rejects.toMatchObject({
        code: "25000",
      });
    } finally {
      await owner.query("rollback").catch(() => undefined);
      await owner.end();
    }
  });
});
