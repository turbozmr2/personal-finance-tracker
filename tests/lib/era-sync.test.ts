import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { accounts, imports, transactions } from "@/lib/db/schema";
import {
  createEraClient,
  ERA_DEFAULT_URL,
  eraConfigFromEnv,
  type FetchFn,
  parseMessages,
  REJECTED_ERROR,
} from "@/lib/era/client";
import { centsToDecimal, planFor, toCents, toMappedRow } from "@/lib/era/map";
import { getEraConnection } from "@/lib/era/store";
import { OVERLAP_DAYS, runEraSync } from "@/lib/era/sync";
import type { EraAccount, EraTransaction } from "@/lib/era/types";
import { listSnapshots } from "@/lib/networth/store";
import { mustFind } from "../helpers";

const KEY = "era_test_key_123";
const NOW = new Date("2026-09-20T15:00:00Z");

const acct = (
  key: string,
  type: string,
  current: number,
  currency = "USD",
): EraAccount => ({
  account_group_key: key,
  name: `Acme ${type}`,
  institution: "Acme Bank",
  type,
  balance: { current, currency },
  balance_as_of: "2026-09-20T10:00:00Z",
});

const txn = (
  id: string,
  key: string,
  date: string,
  amount: number,
  desc: string,
  pending = false,
): EraTransaction => ({
  transaction_id: id,
  account_group_key: key,
  amount,
  currency: "USD",
  description: desc,
  original_description: `${desc.toUpperCase()} SPRINGFIELD`,
  transaction_date: date,
  posted_date: pending ? null : date,
  is_pending: pending,
});

type Call = { name: string; args: Record<string, unknown> };

/** A fake Era MCP server: session handshake, then canned tool results. */
function fakeEra(
  data: { accounts: EraAccount[]; transactions: EraTransaction[] },
  opts: { status?: number; sse?: boolean } = {},
) {
  const calls: Call[] = [];
  const auth: string[] = [];
  const fetchFn: FetchFn = async (_url, init) => {
    auth.push(
      String(
        (init?.headers as Record<string, string> | undefined)?.authorization,
      ),
    );
    if (opts.status) return new Response("nope", { status: opts.status });
    const msg = JSON.parse(String(init?.body));
    if (msg.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let result: unknown;
    if (msg.method === "initialize") result = { protocolVersion: "2025-06-18" };
    else {
      const { name, arguments: args } = msg.params;
      calls.push({ name, args });
      let payload: unknown;
      if (name === "accounts__list_financial_accounts")
        payload = { accounts: data.accounts };
      else {
        const from = args.from_date as string | undefined;
        const rows = data.transactions.filter(
          (t) => !from || (t.transaction_date ?? "") >= from,
        );
        const size = args.page_size as number;
        const page = args.page as number;
        payload = {
          transactions: rows.slice((page - 1) * size, page * size),
          pagination: { has_more: page * size < rows.length },
        };
      }
      result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    return opts.sse
      ? new Response(`event: message\ndata: ${body}\n\n`, {
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "s1",
          },
        })
      : new Response(body, {
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "s1",
          },
        });
  };
  return { fetchFn, calls, auth };
}

/** The newest balance snapshot of one account. */
const balanceOf = (db: ReturnType<typeof openDb>, accountId: number) =>
  listSnapshots(db)
    .filter((s) => s.accountId === accountId)
    .at(-1);

const client = (f: FetchFn) =>
  createEraClient(f, { url: ERA_DEFAULT_URL, apiKey: KEY });

describe("era map", () => {
  it("plans accounts by type and currency", () => {
    expect(planFor(acct("a", "Checking", 1))).toEqual({
      kind: "sync",
      type: "checking",
      transactions: true,
    });
    expect(planFor(acct("a", "CreditCard", 1))).toMatchObject({
      type: "credit",
      transactions: true,
    });
    expect(planFor(acct("a", "Brokerage", 1))).toMatchObject({
      type: "investment",
      transactions: false,
    });
    expect(planFor(acct("a", "Mortgage", 1))).toMatchObject({ type: "loan" });
    expect(planFor(acct("a", "Checking", 1, "GBP")).kind).toBe("skip");
    expect(planFor(acct("a", "RealEstate", 1)).kind).toBe("skip");
  });

  it("converts amounts to cents and back without float drift", () => {
    expect(toCents(0.14)).toBe(14);
    expect(toCents(-3229.18)).toBe(-322918);
    expect(toCents(7695.29)).toBe(769529);
    expect(toCents(Number.NaN)).toBeNull();
    expect(centsToDecimal(-1205)).toBe("-12.05");
    expect(centsToDecimal(7)).toBe("0.07");
  });

  it("maps a transaction, preferring the raw description", () => {
    const r = toMappedRow(txn("t1", "a", "2026-09-01", -9.73, "Acme Cafe"));
    expect(r).toMatchObject({
      ok: true,
      row: {
        externalId: "t1",
        pending: false,
        row: {
          date: "2026-09-01",
          amountCents: -973,
          rawDescription: "ACME CAFE SPRINGFIELD",
        },
      },
    });
    expect(
      toMappedRow({ ...txn("t2", "a", "x", 1, "y"), posted_date: null }).ok,
    ).toBe(false);
  });
});

