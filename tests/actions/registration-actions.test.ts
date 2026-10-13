import { beforeEach, describe, expect, it, vi } from "vitest";

// Las acciones de servidor de registro, verificación y recuperación, con los servicios
// simulados: qué le pasa cada una a su servicio, en qué orden, y qué hace con cada respuesta.
// Lo que los servicios hacen de verdad lo prueban sus pruebas de integración, y el camino
// entero, las de extremo a extremo.

// El orden de las llamadas, y lo que contesta la siguiente llamada a cada simulación. No se
// usa `mockResolvedValueOnce`: cambiaría la implementación, y la llamada no quedaría anotada.
const calls = vi.hoisted(() => ({ order: [] as string[], next: new Map<string, unknown[]>() }));
const mocks = vi.hoisted(() => {
  const logged = <Result,>(name: string, result: () => Result) =>
    vi.fn((...args: unknown[]): Result => {
      void args;
      calls.order.push(name);
      const queued = calls.next.get(name);
      return queued !== undefined && queued.length > 0 ? (queued.shift() as Result) : result();
    });
  return {
    requestRegistration: logged("requestRegistration", () => Promise.resolve<unknown>({ kind: "accepted" })),
    requestRecovery: logged("requestRecovery", () => Promise.resolve<unknown>({ kind: "accepted" })),
    accountFormFacts: logged("accountFormFacts", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    completeRegistration: logged("completeRegistration", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    completeRecovery: logged("completeRecovery", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    signOut: logged("signOut", () => Promise.resolve("closed")),
    signIn: logged("signIn", () => Promise.resolve<unknown>({ kind: "unavailable" })),
    rememberRegistration: logged("rememberRegistration", () => undefined),
    readRegistration: logged("readRegistration", (): unknown => null),
    forgetRegistration: logged("forgetRegistration", () => undefined),
    clearNotice: logged("clearNotice", () => undefined),
    leaveNotice: logged("leaveNotice", () => undefined),
    refresh: logged("refresh", () => undefined),
    redirect: vi.fn((to: string): never => {
      calls.order.push("redirect");
      throw new Error(`redirige a ${to}`);
    }),
    cookieJar: vi.fn(),
    requestOrigin: vi.fn(),
  };
});
vi.mock("@/app/_lib/mail-requests", () => ({
  requestRegistration: mocks.requestRegistration,
  requestRecovery: mocks.requestRecovery,
}));
vi.mock("@/app/_lib/request-context", () => ({ cookieJar: mocks.cookieJar, requestOrigin: mocks.requestOrigin }));
vi.mock("@/services/account/account", async () => ({
  // El de verdad siempre contesta con una promesa, también cuando aquí se le encola un valor.
  accountFormFacts: () => Promise.resolve(mocks.accountFormFacts()),
  completeRegistration: mocks.completeRegistration,
  completeRecovery: mocks.completeRecovery,
  signOut: mocks.signOut,
  signIn: mocks.signIn,
  isLinkToken: (await import("@/adapters/supabase/tokens")).isLinkToken,
}));
vi.mock("@/services/account/pending-registration", () => ({
  rememberRegistration: mocks.rememberRegistration,
  readRegistration: mocks.readRegistration,
  forgetRegistration: mocks.forgetRegistration,
}));
vi.mock("@/services/account/notice", () => ({ clearNotice: mocks.clearNotice, leaveNotice: mocks.leaveNotice }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ refresh: mocks.refresh }));

import {
  forgetFormFacts,
  FORM_FACTS_MEMORY_MS,
  formFacts,
  linkLifetimeSeconds,
  pendingRequestFacts,
  rememberRequest,
} from "@/app/(cuenta)/_lib/link-facts";
import { signInAction } from "@/app/(cuenta)/entrar/actions";
import { completeRecoveryAction } from "@/app/(cuenta)/recuperar/[token]/actions";
import { requestRecoveryAction } from "@/app/(cuenta)/recuperar/actions";
import { requestRegistrationAction } from "@/app/(cuenta)/registro/actions";
import { completeRegistrationAction } from "@/app/(cuenta)/verificar/[token]/actions";
import { notMyEmailAction, resendAction } from "@/app/(cuenta)/verificar/actions";

const jar = { get: () => undefined, set: () => undefined };
const origin = { ip: "203.0.113.7", userAgent: "prueba" };
const TOKEN = "abcdefgh12345678";
const IDLE = { kind: "idle" } as const;
const facts = { kind: "ready", texts: [], minimumAge: 18, linkLifetimeMinutes: 60, resendWaitSeconds: 90 };

const TERMS = "11111111-1111-4111-8111-111111111111";
const PRIVACY = "22222222-2222-4222-8222-222222222222";
const HISTORY = "33333333-3333-4333-8333-333333333333";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}
const emailForm = (email: string) => form([["email", email]]);
const completeForm = (extra: [string, string][] = []) =>
  form([
    ["token", TOKEN],
    ["name", "Ana Prueba"],
    ["password", "una clave larga"],
    ["adult", "on"],
    ["shown", `terms=${TERMS}`],
    ["shown", `student_privacy_notice=${PRIVACY}`],
    ["shown", `course_history_consent=${HISTORY}`],
    ["accept:legal", "on"],
    ["accept:course_history_consent", "on"],
    ...extra,
  ]);

/** Lo que contesta la siguiente llamada a esa simulación. */
function once(name: keyof typeof mocks, answer: unknown): void {
  calls.next.set(name, [...(calls.next.get(name) ?? []), answer]);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order = [];
  calls.next.clear();
  // Lo que las pantallas recuerdan de la base no pasa de un caso al siguiente.
  forgetFormFacts();
  mocks.cookieJar.mockResolvedValue(jar);
  mocks.requestOrigin.mockResolvedValue(origin);
});

