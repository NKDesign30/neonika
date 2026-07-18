import { readFile } from "node:fs/promises";

export interface IElevenLabsApiKeySource {
  readonly apiKey?: string;
  readonly apiKeyEnvFile?: string;
}

export async function resolveElevenLabsApiKey(
  source: IElevenLabsApiKeySource
): Promise<string | undefined> {
  const direct = source.apiKey?.trim();
  if (direct) {
    return direct;
  }

  if (!source.apiKeyEnvFile) {
    return undefined;
  }

  try {
    const envFile = await readFile(source.apiKeyEnvFile, "utf8");
    return parseEnvValue(envFile, "ELEVENLABS_API_KEY");
  } catch {
    return undefined;
  }
}

export function parseEnvValue(source: string, key: string): string | undefined {
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.startsWith(`${key}=`)) {
      continue;
    }
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/gu, "");
  }
  return undefined;
}
