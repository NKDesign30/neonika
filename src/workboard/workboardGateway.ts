import {
  blockNeonWorkboardCard,
  claimNeonWorkboardCard,
  completeNeonWorkboardCard,
  createNeonWorkboardCard,
  createNeonWorkboardSnapshot,
  createNeonWorkboardStats,
  dispatchNeonWorkboard,
  getNeonWorkboardCard,
  heartbeatNeonWorkboardCard
} from "./workboardStore.js";

export const neonWorkboardReadGatewayMethods = [
  "workboard.cards.list",
  "workboard.cards.read",
  "workboard.cards.stats"
] as const;

export const neonWorkboardWriteGatewayMethods = [
  "workboard.cards.create",
  "workboard.cards.claim",
  "workboard.cards.heartbeat",
  "workboard.cards.complete",
  "workboard.cards.block",
  "workboard.cards.dispatch"
] as const;

export const neonWorkboardGatewayMethodNames = [
  ...neonWorkboardReadGatewayMethods,
  ...neonWorkboardWriteGatewayMethods
] as const;

export type TNeonWorkboardGatewayMethod = (typeof neonWorkboardGatewayMethodNames)[number];

export interface INeonWorkboardRpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

export async function runNeonWorkboardGatewayMethod(
  projectRoot: string,
  method: string,
  params: unknown
): Promise<unknown> {
  const record = isRecord(params) ? params : {};

  switch (method) {
    case "workboard.cards.list":
      return await createNeonWorkboardSnapshot(projectRoot);
    case "workboard.cards.read": {
      const card = await getNeonWorkboardCard(projectRoot, readRequiredText(record, "id"));
      if (!card) {
        throw new Error(`card not found: ${readRequiredText(record, "id")}`);
      }
      return { card };
    }
    case "workboard.cards.stats":
      return await createNeonWorkboardStats(projectRoot);
    case "workboard.cards.create":
      return { card: await createNeonWorkboardCard(projectRoot, record) };
    case "workboard.cards.claim":
      return await claimNeonWorkboardCard(projectRoot, record);
    case "workboard.cards.heartbeat":
      return { card: await heartbeatNeonWorkboardCard(projectRoot, record) };
    case "workboard.cards.complete":
      return { card: await completeNeonWorkboardCard(projectRoot, record) };
    case "workboard.cards.block":
      return { card: await blockNeonWorkboardCard(projectRoot, record) };
    case "workboard.cards.dispatch":
      return await dispatchNeonWorkboard(projectRoot);
    default:
      throw new Error(`unsupported workboard method: ${method}`);
  }
}

export function parseNeonWorkboardRpcRequest(value: unknown): INeonWorkboardRpcRequest | undefined {
  if (!isRecord(value) || typeof value["method"] !== "string" || !value["method"].trim()) {
    return undefined;
  }

  return {
    method: value["method"].trim(),
    ...(Object.hasOwn(value, "params") ? { params: value["params"] } : {})
  };
}

function readRequiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
