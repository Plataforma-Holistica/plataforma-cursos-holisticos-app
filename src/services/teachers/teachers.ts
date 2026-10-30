import "server-only";

import { asUser } from "@/adapters/supabase/db";
import { checkSession } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { readTeacherStanding } from "./records";
import { createTeachers, type TeacherStore } from "./standing";

// El servicio del maestro, ya armado con la guarda de sesión, la base y el registro de errores. Lo que
// importa la guarda de las pantallas del portal.

export type { TeacherCheck, TeacherStanding } from "./standing";

const store: TeacherStore = { standing: (claims) => asUser(claims, (tx) => readTeacherStanding(tx)) };

export const { teacherStanding } = createTeachers({ store, checkSession, report: reportFailure });
