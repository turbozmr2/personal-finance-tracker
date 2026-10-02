/**
 * `npm run era:sync`: pull from Era Context into the database. Meant for a
 * scheduler (cron or a systemd timer) next to the running app; SQLite's WAL
 * mode lets it write while the server reads.
 */
import { getDb } from "../src/lib/db/client";
import {
  createEraClient,
  type EraConfig,
  eraConfigFromEnv,
  NOT_CONFIGURED_ERROR,
} from "../src/lib/era/client";
import { runEraSync, summarizeEra } from "../src/lib/era/sync";

const config = eraConfigFromEnv();
if (!config) {
  console.error(NOT_CONFIGURED_ERROR);
  process.exit(1);
}

async function main(config: EraConfig) {
  const outcome = await runEraSync(
    getDb(),
    createEraClient(globalThis.fetch, config),
    {
      now: new Date(),
    },
  );
  if (!outcome.ok) {
    console.error(outcome.error);
    process.exit(1);
  }
  console.log(`${summarizeEra(outcome.results)} (${outcome.calls} Era calls)`);
  for (const w of outcome.warnings) console.warn(w);
}

void main(config);
