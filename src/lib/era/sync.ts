import { z } from "zod";
import { addDays, localDay } from "@/lib/dates";
import type { Db } from "@/lib/db/client";
import type { MappedRow } from "@/lib/simplefin/map";
import { plainReason, syncAccount } from "@/lib/simplefin/sync";
import { type EraClient, EraError } from "./client";
import { toMappedRow, toSfinAccount } from "./map";
import {
  ensureLinks,
  getLastSyncAt,
  setLastError,
  setLastSyncAt,
  setLastWarnings,
} from "./store";
import type {
  EraAccount,
  EraSyncOutcome,
  EraSyncResult,
  EraTransaction,
} from "./types";

/**
 * A catch-up sync re-reads this many days before the last one, so late
 * postings land and a pending row that never posted is old enough (past
 * `VANISHED_PENDING_DAYS`) to be cleaned up inside the window.
 */
export const OVERLAP_DAYS = 21;
const PAGE_SIZE = 100;
/** 20,000 rows; a guard against a pager that never says it is done. */
const MAX_PAGES = 200;

export const ERA_SYNC_FAILED = "Era sync failed.";

const accountSchema = z.looseObject({
  account_group_key: z.string().min(1),
  name: z.string(),
  institution: z.string().nullish(),
  type: z.string(),
  balance: z
    .looseObject({
      current: z.number().nullish(),
      currency: z.string().nullish(),
    })
    .nullish(),
  balance_as_of: z.string().nullish(),
});

const transactionSchema = z.looseObject({
  transaction_id: z.string().min(1),
  account_group_key: z.string().min(1),
  amount: z.number(),
  currency: z.string().nullish(),
  description: z.string().nullish(),
  original_description: z.string().nullish(),
  transaction_date: z.string().nullish(),
  posted_date: z.string().nullish(),
  is_pending: z.boolean().nullish(),
});

const accountsResponse = z.looseObject({ accounts: z.array(accountSchema) });
const transactionsResponse = z.looseObject({
  transactions: z.array(transactionSchema),
  pagination: z.looseObject({ has_more: z.boolean().nullish() }).nullish(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new EraError("Era returned an unexpected shape.");
  return p.data;
}

/** Every transaction since `fromDate` (all history when null), pending ones included. */
export async function fetchTransactions(
  client: EraClient,
  fromDate: string | null,
): Promise<EraTransaction[]> {
  const out: EraTransaction[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = parse(
      transactionsResponse,
      await client.callTool("transactions__list_transactions", {
        page,
        page_size: PAGE_SIZE,
        include_pending: true,
        ...(fromDate ? { from_date: fromDate } : {}),
      }),
    );
    out.push(...res.transactions);
    if (!res.pagination?.has_more || res.transactions.length === 0) return out;
  }
  throw new EraError("Era kept paging past the row limit.");
}

/**
 * Store one fetch: link accounts, then upsert each account's rows and
 * balance in its own transaction through the same engine SimpleFIN uses.
 * Pure with respect to the network — `runEraSync` fetches, this stores.
 */
export function applyEra(
  db: Db,
  eraAccounts: EraAccount[],
  eraTransactions: EraTransaction[],
  opts: { now: Date; fromDate: string | null },
): { results: EraSyncResult[]; warnings: string[] } {
  const warnings: string[] = [];
  const results: EraSyncResult[] = [];
  const links = ensureLinks(db, eraAccounts);

  const byAccount = new Map<string, MappedRow[]>();
  const seen = new Set<string>();
  for (const t of eraTransactions) {
    // A pager that shifts under new rows can repeat one; the first copy wins.
    if (seen.has(t.transaction_id)) continue;
    seen.add(t.transaction_id);
    const mapped = toMappedRow(t);
    if (!mapped.ok) {
      warnings.push(`Skipped a transaction: ${mapped.reason}.`);
      continue;
    }
    const list = byAccount.get(t.account_group_key) ?? [];
    list.push(mapped.row);
    byAccount.set(t.account_group_key, list);
  }

  const nowIso = opts.now.toISOString();
  const today = localDay(opts.now);
  const window = opts.fromDate
    ? {
        start: Date.parse(`${opts.fromDate}T00:00:00Z`) / 1000,
        end: Date.parse(`${addDays(today, 2)}T00:00:00Z`) / 1000,
      }
    : undefined;

  for (const link of links) {
    const rows = link.plan.transactions
      ? (byAccount.get(link.era.account_group_key) ?? [])
      : [];
    try {
      const r = db.transaction((tx) =>
        syncAccount(tx as Db, {
          accountId: link.accountId,
          account: toSfinAccount(link.era, link.plan.type),
          rows,
          now: opts.now,
          importTag: nowIso,
          window,
          // An empty fetch proves nothing about what Era still holds.
          cleanup: rows.length > 0,
          source: "era",
        }),
      );
      results.push({
        key: link.era.account_group_key,
        name: link.era.name,
        added: r.added,
        updated: r.updated,
        matched: r.matched,
        removed: r.removed,
        balanceRecorded: r.balanceRecorded,
      });
    } catch (e) {
      warnings.push(`${link.era.name}: sync failed — ${plainReason(e)}`);
    }
  }
  return { results, warnings };
}

/**
 * Fetch from Era and apply: all history on the first sync, then from
 * `OVERLAP_DAYS` before the last one. Nothing thrown escapes; an unforeseen
 * failure reports a flat message that cannot carry the API key.
 */
export async function runEraSync(
  db: Db,
  client: EraClient,
  opts: { now: Date },
): Promise<EraSyncOutcome> {
  try {
    const last = getLastSyncAt(db);
    const fromDate = last
      ? addDays(localDay(new Date(last)), -OVERLAP_DAYS)
      : null;
    const { accounts } = parse(
      accountsResponse,
      await client.callTool("accounts__list_financial_accounts", {}),
    );
    const txns = await fetchTransactions(client, fromDate);
    const { results, warnings } = applyEra(db, accounts, txns, {
      now: opts.now,
      fromDate,
    });
    setLastSyncAt(db, opts.now.toISOString());
    setLastWarnings(db, warnings);
    setLastError(db, null);
    return { ok: true, results, warnings, calls: client.calls() };
  } catch (e) {
    const error = e instanceof EraError ? e.message : ERA_SYNC_FAILED;
    try {
      setLastError(db, error);
    } catch {
      // A database too broken to record the failure still owes a clean answer.
    }
    return { ok: false, error };
  }
}

/** One line for a toast or the CLI: what the sync changed. */
export function summarizeEra(results: EraSyncResult[]): string {
  const added = results.reduce((s, r) => s + r.added, 0);
  const updated = results.reduce((s, r) => s + r.updated, 0);
  const n = results.length;
  return `Era: ${added} new, ${updated} updated across ${n} account${n === 1 ? "" : "s"}.`;
}
