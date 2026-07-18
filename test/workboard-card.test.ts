import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  claimNeonWorkboardCard,
  completeNeonWorkboardCard,
  createNeonWorkboardCardSnapshot,
  createNeonWorkboardCard,
  dispatchNeonWorkboard,
  heartbeatNeonWorkboardCard,
  listenNeonGatewayHttpServer,
  neonWorkboardStatuses,
  readNeonWorkboardCards,
  type INeonWorkboardListResult
} from "../src/index.js";

describe("Neon Workboard cards", () => {
  it("supports card create, claim, heartbeat, proof completion, and redacted reads", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const created = await createNeonWorkboardCard(
        projectRoot,
        {
          title: "Ship Workboard sk-live-SHOULD-REDACT",
          status: "ready",
          priority: "urgent",
          labels: ["runtime", "upstream"],
          agentId: "chaty"
        },
        1000
      );

      assert.equal(created.status, "ready");
      assert.deepEqual(createNeonWorkboardStatuses(), neonWorkboardStatuses);
      assert.doesNotMatch(JSON.stringify(created), /sk-live-SHOULD-REDACT/);

      const claimed = await claimNeonWorkboardCard(
        projectRoot,
        { id: created.id, ownerId: "chaty", ttlSeconds: 60 },
        2000
      );

      assert.equal(claimed.card.status, "running");
      assert.equal(claimed.card.metadata?.claim?.token, "[redacted]");
      assert.notEqual(claimed.token, "[redacted]");

      const heartbeat = await heartbeatNeonWorkboardCard(
        projectRoot,
        { id: created.id, token: claimed.token, note: "Still moving" },
        3000
      );

      assert.equal(heartbeat.metadata?.comments?.at(-1)?.body, "Still moving");

      const completed = await completeNeonWorkboardCard(
        projectRoot,
        {
          id: created.id,
          token: claimed.token,
          summary: "Done",
          proof: { status: "passed", command: "npm test" }
        },
        4000
      );

      assert.equal(completed.status, "done");
      assert.equal(completed.completedAt, 4000);
      assert.equal(completed.metadata?.claim, undefined);
      assert.equal(completed.metadata?.proof?.at(-1)?.status, "passed");

      const cards = await readNeonWorkboardCards(projectRoot);
      assert.equal(cards.length, 1);
      assert.doesNotMatch(JSON.stringify(cards), new RegExp(claimed.token));
      assert.doesNotMatch(JSON.stringify(cards), /sk-live-SHOULD-REDACT/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("exposes the card lifecycle through the live HTTP RPC", async () => {
    const projectRoot = await createTempProjectRoot();
    const handle = await listenNeonGatewayHttpServer(
      { projectRoot },
      { host: "127.0.0.1", port: 0 }
    );

    try {
      const created = await postWorkboardRpc(handle.url, "workboard.cards.create", {
        title: "RPC Card",
        status: "ready",
        priority: "high",
        agentId: "chaty"
      });
      const card = readRecordField(created, "card");
      const cardId = readStringField(card, "id");
      const claimed = await postWorkboardRpc(handle.url, "workboard.cards.claim", {
        id: cardId,
        ownerId: "chaty",
        ttlSeconds: 60
      });
      const token = readStringField(claimed, "token");

      await postWorkboardRpc(handle.url, "workboard.cards.complete", {
        id: cardId,
        token,
        summary: "HTTP RPC verified",
        proof: { status: "passed", command: "node --test" }
      });

      const listResponse = await fetch(`${handle.url}/api/workboard/cards`);
      const list = (await listResponse.json()) as INeonWorkboardListResult;

      assert.equal(listResponse.status, 200);
      assert.deepEqual(list.statuses, neonWorkboardStatuses);
      assert.equal(list.cards.find((candidate) => candidate.id === cardId)?.status, "done");
      assert.doesNotMatch(JSON.stringify(list), new RegExp(token));
    } finally {
      await handle.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("dispatch blocks stale running claims and records ready dispatches", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const running = await createNeonWorkboardCard(
        projectRoot,
        { title: "Stale run", status: "ready", priority: "normal" },
        1000
      );
      const ready = await createNeonWorkboardCard(
        projectRoot,
        { title: "Ready card", status: "ready", priority: "normal" },
        1000
      );
      await claimNeonWorkboardCard(
        projectRoot,
        { id: running.id, ownerId: "chaty", ttlSeconds: 1 },
        2000
      );

      const result = await dispatchNeonWorkboard(projectRoot, 310_000);
      const cards = await readNeonWorkboardCards(projectRoot);

      assert.equal(result.blocked.length, 1);
      assert.equal(cards.find((card) => card.id === running.id)?.status, "blocked");
      assert.equal(cards.find((card) => card.id === ready.id)?.metadata?.dispatchCount, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function postWorkboardRpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/api/workboard/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params })
  });

  assert.equal(response.status, 200);
  return readJsonRecord(await response.json());
}

function createNeonWorkboardStatuses(): readonly string[] {
  return ["triage", "backlog", "todo", "scheduled", "ready", "running", "review", "blocked", "done"];
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }

  return value as Record<string, unknown>;
}

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return readJsonRecord(record[key]);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected string field ${key}`);
  }

  return value.trim();
}

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-upstream-workboard-"));
}
