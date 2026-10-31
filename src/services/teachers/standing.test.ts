import { describe, expect, it, vi } from "vitest";

import type { CookieJar, CookieReader } from "@/adapters/supabase/auth-cookies";
import type { VerifiedClaims } from "@/adapters/supabase/claims";
import type { SessionCheck } from "@/services/account/admission";
import type { FailureCode } from "@/services/error-reporting/server";

import { createTeachers, type AcceptAnswer, type TeacherStanding, type TeacherStore } from "./standing";

vi.mock("server-only", () => ({}));

// En qué estado está quien pide el portal del maestro, y aceptar su invitación o el aviso, con la base simulada.
// Contra la base de verdad, en tests/integration/73-portal.test.ts y 81-aceptar-invitacion.test.ts.

const claims = { userId: "a0000000-0000-4000-8000-000000000001" } as VerifiedClaims;
const reader = {} as CookieReader;
const jar = {} as CookieJar;
const TEACHER = "7e000000-0000-4000-8000-000000000001";
const TICKET = "a".repeat(64);
const origin = { realIp: null, userAgent: "navegador" };
const shown = { agreement: "c0000000-0000-4000-8000-000000000001", notice: "c0000000-0000-4000-8000-000000000002" };
const evidence = { address: null, userAgent: "navegador" };

interface Setup {
  session?: SessionCheck;
  standing?: () => Promise<TeacherStanding>;
  accept?: () => Promise<AcceptAnswer>;
  acceptNotice?: () => Promise<boolean>;
  ticket?: string | null;
}

function setup({ session = { kind: "pass", claims }, standing, accept, acceptNotice, ticket = TICKET }: Setup) {
  const reported: FailureCode[] = [];
  const store = {
    standing: vi.fn<TeacherStore["standing"]>(() => (standing ? standing() : Promise.resolve({ state: "none" }))),
    texts: vi.fn<TeacherStore["texts"]>(() => Promise.resolve({ agreement: null, notice: null })),
    accept: vi.fn<TeacherStore["accept"]>(() => (accept ? accept() : Promise.resolve("accepted"))),
    acceptNotice: vi.fn<TeacherStore["acceptNotice"]>(() => (acceptNotice ? acceptNotice() : Promise.resolve(true))),
  };
  const checkSession = vi.fn<(reader: CookieReader) => Promise<SessionCheck>>(() => Promise.resolve(session));
  const dropTicket = vi.fn<(jar: CookieJar) => void>();
  const service = createTeachers({
    store,
    checkSession,
    report: (code) => (reported.push(code), Promise.resolve()),
    readTicket: () => ticket,
    dropTicket,
    evidence: () => evidence,
    isLocal: () => false,
  });
  return { ...service, store, checkSession, dropTicket, reported };
}

const REFUSED: SessionCheck[] = [{ kind: "anonymous" }, { kind: "suspended" }, { kind: "must_sign_out", then: "sign_in" }, { kind: "unavailable" }];

describe("teacherStanding", () => {
  it("corre la guarda de sesión con esas cookies y le pregunta a la base con el resguardo de ese navegador", async () => {
    const service = setup({ standing: () => Promise.resolve({ state: "active", teacher: { id: TEACHER } }) });
    expect(await service.teacherStanding(reader)).toEqual({ kind: "teacher", claims, standing: { state: "active", teacher: { id: TEACHER } } });
    expect(service.checkSession).toHaveBeenCalledExactlyOnceWith(reader);
    expect(service.store.standing).toHaveBeenCalledExactlyOnceWith(claims, TICKET);
  });

  it.each(REFUSED)("lo que la guarda no deja pasar se contesta tal cual, sin preguntarle a la base: %j", async (session) => {
    const service = setup({ session });
    expect(await service.teacherStanding(reader)).toEqual(session);
    expect(service.store.standing).not.toHaveBeenCalled();
  });

  it("quien no es maestro lo dice la base", async () => {
    const service = setup({});
    expect(await service.teacherStanding(reader)).toEqual({ kind: "teacher", claims, standing: { state: "none" } });
  });

  it("si la base no contesta, «no se supo», que nunca es «no es maestro»; y se reporta", async () => {
    const service = setup({ standing: () => Promise.reject(new Error("se cayó")) });
    expect(await service.teacherStanding(reader)).toEqual({ kind: "unavailable" });
    expect(service.reported).toEqual(["teacher_unavailable"]);
  });
});

describe("teacherTexts", () => {
  it("lee los dos textos, con la regla de los borradores de este entorno", async () => {
    const service = setup({});
    expect(await service.teacherTexts(claims)).toEqual({ agreement: null, notice: null });
    expect(service.store.texts).toHaveBeenCalledExactlyOnceWith(claims, false);
  });

  it("si no se supo, nulo; y se reporta", async () => {
    const service = setup({});
    service.store.texts.mockRejectedValueOnce(new Error("se cayó"));
    expect(await service.teacherTexts(claims)).toBeNull();
    expect(service.reported).toEqual(["teacher_unavailable"]);
  });
});

