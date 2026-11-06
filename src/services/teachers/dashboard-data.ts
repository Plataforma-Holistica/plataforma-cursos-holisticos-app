import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { reportFailure } from "@/services/error-reporting/server";

import { createDashboard, type DashboardStore } from "./dashboard";
import { askTeacherDashboard } from "./dashboard-records";

// El panel del maestro, ya armado: lo que importa el inicio del portal (PA-41, T-408). Corre como el servidor, a nombre de la persona: las tablas del
// estimado y del cierre no tienen permisos para la aplicación, y la base sabe quién es el maestro por `actor_teacher_id()`.

export type { DashboardCourse, DashboardCurrent, DashboardFigures, DashboardPeriod, DashboardRead, DashboardRun, DashboardValue } from "./dashboard";

const store: DashboardStore = {
  read: (claims) => asServer({ claims, reason: "teacher_dashboard" }, askTeacherDashboard),
};

export const { teacherDashboard } = createDashboard({ store, report: reportFailure });
