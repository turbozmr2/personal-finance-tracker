/** The slices of Era Context's MCP tool results this app reads, and its view of the connection. */

export type EraAccount = {
  account_group_key: string;
  name: string;
  institution?: string | null;
  /** Era's account type: Checking, Savings, CreditCard, Brokerage, Hsa, Mortgage, RealEstate, … */
  type: string;
  balance?: { current?: number | null; currency?: string | null } | null;
  /** ISO instant. */
  balance_as_of?: string | null;
  /** "user_excluded" when the user hid the account in Era; absent when visible. */
  visibility?: string | null;
};

export type EraTransaction = {
  transaction_id: string;
  account_group_key: string;
  /** Signed, outflows negative — the app's own convention. */
  amount: number;
  currency?: string | null;
  description?: string | null;
  original_description?: string | null;
  /** `YYYY-MM-DD`. */
  transaction_date?: string | null;
  posted_date?: string | null;
  is_pending?: boolean | null;
};

/** How an Era account is brought in: its rows and balance, its balance only, or not at all. */
export type EraPlan =
  | {
      kind: "sync";
      type: "checking" | "savings" | "credit" | "investment" | "loan";
      transactions: boolean;
    }
  | { kind: "skip"; reason: string };

export type EraLinkedAccount = {
  key: string;
  name: string;
  institution: string | null;
  eraType: string;
  /** The app account it feeds, or null when skipped. */
  accountId: number | null;
  skipReason: string | null;
};

export type EraSyncResult = {
  key: string;
  name: string;
  added: number;
  updated: number;
  matched: number;
  removed: number;
  balanceRecorded: boolean;
};

export type EraSyncOutcome =
  | { ok: true; results: EraSyncResult[]; warnings: string[]; calls: number }
  | { ok: false; error: string };

export type EraConnection = {
  /** `ERA_API_KEY` is set on the server. The key itself never leaves it. */
  configured: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  warnings: string[];
  accounts: EraLinkedAccount[];
};
