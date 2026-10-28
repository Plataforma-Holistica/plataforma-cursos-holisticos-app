import { describe, expect, it } from "vitest";

import { periodClosePath, periodPath, ROUTES } from "@/services/account/navigation";
import { CLOSE_ANSWERS, DOWNLOAD_ANSWERS, REHEARSE_ANSWERS, ROLLUP_ANSWERS } from "@/services/periods/periods";

import {
  closeOutcome,
  csvHref,
  downloadOutcome,
  periodCodeTarget,
  periodFrom,
  periodsButton,
  readPeriodsForm,
  rehearseOutcome,
  rollupOutcome,
  type PeriodFailure,
} from "./outcomes";

// La tabla de PA-79 y PA-80: lo que llega, lo que contesta cada servicio y a dónde va. Pura: sin
// servicios ni base.

const PERIOD = 202710;
const RUN = "c1000000-0000-4000-8000-000000000001";
const PANEL = { kind: "leave", to: periodPath(PERIOD), notice: null };
const CLOSE = { kind: "leave", to: periodClosePath(PERIOD), notice: null };
const failed = (reason: PeriodFailure) => ({ kind: "failed", reason });

function formWith(...values: [string, string | Blob][]) {
  const form = new FormData();
  for (const [name, value] of values) form.append(name, value);
  return form;
}

describe("readPeriodsForm", () => {
  it("lee los valores que arma periodsButton", () => {
    expect(readPeriodsForm(formWith(["do", periodsButton.rollup(PERIOD)]))).toEqual({ step: "rollup", period: PERIOD });
    expect(readPeriodsForm(formWith(["do", periodsButton.rehearse(PERIOD)]))).toEqual({ step: "rehearse", period: PERIOD });
    expect(readPeriodsForm(formWith(["do", periodsButton.askClose(PERIOD)]))).toEqual({ step: "ask_close", period: PERIOD });
    expect(readPeriodsForm(formWith(["do", periodsButton.close(PERIOD)], ["understood", "yes"]))).toEqual({ step: "close", period: PERIOD, understood: true });
    expect(readPeriodsForm(formWith(["do", periodsButton.close(PERIOD)]))).toEqual({ step: "close", period: PERIOD, understood: false });
    expect(readPeriodsForm(formWith(["do", periodsButton.close(PERIOD)], ["understood", "on"]))).toEqual({ step: "close", period: PERIOD, understood: false });
    expect(readPeriodsForm(formWith(["do", periodsButton.download(RUN)]))).toEqual({ step: "download", run: RUN });
    expect(readPeriodsForm(formWith(["do", periodsButton.cancel()]))).toEqual({ step: "cancel" });
  });

  it.each([
    ["sin botón", formWith()],
    ["dos botones", formWith(["do", periodsButton.rehearse(PERIOD)], ["do", periodsButton.close(PERIOD)])],
    ["un verbo desconocido", formWith(["do", `reopen:${PERIOD}`])],
    ["un periodo sin forma", formWith(["do", "rehearse:202713"])],
    ["un periodo con letras", formWith(["do", "rehearse:2027-10"])],
    ["un periodo con decimales", formWith(["do", "rehearse:202710.0"])],
    ["un periodo con ceros a la izquierda", formWith(["do", "rehearse:0202710"])],
    ["una corrida sin forma", formWith(["do", "download:no"])],
    ["descargar un periodo", formWith(["do", `download:${PERIOD}`])],
    ["ensayar una corrida", formWith(["do", `rehearse:${RUN}`])],
    ["de más", formWith(["do", `rehearse:${PERIOD}:x`])],
    ["cancelar con algo", formWith(["do", `cancel:${PERIOD}`])],
    ["un archivo", formWith(["do", new Blob(["rehearse:202710"])])],
    ["desmedido", formWith(["do", `rehearse:${"9".repeat(200)}`])],
  ])("%s no es nada", (_name, form) => {
    expect(readPeriodsForm(form)).toEqual({ step: "none" });
  });

  it("lo que no es un formulario no es nada", () => {
    expect(readPeriodsForm(null)).toEqual({ step: "none" });
    expect(readPeriodsForm({ do: "rehearse:202710" })).toEqual({ step: "none" });
  });
});

