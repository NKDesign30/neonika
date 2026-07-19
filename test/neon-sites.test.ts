import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonSiteAnalyticsSnapshot,
  createNeonSitesSnapshot,
  neonSiteAnalyticsCommandEnvKey,
  neonSitesJsonEnvKey,
  listenNeonGatewayHttpServer,
  type TNeonSiteAnalyticsRunner
} from "../src/index.js";

describe("Neonika Sites", () => {
  it("stays honestly empty without public configuration", () => {
    assert.deepEqual(createNeonSitesSnapshot({}), { sites: [] });
  });

  it("exposes the honest empty snapshot through the live HTTP entry point", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-sites-http-"));
    const previousSites = process.env[neonSitesJsonEnvKey];

    try {
      delete process.env[neonSitesJsonEnvKey];
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-sites`);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sites: [] });
      } finally {
        await handle.close();
      }
    } finally {
      if (previousSites === undefined) {
        delete process.env[neonSitesJsonEnvKey];
      } else {
        process.env[neonSitesJsonEnvKey] = previousSites;
      }
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("accepts only bounded, unique, public-safe site records", () => {
    const snapshot = createNeonSitesSnapshot({
      [neonSitesJsonEnvKey]: JSON.stringify([
        { property: "example", label: "Example", domain: "example.com" },
        { property: "example", label: "Duplicate", domain: "duplicate.example" },
        { property: "bad value", label: "Rejected", domain: "localhost" }
      ])
    });

    assert.deepEqual(snapshot, {
      sites: [{ property: "example", label: "Example", domain: "example.com" }]
    });
  });

  it("runs the configured executable without a shell and returns parsed analytics", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run: TNeonSiteAnalyticsRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: '{"property":"example","days":90,"token":"sk-supersecretvalue123456789"}'
      };
    };
    const result = await createNeonSiteAnalyticsSnapshot("example", 120, {
      env: {
        [neonSitesJsonEnvKey]: '[{"property":"example","label":"Example","domain":"example.com"}]',
        [neonSiteAnalyticsCommandEnvKey]: "/opt/example/analytics"
      },
      run
    });

    assert.deepEqual(result, {
      ok: true,
      value: { property: "example", days: 90, token: "[REDACTED_SECRET]" }
    });
    assert.doesNotMatch(JSON.stringify(result), /sk-supersecretvalue123456789/);
    assert.deepEqual(calls, [
      {
        command: "/opt/example/analytics",
        args: ["--json", "--property", "example", "--days", "90"]
      }
    ]);
  });

  it("fails closed for unknown sites and unavailable analytics", async () => {
    const env = {
      [neonSitesJsonEnvKey]: '[{"property":"example","label":"Example","domain":"example.com"}]'
    };

    assert.deepEqual(await createNeonSiteAnalyticsSnapshot("other", 28, { env }), {
      ok: false,
      status: 404,
      error: "unknown-site"
    });
    assert.deepEqual(await createNeonSiteAnalyticsSnapshot("example", 28, { env }), {
      ok: false,
      status: 502,
      error: "analytics-command-unavailable"
    });
    assert.deepEqual(
      await createNeonSiteAnalyticsSnapshot("example", 28, {
        env: { ...env, [neonSiteAnalyticsCommandEnvKey]: "analytics-cli" }
      }),
      { ok: false, status: 502, error: "analytics-command-unavailable" }
    );
  });
});
