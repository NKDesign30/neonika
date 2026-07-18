import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeRunnerSnapshot,
  executeNeonNodeRunnerDispatch,
  resolveNeonNodeRunnerPaths,
  renderNeonNodeRunnerReport,
  renderNeonNodeRunnerSnapshotReport,
  runNeonNodeRunnerLoop,
  runNeonNodeRunnerOnce,
  writeNeonNodeRunnerControl,
  type INeonNodeTransportDispatch,
  type TNeonNodeRunnerFetch
} from "../src/index.js";

describe("Neon Node Runner", () => {
  it("executes bounded file dispatches without workspace escape or raw secret output", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "runner-fixtures"), { recursive: true });
      await writeFile(join(projectRoot, "runner-fixtures", "sample.txt"), "runner TOKEN=runner-value\n", "utf8");

      const listResult = await executeNeonNodeRunnerDispatch(
        projectRoot,
        createRunnerDispatch("file.list", { path: "runner-fixtures" })
      );
      const dirListResult = await executeNeonNodeRunnerDispatch(
        projectRoot,
        createRunnerDispatch("dir.list", { path: "runner-fixtures" })
      );
      const fetchResult = await executeNeonNodeRunnerDispatch(
        projectRoot,
        createRunnerDispatch("file.fetch", { path: "runner-fixtures/sample.txt" })
      );
      const escapeResult = await executeNeonNodeRunnerDispatch(
        projectRoot,
        createRunnerDispatch("file.fetch", { path: "../outside.txt" })
      );

      assert.equal(listResult.state, undefined);
      assert.equal(listResult.entries?.length, 1);
      assert.equal(listResult.totalEntries, 1);
      assert.equal(dirListResult.state, undefined);
      assert.equal(dirListResult.entries?.length, 1);
      assert.equal(dirListResult.totalEntries, 1);
      assert.equal(fetchResult.state, undefined);
      assert.equal(fetchResult.binary, false);
      assert.match(fetchResult.textPreview ?? "", /\[REDACTED\]/u);
      assert.doesNotMatch(JSON.stringify(fetchResult), /TOKEN=runner-value/u);
      assert.equal(escapeResult.state, "blocked");
      assert.equal(escapeResult.blockReason, "unsafe-target");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reads a loopback CDP browser tab inventory without leaking query tokens or debugger handles", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const cdpPayload = JSON.stringify([
        {
          type: "page",
          title: "Neon Mission Control",
          url: "http://localhost:8788/mission-control?token=secret-query-token"
        },
        { type: "page", title: "GitHub", url: "https://github.com/neondev/neonika" },
        {
          type: "service_worker",
          title: "background worker",
          url: "https://example.com/sw.js",
          webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/SWHANDLE"
        },
        {
          type: "page",
          title: "App Tab",
          url: "https://app.example.com/dashboard",
          webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/PAGEHANDLE"
        }
      ]);
      const fetchImpl: TNeonNodeRunnerFetch = async () => new Response(cdpPayload, { status: 200 });

      const result = await executeNeonNodeRunnerDispatch(
        projectRoot,
        createRunnerDispatch("browser.tabs", { url: "http://localhost:9222/json/list" }),
        { fetchImpl }
      );

      assert.equal(result.state, undefined);
      assert.equal(result.status, 200);
      // service_worker target is filtered out — only real pages are inventoried.
      assert.equal(result.tabs?.length, 3);
      assert.equal(result.totalEntries, 3);
      assert.deepEqual(result.tabs, [
        { title: "Neon Mission Control", host: "localhost:8788" },
        { title: "GitHub", host: "github.com" },
        { title: "App Tab", host: "app.example.com" }
      ]);
      // Leak-safe: no query token, no debugger control handle, no full page URL.
      const serialized = JSON.stringify(result);
      assert.doesNotMatch(serialized, /secret-query-token/u);
      assert.doesNotMatch(serialized, /webSocketDebuggerUrl|devtools\/page/u);
      assert.doesNotMatch(serialized, /\/dashboard/u);
      assert.match(result.summary ?? "", /read 3 loopback browser tab\(s\) \(200\)/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks a non-loopback browser tab inventory target", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const fetchImpl: TNeonNodeRunnerFetch = async () => new Response("[]", { status: 200 });
      const result = await executeNeonNodeRunnerDispatch(
        projectRoot,
        createRunnerDispatch("browser.tabs", { url: "http://10.0.0.5:9222/json/list" }),
        { fetchImpl }
      );

      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "unsafe-target");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("polls and submits through the paired-node HTTP contract without exposing session secrets", async () => {
    const projectRoot = await createTempProjectRoot();
    const dispatch = createRunnerDispatch("file.list", { path: "." });
    const sessionSecret = "runner-session-unit-value";
    const submittedBodies: string[] = [];
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl: TNeonNodeRunnerFetch = async (input, init) => {
      const url = requestInputToUrl(input);
      const headers = normalizeHeaders(init?.headers);
      seenHeaders.push(headers);

      if (url.endsWith("/api/neon-nodes/transport/poll")) {
        return new Response(
          JSON.stringify({
            replay: "replay",
            cursor: "node-cursor-unit",
            heartbeatAt: "2026-06-01T00:00:00.000Z",
            dispatches: [dispatch]
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }

      if (url.endsWith("/api/neon-nodes/transport/results")) {
        submittedBodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ state: "received" }), {
          status: 201,
          headers: {
            "content-type": "application/json"
          }
        });
      }

      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    };

    try {
      await writeFile(join(projectRoot, "sample.txt"), "runner\n", "utf8");

      const result = await runNeonNodeRunnerOnce({
        gatewayUrl: "http://127.0.0.1:8797",
        projectRoot,
        sessionId: "device-session-unit",
        sessionSecret,
        fetchImpl
      });
      const report = renderNeonNodeRunnerReport(result);

      assert.equal(result.state, "submitted");
      assert.equal(result.dispatches, 1);
      assert.equal(result.submitted, 1);
      assert.equal(result.blocked, 0);
      assert.equal(result.failed, 0);
      assert.equal(submittedBodies.length, 1);
      assert.match(submittedBodies[0] ?? "", /node-dispatch-unit/u);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sessionSecret, "u"));
      assert.doesNotMatch(report, new RegExp(sessionSecret, "u"));
      assert.equal(seenHeaders[0]?.["x-neon-node-session-secret"], sessionSecret);
      assert.equal(seenHeaders[1]?.["x-neon-node-session-secret"], sessionSecret);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("persists supervised loop health, cursor, and stop control without session secrets", async () => {
    const projectRoot = await createTempProjectRoot();
    const dispatch = createRunnerDispatch("file.list", { path: "." });
    const sessionSecret = "runner-loop-session-value";
    const fetchImpl = createLoopFetch(dispatch);

    try {
      await writeFile(join(projectRoot, "sample.txt"), "runner\n", "utf8");
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "unit loop"
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );

      const running = await runNeonNodeRunnerLoop({
        gatewayUrl: "http://127.0.0.1:8797",
        projectRoot,
        sessionId: "device-session-unit",
        sessionSecret,
        fetchImpl,
        intervalMs: 0,
        maxCycles: 2,
        now: () => new Date("2026-06-01T00:01:00.000Z"),
        wait: async () => undefined
      });
      const runningState = await createNeonNodeRunnerSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:02:00.000Z")
      });
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "stopped",
          operatorId: "chaty",
          reason: "unit stop"
        },
        {
          now: () => new Date("2026-06-01T00:03:00.000Z")
        }
      );
      const stoppedState = await createNeonNodeRunnerSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:04:00.000Z")
      });
      const rawHealth = await readFile(resolveNeonNodeRunnerPaths(projectRoot).healthPath, "utf8");
      const report = renderNeonNodeRunnerSnapshotReport(runningState);

      assert.equal(running.state, "running");
      assert.equal(running.totals.cycles, 2);
      assert.equal(running.totals.pollRequests, 2);
      assert.equal(running.totals.dispatches, 1);
      assert.equal(running.totals.submitted, 1);
      assert.equal(running.totals.failed, 0);
      assert.equal(runningState.cursor, "node-cursor-unit");
      assert.equal(stoppedState.state, "stopped");
      assert.equal(stoppedState.control.desiredState, "stopped");
      assert.doesNotMatch(rawHealth, new RegExp(sessionSecret, "u"));
      assert.doesNotMatch(report, new RegExp(sessionSecret, "u"));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createRunnerDispatch(
  kind: INeonNodeTransportDispatch["kind"],
  target: INeonNodeTransportDispatch["target"]
): INeonNodeTransportDispatch {
  return {
    dispatchId: "node-dispatch-unit",
    state: "ready",
    approvalId: "node-approval-unit",
    requestId: "node-request-unit",
    sessionId: "device-session-unit",
    deviceId: "operator-node",
    kind,
    target,
    requestedAt: "2026-06-01T00:00:00.000Z",
    approvedAt: "2026-06-01T00:01:00.000Z",
    generatedAt: "2026-06-01T00:02:00.000Z",
    delivery: "poll",
    safety: {
      readOnly: true,
      mutationAllowed: false,
      sideEffectExecuted: false,
      rawOutputPersisted: false,
      rawTokenExposed: false,
      sessionSecretExposed: false
    }
  };
}

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-node-runner-test-"));
}

function requestInputToUrl(input: Parameters<TNeonNodeRunnerFetch>[0]): string {
  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof input === "string") {
    return input;
  }

  return input.url;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

function createLoopFetch(dispatch: INeonNodeTransportDispatch): TNeonNodeRunnerFetch {
  let polls = 0;

  return async (input, init) => {
    const url = requestInputToUrl(input);

    if (url.includes("/api/neon-nodes/transport/poll")) {
      polls += 1;

      return new Response(
        JSON.stringify({
          replay: polls === 1 ? "replay" : "cursor-hit",
          cursor: "node-cursor-unit",
          heartbeatAt: "2026-06-01T00:00:00.000Z",
          dispatches: polls === 1 ? [dispatch] : []
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    if (url.includes("/api/neon-nodes/transport/results")) {
      assert.match(String(init?.body ?? ""), /node-dispatch-unit/u);

      return new Response(JSON.stringify({ state: "received" }), {
        status: 201,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  };
}
