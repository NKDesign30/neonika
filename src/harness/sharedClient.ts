import { createHash } from "node:crypto";

import type { ICodexAppServerClient, ICodexAppServerStartOptions } from "./appServerProtocol.js";

export type TCodexAppServerClientFactory = (
  options: ICodexAppServerStartOptions
) => ICodexAppServerClient;

export interface ICodexAppServerClientLease {
  readonly client: ICodexAppServerClient;
  release(): Promise<void>;
}

interface ISharedClientEntry {
  readonly key: string;
  readonly promise: Promise<ICodexAppServerClient>;
  client?: ICodexAppServerClient;
  activeLeases: number;
  closeWhenIdle: boolean;
}

export class CodexAppServerClientPool {
  private readonly entries = new Map<string, ISharedClientEntry>();

  constructor(private readonly createClient: TCodexAppServerClientFactory) {}

  async acquire(options: ICodexAppServerStartOptions): Promise<ICodexAppServerClientLease> {
    const key = createStartOptionsKey(options);
    const entry = this.entries.get(key) ?? this.createEntry(key, options);
    const client = await entry.promise;

    entry.activeLeases += 1;

    return {
      client,
      release: async () => {
        await this.release(key, entry);
      }
    };
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.entries.values());

    this.entries.clear();

    await Promise.all(
      entries.map(async (entry) => {
        const client = entry.client ?? (await entry.promise.catch(() => undefined));
        await client?.close();
      })
    );
  }

  async retireWhenIdle(options: ICodexAppServerStartOptions): Promise<boolean> {
    const key = createStartOptionsKey(options);
    const entry = this.entries.get(key);

    if (!entry) {
      return false;
    }

    entry.closeWhenIdle = true;

    if (entry.activeLeases > 0) {
      return true;
    }

    this.entries.delete(key);
    const client = entry.client ?? (await entry.promise.catch(() => undefined));
    await client?.close();

    return true;
  }

  getActiveLeaseCountForTests(options: ICodexAppServerStartOptions): number {
    return this.entries.get(createStartOptionsKey(options))?.activeLeases ?? 0;
  }

  getClientCountForTests(): number {
    return this.entries.size;
  }

  private createEntry(key: string, options: ICodexAppServerStartOptions): ISharedClientEntry {
    const client = this.createClient(options);
    const entry: ISharedClientEntry = {
      key,
      promise: client.initialize().then(() => {
        entry.client = client;
        return client;
      }),
      activeLeases: 0,
      closeWhenIdle: false
    };

    this.entries.set(key, entry);
    void entry.promise.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    });

    return entry;
  }

  private async release(key: string, entry: ISharedClientEntry): Promise<void> {
    entry.activeLeases = Math.max(0, entry.activeLeases - 1);

    if (entry.activeLeases > 0 || this.entries.get(key) !== entry) {
      return;
    }

    if (entry.closeWhenIdle) {
      this.entries.delete(key);
      await entry.client?.close();
    }
  }
}

export function createStartOptionsKey(options: ICodexAppServerStartOptions): string {
  const safeKeyMaterial = {
    transport: options.transport,
    command: options.command ?? null,
    args: options.args ?? [],
    cwd: options.cwd ?? null,
    url: options.url ? normalizeUrlForKey(options.url) : null,
    authTokenFingerprint: options.authToken ? fingerprintSecretValue(options.authToken) : "absent",
    headers: fingerprintRecordValues(options.headers, { lowerCaseKeys: true }),
    env: fingerprintRecordValues(options.env ?? {}, { lowerCaseKeys: false }),
    inheritEnv: options.inheritEnv ?? null,
    clearEnv: [...options.clearEnv].sort()
  };

  return createHash("sha256").update(JSON.stringify(safeKeyMaterial)).digest("hex").slice(0, 24);
}

function fingerprintRecordValues(
  record: Readonly<Record<string, string>>,
  options: { readonly lowerCaseKeys: boolean }
): readonly string[] {
  return Object.entries(record)
    .map(([key, value]) => {
      const normalizedKey = options.lowerCaseKeys ? key.toLowerCase() : key;
      return `${normalizedKey}=${fingerprintSecretValue(value)}`;
    })
    .sort();
}

function fingerprintSecretValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function normalizeUrlForKey(value: string): string {
  try {
    const url = new URL(value);

    url.username = "";
    url.password = "";
    url.search = "";

    return url.toString();
  } catch {
    return value.split("?")[0] ?? value;
  }
}
