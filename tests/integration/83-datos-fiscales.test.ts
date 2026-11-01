import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createAuth } from "@/adapters/supabase/auth";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { Tx } from "@/adapters/supabase/db";
import { clabeCheckDigit } from "@/domain/fiscal/clabe";
import { acceptsPayee, TAX_REGIMES } from "@/domain/fiscal/regime";
import type { SessionCheck } from "@/services/account/admission";
import { createManagement } from "@/services/account/management";
import { readTeacherStanding } from "@/services/teachers/records";
import { createTaxCipher } from "@/services/teachers/tax-cipher";
import { createTaxProfile, type TaxStore } from "@/services/teachers/tax-profile";
import { askTaxForPayout, askTaxMine, askTaxSave, askTaxState } from "@/services/teachers/tax-records";

import { claimedUser, clearThrottle, freshOrigin, keysOf, pairOf, testServices } from "./helpers/account";
import { memoryJar, secondFactorFor } from "./helpers/auth";
import { connect, waitBehind } from "./helpers/finance";
import { asOwner, asServer, asSystem, reverted } from "./helpers/team";
import { completeAccountAsOwner, deleteTestUsersByEmail, ownerQuery } from "./helpers/users";

// PA-48 contra la base y el Auth locales (T-409). Dos partes. Comprobar la contraseña es de verdad contra Auth y el freno, que no escriben en nada
// auditado. Lo fiscal va en una transacción del dueño que se revierte, con las consultas de la aplicación, como el servidor y a nombre de la persona:
// la tabla no admite borrar, y una entrada de Auth en medio chocaría con los candados del perfil. Cada condición de la base se rompe en
// `63_datos_fiscales.test.sql`; aquí se prueba que el servicio las llama bien, y que lo que sale es lo que entró. El camino entero lo recorre
// `tests/e2e/equipo/datos-fiscales.equipo.ts`.

const emails: string[] = [];
afterAll(async () => {
  await deleteTestUsersByEmail(emails);
});

