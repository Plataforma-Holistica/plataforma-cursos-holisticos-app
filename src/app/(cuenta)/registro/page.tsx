import type { Metadata } from "next";

import { visitorOnly } from "@/app/_lib/guard";
import { messages } from "@/messages";
import { AccessFrame } from "@/app/(cuenta)/_lib/access-frame";
import { RETURN_PARAM } from "@/services/account/navigation";
import { slugOfDocType } from "@/services/legal/texts";

import { SignUpScreen } from "./screen";

// PA-10 · Registro (`/registro`). Quien ya tiene sesión se va a su inicio. Quien llega yendo a algún lado (`volver`: el plan
// elegido, la lección de un curso abierto) lo conserva hasta completar su cuenta (FL-04).

export const metadata: Metadata = { title: messages.account.signUp.pageTitle };

const legalHref = (docType: string): string | null => {
  const slug = slugOfDocType(docType);
  return slug === null ? null : `/legal/${slug}`;
};

type Params = Record<string, string | string[] | undefined>;

export default async function SignUpPage({ searchParams }: { searchParams: Promise<Params> }) {
  await visitorOnly();
  const returnTo = (await searchParams)[RETURN_PARAM];
  return (
    <AccessFrame>
      <SignUpScreen
        termsHref={legalHref("terms")}
        privacyHref={legalHref("student_privacy_notice")}
        // Tal como llegó: lo valida quien lo guarda. Repetido en la dirección no es un destino.
        returnTo={typeof returnTo === "string" ? returnTo : ""}
      />
    </AccessFrame>
  );
}
