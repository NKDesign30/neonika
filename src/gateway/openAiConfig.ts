import { readFile } from "node:fs/promises";

import { parseEnvValue } from "./elevenLabsConfig.js";

export interface IOpenAiApiKeySource {
  readonly openAiApiKey?: string;
  readonly openAiApiKeyEnvFile?: string;
}

export async function resolveOpenAiApiKey(source: IOpenAiApiKeySource): Promise<string | undefined> {
  const direct = source.openAiApiKey?.trim();
  if (direct) {
    return direct;
  }

  if (!source.openAiApiKeyEnvFile) {
    return undefined;
  }

  try {
    const envFile = await readFile(source.openAiApiKeyEnvFile, "utf8");
    return parseEnvValue(envFile, "OPENAI_API_KEY");
  } catch {
    return undefined;
  }
}
