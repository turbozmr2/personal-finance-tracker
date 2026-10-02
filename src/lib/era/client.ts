/**
 * A minimal MCP client for Era Context over Streamable HTTP: initialize once,
 * then `tools/call`. `fetch` is a parameter so tests never touch the network.
 * The API key is a secret: it travels only in the Authorization header and is
 * never part of an error message.
 */

export const ERA_DEFAULT_URL = "https://context.era.app/mcp";
const PROTOCOL_VERSION = "2025-06-18";

export const NOT_CONFIGURED_ERROR =
  "Era is not configured: set ERA_API_KEY on the server.";
export const NETWORK_ERROR = "Couldn't reach Era.";
export const REJECTED_ERROR =
  "Era rejected the API key; create a new one and update ERA_API_KEY.";
export const UNREADABLE_ERROR = "Era returned an unreadable response.";

export type FetchFn = typeof fetch;

/** A failure whose message is already safe to show the user. */
export class EraError extends Error {}

export type EraConfig = { url: string; apiKey: string };

/** Reads `ERA_API_KEY` / `ERA_MCP_URL`; null when no key is set. */
export function eraConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): EraConfig | null {
  const apiKey = env.ERA_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, url: env.ERA_MCP_URL?.trim() || ERA_DEFAULT_URL };
}

type RpcMessage = {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** The JSON-RPC messages in a body that is plain JSON or a server-sent event stream. */
export function parseMessages(body: string, contentType: string): RpcMessage[] {
  if (!contentType.includes("text/event-stream")) {
    const parsed = JSON.parse(body) as RpcMessage | RpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const out: RpcMessage[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data) out.push(JSON.parse(data) as RpcMessage);
  }
  return out;
}

export type EraClient = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Tool calls made so far; each counts against Era's MCP-call meter. */
  calls: () => number;
};

export function createEraClient(
  fetchFn: FetchFn,
  config: EraConfig,
): EraClient {
  let session: string | null = null;
  let initialized = false;
  let nextId = 1;
  let toolCalls = 0;

  async function post(
    method: string,
    params: unknown,
    notify = false,
  ): Promise<unknown> {
    const id = notify ? undefined : nextId++;
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (session) headers["mcp-session-id"] = session;
    let res: Response;
    try {
      res = await fetchFn(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    } catch {
      throw new EraError(NETWORK_ERROR);
    }
    if (res.status === 401 || res.status === 403)
      throw new EraError(REJECTED_ERROR);
    if (!res.ok) throw new EraError(`Era answered HTTP ${res.status}.`);
    session = res.headers.get("mcp-session-id") ?? session;
    if (notify) return undefined;

    let messages: RpcMessage[];
    try {
      messages = parseMessages(
        await res.text(),
        res.headers.get("content-type") ?? "",
      );
    } catch {
      throw new EraError(UNREADABLE_ERROR);
    }
    const reply = messages.find((m) => m.id === id);
    if (!reply) throw new EraError(UNREADABLE_ERROR);
    if (reply.error)
      throw new EraError(
        `Era error: ${(reply.error.message ?? "unknown").slice(0, 120)}`,
      );
    return reply.result;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    await post("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "personal-finance-tracker", version: "0.1.0" },
    });
    await post("notifications/initialized", {}, true);
    initialized = true;
  }

  return {
    calls: () => toolCalls,
    async callTool(name, args) {
      await ensureInitialized();
      toolCalls++;
      const result = (await post("tools/call", {
        name,
        arguments: args,
      })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { type: string; text?: string }[];
      } | null;
      const text = result?.content?.find((c) => c.type === "text")?.text;
      if (result?.isError)
        throw new EraError(
          `Era tool ${name} failed: ${(text ?? "unknown").slice(0, 120)}`,
        );
      if (result?.structuredContent !== undefined)
        return result.structuredContent;
      if (text === undefined) throw new EraError(UNREADABLE_ERROR);
      try {
        return JSON.parse(text);
      } catch {
        throw new EraError(UNREADABLE_ERROR);
      }
    },
  };
}
