export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface AppendHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type AppendOutcome = "inserted" | "unauthorized" | "fallback";

declare function btoa(s: string): string;

export function appendRequest(cfg: ServerConfig, text: string): AppendHttpRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.username !== "") headers["Authorization"] = "Basic " + basicAuthHeader(cfg.username, cfg.password);
  return {
    url: `http://${cfg.host}:${cfg.port}/tui/append-prompt`,
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  };
}

export function basicAuthHeader(username: string, password: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(`${username}:${password}`).toString("base64");
  return btoa(`${username}:${password}`);
}

export function parseAppendResult(status: number, ack: boolean): AppendOutcome {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 200 && ack === true) return "inserted";
  return "fallback";
}

export type Target = "tui" | "web";

export interface SessionRef {
  id: string;
  title: string;
}

export interface SessionHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

function authHeaders(cfg: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.username !== "") headers["Authorization"] = "Basic " + basicAuthHeader(cfg.username, cfg.password);
  return headers;
}

export function sessionListRequest(cfg: ServerConfig): SessionHttpRequest {
  return {
    url: `http://${cfg.host}:${cfg.port}/session`,
    method: "GET",
    headers: authHeaders(cfg),
  };
}

export function sessionMessageRequest(cfg: ServerConfig, sessionId: string, text: string): SessionHttpRequest {
  return {
    url: `http://${cfg.host}:${cfg.port}/session/${encodeURIComponent(sessionId)}/prompt_async`,
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  };
}

export type SendOutcome = "sent" | "unauthorized" | "session-not-found" | "fallback";

export function parseSendResult(status: number): SendOutcome {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "session-not-found";
  if (status >= 200 && status < 300) return "sent";
  return "fallback";
}

export function parseSessionList(json: unknown): SessionRef[] {
  if (!Array.isArray(json)) return [];
  const out: SessionRef[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || rec["id"] === "") continue;
    const id = rec["id"];
    const title = typeof rec["title"] === "string" && rec["title"] !== "" ? rec["title"] : id;
    if (!out.some((s) => s.id === id)) out.push({ id, title });
  }
  return out;
}
