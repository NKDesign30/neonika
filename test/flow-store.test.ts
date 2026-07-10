import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  readNeonFlow,
  readNeonFlowRecords,
  readNeonFlows,
  resolveNeonFlowStatePaths,
  writeNeonFlow,
  type INeonFlowDefinition
} from "../src/index.js";

describe("Neon Flow store", () => {
  it("writes and reads flow definitions from a Neon-owned JSONL store", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonFlow(projectRoot, createFlow("flow-1", { status: "armed" }));
      await writeNeonFlow(projectRoot, createFlow("flow-2", { status: "draft" }));

      const flows = await readNeonFlows(projectRoot);

      assert.equal(flows.length, 2);
      assert.equal(flows[0]?.flowId, "flow-1");
      assert.match(resolveNeonFlowStatePaths(projectRoot).flowsPath, /state\/flows\/flows\.jsonl$/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("collapses an append-only log to the latest definition per flowId", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonFlow(projectRoot, createFlow("flow-1", { status: "draft", updatedAt: "2026-06-01T00:00:00.000Z" }));
      await writeNeonFlow(projectRoot, createFlow("flow-1", { status: "armed", updatedAt: "2026-06-02T00:00:00.000Z" }));

      const records = await readNeonFlowRecords(projectRoot);
      const projected = await readNeonFlows(projectRoot);

      assert.equal(records.length, 2);
      assert.equal(projected.length, 1);
      assert.equal(projected[0]?.status, "armed");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("forces gated=true for side-effecting steps even if the source claims otherwise", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonFlow(
        projectRoot,
        createFlow("flow-gate", {
          steps: [
            { stepId: "read", title: "Read", effect: "read", action: "context.pack", gated: false },
            { stepId: "send", title: "Send", effect: "send", action: "discord.send", gated: false }
          ]
        })
      );

      const flow = await readNeonFlow(projectRoot, "flow-gate");
      const sendStep = flow?.steps.find((step) => step.stepId === "send");
      const readStep = flow?.steps.find((step) => step.stepId === "read");

      assert.equal(sendStep?.gated, true, "a send step is always gated on read");
      assert.equal(readStep?.gated, false, "a read step stays plannable");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("redacts secrets and re-redacts a tampered line on read", async () => {
    const projectRoot = await createTempProjectRoot();
    const paths = resolveNeonFlowStatePaths(projectRoot);

    try {
      await mkdir(dirname(paths.flowsPath), { recursive: true });
      const tampered = {
        ...createFlow("flow-tampered", {}),
        name: "leak sk-live-0123456789abcdefghij",
        description: "token sk-live-0123456789abcdefghij"
      };
      await writeFile(paths.flowsPath, `${JSON.stringify(tampered)}\n`, "utf8");

      const flows = await readNeonFlows(projectRoot);

      assert.equal(flows.length, 1);
      assert.doesNotMatch(JSON.stringify(flows), /sk-live-0123456789abcdefghij/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("skips corrupted and malformed lines while keeping valid flows", async () => {
    const projectRoot = await createTempProjectRoot();
    const paths = resolveNeonFlowStatePaths(projectRoot);

    try {
      await mkdir(dirname(paths.flowsPath), { recursive: true });
      await writeFile(
        paths.flowsPath,
        [
          JSON.stringify(createFlow("flow-valid", {})),
          "not-json",
          JSON.stringify({ flowId: "flow-no-trigger", name: "x", ownerAgentId: "neo", status: "armed" })
        ].join("\n"),
        "utf8"
      );

      const flows = await readNeonFlows(projectRoot);

      assert.equal(flows.length, 1);
      assert.equal(flows[0]?.flowId, "flow-valid");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createFlow(flowId: string, overrides: Partial<INeonFlowDefinition>): INeonFlowDefinition {
  return {
    flowId,
    name: "Sample flow",
    ownerAgentId: "neo",
    trigger: { kind: "manual" },
    steps: [{ stepId: "recall", title: "Recall", effect: "read", action: "context.pack", gated: false }],
    status: "draft",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides
  };
}

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-flow-store-"));
}
