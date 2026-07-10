export const NEON_SESSION_ACTOR_QUEUE_DEFAULT_MAX_IDLE_MS = 5 * 60 * 1000;

export interface INeonSessionActorQueueOptions {
  readonly maxIdleMs?: number;
  readonly now?: () => number;
}

export interface INeonSessionActorQueueSessionSnapshot {
  readonly sessionKey: string;
  readonly active: number;
  readonly pending: number;
  readonly idleMs: number;
}

export interface INeonSessionActorQueueSnapshot {
  readonly sessions: readonly INeonSessionActorQueueSessionSnapshot[];
  readonly sessionCount: number;
  readonly active: number;
  readonly pending: number;
}

export interface INeonSessionActorQueue {
  cleanupIdle(): number;
  enqueue<T>(sessionKey: string, task: () => Promise<T> | T): Promise<T>;
  getPendingCountForSession(sessionKey: string): number;
  getTotalPendingCount(): number;
  run<T>(sessionKey: string, task: () => Promise<T> | T): Promise<T>;
  snapshot(): INeonSessionActorQueueSnapshot;
}

interface INeonSessionActorQueueState {
  active: number;
  lastSettledAtMs: number;
  pending: number;
  tail: Promise<void>;
}

export class NeonSessionActorQueue implements INeonSessionActorQueue {
  private readonly maxIdleMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, INeonSessionActorQueueState>();

  constructor(options: INeonSessionActorQueueOptions = {}) {
    this.maxIdleMs = Math.max(0, options.maxIdleMs ?? NEON_SESSION_ACTOR_QUEUE_DEFAULT_MAX_IDLE_MS);
    this.now = options.now ?? Date.now;
  }

  cleanupIdle(): number {
    const now = this.now();
    let removed = 0;
    for (const [sessionKey, state] of this.sessions) {
      if (state.active > 0 || state.pending > 0) {
        continue;
      }
      if (now - state.lastSettledAtMs < this.maxIdleMs) {
        continue;
      }
      this.sessions.delete(sessionKey);
      removed += 1;
    }
    return removed;
  }

  enqueue<T>(sessionKey: string, task: () => Promise<T> | T): Promise<T> {
    const key = normalizeNeonSessionActorQueueKey(sessionKey);
    const state = this.getOrCreateState(key);
    state.pending += 1;

    const current = state.tail.catch(() => undefined).then(async () => {
      state.active += 1;
      try {
        return await task();
      } finally {
        state.active -= 1;
        state.pending = Math.max(0, state.pending - 1);
        state.lastSettledAtMs = this.now();
      }
    });

    state.tail = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  }

  getPendingCountForSession(sessionKey: string): number {
    const key = normalizeNeonSessionActorQueueKey(sessionKey);
    return this.sessions.get(key)?.pending ?? 0;
  }

  getTotalPendingCount(): number {
    let total = 0;
    for (const state of this.sessions.values()) {
      total += state.pending;
    }
    return total;
  }

  run<T>(sessionKey: string, task: () => Promise<T> | T): Promise<T> {
    return this.enqueue(sessionKey, task);
  }

  snapshot(): INeonSessionActorQueueSnapshot {
    const now = this.now();
    const sessions = [...this.sessions.entries()]
      .map(([sessionKey, state]): INeonSessionActorQueueSessionSnapshot => ({
        sessionKey,
        active: state.active,
        pending: state.pending,
        idleMs: state.active > 0 || state.pending > 0 ? 0 : Math.max(0, now - state.lastSettledAtMs)
      }))
      .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));

    return {
      sessions,
      sessionCount: sessions.length,
      active: sessions.reduce((total, session) => total + session.active, 0),
      pending: sessions.reduce((total, session) => total + session.pending, 0)
    };
  }

  private getOrCreateState(sessionKey: string): INeonSessionActorQueueState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const state: INeonSessionActorQueueState = {
      active: 0,
      lastSettledAtMs: this.now(),
      pending: 0,
      tail: Promise.resolve()
    };
    this.sessions.set(sessionKey, state);
    return state;
  }
}

export function createNeonSessionActorQueue(options: INeonSessionActorQueueOptions = {}): NeonSessionActorQueue {
  return new NeonSessionActorQueue(options);
}

export function normalizeNeonSessionActorQueueKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.length === 0) {
    throw new Error("Neon session actor queue requires a non-empty session key");
  }
  return trimmed;
}
