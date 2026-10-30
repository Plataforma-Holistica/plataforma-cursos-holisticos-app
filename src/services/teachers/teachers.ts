import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { isLockConflict } from "@/adapters/supabase/errors";
import { getEnv } from "@/config/env";
import { checkSession } from "@/services/account/account";
import { dropTicket, readTicketPrint } from "@/services/account/mailbox-ticket";
import { proxyIsTrusted, resolveOrigin } from "@/services/account/origin";
import { withLockRetry } from "@/services/account/team";
import { reportFailure } from "@/services/error-reporting/server";

import { acceptAnswerOf, askAcceptInvitation, readTeacherStanding, readTeacherTexts, recordTeacherNotice } from "./records";
import { createTeachers, type TeacherStore } from "./standing";

// El servicio del maestro, ya armado con la guarda de sesión, la base y el registro de errores. Lo que importa
// la guarda de las pantallas del portal. Todo corre como el servidor, a nombre de la persona: el estado, la
// invitación y los textos del maestro no los lee ella como `authenticated`.

export type { InvitationAccepted, NoticeAccepted, TeacherCheck, TeacherStanding, TeacherText, TeacherTexts } from "./standing";

const store: TeacherStore = {
  // Solo leen y no toman candados: no hay choque que reintentar.
  standing: (claims, ticketPrint) => asServer({ claims, reason: "teacher_standing" }, (tx) => readTeacherStanding(tx, ticketPrint)),
  texts: (claims, draftsAllowed) => asServer({ claims, reason: "teacher_texts" }, (tx) => readTeacherTexts(tx, draftsAllowed)),
  // Aceptar cierra sesiones en Auth, y Auth puede estar tocando las mismas filas: un choque de candados revierte
  // la transacción entera, y se intenta una vez más. Se valida ya confirmada: dos rechazos escriben.
  accept: async (claims, ticketPrint, agreement, notice, evidence) =>
    acceptAnswerOf(
      await withLockRetry(
        () => asServer({ claims, reason: "teacher_invitation" }, (tx) => askAcceptInvitation(tx, ticketPrint, agreement, notice, evidence)),
        isLockConflict,
      ),
    ),
  acceptNotice: (claims, notice, evidence, draftsAllowed) =>
    asServer({ claims, reason: "teacher_notice" }, (tx) => recordTeacherNotice(tx, claims.userId, notice, evidence, draftsAllowed)),
};

export const { teacherStanding, teacherTexts, acceptTeacherInvitation, acceptTeacherNotice } = createTeachers({
  store,
  checkSession,
  report: reportFailure,
  readTicket: readTicketPrint,
  dropTicket,
  evidence: (origin) => {
    const { address, userAgent } = resolveOrigin(origin, proxyIsTrusted());
    return { address, userAgent };
  },
  isLocal: () => getEnv().APP_ENV === "local",
});
