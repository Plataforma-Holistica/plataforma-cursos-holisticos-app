import type { Metadata } from "next";

import { visitorOnly } from "@/app/_lib/guard";
import { messages } from "@/messages";
import { slugOfDocType } from "@/services/legal/texts";

import { SignUpScreen } from "./screen";

// PA-10 · Registro (`/registro`). Quien ya tiene sesión se va a su inicio.

export const metadata: Metadata = { title: messages.account.signUp.pageTitle };

const legalHref = (docType: string): string | null => {
  const slug = slugOfDocType(docType);
  return slug === null ? null : `/legal/${slug}`;
};

export default async function SignUpPage() {
  await visitorOnly();
  return <SignUpScreen termsHref={legalHref("terms")} privacyHref={legalHref("student_privacy_notice")} />;
}
