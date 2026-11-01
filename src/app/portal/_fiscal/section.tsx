import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import { sessionEmail, type VerifiedClaims } from "@/services/account/account";
import { ROUTES } from "@/services/account/navigation";
import { readNotice } from "@/services/account/notice";
import { taxDataReady, taxProfileState } from "@/services/teachers/tax-data";
import { InlineAlert } from "@/ui/inline-alert";

import { PortalFrame } from "../_lib/frame";
import { TaxCapture, TaxReveal } from "./screen";

// PA-48, los datos fiscales y bancarios (`/portal/datos-fiscales`; T-409, FL-31). Lo sirve el comodín, ya pasada la guarda. Aquí no se lee nada cifrado: solo
// si ya los capturó y cuándo. Abrirlos pide la contraseña, en el formulario. El maestro suspendido los ve y no los cambia (FL-31, A2).

const text = messages.portal.taxData;

export async function TaxDataSection({
  claims,
  readOnly,
  search,
}: {
  claims: VerifiedClaims;
  readOnly: boolean;
  search: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const reader = await cookieReader();
  const notice = readNotice(reader);
  const email = await sessionEmail(reader);
  const ready = await taxDataReady();
  const state = ready ? await taxProfileState(claims) : null;
  // La franja de solo lectura es del portal. Estos datos los cambia también un suspendido, salvo por fraude: lo dice la base.
  const canSave = state?.canSave === true;
  const wantsChange = search.cambiar === "1" && canSave;

  return (
    <PortalFrame current={ROUTES.portalTaxData} readOnly={readOnly}>
      <h1 className="text-h1">{text.title}</h1>
      <p className="text-text-2">{text.who}</p>
      {notice === "tax_data_saved" && !wantsChange && <InlineAlert tone="success">{text.saved}</InlineAlert>}
      {notice === "tax_data_changed" && wantsChange && <InlineAlert tone="warning">{text.changedElsewhere}</InlineAlert>}
      {!ready && <InlineAlert tone="warning">{text.off}</InlineAlert>}
      {ready && state === null && <InlineAlert tone="danger">{text.unavailable}</InlineAlert>}
      {state !== null && state.version === 0 && (canSave ? <TaxCapture seen={0} changing={false} email={email} /> : <p className="text-text-2">{text.readOnlyEmpty}</p>)}
      {state !== null && state.version > 0 && wantsChange && <TaxCapture seen={state.version} changing email={email} />}
      {state !== null && state.version > 0 && !wantsChange && (
        <TaxReveal canChange={canSave} />
      )}
    </PortalFrame>
  );
}