describe("pedir el registro (PA-10)", () => {
  it.each([
    ["", "required"],
    ["   ", "required"],
    ["ana", "invalid"],
  ])("un correo que no se puede mandar (%j) no llega al servicio", async (email, field) => {
    expect(await requestRegistrationAction(IDLE, emailForm(email))).toEqual({ kind: "invalid", email, field, attempt: 1 });
    expect(calls.order).toEqual([]);
  });

  it("lo que no es un formulario cuenta como un correo vacío", async () => {
    expect(await requestRegistrationAction(IDLE, "email=ana@prueba.test" as unknown as FormData)).toMatchObject({
      kind: "invalid",
      field: "required",
    });
    expect(mocks.requestRegistration).not.toHaveBeenCalled();
  });

  it("aceptado: anota el correo en la cookie corta, con la vida del enlace, y va a «Revisa tu correo»", async () => {
    once("accountFormFacts", facts);
    const before = Date.now();
    await expect(requestRegistrationAction(IDLE, emailForm(" Ana@Prueba.test "))).rejects.toThrow("redirige a /verificar");
    expect(mocks.requestRegistration).toHaveBeenCalledExactlyOnceWith({ email: " Ana@Prueba.test " }, origin);
    expect(mocks.rememberRegistration).toHaveBeenCalledOnce();
    const [toJar, pending, maxAge] = mocks.rememberRegistration.mock.calls[0] as [unknown, { email: string; sentAt: number }, number];
    expect(toJar).toBe(jar);
    expect(pending.email).toBe(" Ana@Prueba.test ");
    expect(pending.sentAt).toBeGreaterThanOrEqual(before);
    expect(pending.sentAt).toBeLessThanOrEqual(Date.now());
    expect(maxAge).toBe(3_600);
    // Los parámetros se leen después de pedir el correo, nunca antes.
    expect(calls.order).toEqual(["requestRegistration", "accountFormFacts", "rememberRegistration", "redirect"]);
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each([{ kind: "unavailable" }, { kind: "no_current_text" }])(
    "aceptado sin saber cuánto dura el enlace (%j): no anota nada, y va a la misma pantalla",
    async (answer) => {
      once("accountFormFacts", answer);
      await expect(requestRegistrationAction(IDLE, emailForm("ana@prueba.test"))).rejects.toThrow("redirige a /verificar");
      expect(mocks.rememberRegistration).not.toHaveBeenCalled();
      expect(mocks.forgetRegistration).not.toHaveBeenCalled();
    },
  );

  it("aceptado sin saber cuánto dura, con otro correo anotado de antes: lo olvida, para no decir que el enlace se mandó ahí", async () => {
    once("accountFormFacts", { kind: "unavailable" });
    once("readRegistration", { email: "otra@prueba.test", sentAt: 1 });
    await expect(requestRegistrationAction(IDLE, emailForm("ana@prueba.test"))).rejects.toThrow("redirige a /verificar");
    expect(mocks.forgetRegistration).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.rememberRegistration).not.toHaveBeenCalled();
    expect(calls.order).toEqual(["requestRegistration", "accountFormFacts", "readRegistration", "forgetRegistration", "redirect"]);
  });

  it("aceptado sin saber cuánto dura, con ese mismo correo ya anotado: lo deja", async () => {
    once("accountFormFacts", { kind: "unavailable" });
    once("readRegistration", { email: "ana@prueba.test", sentAt: 1 });
    await expect(requestRegistrationAction(IDLE, emailForm(" Ana@Prueba.test "))).rejects.toThrow("redirige a /verificar");
    expect(mocks.forgetRegistration).not.toHaveBeenCalled();
  });

  it.each(["wait", "unavailable"] as const)("%s: lo dice, conserva el correo y no anota ni redirige", async (reason) => {
    once("requestRegistration", { kind: reason });
    expect(await requestRegistrationAction(IDLE, emailForm("ana@prueba.test"))).toEqual({
      kind: "failed",
      email: "ana@prueba.test",
      reason,
      attempt: 1,
    });
    expect(calls.order).toEqual(["requestRegistration"]);
  });

  it("un correo que el servicio no acepta se marca en el campo", async () => {
    once("requestRegistration", { kind: "invalid_email", reason: "malformed" });
    expect(await requestRegistrationAction(IDLE, emailForm("ana@prueba.test"))).toEqual({
      kind: "invalid",
      email: "ana@prueba.test",
      field: "invalid",
      attempt: 1,
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("del estado anterior solo lee el número de intento", async () => {
    const previous = { kind: "sent", attempt: 4, email: "otro@prueba.test", lifetimeSeconds: 1 } as never;
    expect(await requestRegistrationAction(previous, emailForm(""))).toEqual({ kind: "invalid", email: "", field: "required", attempt: 5 });
  });
});

describe("«Reenviar» (PA-14)", () => {
  it("sin correo anotado no hay a quién reenviar: vuelve al registro sin pedirle nada al servicio", async () => {
    await expect(resendAction(IDLE)).rejects.toThrow("redirige a /registro");
    expect(mocks.readRegistration).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.requestRegistration).not.toHaveBeenCalled();
    expect(mocks.rememberRegistration).not.toHaveBeenCalled();
  });

  it("pide el registro con el correo anotado, y con ningún otro", async () => {
    once("readRegistration", { email: "ana@prueba.test", sentAt: 1 });
    once("accountFormFacts", facts);
    const state = await resendAction(IDLE);
    expect(mocks.requestRegistration).toHaveBeenCalledExactlyOnceWith({ email: "ana@prueba.test" }, origin);
    expect(state).toMatchObject({ kind: "sent", attempt: 1, wait: { seconds: 90 } });
    // La cookie se vuelve a escribir, con la hora de este envío.
    expect(mocks.rememberRegistration).toHaveBeenCalledOnce();
    expect(mocks.rememberRegistration.mock.calls[0]?.[1]).toMatchObject({ email: "ana@prueba.test" });
    expect(calls.order).toEqual(["readRegistration", "requestRegistration", "accountFormFacts", "rememberRegistration"]);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("la espera que contesta termina cuando pasa `ESPERA_REENVIO` desde ahora", async () => {
    once("readRegistration", { email: "ana@prueba.test", sentAt: 1 });
    once("accountFormFacts", facts);
    // Un tiempo, no una hora: el navegador lo deja pasar sin comparar relojes.
    expect(await resendAction(IDLE)).toEqual({ kind: "sent", wait: { remainingMs: 90_000, seconds: 90 }, attempt: 1 });
  });

  it("aceptado sin saber la espera: lo dice igual, y no vuelve a escribir la cookie", async () => {
    once("readRegistration", { email: "ana@prueba.test", sentAt: 1 });
    expect(await resendAction({ kind: "sent", wait: null, attempt: 2 })).toEqual({ kind: "sent", wait: null, attempt: 3 });
    expect(mocks.rememberRegistration).not.toHaveBeenCalled();
    // El correo anotado es el mismo al que se reenvió: se queda.
    expect(mocks.forgetRegistration).not.toHaveBeenCalled();
  });

  it.each(["wait", "unavailable"] as const)("%s: lo dice, y la cookie se queda como estaba", async (reason) => {
    once("readRegistration", { email: "ana@prueba.test", sentAt: 1 });
    once("requestRegistration", { kind: reason });
    expect(await resendAction(IDLE)).toEqual({ kind: "failed", reason, attempt: 1 });
    expect(mocks.rememberRegistration).not.toHaveBeenCalled();
    expect(mocks.forgetRegistration).not.toHaveBeenCalled();
  });

  it("si lo anotado no es un correo al que se pueda mandar nada, se olvida y se vuelve al registro", async () => {
    once("readRegistration", { email: "ana@prueba.test", sentAt: 1 });
    once("requestRegistration", { kind: "invalid_email", reason: "malformed" });
    await expect(resendAction(IDLE)).rejects.toThrow("redirige a /registro");
    expect(mocks.forgetRegistration).toHaveBeenCalledExactlyOnceWith(jar);
    expect(calls.order).toEqual(["readRegistration", "requestRegistration", "forgetRegistration", "redirect"]);
  });
});

describe("«Ese no es mi correo» (PA-14)", () => {
  it("olvida el correo anotado y vuelve al registro, sin pedirle nada a nadie", async () => {
    await expect(notMyEmailAction()).rejects.toThrow("redirige a /registro");
    expect(mocks.forgetRegistration).toHaveBeenCalledExactlyOnceWith(jar);
    expect(calls.order).toEqual(["forgetRegistration", "redirect"]);
  });
});

describe("completar la cuenta desde el enlace (PA-14)", () => {
  it.each(["", "corto", "con espacio dentro", "x".repeat(257)])(
    "una huella sin forma de enlace (%j) no se le pregunta a nadie",
    async (token) => {
      const data = completeForm();
      data.set("token", token);
      expect(await completeRegistrationAction(IDLE, data)).toEqual({ kind: "link_dead" });
      expect(calls.order).toEqual([]);
    },
  );

  it("le pasa al servicio la huella, los datos y los textos que se pintaron junto a cada casilla marcada", async () => {
    await completeRegistrationAction(IDLE, completeForm());
    expect(mocks.completeRegistration).toHaveBeenCalledExactlyOnceWith(
      jar,
      { tokenHash: TOKEN, name: "Ana Prueba", password: "una clave larga", adultDeclared: true, accepted: [TERMS, PRIVACY, HISTORY] },
      origin,
    );
  });

  it("una casilla sin marcar no acepta su texto", async () => {
    const data = completeForm();
    data.delete("accept:course_history_consent");
    data.delete("adult");
    await completeRegistrationAction(IDLE, data);
    expect(mocks.completeRegistration.mock.calls[0]?.[1]).toMatchObject({ adultDeclared: false, accepted: [TERMS, PRIVACY] });
  });

  it("quedó dentro: olvida el correo anotado y va al inicio", async () => {
    once("completeRegistration", { kind: "entered", pending: null });
    await expect(completeRegistrationAction(IDLE, completeForm())).rejects.toThrow("redirige a /inicio");
    expect(mocks.forgetRegistration).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
    // La sesión recién abierta no se cierra.
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(calls.order).toEqual(["completeRegistration", "forgetRegistration", "redirect"]);
  });

  it("quedó dentro y le falta algo: va a completarlo", async () => {
    const pending = { variant: "updated_texts", missing: { name: false, adultDeclaration: false, documents: [] } };
    once("completeRegistration", { kind: "entered", pending });
    await expect(completeRegistrationAction(IDLE, completeForm())).rejects.toThrow("redirige a /consentimientos");
  });

  it("la cuenta quedó lista y solo falló abrir la sesión: a entrar, con su aviso", async () => {
    once("completeRegistration", { kind: "ready_sign_in" });
    await expect(completeRegistrationAction(IDLE, completeForm())).rejects.toThrow("redirige a /entrar");
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "account_ready");
    expect(mocks.forgetRegistration).toHaveBeenCalledExactlyOnceWith(jar);
  });

  it("un texto cambió: pide la página de nuevo y lo avisa, sin canjear nada más", async () => {
    once("completeRegistration", { kind: "texts_changed" });
    expect(await completeRegistrationAction(IDLE, completeForm())).toEqual({ kind: "repainted", name: "Ana Prueba", attempt: 1 });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.forgetRegistration).not.toHaveBeenCalled();
  });

  it.each(["texts_changed", "texts_unavailable"] as const)(
    "%s: lo que se recordaba de los textos se olvida, y la página vuelve a leerlos",
    async (kind) => {
      once("accountFormFacts", facts);
      await formFacts();
      once("completeRegistration", { kind });
      await completeRegistrationAction(IDLE, completeForm());
      await formFacts();
      expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["unavailable", "link_dead", "recover_instead"] as const)("%s: lo recordado se queda", async (kind) => {
    once("accountFormFacts", facts);
    await formFacts();
    once("completeRegistration", { kind });
    await completeRegistrationAction(IDLE, completeForm());
    await formFacts();
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });

  it("datos por corregir: dice cuáles, con las casillas que faltaron, y no pide la página de nuevo", async () => {
    once("completeRegistration", { kind: "invalid", fields: { name: "too_long" } });
    const data = completeForm();
    data.delete("accept:legal");
    expect(await completeRegistrationAction(IDLE, data)).toEqual({
      kind: "invalid",
      name: "Ana Prueba",
      fields: { name: "too_long", boxes: ["accept:legal"] },
      attempt: 1,
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("no se supo: lo dice y conserva el nombre", async () => {
    expect(await completeRegistrationAction({ kind: "unavailable", name: "x", attempt: 2 }, completeForm())).toEqual({
      kind: "unavailable",
      name: "Ana Prueba",
      attempt: 3,
    });
  });

  it.each(["link_dead", "recover_instead", "texts_unavailable"] as const)("%s: la pantalla de ese estado, sin redirigir ni olvidar el correo", async (kind) => {
    once("completeRegistration", { kind });
    expect(await completeRegistrationAction(IDLE, completeForm())).toEqual({ kind });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.forgetRegistration).not.toHaveBeenCalled();
  });

  it("la contraseña nunca vuelve en la respuesta, conteste lo que conteste el servicio", async () => {
    const answers = [
      { kind: "invalid", fields: { password: "too_short", name: "empty", adult: "required", texts: "required" } },
      { kind: "texts_changed" },
      { kind: "unavailable" },
      { kind: "link_dead" },
      { kind: "recover_instead" },
      { kind: "texts_unavailable" },
    ];
    for (const answer of answers) {
      once("completeRegistration", answer);
      const state = await completeRegistrationAction(IDLE, completeForm([["password", "otra-clave-secreta"]]));
      expect(JSON.stringify(state)).not.toContain("clave");
      expect(JSON.stringify(state)).not.toContain(TOKEN);
    }
  });
});

describe("pedir la recuperación (PA-13)", () => {
  it("el aviso con el que se llegó se borra con cualquier envío", async () => {
    await requestRecoveryAction(IDLE, emailForm(""));
    expect(mocks.clearNotice).toHaveBeenCalledExactlyOnceWith(jar);
    vi.clearAllMocks();
    mocks.cookieJar.mockResolvedValue(jar);
    await requestRecoveryAction(IDLE, emailForm("ana@prueba.test"));
    expect(mocks.clearNotice).toHaveBeenCalledExactlyOnceWith(jar);
  });

  it.each([
    ["", "required"],
    ["ana", "invalid"],
  ])("un correo que no se puede mandar (%j) no llega al servicio", async (email, field) => {
    expect(await requestRecoveryAction(IDLE, emailForm(email))).toEqual({ kind: "invalid", email, field, attempt: 1 });
    expect(mocks.requestRecovery).not.toHaveBeenCalled();
  });

  it("aceptado: el mensaje único con lo que dura el enlace, sin repetir el correo y sin cambiar de pantalla", async () => {
    once("accountFormFacts", facts);
    const state = await requestRecoveryAction(IDLE, emailForm("ana@prueba.test"));
    expect(mocks.requestRecovery).toHaveBeenCalledExactlyOnceWith({ email: "ana@prueba.test" }, origin);
    expect(state).toEqual({ kind: "sent", lifetimeSeconds: 3_600, attempt: 1 });
    expect(JSON.stringify(state)).not.toContain("ana@");
    // Los parámetros se leen después de pedir el correo, nunca antes.
    expect(calls.order).toEqual(["clearNotice", "requestRecovery", "accountFormFacts"]);
    expect(mocks.redirect).not.toHaveBeenCalled();
    // No es un registro: no anota ningún correo en el navegador.
    expect(mocks.rememberRegistration).not.toHaveBeenCalled();
    expect(mocks.requestRegistration).not.toHaveBeenCalled();
  });

  it("aceptado sin saber cuánto dura el enlace: el mismo mensaje, sin la cifra", async () => {
    expect(await requestRecoveryAction(IDLE, emailForm("ana@prueba.test"))).toEqual({ kind: "sent", lifetimeSeconds: null, attempt: 1 });
  });

  it.each(["wait", "unavailable"] as const)("%s: lo dice y conserva el correo", async (reason) => {
    once("requestRecovery", { kind: reason });
    expect(await requestRecoveryAction(IDLE, emailForm("ana@prueba.test"))).toEqual({
      kind: "failed",
      email: "ana@prueba.test",
      reason,
      attempt: 1,
    });
    expect(mocks.accountFormFacts).not.toHaveBeenCalled();
  });
});

describe("cambiar la contraseña desde el enlace (PA-13)", () => {
  const changeForm = (token = TOKEN, password = "una clave larga") => form([["token", token], ["password", password]]);

  it.each(["", "corto", "con espacio dentro", "x".repeat(257)])(
    "una huella sin forma de enlace (%j) no se le pregunta a nadie",
    async (token) => {
      expect(await completeRecoveryAction(IDLE, changeForm(token))).toEqual({ kind: "link_dead" });
      expect(calls.order).toEqual([]);
    },
  );

  it("le pasa al servicio la huella y la contraseña, tal como llegó", async () => {
    await completeRecoveryAction(IDLE, changeForm(TOKEN, "  con espacios  "));
    // Con el tarro del navegador: ahí se queda el resguardo del buzón.
    expect(mocks.completeRecovery).toHaveBeenCalledExactlyOnceWith({ tokenHash: TOKEN, password: "  con espacios  " }, origin, jar);
  });

  it("hecho: cierra la sesión de este navegador, sea de quien sea, y va a entrar con el aviso", async () => {
    once("completeRecovery", { kind: "done" });
    await expect(completeRecoveryAction(IDLE, changeForm())).rejects.toThrow("redirige a /entrar");
    // Con otra cuenta abierta, la pantalla de entrar mandaría a su inicio y el aviso no se vería.
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(jar);
    expect(mocks.leaveNotice).toHaveBeenCalledExactlyOnceWith(jar, "password_changed");
    expect(calls.order).toEqual(["completeRecovery", "signOut", "leaveNotice", "redirect"]);
  });

  it.each(["link_dead", "request_new_link", "unavailable"] as const)("%s: no cierra ninguna sesión", async (kind) => {
    once("completeRecovery", { kind });
    await completeRecoveryAction(IDLE, changeForm());
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each(["too_short", "too_long", "malformed"] as const)("contraseña que no cumple la regla (%s): el error en su campo", async (reason) => {
    once("completeRecovery", { kind: "invalid", reason });
    expect(await completeRecoveryAction(IDLE, changeForm())).toEqual({ kind: "invalid", problem: reason, attempt: 1 });
  });

  it("no se supo: lo dice, con su número de intento", async () => {
    expect(await completeRecoveryAction({ kind: "unavailable", attempt: 6 }, changeForm())).toEqual({ kind: "unavailable", attempt: 7 });
  });

  it.each(["link_dead", "request_new_link"] as const)("%s: la pantalla de ese estado, sin redirigir ni dejar aviso", async (kind) => {
    once("completeRecovery", { kind });
    expect(await completeRecoveryAction(IDLE, changeForm())).toEqual({ kind });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.leaveNotice).not.toHaveBeenCalled();
  });

  it("la contraseña nunca vuelve en la respuesta", async () => {
    for (const answer of [{ kind: "invalid", reason: "too_short" }, { kind: "unavailable" }, { kind: "link_dead" }, { kind: "request_new_link" }]) {
      once("completeRecovery", answer);
      const state = await completeRecoveryAction(IDLE, changeForm(TOKEN, "otra-clave-secreta"));
      expect(JSON.stringify(state)).not.toContain("clave");
      expect(JSON.stringify(state)).not.toContain(TOKEN);
    }
  });
});

describe("lo que se lee de los parámetros después de pedir un correo", () => {
  it("lo que dura un enlace, en segundos", async () => {
    once("accountFormFacts", { ...facts, linkLifetimeMinutes: 15 });
    expect(await linkLifetimeSeconds()).toBe(900);
  });

  it.each([{ kind: "unavailable" }, { kind: "no_current_text" }])("si no se supo (%j), nulo", async (answer) => {
    once("accountFormFacts", answer);
    expect(await linkLifetimeSeconds()).toBeNull();
    forgetFormFacts();
    once("accountFormFacts", answer);
    expect(await pendingRequestFacts(Date.now())).toBeNull();
  });

  it("de un registro anotado: lo que dura el enlace y la espera que le queda a «Reenviar»", async () => {
    once("accountFormFacts", facts);
    const pending = await pendingRequestFacts(Date.now() - 10_000);
    expect(pending).toMatchObject({ lifetimeSeconds: 3_600, wait: { seconds: 90 } });
    expect(pending?.wait?.remainingMs).toBeGreaterThan(79_000);
    expect(pending?.wait?.remainingMs).toBeLessThanOrEqual(80_000);
    expect(await pendingRequestFacts(Date.now() - 91_000)).toEqual({ lifetimeSeconds: 3_600, wait: null });
  });
});

describe("lo que las pantallas públicas recuerdan de la base", () => {
  const T0 = Date.parse("2026-10-11T18:00:00.000Z");

  it("se lee a lo más una vez cada tanto: pasado ese tiempo, se vuelve a leer", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      once("accountFormFacts", facts);
      expect(await formFacts()).toBe(facts);
      vi.setSystemTime(T0 + FORM_FACTS_MEMORY_MS - 1);
      expect(await formFacts()).toBe(facts);
      expect(mocks.accountFormFacts).toHaveBeenCalledOnce();

      vi.setSystemTime(T0 + FORM_FACTS_MEMORY_MS);
      const newer = { ...facts, minimumAge: 21 };
      once("accountFormFacts", newer);
      expect(await formFacts()).toBe(newer);
      expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("también recuerda que no se supo: una base caída no recibe una lectura por visita", async () => {
    once("accountFormFacts", { kind: "unavailable" });
    expect(await formFacts()).toEqual({ kind: "unavailable" });
    expect(await formFacts()).toEqual({ kind: "unavailable" });
    expect(await linkLifetimeSeconds()).toBeNull();
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });

  it("muchos que piden a la vez comparten una sola lectura", async () => {
    let release: (value: unknown) => void = () => undefined;
    once("accountFormFacts", new Promise((resolve) => (release = resolve)));
    const asked = [formFacts(), formFacts(), linkLifetimeSeconds()];
    release(facts);
    expect(await Promise.all(asked)).toEqual([facts, facts, 3_600]);
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });

  it("olvidar lo recordado hace que la siguiente lectura llegue a la base", async () => {
    once("accountFormFacts", facts);
    await formFacts();
    forgetFormFacts();
    await formFacts();
    expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
  });

  it("con el reloj echado atrás no se queda con lo recordado para siempre", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      once("accountFormFacts", facts);
      await formFacts();
      vi.setSystemTime(T0 - 60_000);
      await formFacts();
      expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anotar un registro usa lo recordado, sin otra lectura", async () => {
    once("accountFormFacts", facts);
    await formFacts();
    expect(await rememberRequest(jar, "ana@prueba.test")).toEqual({ remainingMs: 90_000, seconds: 90 });
    expect(mocks.rememberRegistration).toHaveBeenCalledOnce();
    expect(mocks.accountFormFacts).toHaveBeenCalledOnce();
  });
});

describe("entrar (PA-11), con un registro a medias anotado en el navegador", () => {
  const signInForm = () => form([["email", "ana@prueba.test"], ["password", "una clave larga"]]);

  it("quien entra ya no tiene un correo por revisar: se olvida antes de irse", async () => {
    once("signIn", { kind: "entered", pending: null });
    await expect(signInAction(IDLE, signInForm())).rejects.toThrow("redirige a /inicio");
    expect(mocks.forgetRegistration).toHaveBeenCalledExactlyOnceWith(jar);
    expect(calls.order).toEqual(["clearNotice", "signIn", "forgetRegistration", "redirect"]);
  });

  it.each(["invalid_credentials", "capped", "unavailable"] as const)("%s: no entró, y lo anotado se queda", async (kind) => {
    once("signIn", { kind });
    expect(await signInAction(IDLE, signInForm())).toMatchObject({ kind: "failed", reason: kind });
    expect(mocks.forgetRegistration).not.toHaveBeenCalled();
  });
});

describe("lo recordado de la base, cuando se olvida con una lectura en camino", () => {
  it("una lectura que empezó antes de olvidar se entrega, pero no se recuerda", async () => {
    let release: (value: unknown) => void = () => undefined;
    once("accountFormFacts", new Promise((resolve) => (release = resolve)));
    const early = formFacts();
    // El servicio acaba de decir que un texto cambió: esa lectura pudo empezar antes.
    forgetFormFacts();
    release(facts);
    expect(await early).toBe(facts);

    const newer = { ...facts, minimumAge: 21 };
    once("accountFormFacts", newer);
    expect(await formFacts()).toBe(newer);
    expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
  });

  it("quien pregunta después de olvidar no se cuelga de la lectura que ya venía: empieza otra, y es la que se recuerda", async () => {
    let releaseOld: (value: unknown) => void = () => undefined;
    once("accountFormFacts", new Promise((resolve) => (releaseOld = resolve)));
    const early = formFacts();
    forgetFormFacts();

    const newer = { ...facts, minimumAge: 21 };
    once("accountFormFacts", newer);
    expect(await formFacts()).toBe(newer);
    // La vieja termina después: no pisa lo que se recordó, ni suelta la lectura de nadie.
    releaseOld(facts);
    expect(await early).toBe(facts);
    expect(await formFacts()).toBe(newer);
    expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
  });

  it("si la lectura revienta, no se recuerda nada roto: la siguiente vuelve a leer", async () => {
    once("accountFormFacts", Promise.reject(new Error("la base se cayó a media lectura")));
    await expect(formFacts()).rejects.toThrow("la base se cayó");
    once("accountFormFacts", facts);
    expect(await formFacts()).toBe(facts);
    expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
  });
});

describe("dos lecturas en camino a la vez", () => {
  it("la vieja, al terminar, no suelta la nueva: quien llega después se cuelga de la nueva y no empieza una tercera", async () => {
    let releaseOld: (value: unknown) => void = () => undefined;
    let releaseNew: (value: unknown) => void = () => undefined;
    once("accountFormFacts", new Promise((resolve) => (releaseOld = resolve)));
    const early = formFacts();
    forgetFormFacts();
    once("accountFormFacts", new Promise((resolve) => (releaseNew = resolve)));
    const second = formFacts();

    releaseOld(facts);
    expect(await early).toBe(facts);
    // La nueva sigue en camino: la tercera petición la comparte.
    const third = formFacts();
    const newer = { ...facts, minimumAge: 21 };
    releaseNew(newer);
    expect(await Promise.all([second, third])).toEqual([newer, newer]);
    expect(mocks.accountFormFacts).toHaveBeenCalledTimes(2);
  });
});
