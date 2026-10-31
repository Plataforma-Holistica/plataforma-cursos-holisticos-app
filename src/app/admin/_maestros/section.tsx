import { notFound } from "next/navigation";

import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import type { VerifiedClaims } from "@/services/account/account";
import { adminTeacherPath, ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { teacherRoster } from "@/services/teachers/teacher-admin";

import { rosterView, teacherView } from "./rows";
import { TeacherScreen, type TeacherDone } from "./teacher-screen";
import { TeachersScreen, type TeachersDone } from "./teachers-screen";

// PA-65 y PA-66 · Los maestros y la ficha de uno (`/admin/maestros`, `/admin/maestros/<id>`; RF-104, RF-702; FL-46; T-401).
// No son páginas: las sirve el comodín de administración, que corre la guarda antes y solo llega aquí con alguien del
// equipo que tiene Contenido (`src/app/admin/_lib/sections.tsx`). Leer no pide el código reciente; cambiar, sí.

const LIST_DONE: readonly TeachersDone[] = ["teacher_invited", "teacher_reinvited", "teacher_invitation_revoked"];
const DETAIL_DONE: readonly TeacherDone[] = ["teacher_founder_saved", "teacher_suspended", "teacher_lifted", "teacher_fraud_confirmed", "teacher_fraud_rejected"];

export async function TeachersSection({ claims }: { claims: VerifiedClaims }) {
  const read = await teacherRoster(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.adminTeachers} withSession />;
  const notice = readNotice(await cookieReader());
  return <TeachersScreen view={rosterView(read.roster)} done={LIST_DONE.find((each) => each === notice) ?? null} />;
}

export async function TeacherSection({ claims, id }: { claims: VerifiedClaims; id: string }) {
  const read = await teacherRoster(claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={adminTeacherPath(id)} withSession />;
  const view = teacherView(read.roster, id);
  if (view === null) notFound();
  const notice = readNotice(await cookieReader());
  return <TeacherScreen view={view} done={DETAIL_DONE.find((each) => each === notice) ?? null} />;
}
