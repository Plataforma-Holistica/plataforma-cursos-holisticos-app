import "server-only";

import type { VerifiedClaims } from "@/adapters/supabase/claims";
import { asServer, type Tx } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";
import { withLockRetry } from "@/services/account/team";

import {
  DECIDE_ANSWERS,
  FOUNDER_ANSWERS,
  INVITE_ANSWERS,
  LIFT_ANSWERS,
  REINVITE_ANSWERS,
  REVOKE_ANSWERS,
  SUSPEND_ANSWERS,
  type TeacherAdminStore,
} from "./admin";
import { askDecide, askFounder, askInviteTeacher, askLift, askReinvite, askRevokeTeacherInvitation, askSuspend, readTeacherRoster, teacherAnswerOf } from "./admin-records";

// Lo que el servicio de administrar maestros le pregunta a la base, a nombre de las claims que verificó. Ningún cambio
// escribe antes de rechazar: un choque de candados revierte la transacción entera, y se intenta una vez más.

/** `run` es `asServer`. Solo las pruebas pasan otro. */
export function createTeacherAdminStore(run: typeof asServer = asServer): TeacherAdminStore {
  function change<Result>(claims: VerifiedClaims, reason: string, work: (tx: Tx) => Promise<Result>): Promise<Result> {
    return withLockRetry(() => run({ claims, reason }, work), isLockConflict);
  }
  return {
    roster: (claims) => run({ claims, reason: "teacher_roster" }, (tx) => readTeacherRoster(tx)),
    invite: async (claims, name, email) => teacherAnswerOf(INVITE_ANSWERS, await change(claims, "teacher_invite", (tx) => askInviteTeacher(tx, name, email))),
    reinvite: async (claims, teacher) => teacherAnswerOf(REINVITE_ANSWERS, await change(claims, "teacher_reinvite", (tx) => askReinvite(tx, teacher))),
    revoke: async (claims, teacher) => teacherAnswerOf(REVOKE_ANSWERS, await change(claims, "teacher_revoke", (tx) => askRevokeTeacherInvitation(tx, teacher))),
    setFounder: async (claims, teacher, since) =>
      teacherAnswerOf(FOUNDER_ANSWERS, await change(claims, "teacher_founder", (tx) => askFounder(tx, teacher, since))),
    suspend: async (claims, teacher, reason, notice) =>
      teacherAnswerOf(SUSPEND_ANSWERS, await change(claims, "teacher_suspend", (tx) => askSuspend(tx, teacher, reason, notice))),
    lift: async (claims, teacher) => teacherAnswerOf(LIFT_ANSWERS, await change(claims, "teacher_lift", (tx) => askLift(tx, teacher))),
    decide: async (claims, request, confirm, note, notice) =>
      teacherAnswerOf(DECIDE_ANSWERS, await change(claims, "teacher_fraud_decide", (tx) => askDecide(tx, request, confirm, note, notice))),
  };
}

export const databaseTeacherAdminStore = createTeacherAdminStore();
