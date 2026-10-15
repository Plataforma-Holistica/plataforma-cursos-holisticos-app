import { UnavailableScreen } from "@/app/(cuenta)/_lib/states";
import { cookieReader } from "@/app/_lib/request-context";
import type { VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { reviewQueue } from "@/services/review/review";

import { reviewView } from "./rows";
import { ReviewScreen } from "./screen";

// PA-61 y PA-62 mínimas · Los cursos por revisar (`/admin/revision`; RF-701, FL-45; T-108). No
// es una página: la sirve el comodín de administración, que corre la guarda antes y solo
// llega aquí con alguien del equipo que tiene Contenido (`src/app/admin/_lib/sections.tsx`).
//
// La cola se lee con las claims con que la guarda dejó pasar, y la base solo se la contesta a
// quien pasa su puerta con Contenido. Nada del video va en lo que se pinta: el reproductor lo
// pide después, con su propia acción.

export async function ReviewSection({ claims }: { claims: VerifiedClaims }) {
  const reader = await cookieReader();
  const read = await reviewQueue(reader, claims);
  if (read.kind === "unavailable") return <UnavailableScreen retryHref={ROUTES.review} withSession />;

  // Aprobar redirige aquí con un aviso: la cola de ahora ya no trae ese curso.
  return <ReviewScreen view={reviewView(read.queue)} published={readNotice(reader) === "course_approved"} />;
}
