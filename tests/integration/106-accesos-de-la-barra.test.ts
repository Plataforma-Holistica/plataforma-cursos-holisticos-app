import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { navAccess } from "@/services/account/nav";
import { createNavAccess, type NavAccess } from "@/services/account/nav-access";
import { readNavStates } from "@/services/account/team-records";

import { claimedUser, freshOrigin, testServices } from "./helpers/account";
import { memoryJar } from "./helpers/auth";
import { answer, asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail } from "./helpers/users";

// Los accesos de la barra del alumno (T-616, solicitud 2) contra la base local: la misma lectura que la aplicación
// (`readNavStates`, como el servidor a nombre de la persona y con su sesión) y la misma regla (`navAccessOf`, por
// `createNavAccess`). Lo que es de maestro y del equipo se pone en una transacción del dueño que se revierte.
// El equipo con el código y el que solo le falta darlo (`member` y `needs_code`) piden un factor de Auth de
// verdad: los prueba el camino del equipo de extremo a extremo.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

type Person = { id: string; email: string; claims: VerifiedClaims };

async function person(): Promise<Person> {
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  const jar = memoryJar();
  const result = await testServices().signIn(jar, who, freshOrigin());
  if (result.kind !== "entered") throw new Error(`La persona de prueba no entró: ${result.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, email: who.email, claims: check.claims };
}

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

/** Lo que la barra le mostraría, leído como el servidor a nombre de esa persona. */
async function accessOf(owner: Client, who: Person): Promise<NavAccess> {
  const reported: string[] = [];
  const navAccess = createNavAccess({
    read: async (claims) => {
      await asServer(owner, claims.userId, claims.sessionId ?? randomUUID());
      try {
        return await readNavStates(txOn(owner));
      } finally {
        await asOwner(owner);
      }
    },
    report: (code) => (reported.push(code), Promise.resolve()),
  });
  const access = await navAccess(who.claims);
  expect(reported).toEqual([]);
  return access;
}

/** Un maestro atado a esa cuenta, como el dueño declarado sistema; con el aviso del maestro aceptado si `notice`. */
async function teacher(owner: Client, who: Person, status: "active" | "suspended", notice = true): Promise<void> {
  await asSystem(owner);
  await owner.query(
    `insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
     values ($1, $2::public.teacher_status, case when $3 then now() end, case when $3 then 'prueba' end)`,
    [who.id, status, status === "suspended"],
  );
  if (notice) {
    await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
    await owner.query(
      "insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')",
      [who.id],
    );
  }
  await asOwner(owner);
}

async function capability(owner: Client, who: Person): Promise<void> {
  await asSystem(owner);
  await owner.query("insert into public.admin_capabilities (profile_id, capability) values ($1, 'content')", [who.id]);
  await asOwner(owner);
}

describe("los accesos de la barra, contra la base", () => {
  it("un alumno no ve ninguno", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      expect(await accessOf(owner, ana)).toEqual({ admin: false, portal: false });
    });
  });

  it("el maestro activo, el suspendido y al que le falta el aviso ven «Mi portal»", async () => {
    const [activa, suspendida, sinAviso] = await Promise.all([person(), person(), person()]);
    await reverted(async (owner) => {
      await teacher(owner, activa, "active");
      await teacher(owner, suspendida, "suspended");
      await teacher(owner, sinAviso, "active", false);
      expect(await accessOf(owner, activa)).toEqual({ admin: false, portal: true });
      expect(await accessOf(owner, suspendida)).toEqual({ admin: false, portal: true });
      expect(await accessOf(owner, sinAviso)).toEqual({ admin: false, portal: true });
    });
  });

  it("una invitación de maestro no lo ve: su camino es el correo", async () => {
    const nora = await person();
    await reverted(async (owner) => {
      await asSystem(owner);
      const added = await answer(owner, "private.system_add_teacher($1, $2, null)::text", ["Maestra Invitada", `m-${randomUUID()}`]);
      expect(await answer(owner, "private.system_invite_teacher($1, $2)", [added, nora.email])).toBe("invited_existing");
      await asOwner(owner);
      expect(await accessOf(owner, nora)).toEqual({ admin: false, portal: false });
    });
  });

  it("del equipo con el factor sin atar ve «Administración» (PA-12 le explica qué pasó)", async () => {
    const eva = await person();
    await reverted(async (owner) => {
      await capability(owner, eva);
      expect(await accessOf(owner, eva)).toEqual({ admin: true, portal: false });
    });
  });

  it("del equipo con una invitación de restablecimiento no lo ve: llega por su correo", async () => {
    const rosa = await person();
    await reverted(async (owner) => {
      await capability(owner, rosa);
      // Conserva su capacidad y perdió su atadura; un restablecimiento no da capacidades.
      await asSystem(owner);
      await owner.query(
        `insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
         values ('rebind', $1, $2, '{}', $3, clock_timestamp(), clock_timestamp() + interval '1 day')`,
        [rosa.email.toLowerCase(), rosa.id, "a".repeat(64)],
      );
      await asOwner(owner);
      expect(await accessOf(owner, rosa)).toEqual({ admin: false, portal: false });
    });
  });

  it("la misma persona del equipo ve «Administración» sin factor atado, y deja de verla al recibir el restablecimiento", async () => {
    const mia = await person();
    await reverted(async (owner) => {
      await capability(owner, mia);
      // Antes: capacidad y sin factor, `unbound`.
      expect(await accessOf(owner, mia)).toEqual({ admin: true, portal: false });
      await asSystem(owner);
      await owner.query(
        `insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
         values ('rebind', $1, $2, '{}', $3, clock_timestamp(), clock_timestamp() + interval '1 day')`,
        [mia.email.toLowerCase(), mia.id, "b".repeat(64)],
      );
      await asOwner(owner);
      // Después: su camino es el correo.
      expect(await accessOf(owner, mia)).toEqual({ admin: false, portal: false });
    });
  });

  it("una invitación al equipo para quien no es del equipo no lo ve", async () => {
    const lia = await person();
    await reverted(async (owner) => {
      await asSystem(owner);
      await owner.query(
        "insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at) values ('grant', $1, '{support}', clock_timestamp(), clock_timestamp() + interval '1 day')",
        [lia.email.toLowerCase()],
      );
      await asOwner(owner);
      expect(await accessOf(owner, lia)).toEqual({ admin: false, portal: false });
    });
  });

  it("del equipo, al revocarle su capacidad deja de ver «Administración»", async () => {
    const ivo = await person();
    await reverted(async (owner) => {
      await capability(owner, ivo);
      expect(await accessOf(owner, ivo)).toEqual({ admin: true, portal: false });
      await asSystem(owner);
      await owner.query("select set_config('app.actor_id', $1, true)", [ivo.id]);
      await owner.query("update public.admin_capabilities set revoked_at = now(), revoked_by = $1 where profile_id = $1", [ivo.id]);
      await asOwner(owner);
      expect(await accessOf(owner, ivo)).toEqual({ admin: false, portal: false });
    });
  });

  it("el maestro que se va deja de ver «Mi portal»", async () => {
    const teo = await person();
    await reverted(async (owner) => {
      await teacher(owner, teo, "active");
      expect(await accessOf(owner, teo)).toEqual({ admin: false, portal: true });
      await asSystem(owner);
      await owner.query("update public.teachers set status = 'left', left_at = now() where profile_id = $1", [teo.id]);
      await asOwner(owner);
      expect(await accessOf(owner, teo)).toEqual({ admin: false, portal: false });
    });
  });

  it("el `navAccess` de la aplicación, como `app_service` y en su propia transacción, lee las dos mitades sin reportar nada", async () => {
    // Lo que una prueba con la conexión del dueño no ve: los permisos del rol del servidor sobre las dos funciones y
    // las tablas que leen. Si faltara uno, la mitad quedaría nula y se reportaría `nav_access_unavailable`.
    const noe = await person();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await navAccess(noe.claims)).toEqual({ admin: false, portal: false });
      expect(errors.mock.calls.flat().join(" ")).not.toContain("nav_access_unavailable");
    } finally {
      errors.mockRestore();
    }
  });

  it("quien es las dos cosas ve los dos", async () => {
    const sol = await person();
    await reverted(async (owner) => {
      await teacher(owner, sol, "active");
      await capability(owner, sol);
      expect(await accessOf(owner, sol)).toEqual({ admin: true, portal: true });
    });
  });
});