function keyEntry(raw: Buffer = randomBytes(32)): string {
  return `1:${raw.toString("base64")}:${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}
const cipher = (() => {
  const keys = keyEntry();
  return createTaxCipher(() => ({ keys, active: "1" }));
})();
const first17 = "01218000123456789";
const CLABE = `${first17}${clabeCheckDigit(first17)}`;
const LAST4 = CLABE.slice(-4);
const FORM = { rfc: "GODE561231GR8", regime: "626", legalName: "Elena Gómez Díaz", clabe: CLABE, seen: 0, password: "no-se-comprueba-aqui" };

/** @param beforeEntering Lo que tiene que pasar antes de abrir su sesión: dar de alta un factor cierra las que haya. */
async function person(beforeEntering?: (who: Awaited<ReturnType<typeof claimedUser>>) => Promise<void>) {
  await clearThrottle();
  const who = await claimedUser();
  emails.push(who.email);
  await completeAccountAsOwner(who.id);
  await beforeEntering?.(who);
  const jar = memoryJar();
  const entered = await testServices().signIn(jar, who, freshOrigin());
  if (entered.kind !== "entered") throw new Error(`La persona de prueba no entró: ${entered.kind}`);
  const check = await testServices().checkSession(jar);
  if (check.kind !== "pass") throw new Error(`La guarda no la dejó pasar: ${check.kind}`);
  return { id: who.id, who, jar, claims: check.claims };
}

const sessionsOf = async (id: string) => (await ownerQuery<{ count: string }>("select count(*) from auth.sessions where user_id = $1", [id]))[0]?.count;

describe("comprobar la contraseña en el mismo envío", () => {
  it("con la suya contesta que sí, con las claims de la sesión que pide, y la de la comprobación no se queda abierta", async () => {
    const ana = await person();
    const before = await sessionsOf(ana.id);
    const answer = await testServices().confirmPassword(ana.jar, ana.who.password, freshOrigin());
    expect(answer).toEqual({ kind: "confirmed", claims: ana.claims });
    expect(await sessionsOf(ana.id)).toBe(before);
    expect((await testServices().checkSession(ana.jar)).kind).toBe("pass");
  });

  it("con otra contesta que no, y la sesión del navegador sigue", async () => {
    const ana = await person();
    const services = testServices();
    expect(await services.confirmPassword(ana.jar, "no-es-la-suya", freshOrigin())).toEqual({ kind: "wrong" });
    expect(services.reported).toEqual([]);
    expect((await services.checkSession(ana.jar)).kind).toBe("pass");
  });

  it("cuenta en el mismo freno que entrar", async () => {
    const ana = await person();
    const services = testServices();
    const origin = freshOrigin();
    const answers: string[] = [];
    for (let i = 0; i < 12; i += 1) answers.push((await services.confirmPassword(ana.jar, "no-es-la-suya", origin)).kind);
    expect(answers).toContain("throttled");
    // Ya frenado, tampoco la correcta pasa: no se le pregunta a Auth.
    expect((await services.confirmPassword(ana.jar, ana.who.password, origin)).kind).toBe("throttled");
    await clearThrottle();
  });

  it("una contraseña desmedida no llega a Auth ni cuenta", async () => {
    const ana = await person();
    const origin = freshOrigin();
    expect(await testServices().confirmPassword(ana.jar, "x".repeat(200), origin)).toEqual({ kind: "wrong" });
    expect(await pairOf(keysOf(ana.who.email, origin))).toBeNull();
  });

  it("una cuenta con segundo factor también se comprueba, y se queda con el que tenía", async () => {
    let factorId = "";
    const ana = await person(async (who) => {
      factorId = (await secondFactorFor(who)).factorId;
    });
    const before = await sessionsOf(ana.id);
    expect(await testServices().confirmPassword(ana.jar, ana.who.password, freshOrigin())).toEqual({ kind: "confirmed", claims: ana.claims });
    expect(await sessionsOf(ana.id)).toBe(before);
    const factors = await ownerQuery<{ count: string }>("select count(*) from auth.mfa_factors where id = $1 and status = 'verified'", [factorId]);
    expect(factors[0]?.count).toBe("1");
  });

  // La contraseña era la suya, y la cuenta dejó de pasar a media operación: la entrada no se admite.
  function staleManagement(checks: SessionCheck[]) {
    const reported: string[] = [];
    const management = createManagement(
      {
        auth: createAuth(),
        proxyTrusted: () => true,
        isLocal: () => true,
        report: (code: string) => {
          reported.push(code);
          return Promise.resolve();
        },
      } as never,
      {
        checkSession: () => Promise.resolve(checks.shift() as SessionCheck),
        openAttempt: () => Promise.resolve({ decision: { proceed: true }, startedText: "2026-10-31T00:00:00Z" } as never),
        admit: () => Promise.resolve({ admit: false, report: null, outcome: "success", result: { kind: "suspended" } } as never),
        settleAttempt: () => Promise.resolve(),
      },
    );
    return { management, reported };
  }

  it("si la cuenta dejó de pasar a media operación, contesta lo que la guarda dice ahora, y cierra la comprobación", async () => {
    const ana = await person();
    const before = await sessionsOf(ana.id);
    const pass = { kind: "pass", claims: ana.claims } as SessionCheck;
    const now: SessionCheck = { kind: "unavailable" };
    const { management } = staleManagement([pass, now]);
    expect(await management.confirmPassword(ana.jar, ana.who.password, freshOrigin())).toEqual({ kind: "session", check: now });
    expect(await sessionsOf(ana.id)).toBe(before);
  });

  it("si la guarda insiste en que pasa, es «no se supo», y no un sí", async () => {
    const ana = await person();
    const pass = { kind: "pass", claims: ana.claims } as SessionCheck;
    const { management } = staleManagement([pass, pass]);
    expect(await management.confirmPassword(ana.jar, ana.who.password, freshOrigin())).toEqual({ kind: "unavailable" });
  });

  it("sin sesión contesta lo que dice la guarda", async () => {
    const answer = await testServices().confirmPassword(memoryJar(), "lo-que-sea", freshOrigin());
    expect(answer.kind).toBe("session");
  });
});

const txOn = (owner: Client): Tx => ({
  query: async (query, row) => (await owner.query(query.text, [...query.values])).rows.map((each) => row.parse(each)),
  execute: async (query) => (await owner.query(query.text, [...query.values])).rowCount ?? 0,
});

/** Como el servidor, a nombre de esa persona y con su sesión. Lo que `asServer` del adaptador haría. */
async function asPersonServer<T>(owner: Client, claims: VerifiedClaims, work: (tx: Tx) => Promise<T>): Promise<T> {
  await asServer(owner, claims.userId, claims.sessionId ?? randomUUID());
  try {
    return await work(txOn(owner));
  } finally {
    await asOwner(owner);
  }
}

function serviceOn(owner: Client, reported: string[] = []) {
  const store: TaxStore = {
    state: (claims) => asPersonServer(owner, claims, askTaxState),
    mine: (claims) => asPersonServer(owner, claims, askTaxMine),
    save: (claims, row) => asPersonServer(owner, claims, (tx) => askTaxSave(tx, row)),
    forPayout: (claims, payout) => asPersonServer(owner, claims, (tx) => askTaxForPayout(tx, payout)),
  };
  return (who: { claims: VerifiedClaims }) =>
    createTaxProfile({
      store,
      cipher,
      // La contraseña ya se probó arriba.
      confirmPassword: () => Promise.resolve({ kind: "confirmed", claims: who.claims }),
      standing: (claims) => asPersonServer(owner, claims, (tx) => readTeacherStanding(tx, null)),
      checkSession: () => Promise.resolve({ kind: "pass", claims: who.claims } as never),
      report: (code) => {
        reported.push(code);
        return Promise.resolve();
      },
    });
}

async function teacher(owner: Client, who: { id: string }, status: "active" | "suspended" = "active"): Promise<string> {
  await asSystem(owner);
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
     values ($1, $2::public.teacher_status, case when $3 then now() end, case when $3 then 'prueba' end) returning id`,
    [who.id, status, status === "suspended"],
  );
  // Con el aviso del maestro aceptado: sin él, la base no lo deja escribir.
  await owner.query("select set_config('app.actor_id', $1, true)", [who.id]);
  await owner.query("insert into public.consents (profile_id, legal_document_id, origin) values ($1, private.current_legal_document('teacher_privacy_notice'), 'account_settings')", [who.id]);
  await asOwner(owner);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("No se creó el maestro.");
  return id;
}

