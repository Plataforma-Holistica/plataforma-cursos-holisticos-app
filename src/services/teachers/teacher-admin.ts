import "server-only";

import { giveSecondFactorCode, teamStanding } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { createTeacherAdmin } from "./admin";
import { databaseTeacherAdminStore } from "./admin-store";

// Administrar a los maestros, ya armado con la guarda del equipo, la base y el registro de errores. Lo que importan las
// pantallas de administración; el portal importa `teachers.ts`.

export type { DecideAnswer, FounderAnswer, FraudRequest, InviteAnswer, LiftAnswer, ReinviteAnswer, RevokeAnswer, RosterRead, SuspendAnswer, TeacherChange, TeacherCode, TeacherInvited, TeacherRoster, TeacherRow } from "./admin";
export { FRAUD_NOTE_MAX, SUSPENSION_NOTICE_MAX, SUSPENSION_REASON_MAX, TEACHER_NAME_MAX, teacherVersion } from "./admin";

export const {
  teacherRoster,
  inviteTeacher,
  reinviteTeacher,
  revokeTeacherInvitation,
  setTeacherFounder,
  suspendTeacher,
  liftTeacherSuspension,
  decideTeacherFraud,
  giveTeacherCode,
} = createTeacherAdmin({ report: reportFailure }, { teamStanding, giveSecondFactorCode, store: databaseTeacherAdminStore });
