import type { Metadata } from "next";

import { SuspendedScreen, UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { signOutAction } from "@/app/(cuenta)/_lib/session-actions";
import { requireSession } from "@/app/_lib/guard";
import { cookieReader } from "@/app/_lib/request-context";
import { messages, t } from "@/messages";
import { sessionEmail } from "@/services/account/account";
import { lessonPath, ROUTES } from "@/services/account/navigation";
import { continueWatching } from "@/services/progress/progress";
import { Button } from "@/ui/button";
import { ProgressBar } from "@/ui/progress-bar";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { TextLink } from "@/ui/text-link";

// El inicio de quien entró, provisional: el del alumno (PA-20) llega con el catálogo
// (T-210). Existe para que haya a dónde llegar después de entrar, y dónde salir. Mientras
// no haya menú de la cuenta, de aquí sale también el enlace a PA-25.
//
// Dice con qué correo se entró. No es un adorno: es lo que le avisa a alguien que completó
// una cuenta desde un enlace que le mandó otra persona, y cuyo buzón no controla.
//
// Desde T-206, «Continuar viendo» en su forma mínima (decisión de Sergio del 2026-10-20): cada
// curso empezado y sin terminar, el más reciente primero, con un enlace a la lección sugerida y su
// avance. Sin cursos empezados, o si no se supo, no hay lista: lo demás del inicio sigue.

const text = messages.account;

export const metadata: Metadata = { title: text.home.pageTitle };

export default async function HomePage() {
  const session = await requireSession(ROUTES.home);
  if (session.kind === "suspended") return <SuspendedScreen withSession />;
  if (session.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.home} withSession />;

  const [email, watching] = await Promise.all([sessionEmail(await cookieReader()), continueWatching(session.claims)]);
  const courses = watching.kind === "ready" ? watching.courses : [];

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <h1 className="text-h1">{text.home.title}</h1>
      <div className="flex flex-col gap-2 text-text-2">
        {email !== null && <p>{t(text.home.signedInAs, { email })}</p>}
        <p>{text.home.status}</p>
      </div>
      {courses.length > 0 && (
        <section aria-labelledby="continuar-viendo" className="flex flex-col gap-3">
          <h2 id="continuar-viendo" className="text-h3">
            {text.home.continueTitle}
          </h2>
          <ul aria-labelledby="continuar-viendo" className="flex flex-col gap-4">
            {courses.map((course) => {
              const href = lessonPath(course.courseSlug, course.lesson.id);
              const words = { number: String(course.lesson.number), total: String(course.total), lesson: course.lesson.title };
              return (
                <li key={course.courseSlug} className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-4">
                  {href !== null && (
                    <TextLink href={href}>
                      <span className="sr-only">{t(text.home.continueName, { ...words, course: course.courseTitle, teacher: course.teacherName })}</span>
                      <span aria-hidden="true">{course.courseTitle}</span>
                    </TextLink>
                  )}
                  <p aria-hidden="true" className="text-body-s text-text-2">
                    {t(text.home.continueLesson, words)}
                  </p>
                  <ProgressBar
                    value={course.completed}
                    max={course.total}
                    size="thin"
                    label={text.home.continueProgressLabel}
                    text={t(text.home.continueProgress, { completed: String(course.completed), total: String(course.total) })}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <p>
        <TextLink href={ROUTES.account}>{text.home.account}</TextLink>
      </p>
      <form action={signOutAction}>
        <Button type="submit" variant="secondary">
          {text.common.signOut}
        </Button>
      </form>
    </main>
  );
}