describe("periodFrom", () => {
  it("un periodo con forma, o nulo", () => {
    expect(periodFrom(PERIOD)).toBe(PERIOD);
    for (const value of [202713, 202700, 199912, "202710", 202710.5, null, undefined]) expect(periodFrom(value)).toBeNull();
  });
});

describe("periodCodeTarget", () => {
  it("a la página del periodo de donde se dio, o a la lista si no tiene forma", () => {
    expect(periodCodeTarget({ period: PERIOD, page: "panel" })).toBe(periodPath(PERIOD));
    expect(periodCodeTarget({ period: PERIOD, page: "close" })).toBe(periodClosePath(PERIOD));
    expect(periodCodeTarget({ period: 202713, page: "close" })).toBe(ROUTES.periods);
    expect(periodCodeTarget({ period: PERIOD, page: "otra" })).toBe(ROUTES.periods);
    expect(periodCodeTarget("https://otro.example")).toBe(ROUTES.periods);
    expect(periodCodeTarget(null)).toBe(ROUTES.periods);
  });
});

describe("rollupOutcome", () => {
  it.each(ROLLUP_ANSWERS)("cada respuesta tiene su caso: %s", (answer) => {
    expect(rollupOutcome({ kind: "answered", answer }, PERIOD)).toBeDefined();
  });

  it("pedido, o ya pedido: al panel con su aviso", () => {
    const done = { kind: "leave", to: periodPath(PERIOD), notice: "rollup_requested" };
    expect(rollupOutcome({ kind: "answered", answer: "requested" }, PERIOD)).toEqual(done);
    expect(rollupOutcome({ kind: "answered", answer: "already_requested" }, PERIOD)).toEqual(done);
  });

  it("lo demás", () => {
    expect(rollupOutcome({ kind: "answered", answer: "not_rollable" }, PERIOD)).toEqual(failed("not_rollable"));
    expect(rollupOutcome({ kind: "answered", answer: "needs_fresh_code" }, PERIOD)).toEqual(failed("needs_code"));
    expect(rollupOutcome({ kind: "answered", answer: "forbidden" }, PERIOD)).toEqual(PANEL);
    expect(rollupOutcome({ kind: "answered", answer: "malformed" }, PERIOD)).toEqual(failed("unknown"));
    expect(rollupOutcome({ kind: "refused" }, PERIOD)).toEqual(PANEL);
    expect(rollupOutcome({ kind: "malformed" }, PERIOD)).toEqual(failed("unknown"));
    expect(rollupOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
    expect(rollupOutcome({ kind: "unknown" }, PERIOD)).toEqual(failed("unknown"));
  });
});

describe("rehearseOutcome", () => {
  it.each(REHEARSE_ANSWERS)("cada respuesta tiene su caso: %s", (answer) => {
    expect(rehearseOutcome({ kind: "answered", answer }, PERIOD)).toBeDefined();
  });

  it("ensayado: al cierre con su aviso", () => {
    expect(rehearseOutcome({ kind: "answered", answer: "rehearsed" }, PERIOD)).toEqual({ kind: "leave", to: periodClosePath(PERIOD), notice: "period_rehearsed" });
  });

  it.each<[string, PeriodFailure]>([
    ["failed", "rehearsal_failed"],
    ["already_closed", "already_closed"],
    ["no_period", "no_period"],
    ["photo_missing", "photo_missing"],
    ["no_pool_bps", "no_pool_percent"],
    ["before_launch", "before_launch"],
    ["too_soon", "too_soon"],
    ["needs_fresh_code", "needs_code"],
    ["malformed", "unknown"],
  ])("%s dice %s", (answer, reason) => {
    expect(rehearseOutcome({ kind: "answered", answer: answer as never }, PERIOD)).toEqual(failed(reason));
  });

  it("lo demás", () => {
    expect(rehearseOutcome({ kind: "answered", answer: "forbidden" }, PERIOD)).toEqual(CLOSE);
    expect(rehearseOutcome({ kind: "refused" }, PERIOD)).toEqual(CLOSE);
    expect(rehearseOutcome({ kind: "timed_out" }, PERIOD)).toEqual(failed("timed_out"));
    expect(rehearseOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
    expect(rehearseOutcome({ kind: "unknown" }, PERIOD)).toEqual(failed("unknown"));
    expect(rehearseOutcome({ kind: "malformed" }, PERIOD)).toEqual(failed("unknown"));
  });
});

describe("closeOutcome", () => {
  it.each(CLOSE_ANSWERS)("cada respuesta tiene su caso: %s", (answer) => {
    expect(closeOutcome({ kind: "answered", answer }, PERIOD)).toBeDefined();
  });

  it("cerrado: al cierre con su aviso", () => {
    expect(closeOutcome({ kind: "answered", answer: "closed" }, PERIOD)).toEqual({ kind: "leave", to: periodClosePath(PERIOD), notice: "period_closed" });
  });

  it.each<[string, PeriodFailure]>([
    ["already_closed", "already_closed"],
    ["not_closing", "not_closing"],
    ["before_launch", "before_launch"],
    ["previous_not_closed", "previous_not_closed"],
    ["photo_missing", "photo_missing"],
    ["no_pool_bps", "no_pool_percent"],
    ["rollup_running", "rollup_running"],
    ["last_rollup_failed", "last_rollup_failed"],
    ["needs_full_rollup", "needs_full_rollup"],
    ["rollup_marks", "rollup_marks"],
    ["open_alerts", "open_alerts"],
    ["rehearsal_missing", "rehearsal_missing"],
    ["rehearsal_stale", "rehearsal_stale"],
    ["needs_fresh_code", "needs_code"],
    ["malformed", "unknown"],
  ])("%s dice %s", (answer, reason) => {
    expect(closeOutcome({ kind: "answered", answer: answer as never }, PERIOD)).toEqual(failed(reason));
  });

  it("la suma que no cuadra, el tiempo vencido y no se supo: nunca como cerrado", () => {
    expect(closeOutcome({ kind: "unbalanced" }, PERIOD)).toEqual(failed("unbalanced"));
    expect(closeOutcome({ kind: "timed_out" }, PERIOD)).toEqual(failed("timed_out"));
    expect(closeOutcome({ kind: "unknown" }, PERIOD)).toEqual(failed("unknown"));
    expect(closeOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
    expect(closeOutcome({ kind: "answered", answer: "forbidden" }, PERIOD)).toEqual(CLOSE);
    expect(closeOutcome({ kind: "refused" }, PERIOD)).toEqual(CLOSE);
  });
});

describe("downloadOutcome", () => {
  it.each(DOWNLOAD_ANSWERS)("cada respuesta tiene su caso: %s", (answer) => {
    expect(downloadOutcome({ kind: "answered", answer }, PERIOD)).toBeDefined();
  });

  it("el archivo: su nombre, sus filas y su dirección de datos", () => {
    const file = { filename: "cierre-2027-10.csv", content: "﻿periodo,total\r\n202710,1.00\r\n", rows: 1, sha256: "ab".repeat(32) };
    expect(downloadOutcome({ kind: "file", file }, PERIOD)).toEqual({ kind: "file", filename: file.filename, rows: 1, href: csvHref(file.content) });
  });

  it("lo demás", () => {
    expect(downloadOutcome({ kind: "answered", answer: "not_found" }, PERIOD)).toEqual(failed("not_found"));
    expect(downloadOutcome({ kind: "answered", answer: "needs_fresh_code" }, PERIOD)).toEqual(failed("needs_code"));
    expect(downloadOutcome({ kind: "answered", answer: "forbidden" }, PERIOD)).toEqual(CLOSE);
    expect(downloadOutcome({ kind: "refused" }, PERIOD)).toEqual(CLOSE);
    expect(downloadOutcome({ kind: "malformed" }, PERIOD)).toEqual(failed("not_found"));
    expect(downloadOutcome({ kind: "unknown" }, PERIOD)).toEqual(failed("unknown"));
    expect(downloadOutcome({ kind: "unavailable" }, PERIOD)).toEqual(failed("unavailable"));
  });
});

describe("csvHref", () => {
  it("una dirección de datos de CSV en UTF-8 que devuelve el contenido exacto, con su marca y sus fines de línea", () => {
    const content = "﻿periodo,maestro\r\n202710,\"Ana, la de \"\"Yoga\"\"\"\r\n";
    const href = csvHref(content);
    expect(href.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(href.slice("data:text/csv;charset=utf-8,".length))).toBe(content);
    expect(href).not.toMatch(/[\s"#]/);
  });
});
