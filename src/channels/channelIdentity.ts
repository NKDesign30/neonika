import { createHash } from "node:crypto";

import type { INeonSetupConfig, TNeonSetupChannel } from "../onboarding/neonSetup.js";

export interface INeonChannelPeerInput {
  readonly channel: TNeonSetupChannel;
  readonly accountId: string;
  readonly peerId: string;
}

export interface INeonCanonicalPeerResolution {
  readonly linkedToOwner: boolean;
  readonly canonicalPeerId: string;
  readonly sessionPeerKey: string;
  readonly channel: TNeonSetupChannel;
  readonly accountId: string;
}

/**
 * Resolves an inbound channel identity through an explicit local link only.
 * Similar names, phone suffixes, and cross-channel guesses never merge peers.
 * The stable session key is hashed so chat ids and phone numbers do not enter
 * filenames, logs, or persisted binding keys.
 */
export function resolveNeonCanonicalPeer(
  config: INeonSetupConfig,
  input: INeonChannelPeerInput
): INeonCanonicalPeerResolution {
  const channel = input.channel;
  const accountId = normalizeIdentityPart(input.accountId, "account id");
  const peerId = normalizeIdentityPart(input.peerId, "peer id");
  const linked = config.identity.links.some(
    (entry) =>
      entry.channel === channel &&
      entry.accountId === accountId &&
      entry.peerId === peerId
  );
  const canonicalPeerId = linked
    ? config.identity.ownerId
    : `${channel}:${fingerprint(`${accountId}:${peerId}`)}`;
  const scope = linked ? "owner" : channel;

  return {
    linkedToOwner: linked,
    canonicalPeerId,
    sessionPeerKey: `${scope}:${fingerprint(canonicalPeerId)}`,
    channel,
    accountId
  };
}

function normalizeIdentityPart(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 160 || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`${label} must be 1-160 characters on one line`);
  }
  return normalized;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
