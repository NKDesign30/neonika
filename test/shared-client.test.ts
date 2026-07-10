import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CodexAppServerClientPool,
  createStartOptionsKey,
  type ICodexAppServerClient,
  type ICodexAppServerStartOptions,
  type TJsonValue
} from "../src/index.js";

const baseOptions: ICodexAppServerStartOptions = {
  transport: "stdio",
  command: "codex",
  args: ["app-server", "--listen", "stdio://"],
  headers: {
    Authorization: "Bearer should-not-enter-key"
  },
  env: {
    OPENAI_API_KEY: "sk-should-not-enter-key"
  },
  clearEnv: ["OPENAI_API_KEY"]
};

describe("Codex app-server shared client pool", () => {
  it("creates stable keys without secret values", () => {
    const key = createStartOptionsKey(baseOptions);

    assert.equal(key, createStartOptionsKey(baseOptions));
    assert.doesNotMatch(key, /sk-/);
    assert.doesNotMatch(key, /Bearer/);
    assert.doesNotMatch(key, /should-not-enter-key/);
    assert.equal(key.length, 24);
  });

  it("separates keys when secret-bearing auth values change", () => {
    const key = createStartOptionsKey(baseOptions);
    const rotatedKey = createStartOptionsKey({
      ...baseOptions,
      authToken: "mutation-token-v2",
      headers: {
        Authorization: "Bearer should-not-enter-key-v2"
      },
      env: {
        OPENAI_API_KEY: "sk-should-not-enter-key-v2"
      }
    });

    assert.notEqual(rotatedKey, key);
    assert.doesNotMatch(rotatedKey, /sk-/);
    assert.doesNotMatch(rotatedKey, /Bearer/);
    assert.doesNotMatch(rotatedKey, /should-not-enter-key/);
    assert.equal(rotatedKey.length, 24);
  });

  it("reuses one initialized client for equivalent start options", async () => {
    const clients: MockCodexClient[] = [];
    const pool = new CodexAppServerClientPool((options) => {
      const client = new MockCodexClient(options);

      clients.push(client);

      return client;
    });
    const first = await pool.acquire(baseOptions);
    const second = await pool.acquire({ ...baseOptions });

    assert.equal(first.client, second.client);
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.initializeCount, 1);
    assert.equal(pool.getActiveLeaseCountForTests(baseOptions), 2);

    await first.release();
    assert.equal(pool.getActiveLeaseCountForTests(baseOptions), 1);
    await second.release();
    assert.equal(pool.getActiveLeaseCountForTests(baseOptions), 0);
  });

  it("separates clients when non-secret connection shape changes", async () => {
    const clients: MockCodexClient[] = [];
    const pool = new CodexAppServerClientPool((options) => {
      const client = new MockCodexClient(options);

      clients.push(client);

      return client;
    });
    const first = await pool.acquire(baseOptions);
    const second = await pool.acquire({
      ...baseOptions,
      args: ["app-server", "--listen", "stdio://", "--profile", "neon"]
    });

    assert.notEqual(first.client, second.client);
    assert.equal(clients.length, 2);

    await pool.closeAll();
    assert.equal(clients.every((client) => client.closed), true);
    assert.equal(pool.getClientCountForTests(), 0);
  });

  it("separates warm clients when only Authorization values differ", async () => {
    const clients: MockCodexClient[] = [];
    const pool = new CodexAppServerClientPool((options) => {
      const client = new MockCodexClient(options);

      clients.push(client);

      return client;
    });
    const first = await pool.acquire(baseOptions);
    const second = await pool.acquire({
      ...baseOptions,
      headers: {
        Authorization: "Bearer should-not-enter-key-v2"
      }
    });

    assert.notEqual(first.client, second.client);
    assert.equal(clients.length, 2);

    await pool.closeAll();
    assert.equal(clients.every((client) => client.closed), true);
  });

  it("retires a warm client after active leases release", async () => {
    const clients: MockCodexClient[] = [];
    const pool = new CodexAppServerClientPool((options) => {
      const client = new MockCodexClient(options);

      clients.push(client);

      return client;
    });
    const lease = await pool.acquire(baseOptions);

    assert.equal(await pool.retireWhenIdle(baseOptions), true);
    assert.equal(clients[0]?.closed, false);

    await lease.release();

    assert.equal(clients[0]?.closed, true);
    assert.equal(pool.getClientCountForTests(), 0);
  });
});

class MockCodexClient implements ICodexAppServerClient {
  initializeCount = 0;
  closed = false;

  constructor(readonly options: ICodexAppServerStartOptions) {}

  async initialize(): Promise<void> {
    this.initializeCount += 1;
  }

  async request(): Promise<TJsonValue | undefined> {
    return undefined;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
