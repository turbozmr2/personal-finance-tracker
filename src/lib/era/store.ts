import { eq } from "drizzle-orm";
import { ACCOUNT_COLORS } from "@/lib/categories/palette";
import type { Db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { planFor } from "./map";
import type {
  EraAccount,
  EraConnection,
  EraLinkedAccount,
  EraPlan,
} from "./types";

export const KEYS = {
  /** Era account key → app account id. */
  links: "era_links",
  /** What the last sync saw, for the Settings card. */
  accounts: "era_accounts",
  lastSyncAt: "era_last_sync_at",
  lastError: "era_last_error",
  lastWarnings: "era_last_warnings",
} as const;

export const getLastSyncAt = (db: Db) =>
  getSetting<string | null>(db, KEYS.lastSyncAt, null);
export const setLastSyncAt = (db: Db, iso: string) =>
  setSetting(db, KEYS.lastSyncAt, iso);
export const setLastError = (db: Db, error: string | null) =>
  setSetting(db, KEYS.lastError, error ?? "");
export const setLastWarnings = (db: Db, w: string[]) =>
  setSetting(db, KEYS.lastWarnings, w);

export function getEraConnection(db: Db, configured: boolean): EraConnection {
  const error = getSetting<string>(db, KEYS.lastError, "");
  return {
    configured,
    lastSyncAt: getLastSyncAt(db),
    lastError: error || null,
    warnings: getSetting<string[]>(db, KEYS.lastWarnings, []),
    accounts: getSetting<EraLinkedAccount[]>(db, KEYS.accounts, []),
  };
}

export type Link = {
  era: EraAccount;
  plan: EraPlan & { kind: "sync" };
  accountId: number;
};

/**
 * Give every syncable Era account an app account, creating it the first time
 * (or again, if the user deleted the one it had). Returns the synced links and
 * records the full roster, skipped accounts included, for the Settings card.
 */
export function ensureLinks(db: Db, eraAccounts: EraAccount[]): Link[] {
  const links = { ...getSetting<Record<string, number>>(db, KEYS.links, {}) };
  const out: Link[] = [];
  const roster: EraLinkedAccount[] = [];
  for (const era of eraAccounts) {
    const plan = planFor(era);
    const base = {
      key: era.account_group_key,
      name: era.name,
      institution: era.institution ?? null,
      eraType: era.type,
    };
    if (plan.kind === "skip") {
      roster.push({ ...base, accountId: null, skipReason: plan.reason });
      continue;
    }
    let accountId: number | undefined = links[era.account_group_key];
    const exists =
      accountId !== undefined &&
      db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get() !== undefined;
    if (!exists) {
      const [created] = db
        .insert(accounts)
        .values({
          name: era.name.slice(0, 60),
          type: plan.type,
          institution: era.institution ? era.institution.slice(0, 60) : null,
          color:
            ACCOUNT_COLORS[Object.keys(links).length % ACCOUNT_COLORS.length],
        })
        .returning({ id: accounts.id })
        .all();
      accountId = created.id;
      links[era.account_group_key] = accountId;
    }
    out.push({ era, plan, accountId: accountId as number });
    roster.push({ ...base, accountId: accountId as number, skipReason: null });
  }
  setSetting(db, KEYS.links, links);
  setSetting(db, KEYS.accounts, roster);
  return out;
}
