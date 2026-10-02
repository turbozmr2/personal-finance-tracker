"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { eraSyncNowAction } from "@/actions/era";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { EraConnection } from "@/lib/era/types";

type Props = {
  connection: EraConnection;
  /** Worded on the server so the client never derives times from its own clock. */
  lastSyncLabel: string | null;
};

export function EraCard({ connection, lastSyncLabel }: Props) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const synced = connection.accounts.filter((a) => a.accountId !== null);
  const skipped = connection.accounts.filter((a) => a.accountId === null);
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-4">
        <h2 className="text-headline font-semibold">Era</h2>
        {connection.configured && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              start(async () => {
                const r = await eraSyncNowAction();
                if (r.ok)
                  toast.success(
                    `Era: ${r.results.reduce((s, x) => s + x.added, 0)} new transactions.`,
                  );
                else toast.error(r.error);
                router.refresh();
              })
            }
          >
            {busy ? "Syncing…" : "Sync now"}
          </Button>
        )}
      </div>
      {!connection.configured ? (
        <p className="text-caption text-ink-2">
          Set <code>ERA_API_KEY</code> in the server environment to pull
          accounts, balances and transactions from Era Context. A scheduled{" "}
          <code>npm run era:sync</code> keeps them current.
        </p>
      ) : (
        <>
          <p className="mb-4 text-caption text-ink-2">
            {lastSyncLabel
              ? `Last synced ${lastSyncLabel}.`
              : "Not synced yet."}{" "}
            Cash and card accounts bring transactions; investment and loan
            accounts bring their balance only.
          </p>
          {connection.lastError && (
            <p className="mb-4 text-caption text-negative">
              {connection.lastError}
            </p>
          )}
          {synced.length > 0 && (
            <ul className="mb-2 grid gap-1 text-caption">
              {synced.map((a) => (
                <li key={a.key}>
                  {a.name}
                  <span className="text-ink-2">
                    {a.institution ? ` · ${a.institution}` : ""} · {a.eraType}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {skipped.length > 0 && (
            <ul className="grid gap-1 text-caption text-ink-2">
              {skipped.map((a) => (
                <li key={a.key}>
                  {a.name} — not synced ({a.skipReason})
                </li>
              ))}
            </ul>
          )}
          {connection.warnings.length > 0 && (
            <ul className="mt-4 grid gap-1 text-caption text-ink-2">
              {connection.warnings.slice(0, 5).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