describe("acceptTeacherInvitation", () => {
  it.each(REFUSED)("lo que la guarda no deja pasar no le pregunta nada a la base: %j", async (session) => {
    const service = setup({ session });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "refused", check: session });
    expect(service.store.accept).not.toHaveBeenCalled();
  });

  it("sin resguardo en este navegador no se le pregunta a la base", async () => {
    const service = setup({ ticket: null });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "answered", answer: "needs_mailbox_proof" });
    expect(service.store.accept).not.toHaveBeenCalled();
  });

  it("aceptada: con el resguardo, los textos que se vieron y de dónde viene; y el resguardo se gasta", async () => {
    const service = setup({});
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "accepted" });
    expect(service.store.accept).toHaveBeenCalledExactlyOnceWith(claims, TICKET, shown.agreement, shown.notice, evidence);
    expect(service.dropTicket).toHaveBeenCalledExactlyOnceWith(jar);
    expect(service.reported).toEqual([]);
  });

  it.each<AcceptAnswer>(["changed", "needs_mailbox_proof", "inviter_lost_content", "already_teacher", "ineligible"])(
    "%s se contesta tal cual, y el resguardo se queda",
    async (answer) => {
      const service = setup({ accept: () => Promise.resolve(answer) });
      expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "answered", answer });
      expect(service.dropTicket).not.toHaveBeenCalled();
      expect(service.reported).toEqual([]);
    },
  );

  it("sin textos vigentes: se contesta y se reporta, porque reintentar no lo arregla", async () => {
    const service = setup({ accept: () => Promise.resolve("unavailable") });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "answered", answer: "unavailable" });
    expect(service.reported).toEqual(["teacher_invitation_unavailable"]);
  });

  it("un doble envío contesta no_invitation: si ya es maestro, quedó aceptada", async () => {
    const service = setup({ accept: () => Promise.resolve("no_invitation"), standing: () => Promise.resolve({ state: "active", teacher: { id: TEACHER } }) });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "accepted" });
    expect(service.dropTicket).toHaveBeenCalledOnce();
    expect(service.reported).toEqual([]);
  });

  it("no_invitation de quien no es maestro: ya no sirve, sin reporte", async () => {
    const service = setup({ accept: () => Promise.resolve("no_invitation") });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "answered", answer: "no_invitation" });
    expect(service.reported).toEqual([]);
  });

  it("una respuesta perdida: si quedó como maestro se dice que quedó, y se reporta", async () => {
    const service = setup({ accept: () => Promise.reject(new Error("se cayó")), standing: () => Promise.resolve({ state: "needs_notice", teacher: { id: TEACHER } }) });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "accepted" });
    expect(service.reported).toEqual(["teacher_invitation_answer_lost"]);
  });

  it("una respuesta perdida sin poder saber: «no se supo», nunca como hecho", async () => {
    const service = setup({ accept: () => Promise.reject(new Error("se cayó")), standing: () => Promise.reject(new Error("se cayó")) });
    expect(await service.acceptTeacherInvitation(jar, shown, origin)).toEqual({ kind: "unknown" });
    expect(service.dropTicket).not.toHaveBeenCalled();
    expect(service.reported).toEqual(["teacher_invitation_answer_lost"]);
  });
});

describe("acceptTeacherNotice", () => {
  const needs = (): Promise<TeacherStanding> => Promise.resolve({ state: "needs_notice", teacher: { id: TEACHER } });

  it.each(REFUSED)("lo que la guarda no deja pasar no escribe: %j", async (session) => {
    const service = setup({ session });
    expect(await service.acceptTeacherNotice(jar, { notice: shown.notice }, origin)).toEqual({ kind: "refused", check: session });
    expect(service.store.acceptNotice).not.toHaveBeenCalled();
  });

  it("a un maestro al que le falta, lo anota con el texto que se vio", async () => {
    const service = setup({ standing: needs });
    expect(await service.acceptTeacherNotice(jar, { notice: shown.notice }, origin)).toEqual({ kind: "accepted" });
    expect(service.store.acceptNotice).toHaveBeenCalledExactlyOnceWith(claims, shown.notice, evidence, false);
  });

  it("si el texto cambió, se vuelve a mostrar", async () => {
    const service = setup({ standing: needs, acceptNotice: () => Promise.resolve(false) });
    expect(await service.acceptTeacherNotice(jar, { notice: shown.notice }, origin)).toEqual({ kind: "changed" });
  });

  it("a un maestro al que ya no le falta no le anota nada: quedó", async () => {
    const service = setup({ standing: () => Promise.resolve({ state: "active", teacher: { id: TEACHER } }) });
    expect(await service.acceptTeacherNotice(jar, { notice: shown.notice }, origin)).toEqual({ kind: "accepted" });
    expect(service.store.acceptNotice).not.toHaveBeenCalled();
  });

  it.each<TeacherStanding>([{ state: "none" }, { state: "invited", name: null }, { state: "suspended", teacher: { id: TEACHER }, notice: null }])(
    "a quien no le toca no le anota nada: %j",
    async (standing) => {
      const service = setup({ standing: () => Promise.resolve(standing) });
      expect(await service.acceptTeacherNotice(jar, { notice: shown.notice }, origin)).toEqual({ kind: "not_needed" });
      expect(service.store.acceptNotice).not.toHaveBeenCalled();
    },
  );

  it("si la base no contesta, «no se supo»; y se reporta", async () => {
    const service = setup({ standing: needs, acceptNotice: () => Promise.reject(new Error("se cayó")) });
    expect(await service.acceptTeacherNotice(jar, { notice: shown.notice }, origin)).toEqual({ kind: "unknown" });
    expect(service.reported).toEqual(["teacher_unavailable"]);
  });
});
