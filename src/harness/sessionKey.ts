import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { ICodexSessionBinding } from "./types.js";

export function deriveCodexSessionKey(binding: ICodexSessionBinding): string {
  const workspaceHash = hashWorkspace(binding.workspaceRoot);
  const guildSegment = binding.guildId ? segment(binding.guildId) : "dm";
  const threadSegment = binding.threadId ? segment(binding.threadId) : "main";

  return [
    "neon",
    "codex",
    segment(binding.agentId),
    segment(binding.channel),
    segment(binding.accountId),
    guildSegment,
    segment(binding.channelId),
    threadSegment,
    workspaceHash,
    binding.mode
  ].join(":");
}

export function hashWorkspace(workspaceRoot: string): string {
  return createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

function segment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "none";
}
