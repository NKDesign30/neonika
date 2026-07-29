// HTTP client for the Neonika gateway API. Same-origin: the bundle is served
// by the gateway HTTP server, so paths are root-relative. Reads are GETs against
// real /api/neon-* endpoints — no mock data anywhere in the UI. The single write
// is the chat-send dry-run (`postChatSend`), which the server hard-suppresses
// (no outbound) and gates with mutation auth.

export class NeonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "NeonApiError";
  }
}

export interface FetchOptions {
  readonly signal?: AbortSignal;
}

async function fetchJson<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: "application/json" },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new NeonApiError(`Network error contacting ${path}`, 0, path);
  }
  if (!response.ok) {
    throw new NeonApiError(`Request failed (${response.status})`, response.status, path);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new NeonApiError(`Invalid JSON from ${path}`, response.status, path);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NeonApiError(`Network error contacting ${path}`, 0, path);
  }
  if (!response.ok) {
    throw new NeonApiError(`Request failed (${response.status})`, response.status, path);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new NeonApiError(`Invalid JSON from ${path}`, response.status, path);
  }
}

export interface ChatSendRequest {
  readonly channelId: string;
  readonly text: string;
  readonly channel?: string;
  readonly agentId?: string;
  readonly threadId?: string;
}

export interface ChatSendResult {
  readonly state: "queued-dry-run" | "blocked";
  readonly runId: string;
  readonly candidateId: string;
  readonly outboundSent: false;
  readonly deliveryState: string;
  readonly candidateVisibleInQueue: boolean;
}

// Endpoint registry — single source of truth for the API surface the UI reads.
export const NEON_ENDPOINTS = {
  gateway: "/api/neon-mission-control/gateway",
  gatewayStatus: "/api/neon-gateway/status",
  gatewayRoutes: "/api/neon-gateway/routes",
  gatewayEvents: "/api/neon-gateway/events",
  chat: "/api/neon-chat/conversations",
  chatSend: "/api/neon-chat/send",
  activity: "/api/neon-activity",
  sessions: "/api/neon-sessions",
  indexer: "/api/neon-indexer",
  indexerActivity: "/api/neon-indexer-activity",
  liveIndexDaemon: "/api/neon-live-index-daemon",
  liveIndexSync: "/api/neon-live-index-sync",
  transcript: "/api/neon-transcript",
  replay: "/api/neon-replay",
  delivery: "/api/neon-delivery/queue",
  workboardCards: "/api/workboard/cards",
  cutover: "/api/neon-cutover",
  doctor: "/api/neon-doctor",
  agents: "/api/neon-agents",
  skills: "/api/neon-skills",
  nodes: "/api/neon-nodes",
  automation: "/api/neon-automation",
  cron: "/api/neon-cron",
  heartbeat: "/api/neon-heartbeat",
  workspace: "/api/neon-workspace",
  onboarding: "/api/neon-onboarding",
  sites: "/api/neon-sites",
  siteAnalytics: "/api/neon-sites/analytics",
} as const;

export class NeonControlClient {
  constructor(private readonly base = "") {}

  private path(p: string): string {
    return `${this.base}${p}`;
  }

  get<T>(endpoint: string, opts?: FetchOptions): Promise<T> {
    return fetchJson<T>(this.path(endpoint), opts);
  }

  gateway<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.gateway, opts);
  }
  chat<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.chat, opts);
  }
  // The dashboard's only write: a dry-run chat send. The server suppresses
  // outbound and returns a queued-dry-run delivery candidate.
  postChatSend(request: ChatSendRequest): Promise<{ readonly state: string; readonly chat: ChatSendResult }> {
    return postJson(this.path(NEON_ENDPOINTS.chatSend), request);
  }
  activity<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.activity, opts);
  }
  sessions<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.sessions, opts);
  }
  indexer<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.indexer, opts);
  }
  indexerActivity<T>(opts?: FetchOptions & { category?: "summary" | "decision"; offset?: number }) {
    const params = new URLSearchParams();
    if (opts?.category) {
      params.set("category", opts.category);
    }
    if (opts?.offset && opts.offset > 0) {
      params.set("offset", String(opts.offset));
    }
    const query = params.toString();
    return this.get<T>(`${NEON_ENDPOINTS.indexerActivity}${query ? `?${query}` : ""}`, opts);
  }
  indexerActivityEntry<T>(entryId: number, opts?: FetchOptions) {
    return this.get<T>(`${NEON_ENDPOINTS.indexerActivity}?entry=${entryId}`, opts);
  }
  liveIndexDaemon<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.liveIndexDaemon, opts);
  }
  liveIndexSync<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.liveIndexSync, opts);
  }
  transcript<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.transcript, opts);
  }
  delivery<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.delivery, opts);
  }
  workboardCards<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.workboardCards, opts);
  }
  replay<T>(runId: string, opts?: FetchOptions & { events?: number }) {
    const params = new URLSearchParams({ runId });
    if (opts?.events) params.set("events", String(opts.events));
    return this.get<T>(`${NEON_ENDPOINTS.replay}?${params.toString()}`, opts);
  }
  cutover<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.cutover, opts);
  }
  doctor<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.doctor, opts);
  }
  agents<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.agents, opts);
  }
  skills<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.skills, opts);
  }
  nodes<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.nodes, opts);
  }
  automation<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.automation, opts);
  }
  cron<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.cron, opts);
  }
  heartbeat<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.heartbeat, opts);
  }
  workspace<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.workspace, opts);
  }
  routes<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.gatewayRoutes, opts);
  }
  sites<T>(opts?: FetchOptions) {
    return this.get<T>(NEON_ENDPOINTS.sites, opts);
  }
  siteAnalytics<T>(property: string, days: number, opts?: FetchOptions) {
    const params = new URLSearchParams({ property, days: String(days) });
    return this.get<T>(`${NEON_ENDPOINTS.siteAnalytics}?${params.toString()}`, opts);
  }
}

export const neonClient = new NeonControlClient();
