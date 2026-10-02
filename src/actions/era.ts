"use server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import {
  createEraClient,
  eraConfigFromEnv,
  NOT_CONFIGURED_ERROR,
} from "@/lib/era/client";
import { getEraConnection } from "@/lib/era/store";
import { runEraSync } from "@/lib/era/sync";
import type { EraConnection, EraSyncOutcome } from "@/lib/era/types";

export async function getEraConnectionAction(): Promise<EraConnection> {
  return getEraConnection(getDb(), eraConfigFromEnv() !== null);
}

/** Pull from Era now. The API key stays in the server's environment. */
export async function eraSyncNowAction(): Promise<EraSyncOutcome> {
  const config = eraConfigFromEnv();
  if (!config) return { ok: false, error: NOT_CONFIGURED_ERROR };
  const outcome = await runEraSync(
    getDb(),
    createEraClient(globalThis.fetch, config),
    { now: new Date() },
  );
  for (const p of [
    "/settings",
    "/home",
    "/transactions",
    "/review",
    "/bills",
    "/insights",
    "/budget",
    "/networth",
    "/forecast",
    "/weekly",
    "/accounts",
  ])
    revalidatePath(p);
  return outcome;
}
