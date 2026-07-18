import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { TNeonDiscordMediaAttachment } from "./discordMediaPayload.js";

export interface INeonLocalMediaAttachmentResult {
  readonly text: string;
  readonly attachments: readonly TNeonDiscordMediaAttachment[];
  readonly attachedFilenames: readonly string[];
  readonly attachedFiles: readonly INeonLocalMediaFile[];
}

export interface INeonLocalMediaFile {
  readonly name: string;
  readonly absolutePath: string;
  readonly contentType?: string;
}

export interface ICreateNeonLocalMediaAttachmentsOptions {
  readonly projectRoot: string;
  readonly maxAttachments?: number;
}

interface INeonLocalMediaCandidate {
  readonly raw: string;
  readonly pathText: string;
}

const localMediaExtensions = new Set([
  ".aac",
  ".avi",
  ".bmp",
  ".csv",
  ".doc",
  ".docx",
  ".flac",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".oga",
  ".ogg",
  ".odp",
  ".ods",
  ".odt",
  ".opus",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rtf",
  ".svg",
  ".tif",
  ".tiff",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip"
]);

const mediaCandidatePattern =
  /`([^`]+?\.(?:aac|avi|bmp|csv|docx?|flac|gif|heic|heif|jpe?g|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|od[pst]|oga|ogg|opus|pdf|png|pptx?|rtf|svg|tiff?|txt|wav|webm|webp|xlsx?|zip))`|((?:\/[^\s`"'<>]+|(?:\.{1,2}\/|state\/)[^\s`"'<>]+?)\.(?:aac|avi|bmp|csv|docx?|flac|gif|heic|heif|jpe?g|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|od[pst]|oga|ogg|opus|pdf|png|pptx?|rtf|svg|tiff?|txt|wav|webm|webp|xlsx?|zip))/gi;

const defaultMaxAttachments = 4;

export async function createNeonLocalMediaAttachmentsFromText(
  text: string,
  options: ICreateNeonLocalMediaAttachmentsOptions
): Promise<INeonLocalMediaAttachmentResult> {
  const projectRoot = resolve(options.projectRoot);
  const maxAttachments = resolveMaxAttachments(options.maxAttachments);
  const candidates = extractLocalMediaCandidates(text);
  const seenPaths = new Set<string>();
  const attachments: TNeonDiscordMediaAttachment[] = [];
  const attachedFilenames: string[] = [];
  const attachedFiles: INeonLocalMediaFile[] = [];
  let cleanText = text;

  for (const candidate of candidates) {
    const filename = basename(candidate.pathText);
    cleanText = cleanText.replace(candidate.raw, filename);

    if (attachments.length >= maxAttachments) {
      continue;
    }

    const absolutePath = resolveCandidatePath(candidate.pathText, projectRoot);
    if (!isAllowedProjectPath(absolutePath, projectRoot) || seenPaths.has(absolutePath)) {
      continue;
    }

    try {
      const data = await readFile(absolutePath);
      const contentType = resolveContentType(filename);
      attachments.push({
        name: filename,
        data,
        ...(contentType !== undefined ? { contentType } : {})
      });
      attachedFilenames.push(filename);
      attachedFiles.push({
        name: filename,
        absolutePath,
        ...(contentType !== undefined ? { contentType } : {})
      });
      seenPaths.add(absolutePath);
    } catch {
      // Missing or unreadable local files are not fatal; the reply still stays path-safe.
    }
  }

  return {
    text: cleanText.trim(),
    attachments,
    attachedFilenames,
    attachedFiles
  };
}

function extractLocalMediaCandidates(text: string): readonly INeonLocalMediaCandidate[] {
  const candidates: INeonLocalMediaCandidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = mediaCandidatePattern.exec(text)) !== null) {
    const pathText = match[1] ?? match[2];
    if (!pathText) {
      continue;
    }

    const extension = extname(pathText).toLowerCase();
    if (!localMediaExtensions.has(extension)) {
      continue;
    }

    candidates.push({
      raw: match[0],
      pathText
    });
  }

  return candidates;
}

function resolveCandidatePath(pathText: string, projectRoot: string): string {
  if (isAbsolute(pathText)) {
    return resolve(pathText);
  }

  return resolve(join(projectRoot, pathText));
}

function isAllowedProjectPath(pathname: string, projectRoot: string): boolean {
  const rel = relative(projectRoot, pathname);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function resolveMaxAttachments(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return defaultMaxAttachments;
  }

  return Math.floor(value);
}

function resolveContentType(filename: string): string | undefined {
  const extension = extname(filename).toLowerCase();
  switch (extension) {
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".odt":
      return "application/vnd.oasis.opendocument.text";
    case ".ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case ".odp":
      return "application/vnd.oasis.opendocument.presentation";
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".rtf":
      return "application/rtf";
    case ".zip":
      return "application/zip";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".flac":
      return "audio/flac";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    default:
      return undefined;
  }
}