describe("era client", () => {
  it("reads config from the environment", () => {
    expect(eraConfigFromEnv({})).toBeNull();
    expect(eraConfigFromEnv({ ERA_API_KEY: " k " })).toEqual({
      apiKey: "k",
      url: ERA_DEFAULT_URL,
    });
  });

  it("parses server-sent events", () => {
    const msgs = parseMessages(
      'event: message\ndata: {"id":1,"result":2}\n\n',
      "text/event-stream",
    );
    expect(msgs).toEqual([{ id: 1, result: 2 }]);
  });

  it("sends the key as a bearer token and handles SSE replies", async () => {
    const era = fakeEra({ accounts: [], transactions: [] }, { sse: true });
    const c = client(era.fetchFn);
    await expect(
      c.callTool("accounts__list_financial_accounts", {}),
    ).resolves.toEqual({ accounts: [] });
    expect(era.auth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
    expect(c.calls()).toBe(1);
  });

  it("reports a rejected key without echoing it", async () => {
    const era = fakeEra({ accounts: [], transactions: [] }, { status: 401 });
    const db = openDb(":memory:");
    const r = await runEraSync(db, client(era.fetchFn), { now: NOW });
    expect(r).toEqual({ ok: false, error: REJECTED_ERROR });
    expect(JSON.stringify(getEraConnection(db, true))).not.toContain(KEY);
  });
});

describe("runEraSync", () => {
  const data = {
    accounts: [
      acct("chk", "Checking", 1234.5),
      acct("card", "CreditCard", 250),
      acct("brk", "Brokerage", 10000),
      acct("gbp", "Checking", 99, "GBP"),
    ],
    transactions: [
      txn("t1", "chk", "2026-09-01", 2000, "Acme Payroll"),
      txn("t2", "chk", "2026-09-02", -45.5, "Acme Grocer"),
      txn("t3", "card", "2026-09-03", -12.34, "Acme Cafe"),
      txn("t4", "card", "2026-09-19", -8, "Acme Cafe", true),
      txn("t5", "brk", "2026-09-04", -100, "Bought Acme Fund"),
      txn("t6", "gbp", "2026-09-04", -5, "Acme Pub"),
    ],
  };

  it("links accounts and imports rows and balances on the first sync", async () => {
    const db = openDb(":memory:");
    const era = fakeEra(data);
    const r = await runEraSync(db, client(era.fetchFn), { now: NOW });
    expect(r.ok).toBe(true);

    const made = db.select().from(accounts).all();
    expect(made.map((a) => [a.name, a.type])).toEqual([
      ["Acme Checking", "checking"],
      ["Acme CreditCard", "credit"],
      ["Acme Brokerage", "investment"],
    ]);
    const rows = db.select().from(transactions).all();
    // Brokerage rows and the GBP account stay out.
    expect(rows.map((t) => t.externalId).sort()).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    expect(mustFind(rows, (t) => t.externalId === "t4").pending).toBe(true);
    expect(mustFind(rows, (t) => t.externalId === "t2").amountCents).toBe(
      -4550,
    );

    const card = mustFind(made, (a) => a.type === "credit");
    expect(balanceOf(db, card.id)?.balanceCents).toBe(25000);
    const brk = mustFind(made, (a) => a.type === "investment");
    expect(balanceOf(db, brk.id)?.balanceCents).toBe(1000000);

    expect(db.select().from(imports).all()[0].filename.startsWith("era:")).toBe(
      true,
    );
    const conn = getEraConnection(db, true);
    expect(conn.lastSyncAt).toBe(NOW.toISOString());
    expect(conn.accounts.find((a) => a.key === "gbp")?.skipReason).toMatch(
      /GBP/,
    );
    // First sync reads all history: no from_date.
    expect(
      era.calls.find((c) => c.name === "transactions__list_transactions")?.args
        .from_date,
    ).toBeUndefined();
  });

  it("stores a liability's balance as owed whatever sign Era sends", async () => {
    const db = openDb(":memory:");
    const neg = { ...data, accounts: [acct("card", "CreditCard", -479.18)] };
    await runEraSync(db, client(fakeEra(neg).fetchFn), { now: NOW });
    const card = db.select().from(accounts).get();
    expect(balanceOf(db, card?.id ?? 0)?.balanceCents).toBe(47918);
  });

  it("catches up from an overlap window, updating rather than duplicating", async () => {
    const db = openDb(":memory:");
    await runEraSync(db, client(fakeEra(data).fetchFn), { now: NOW });
    const userCategory = db.select().from(transactions).all().length;

    const later = new Date("2026-09-22T15:00:00Z");
    const posted = {
      ...data,
      transactions: [
        ...data.transactions.filter((t) => t.transaction_id !== "t4"),
        txn("t4", "card", "2026-09-19", -8.5, "Acme Cafe"),
        txn("t7", "chk", "2026-09-21", -20, "Acme Hardware"),
      ],
    };
    const era = fakeEra(posted);
    const r = await runEraSync(db, client(era.fetchFn), { now: later });
    expect(r.ok).toBe(true);
    const from = era.calls.find(
      (c) => c.name === "transactions__list_transactions",
    )?.args.from_date;
    expect(from).toBe(
      new Date(Date.UTC(2026, 8, 20 - OVERLAP_DAYS)).toISOString().slice(0, 10),
    );
    const rows = db.select().from(transactions).all();
    expect(rows.length).toBe(userCategory + 1);
    const t4 = mustFind(rows, (t) => t.externalId === "t4");
    expect([t4.pending, t4.amountCents]).toEqual([false, -850]);
  });

  it("recreates an app account the user deleted", async () => {
    const db = openDb(":memory:");
    const only = {
      accounts: [acct("brk", "Brokerage", 5)],
      transactions: [],
    };
    await runEraSync(db, client(fakeEra(only).fetchFn), { now: NOW });
    const first = db.select().from(accounts).get();
    db.delete(transactions).run();
    db.delete(imports).run();
    // Snapshots reference the account; clear them as account delete would.
    db.run("delete from balance_snapshots");
    db.delete(accounts)
      .where(eq(accounts.id, first?.id ?? 0))
      .run();
    await runEraSync(db, client(fakeEra(only).fetchFn), { now: NOW });
    expect(db.select().from(accounts).all()).toHaveLength(1);
  });
});
