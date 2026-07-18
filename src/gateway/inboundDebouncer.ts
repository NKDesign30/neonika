export interface INeonInboundDebounceTimer {
  cancel(): void;
}

export interface INeonInboundDebounceScheduler {
  schedule(callback: () => void | Promise<void>, delayMs: number): INeonInboundDebounceTimer;
}

export interface INeonInboundDebouncerEnqueueParams<TItem> {
  readonly key: string;
  readonly item: TItem;
  readonly delayMs: number;
  readonly shouldDebounce: boolean;
}

export interface INeonInboundDebouncer<TItem> {
  enqueue(params: INeonInboundDebouncerEnqueueParams<TItem>): Promise<void>;
  flushKey(key: string): Promise<void>;
  flushAll(): Promise<void>;
  cancelKey(key: string): void;
}

export interface ICreateNeonInboundDebouncerOptions<TItem> {
  readonly scheduler?: INeonInboundDebounceScheduler;
  readonly onFlush: (items: readonly TItem[]) => Promise<void> | void;
  readonly onError?: (error: Error) => Promise<void> | void;
}

interface INeonInboundDebounceBucket<TItem> {
  readonly key: string;
  readonly items: TItem[];
  timer?: INeonInboundDebounceTimer;
}

const defaultNeonInboundDebounceScheduler: INeonInboundDebounceScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);

    return {
      cancel: () => {
        clearTimeout(timer);
      }
    };
  }
};

export function createNeonInboundDebouncer<TItem>(
  options: ICreateNeonInboundDebouncerOptions<TItem>
): INeonInboundDebouncer<TItem> {
  const scheduler = options.scheduler ?? defaultNeonInboundDebounceScheduler;
  const buckets = new Map<string, INeonInboundDebounceBucket<TItem>>();
  const keyChains = new Map<string, Promise<void>>();

  const runFlush = async (key: string, items: readonly TItem[]): Promise<void> => {
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await options.onFlush(items);
      });

    keyChains.set(key, next);

    try {
      await next;
    } finally {
      if (keyChains.get(key) === next) {
        keyChains.delete(key);
      }
    }
  };

  const reportScheduledError = async (error: unknown): Promise<void> => {
    const normalized = error instanceof Error ? error : new Error("Unknown inbound debounce error");
    try {
      await options.onError?.(normalized);
    } catch {
      // Scheduled callbacks do not have a caller to report to. Avoid an
      // unhandled rejection while preserving the next flush chain.
    }
  };

  const scheduleBucket = (bucket: INeonInboundDebounceBucket<TItem>, delayMs: number): void => {
    const safeDelayMs = Math.max(0, Math.trunc(delayMs));
    bucket.timer = scheduler.schedule(async () => {
      await debouncer.flushKey(bucket.key).catch(reportScheduledError);
    }, safeDelayMs);
  };

  const debouncer: INeonInboundDebouncer<TItem> = {
    async enqueue(params) {
      if (!params.shouldDebounce || params.delayMs <= 0) {
        await debouncer.flushKey(params.key);
        await runFlush(params.key, [params.item]);
        return;
      }

      const existing = buckets.get(params.key);
      if (existing) {
        existing.items.push(params.item);
        existing.timer?.cancel();
        delete existing.timer;
        scheduleBucket(existing, params.delayMs);
        return;
      }

      const bucket: INeonInboundDebounceBucket<TItem> = {
        key: params.key,
        items: [params.item]
      };
      buckets.set(params.key, bucket);
      scheduleBucket(bucket, params.delayMs);
    },

    async flushKey(key) {
      const bucket = buckets.get(key);
      if (!bucket) {
        return;
      }

      bucket.timer?.cancel();
      delete bucket.timer;
      buckets.delete(key);

      if (bucket.items.length > 0) {
        await runFlush(key, [...bucket.items]);
      }
    },

    async flushAll() {
      const keys = Array.from(buckets.keys());
      await Promise.all(keys.map((key) => debouncer.flushKey(key)));
    },

    cancelKey(key) {
      const bucket = buckets.get(key);
      if (!bucket) {
        return;
      }

      bucket.timer?.cancel();
      buckets.delete(key);
    }
  };

  return debouncer;
}
