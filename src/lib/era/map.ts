import { isIsoDate } from "@/lib/dates";
import { cleanMerchant } from "@/lib/normalize/merchant";
import type { MappedRow } from "@/lib/simplefin/map";
import type { SfinAccount } from "@/lib/simplefin/types";
import type { EraAccount, EraPlan, EraTransaction } from "./types";

/**
 * Era's account types → this app's. Cash accounts bring their transactions;
 * investment and loan accounts bring only their balance, because buys,
 * contributions and loan postings would read as spending or double-count the
 * payment already on the checking side. Anything else is left out.
 */
const TYPE_PLANS: Record<string, EraPlan> = {
  checking: { kind: "sync", type: "checking", transactions: true },
  savings: { kind: "sync", type: "savings", transactions: true },
  moneymarket: { kind: "sync", type: "savings", transactions: true },
  creditcard: { kind: "sync", type: "credit", transactions: true },
  brokerage: { kind: "sync", type: "investment", transactions: false },
  investment: { kind: "sync", type: "investment", transactions: false },
  retirement: { kind: "sync", type: "investment", transactions: false },
  hsa: { kind: "sync", type: "investment", transactions: false },
  mortgage: { kind: "sync", type: "loan", transactions: false },
  loan: { kind: "sync", type: "loan", transactions: false },
  studentloan: { kind: "sync", type: "loan", transactions: false },
  autoloan: { kind: "sync", type: "loan", transactions: false },
  lineofcredit: { kind: "sync", type: "loan", transactions: false },
};

export function planFor(a: EraAccount): EraPlan {
  // Era lists hidden accounts anyway, with no balance or transactions; they
  // are often duplicates, so the user's choice in Era carries over.
  if (a.visibility === "user_excluded")
    return { kind: "skip", reason: "hidden in Era" };
  const currency = a.balance?.currency ?? "USD";
  if (currency !== "USD")
    return { kind: "skip", reason: `${currency} — only USD is supported` };
  const plan = TYPE_PLANS[a.type.toLowerCase().replace(/[^a-z]/g, "")];
  return (
    plan ?? { kind: "skip", reason: `${a.type} accounts aren't supported` }
  );
}

/** Era's decimal amount → integer cents, or null when it isn't a finite number. */
export function toCents(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Integer cents → a plain decimal string ("-12.05"), the form `SfinAccount.balance` takes. */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents);
  const frac = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${frac}`;
}

/**
 * The account as the shared sync engine expects it. That engine flips a
 * liability's balance on the SimpleFIN assumption that debt arrives
 * negative; Era's sources disagree on the sign of what is owed, so a
 * liability's balance is sent as minus its magnitude and stored as owed.
 */
export function toSfinAccount(a: EraAccount, type: string): SfinAccount {
  const cents = toCents(a.balance?.current);
  const asOf = a.balance_as_of ? Date.parse(a.balance_as_of) : Number.NaN;
  const liability = type === "credit" || type === "loan";
  return {
    id: a.account_group_key,
    org: { name: a.institution ?? null },
    name: a.name,
    currency: a.balance?.currency ?? "USD",
    balance:
      cents === null
        ? ""
        : centsToDecimal(liability ? -Math.abs(cents) : cents),
    "balance-date": Number.isFinite(asOf) ? Math.floor(asOf / 1000) : 0,
    transactions: [],
  };
}

/**
 * One Era transaction as an import row, dated by its transaction date (what
 * Era shows, and stable from pending to posted). Unusable rows are reported.
 */
export function toMappedRow(
  t: EraTransaction,
): { ok: true; row: MappedRow } | { ok: false; reason: string } {
  const amountCents = toCents(t.amount);
  if (amountCents === null)
    return { ok: false, reason: `unreadable amount on ${t.transaction_id}` };
  const date = [t.transaction_date, t.posted_date].find(
    (d): d is string => typeof d === "string" && isIsoDate(d),
  );
  if (!date) return { ok: false, reason: `no date on ${t.transaction_id}` };
  const rawDescription =
    (t.original_description ?? "").trim() ||
    (t.description ?? "").trim() ||
    "(no description)";
  return {
    ok: true,
    row: {
      row: {
        date,
        amountCents,
        rawDescription,
        merchant: cleanMerchant(rawDescription),
      },
      externalId: t.transaction_id,
      pending: t.is_pending === true,
    },
  };
}