const reads = async (owner: Client, teacherId: string) =>
  (await owner.query<{ count: string }>("select count(*) from public.audit_log where action = 'tax_profile.read' and new_value ->> 'teacher_id' = $1", [teacherId])).rows[0]?.count;

const jar = memoryJar();

describe("guardar mientras se confirma un fraude, de verdad", () => {
  it("guardar espera a la confirmación, y como ya es fraude, contesta que no", async () => {
    const ana = await person();
    const seal = (length: number) => Buffer.from(`010001${"ab".repeat(12 + length + 16)}`, "hex");
    const owner = await connect();
    const confirmer = await connect();
    const saver = await connect();
    let id = "";
    try {
      await owner.query("grant app_service to postgres with set true, inherit false");
      await owner.query("begin");
      await owner.query("select set_config('app.actor_kind', 'system', true)");
      id = (await owner.query<{ id: string }>("insert into public.teachers (profile_id, status, suspended_at, suspension_reason) values ($1, 'suspended', now(), 'prueba') returning id::text", [ana.id])).rows[0]!.id;
      await owner.query("commit");

      await confirmer.query("begin");
      await confirmer.query("select set_config('app.actor_kind', 'system', true)");
      await confirmer.query("update public.teachers set suspension_approved_by = $2 where id = $1", [id, ana.id]);
      await saver.query("begin");
      await asServer(saver, ana.id, ana.claims.sessionId ?? randomUUID());
      const waiting = saver.query<{ answer: string }>(
        "select private.tax_profile_save($1, 0, $2, $3, '612', 'person', $4, '7771', 1) as answer",
        [id, seal(13), seal(20), seal(18)],
      );
      await waitBehind(owner, confirmer, 1);
      await confirmer.query("commit");
      expect((await waiting).rows[0]?.answer).toBe("suspended");
      await saver.query("rollback");
    } finally {
      await confirmer.query("rollback").catch(() => undefined);
      await saver.query("rollback").catch(() => undefined);
      await owner.query("begin");
      await owner.query("set local session_replication_role = replica");
      if (id !== "") await owner.query("delete from public.teachers where id = $1", [id]);
      await owner.query("commit");
      await owner.query("revoke app_service from postgres");
      await Promise.all([owner.end(), confirmer.end(), saver.end()]);
    }
  });
});

