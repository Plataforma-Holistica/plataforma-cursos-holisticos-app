import { cookieReader } from "@/app/_lib/request-context";
import { messages } from "@/messages";
import type { VerifiedClaims } from "@/services/account/account";
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
  const notice = readNotice(await cookieReader());
  const ready = await taxDataReady();
  const state = ready ? await taxProfileState(claims) : null;
  const wantsChange = search.cambiar === "1" && !readOnly;

  return (
    <PortalFrame current={ROUTES.portalTaxData} readOnly={readOnly}>
      <h1 className="text-h1">{text.title}</h1>
      <p className="text-text-2">{text.who}</p>
      {notice === "tax_data_saved" && !wantsChange && <InlineAlert tone="success">{text.saved}</InlineAlert>}
      {!ready && <InlineAlert tone="warning">{text.off}</InlineAlert>}
      {ready && state === null && <InlineAlert tone="danger">{text.unavailable}</InlineAlert>}
      {state !== null && state.version === 0 && (readOnly ? <p className="text-text-2">{text.readOnlyEmpty}</p> : <TaxCapture seen={0} changing={false} />)}
      {state !== null && state.version > 0 && wantsChange && <TaxCapture seen={state.version} changing />}
      {state !== null && state.version > 0 && !wantsChange && (
        <TaxReveal canChange={!readOnly} />
      )}
    </PortalFrame>
  );
}
