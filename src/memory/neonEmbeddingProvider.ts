import { createHash } from "node:crypto";

/**
 * Local deterministic embedding provider (memory autarky, Slice 1).
 *
 * Neonika must embed text identically to the way the canonical memory DB was
 * embedded, otherwise a freshly computed query vector can never match a stored
 * BLOB. This is a provider-free feature-hashing embedder (only `node:crypto`, no
 * ML model): token + character-trigram features are SHA-256 hashed into a fixed
 * 384-dim signed bag, then L2-normalized. The name `local:feature-hash` and the
 * 384 dimensions are part of the contract and must not drift.
 *
 * Bit-for-bit compatible with the previous runtime's local embedding provider so
 * vectors written by either runtime are mutually searchable during the cutover.
 */

export const NEON_LOCAL_EMBEDDING_NAME = "local:feature-hash";
export const NEON_LOCAL_EMBEDDING_DIMENSIONS = 384;

export const NEON_OLLAMA_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_NEON_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_NEON_OLLAMA_BASE_URL = "http://localhost:11434";

/** Characters sent to the embedder at most; see the note in `embed`. */
export const MAX_EMBED_INPUT_CHARS = 4000;

export interface INeonEmbeddingRequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Embedding is async because the canonical provider (Ollama) is an HTTP call.
 * The local feature-hash provider is pure CPU but exposes the same async shape
 * so callers stay provider-agnostic.
 */
export interface INeonEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly embed: (
    text: string,
    options?: INeonEmbeddingRequestOptions
  ) => Promise<Float32Array>;
}

export interface INeonOllamaEmbeddingOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly timeoutMs?: number;
}

export function normalizeNeonVector(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    norm += value * value;
  }
  const divisor = Math.sqrt(norm);
  if (divisor === 0) {
    return vector;
  }
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = (vector[index] ?? 0) / divisor;
  }
  return normalized;
}

export function neonCosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const divisor = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return divisor === 0 ? 0 : dot / divisor;
}

/** Serializes a vector to a little-endian Float32 BLOB for DB storage. */
export function neonVectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Deserializes a stored BLOB back to a vector. Accepts a plain `Uint8Array`
 * (what `node:sqlite` returns for BLOB columns) as well as a `Buffer` (Node's
 * Uint8Array subclass). A defensive copy via `slice` avoids aliasing a shared
 * pool buffer and keeps the byte offsets honest.
 */
export function bufferToNeonVector(buffer: Uint8Array): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}

function normalizeEmbeddingText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9äöüß\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function embeddingFeaturesFor(text: string): readonly string[] {
  const normalized = normalizeEmbeddingText(text);
  if (!normalized) {
    return [];
  }
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
  const features: string[] = [];
  for (const token of tokens) {
    features.push(`tok:${token}`);
    const bounded = `^${token}$`;
    for (let index = 0; index <= bounded.length - 3; index += 1) {
      features.push(`tri:${bounded.slice(index, index + 3)}`);
    }
  }
  return features;
}

function hashEmbeddingFeature(
  feature: string,
  dimensions: number
): { readonly index: number; readonly signedWeight: number } {
  const hash = createHash("sha256").update(feature).digest();
  const index = hash.readUInt32BE(0) % dimensions;
  const signedWeight = ((hash[4] ?? 0) & 1) === 0 ? 1 : -1;
  return { index, signedWeight };
}

/** Synchronous local embedding compute (deterministic, no I/O). */
export function embedNeonLocalText(
  text: string,
  dimensions = NEON_LOCAL_EMBEDDING_DIMENSIONS
): Float32Array {
  const safeDimensions = Math.max(32, Math.min(4096, Math.floor(dimensions)));
  const vector = new Float32Array(safeDimensions);
  for (const feature of embeddingFeaturesFor(text)) {
    const { index, signedWeight } = hashEmbeddingFeature(feature, safeDimensions);
    const weight = feature.startsWith("tok:") ? signedWeight : signedWeight * 0.35;
    vector[index] = (vector[index] ?? 0) + weight;
  }
  return normalizeNeonVector(vector);
}

export function createNeonLocalEmbeddingProvider(
  dimensions = NEON_LOCAL_EMBEDDING_DIMENSIONS
): INeonEmbeddingProvider {
  const safeDimensions = Math.max(32, Math.min(4096, Math.floor(dimensions)));
  return {
    name: NEON_LOCAL_EMBEDDING_NAME,
    dimensions: safeDimensions,
    embed: (text) => Promise.resolve(embedNeonLocalText(text, safeDimensions))
  };
}

/**
 * Canonical embedding provider: Ollama `nomic-embed-text` (768 dim), matching how
 * the live memory DB was actually embedded (verified: 2873 entries are 768-dim).
 * Mirrors v2's call exactly — `POST /api/embed` with `{model, input}`, take
 * `embeddings[0]`, pad/truncate to the configured dimensions, then L2-normalize —
 * so a query vector computed here matches the stored BLOBs. Throws on failure
 * (no silent zero-vector) so the caller can fall back to FTS-only instead of
 * matching garbage.
 */
export function createNeonOllamaEmbeddingProvider(
  options: INeonOllamaEmbeddingOptions = {}
): INeonEmbeddingProvider {
  const baseUrl = options.baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? DEFAULT_NEON_OLLAMA_BASE_URL;
  const model = options.model ?? process.env["OLLAMA_EMBED_MODEL"] ?? DEFAULT_NEON_OLLAMA_EMBEDDING_MODEL;
  const dimensions = options.dimensions ?? NEON_OLLAMA_EMBEDDING_DIMENSIONS;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function embed(
    text: string,
    requestOptions?: INeonEmbeddingRequestOptions
  ): Promise<Float32Array> {
    // kiss: hard character cap instead of real token counting. Ollama runs
    // nomic-embed-text with a 2048-token context and answers HTTP 400
    // ("the input length exceeds the context length") for anything longer —
    // which is why 14 meeting notes sat in the DB with no vector at all,
    // invisible to semantic recall and to relation discovery. German prose with
    // names and timestamps runs well under three characters per token, so 4000
    // characters stays inside the window with room to spare (verified against
    // the longest entry in the live DB, 66k characters).
    // Ceiling: a long note is embedded by its opening only. That is the right
    // trade for these entries — meeting notes lead with title, date, TLDR and
    // highlights — but it is a truncation, not a summary. Upgrade path when it
    // starts costing recall: chunk the text, embed each chunk, average the
    // vectors (or keep the best-matching chunk per entry).
    const input = text.length > MAX_EMBED_INPUT_CHARS ? text.slice(0, MAX_EMBED_INPUT_CHARS) : text;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestOptions?.signal
      ? AbortSignal.any([requestOptions.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal
    });
    if (!response.ok) {
      throw new Error(`Ollama embed failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { embeddings?: number[][] };
    const first = json.embeddings?.[0];
    if (!first || first.length === 0) {
      throw new Error("Ollama embed returned no vector");
    }
    const raw = new Float32Array(first);
    if (raw.length === dimensions) {
      return normalizeNeonVector(raw);
    }
    const result = new Float32Array(dimensions);
    result.set(raw.subarray(0, Math.min(raw.length, dimensions)));
    return normalizeNeonVector(result);
  }

  return { name: `ollama:${model}`, dimensions, embed };
}
