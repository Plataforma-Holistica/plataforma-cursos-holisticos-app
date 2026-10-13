import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMailboxTickets, MAILBOX_TICKET_MAX_AGE_LIMIT } from "./mailbox-ticket";

function jarOf(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: { name: string; value: string; options: Record<string, unknown> }[] = [];
  return {
    writes,
    get: (name: string) => values.get(name),
    set(name: string, value: string, options: { maxAge: number }) {
      writes.push({ name, value, options: { ...options } });
      if (options.maxAge === 0) values.delete(name);
      else values.set(name, value);
    },
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("el resguardo del buzón", () => {
  it("es un secreto de 32 bytes que nadie más eligió, y su huella es su SHA-256 en hexadecimal", () => {
    const asked: number[] = [];
    const tickets = createMailboxTickets({
      secure: () => true,
      random: (size) => {
        asked.push(size);
        return Buffer.alloc(size, 0xab);
      },
    });
    const ticket = tickets.issueTicket();
    expect(asked).toEqual([32]);
    expect(ticket.secret).toBe(Buffer.alloc(32, 0xab).toString("base64url"));
    expect(ticket.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket.print).toBe(sha256(ticket.secret));
    expect(ticket.print).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dos resguardos no se parecen", () => {
    const tickets = createMailboxTickets({ secure: () => true });
    const first = tickets.issueTicket();
    const second = tickets.issueTicket();
    expect(first.secret).not.toBe(second.secret);
    expect(first.print).not.toBe(second.print);
  });

  it("lo que se deja en el navegador es el secreto, y lo que se lee de vuelta es su huella", () => {
    const tickets = createMailboxTickets({ secure: () => true });
    const jar = jarOf();
    const ticket = tickets.issueTicket();
    expect(tickets.keepTicket(jar, ticket, 3600)).toBe(true);
    expect(jar.writes).toEqual([
      {
        name: "__Host-plataforma-resguardo",
        value: ticket.secret,
        options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 },
      },
    ]);
    expect(jar.writes[0]?.value).not.toContain(ticket.print);
    expect(tickets.readTicketPrint(jar)).toBe(ticket.print);
  });

  it("sin https no lleva el prefijo, que un navegador rechazaría", () => {
    const tickets = createMailboxTickets({ secure: () => false });
    const jar = jarOf();
    tickets.keepTicket(jar, tickets.issueTicket(), 60);
    expect(jar.writes[0]).toMatchObject({ name: "plataforma-resguardo", options: { secure: false, httpOnly: true } });
  });

  it("dura lo que diga la base, con un tope", () => {
    const tickets = createMailboxTickets({ secure: () => true });
    const jar = jarOf();
    tickets.keepTicket(jar, tickets.issueTicket(), 128_849_018_820);
    expect(jar.writes[0]?.options.maxAge).toBe(MAILBOX_TICKET_MAX_AGE_LIMIT);
  });

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("sin una duración que valga (%s) no deja nada", (seconds) => {
    const tickets = createMailboxTickets({ secure: () => true });
    const jar = jarOf();
    expect(tickets.keepTicket(jar, tickets.issueTicket(), seconds)).toBe(false);
    expect(jar.writes).toEqual([]);
  });

  it.each([
    ["nada", undefined],
    ["vacío", ""],
    ["más corto", "a".repeat(42)],
    ["más largo", "a".repeat(44)],
    ["con un carácter que no es de base64url", `${"a".repeat(42)}+`],
    ["una huella en vez del secreto", "0".repeat(64)],
  ])("lo que no tiene forma de resguardo (%s) cuenta como ausente", (_name, value) => {
    const tickets = createMailboxTickets({ secure: () => true });
    const jar = jarOf(value === undefined ? {} : { "__Host-plataforma-resguardo": value });
    expect(tickets.readTicketPrint(jar)).toBeNull();
  });

  it("la cookie con el otro nombre no se lee", () => {
    const tickets = createMailboxTickets({ secure: () => true });
    expect(tickets.readTicketPrint(jarOf({ "plataforma-resguardo": "a".repeat(43) }))).toBeNull();
  });

  it("al gastarse se borra, y si no había nada no escribe", () => {
    const tickets = createMailboxTickets({ secure: () => true });
    const jar = jarOf();
    tickets.dropTicket(jar);
    expect(jar.writes).toEqual([]);

    tickets.keepTicket(jar, tickets.issueTicket(), 60);
    tickets.dropTicket(jar);
    expect(jar.writes.at(-1)).toEqual({
      name: "__Host-plataforma-resguardo",
      value: "",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 },
    });
    expect(tickets.readTicketPrint(jar)).toBeNull();
  });
});
