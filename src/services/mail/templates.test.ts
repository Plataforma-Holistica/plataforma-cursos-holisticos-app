import { describe, expect, it } from "vitest";

import { renderMail, type MailCopy } from "./templates";

const SITE = "https://plataforma.ejemplo.test";
const COPY: MailCopy = {
  clabeNotice: {
    subject: "Asunto",
    intro: "Intro",
    wait: (hours) => `${hours} horas`,
    yours: "Tuya",
    notYours: "No <tuya>",
    recoverLabel: "Cambiar",
    reviewLabel: "Ver",
  },
};

describe("el aviso de CLABE", () => {
  it("dice cuánto espera, y enlaza a cambiar la contraseña", () => {
    const mail = renderMail("CO-27", { hours: 72 }, SITE, COPY);
    expect(mail?.text).toContain("72 horas");
    expect(mail?.text).toContain(`${SITE}/recuperar`);
    expect(mail?.html).toContain(`href="${SITE}/recuperar"`);
    expect(mail?.html).toContain(`href="${SITE}/portal/datos-fiscales"`);
  });

  it.each([{}, { hours: "72" }, { hours: 0 }, { hours: 1.5 }, { hours: 72, clabe: "012" }, null])("con parámetros sin forma (%j) no arma nada", (params) => {
    expect(renderMail("CO-27", params, SITE, COPY)).toBeNull();
  });

  it("no conoce otra plantilla", () => {
    expect(renderMail("CO-99", { hours: 72 }, SITE, COPY)).toBeNull();
  });

  it("escapa lo que va en el HTML", () => {
    const html = renderMail("CO-27", { hours: 72 }, 'https://x.test/"><b>', COPY)?.html;
    expect(html).not.toContain('"><b>');
    expect(html).toContain("No &lt;tuya&gt;");
  });
});