describe("el catálogo de regímenes", () => {
  it("la base y la aplicación aceptan lo mismo, clave por clave y por tipo de persona", async () => {
    await reverted(async (owner) => {
      const ask = async (regime: string, payee: string) =>
        (await owner.query<{ ok: boolean }>("select private.tax_regime_ok($1, $2) as ok", [regime, payee])).rows[0]?.ok;
      for (const { code } of TAX_REGIMES) {
        expect(await ask(code, "person"), `${code}, persona física`).toBe(acceptsPayee(code, "person"));
        expect(await ask(code, "company"), `${code}, persona moral`).toBe(acceptsPayee(code, "company"));
      }
      expect(await ask("999", "person")).toBe(false);
    }, false);
  });
});

describe("lo fiscal, contra la base", () => {
  it("guarda cifrado: en la base no queda nada en claro, y abre con lo que dice la fila", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner)(ana);
      expect(await service.taxProfileState(ana.claims)).toEqual({ version: 0, updatedAt: null, canSave: true });
      expect(await service.saveTaxProfile(jar, FORM, freshOrigin())).toEqual({ kind: "saved" });

      const { rows } = await owner.query<{ version: number; rfc: Buffer; legal: Buffer; clabe: Buffer; last4: string; regime: string; payee: string; key_version: number; created_by: string }>(
        `select version, rfc_enc as rfc, legal_name_enc as legal, clabe_enc as clabe, clabe_last4 as last4, tax_regime_code as regime, payee_kind as payee, key_version, created_by::text as created_by
         from private.teacher_tax_profiles where teacher_id = $1`,
        [id],
      );
      const row = rows[0];
      expect(row).toMatchObject({ version: 1, last4: LAST4, regime: "626", payee: "person", key_version: 1, created_by: ana.id });
      for (const cell of [row?.rfc, row?.legal, row?.clabe]) {
        const text = Buffer.from(cell ?? []).toString("latin1");
        for (const plain of [FORM.rfc, "Elena", CLABE]) expect(text).not.toContain(plain);
      }
      const state = await service.taxProfileState(ana.claims);
      expect(state?.version).toBe(1);
      expect(state?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  it("ver muestra lo oculto en parte, y cada lectura queda en la auditoría", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner)(ana);
      await service.saveTaxProfile(jar, FORM, freshOrigin());
      expect(await reads(owner, id)).toBe("0");
      expect(await service.revealTaxProfile(jar, "x", freshOrigin())).toMatchObject({
        kind: "revealed",
        data: { rfc: "•••• 1GR8", legalName: "•••• Díaz", regime: "626", clabe: `•••• ${LAST4}` },
      });
      expect(await reads(owner, id)).toBe("1");
    });
  });

  it("guardar no se cuenta como una lectura, ni preguntar si los hay", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner)(ana);
      await service.saveTaxProfile(jar, FORM, freshOrigin());
      await service.taxProfileState(ana.claims);
      expect(await reads(owner, id)).toBe("0");
    });
  });

  it("una pestaña vieja no pisa lo de otra, y la versión nueva abre con su propia versión", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const service = serviceOn(owner)(ana);
      await service.saveTaxProfile(jar, FORM, freshOrigin());
      expect(await service.saveTaxProfile(jar, FORM, freshOrigin())).toEqual({ kind: "changed" });
      expect(await service.saveTaxProfile(jar, { ...FORM, regime: "612", seen: 1 }, freshOrigin())).toEqual({ kind: "saved" });
      expect(await service.revealTaxProfile(jar, "x", freshOrigin())).toMatchObject({ kind: "revealed", data: { regime: "612" } });
    });
  });

  it("sin datos lo dice, y no deja lectura", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      expect(await serviceOn(owner)(ana).revealTaxProfile(jar, "x", freshOrigin())).toEqual({ kind: "no_profile" });
      expect(await reads(owner, id)).toBe("0");
    });
  });

  it("un maestro suspendido sin fraude los cambia, y por fraude no, aunque los siga viendo (FL-31, A2)", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const id = await teacher(owner, ana);
      const service = serviceOn(owner)(ana);
      await service.saveTaxProfile(jar, FORM, freshOrigin());
      await asSystem(owner);
      await owner.query("update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = $1", [id]);
      await asOwner(owner);
      expect((await service.taxProfileState(ana.claims))?.canSave).toBe(true);
      expect(await service.saveTaxProfile(jar, { ...FORM, seen: 1 }, freshOrigin())).toEqual({ kind: "saved" });
      await asSystem(owner);
      await owner.query("update public.teachers set suspension_approved_by = $2 where id = $1", [id, ana.id]);
      await asOwner(owner);
      expect((await service.taxProfileState(ana.claims))?.canSave).toBe(false);
      expect(await service.saveTaxProfile(jar, { ...FORM, seen: 2 }, freshOrigin())).toEqual({ kind: "suspended" });
      expect(await service.revealTaxProfile(jar, "x", freshOrigin())).toMatchObject({ kind: "revealed" });
    });
  });

  it("quien no es maestro no guarda ni lee", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      const service = serviceOn(owner)(ana);
      expect(await service.taxProfileState(ana.claims)).toBeNull();
      expect(await service.saveTaxProfile(jar, FORM, freshOrigin())).toEqual({ kind: "not_teacher" });
      expect(await service.revealTaxProfile(jar, "x", freshOrigin())).toEqual({ kind: "not_teacher" });
    });
  });

  it("la base no guarda a nombre de otro maestro, aunque se lo pidan", async () => {
    const ana = await person();
    const luis = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const other = await teacher(owner, luis);
      const at = { teacher: other, rowVersion: 1 };
      const answer = await asPersonServer(owner, ana.claims, (tx) =>
        askTaxSave(tx, {
          teacher: other,
          seen: 0,
          regime: "626",
          payee: "person",
          last4: LAST4,
          keyVersion: 1,
          rfc: cipher.seal({ ...at, field: "rfc" }, FORM.rfc),
          legalName: cipher.seal({ ...at, field: "legal_name" }, FORM.legalName),
          clabe: cipher.seal({ ...at, field: "clabe", last4: LAST4 }, CLABE),
        }),
      );
      expect(answer).toBe("changed");
    });
  });

  it("finanzas: un maestro no lee por una liquidación", async () => {
    const ana = await person();
    await reverted(async (owner) => {
      await teacher(owner, ana);
      const service = serviceOn(owner)(ana);
      expect(await service.taxProfileForPayout(jar, "x")).toEqual({ kind: "not_found" });
      expect(await service.taxProfileForPayout(jar, "d0000000-0000-4000-8000-000000000003")).toEqual({ kind: "forbidden" });
    });
  });
});
