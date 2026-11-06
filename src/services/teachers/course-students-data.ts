import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { reportFailure } from "@/services/error-reporting/server";

import { createCourseStudents, type CourseStudentsStore } from "./course-students";
import { askCourseStudents } from "./course-students-records";

// El avance de los alumnos de un curso, ya armado: lo que importa PA-51 (T-408). Corre como el servidor, a nombre de la persona: el resumen y los alias no
// tienen permisos para la aplicación, y la base sabe quién es el maestro por `actor_teacher_id()`.

export type { CourseStudent, CourseStudentsFigures, CourseStudentsLesson, CourseStudentsRead, CourseStudentsValue, StudentsOrder } from "./course-students";

const store: CourseStudentsStore = {
  read: (claims, query) => asServer({ claims, reason: "course_students" }, (tx) => askCourseStudents(tx, query)),
};

export const { courseStudents } = createCourseStudents({ store, report: reportFailure });
