/**
 * Resumable Downloads with Chunked Verification
 *
 * The killer feature: download 4GB, fail at 3.8GB, resume from 3.8GB.
 * No more starting over.
 */

import type { ChunkedInfo, SRIString } from './types.js';
import { computeRootHash } from './chunked.js';
import {
  saveDownloadState,
  loadDownloadState,
  deleteDownloadState,
  saveChunk,
  loadChunks,
  isStorageAvailable,
  type DownloadState,
} from './storage.js';

/**
 * Options for resumable fetch
 */
export interface ResumableFetchOptions {
  /**
   * Chunked verification config (required for resumable downloads)
   */
  chunked: ChunkedInfo;

  /**
   * Enable persistence to IndexedDB for resume after page reload
   * @default true
   */
  persist?: boolean;

  /**
   * Progress callback
   */
  onProgress?: (progress: ResumableProgress) => void;

  /**
   * Called when resuming from a previous download
   */
  onResume?: (state: DownloadState) => void;

  /**
   * Custom fetch implementation
   */
  fetchImpl?: typeof fetch;

  /**
   * Timeout per chunk request in ms
   * @default 30000
   */
  chunkTimeout?: number;
}

/**
 * Progress information for resumable downloads
 */
export interface ResumableProgress {
  /** Bytes downloaded and verified */
  bytesVerified: number;

  /** Total bytes (from Content-Length) */
  totalBytes?: number;

  /** Number of verified chunks */
  chunksVerified: number;

  /** Total number of chunks */
  totalChunks: number;

  /** Whether this is a resumed download */
  resumed: boolean;

  /** Download speed in bytes/second (rolling average) */
  speed: number;

  /** Estimated time remaining in ms */
  eta?: number;
}

/**
 * Result of a resumable fetch
 */
export interface ResumableFetchResult {
  /** The verified response data */
  data: ArrayBuffer;

  /** Whether the download was resumed */
  resumed: boolean;

  /** Number of chunks that were already verified (from resume) */
  chunksResumed: number;

  /** Total chunks downloaded */
  totalChunks: number;

  /** Total bytes */
  totalBytes: number;
}

/**
 * Fetch a file with resumable, chunked verification
 *
 * If the download fails or the page reloads, calling this again
 * with the same URL will resume from the last verified chunk.
 *
 * @example
 * ```ts
 * const result = await verifyFetchResumable('/model.safetensors', {
 *   chunked: manifest.artifacts['/model.safetensors'].chunked,
 *   onProgress: ({ bytesVerified, totalBytes, chunksVerified, totalChunks }) => {
 *     console.log(`${chunksVerified}/${totalChunks} chunks verified`);
 *   }
 * });
 *
 * // If page reloads or network fails, call again to resume:
 * const result2 = await verifyFetchResumable('/model.safetensors', {
 *   chunked: manifest.artifacts['/model.safetensors'].chunked,
 *   onResume: (state) => {
 *     console.log(`Resuming from chunk ${state.verifiedChunks}`);
 *   }
 * });
 * ```
 */
export async function verifyFetchResumable(
  url: string | URL,
  options: ResumableFetchOptions
): Promise<ResumableFetchResult> {
  const {
    chunked,
    persist = true,
    onProgress,
    onResume,
    fetchImpl = fetch,
    chunkTimeout = 30000,
  } = options;

  const urlString = url.toString();
  const totalChunks = chunked.hashes?.length || 0;

  if (totalChunks === 0) {
    throw new Error('Chunked config has no hashes');
  }

  const algorithm = algorithmFromSri(chunked.root);
  const chunkHashes = chunked.hashes || [];

  // Fail fast on an internally inconsistent manifest: every chunk hash is
  // anchored by the aggregate root, so a wrong root means the config itself
  // cannot be trusted.
  const declaredRoot = await computeRootHash(chunkHashes, algorithm);
  if (declaredRoot !== chunked.root) {
    throw new Error(
      `Chunked root hash mismatch for ${urlString}: ` +
      `manifest declares ${chunked.root}, but chunk hashes derive ${declaredRoot}`
    );
  }

  // Check for existing download state
  let existingState: DownloadState | null = null;
  let existingChunks = new Map<number, ArrayBuffer>();
  let resumed = false;
  let chunksResumed = 0;

  if (persist && isStorageAvailable()) {
    existingState = await loadDownloadState(urlString);

    if (existingState) {
      // Validate that the chunked config matches
      const existingHashes = existingState.chunked.hashes || [];
      const currentHashes = chunked.hashes || [];

      if (existingHashes.length === currentHashes.length &&
          existingState.chunked.root === chunked.root) {
        // Config matches, but cached bytes are never trusted on their own.
        // Replay the hash of every stored chunk before resuming so a corrupt
        // cache or a recycled old file cannot be stitched into the result.
        const storedChunks = await loadChunks(urlString);
        const replay = await replayStoredChunks(
          storedChunks,
          existingState.verifiedChunks,
          currentHashes
        );

        if (!replay) {
          // Stored state/cache failed re-verification - fail closed and
          // restart from scratch instead of building a corrupt file.
          await deleteDownloadState(urlString);
          existingState = null;
        } else {
          existingChunks = replay.chunks;
          chunksResumed = existingState.verifiedChunks;
          resumed = true;

          // Rebuild counters from replayed evidence rather than trusting the
          // persisted start/end/total bookkeeping.
          existingState = {
            ...existingState,
            bytesVerified: replay.bytesVerified,
          };

          if (onResume) {
            onResume(existingState);
          }
        }
      } else {
        // Config changed, start fresh
        await deleteDownloadState(urlString);
        existingState = null;
      }
    }
  }

  // Initialize state
  const state: DownloadState = existingState || {
    url: urlString,
    chunked,
    verifiedChunks: 0,
    startedAt: Date.now(),
    lastUpdated: Date.now(),
    bytesVerified: 0,
  };

  // Collect all chunks (existing + new)
  const allChunks: ArrayBuffer[] = new Array(totalChunks);

  // Copy existing verified chunks
  for (const [index, data] of existingChunks) {
    allChunks[index] = data;
  }

  // Speed tracking
  let lastProgressTime = Date.now();
  let lastProgressBytes = state.bytesVerified;
  let speedSamples: number[] = [];

  const reportProgress = () => {
    if (!onProgress) return;

    const now = Date.now();
    const timeDiff = (now - lastProgressTime) / 1000;
    const bytesDiff = state.bytesVerified - lastProgressBytes;

    if (timeDiff > 0) {
      const currentSpeed = bytesDiff / timeDiff;
      speedSamples.push(currentSpeed);
      if (speedSamples.length > 10) speedSamples.shift();
    }

    const avgSpeed = speedSamples.length > 0
      ? speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length
      : 0;

    const remainingBytes = (state.totalSize || 0) - state.bytesVerified;
    const eta = avgSpeed > 0 ? (remainingBytes / avgSpeed) * 1000 : undefined;

    lastProgressTime = now;
    lastProgressBytes = state.bytesVerified;

    onProgress({
      bytesVerified: state.bytesVerified,
      totalBytes: state.totalSize,
      chunksVerified: state.verifiedChunks,
      totalChunks,
      resumed,
      speed: avgSpeed,
      eta,
    });
  };

  // Download and verify remaining chunks
  const startChunk = state.verifiedChunks;

  for (let i = startChunk; i < totalChunks; i++) {
    const rangeStart = i * chunked.chunkSize;
    const rangeEnd = Math.min((i + 1) * chunked.chunkSize - 1, (state.totalSize || Infinity) - 1);

    // Fetch this chunk with Range header
    const response = await fetchWithTimeout(
      urlString,
      {
        headers: {
          Range: `bytes=${rangeStart}-${rangeEnd}`,
        },
      },
      chunkTimeout,
      fetchImpl
    );

    // A server that ignores Range and replies 200 OK would make us splice the
    // whole file into a single chunk slot. Fail closed and clear stale state.
    if (response.status === 200) {
      await failClosed(
        urlString,
        persist,
        `server ignored the Range request and returned 200 OK for chunk ${i}; ` +
        `206 Partial Content is required for resumable downloads`
      );
    }

    if (response.status !== 206) {
      // Transport-level errors (404, 500, ...) remain retryable: verified
      // chunks are preserved so a later call can resume.
      if (!response.ok) {
        throw new Error(`Failed to fetch chunk ${i}: ${response.status} ${response.statusText}`);
      }

      await failClosed(
        urlString,
        persist,
        `unexpected status ${response.status} ${response.statusText} for chunk ${i}; ` +
        `expected 206 Partial Content`
      );
    }

    // Strictly validate the 206 Content-Range against the requested interval.
    const contentRange = response.headers.get('Content-Range');
    let parsedRange: ParsedContentRange;
    try {
      parsedRange = parseContentRange(
        contentRange,
        rangeStart,
        rangeEnd,
        state.totalSize
      );
    } catch (error) {
      await failClosed(urlString, persist, (error as Error).message);
      throw error;
    }

    const chunkData = await response.arrayBuffer();

    // The response body must cover exactly the advertised byte interval.
    const expectedLength = parsedRange.end - parsedRange.start + 1;
    if (chunkData.byteLength !== expectedLength) {
      await failClosed(
        urlString,
        persist,
        `response body for chunk ${i} is ${chunkData.byteLength} bytes but ` +
        `Content-Range covers ${expectedLength} bytes (${contentRange})`
      );
    }

    if (parsedRange.totalSize !== undefined) {
      if (state.totalSize === undefined) {
        state.totalSize = parsedRange.totalSize;
      } else if (state.totalSize !== parsedRange.totalSize) {
        await failClosed(
          urlString,
          persist,
          `Content-Range total size changed mid-download for chunk ${i}: ` +
          `expected ${state.totalSize}, got ${parsedRange.totalSize}`
        );
      }
    }

    // Verify chunk
    const expectedHash = chunkHashes[i];
    const actualHash = await hashChunk(new Uint8Array(chunkData));

    if (actualHash !== expectedHash) {
      throw new ChunkVerificationError(
        urlString,
        i,
        expectedHash,
        actualHash,
        state.bytesVerified,
        state.totalSize
      );
    }

    // Chunk verified - store it
    allChunks[i] = chunkData;
    state.verifiedChunks = i + 1;
    state.bytesVerified += chunkData.byteLength;
    state.lastUpdated = Date.now();

    // Persist progress
    if (persist && isStorageAvailable()) {
      await saveChunk(urlString, i, chunkData);
      await saveDownloadState(state);
    }

    reportProgress();
  }

  // All chunks verified - concatenate and clean up
  const totalBytes = allChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of allChunks) {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  // Final integrity gate: the assembled chunk list must derive the manifest
  // root, and byte counters must agree with the server-declared total.
  const finalRoot = await computeRootHash(chunkHashes, algorithm);
  if (finalRoot !== chunked.root) {
    if (persist && isStorageAvailable()) {
      await deleteDownloadState(urlString);
    }
    throw new Error(
      `Chunked root hash mismatch for ${urlString}: ` +
      `expected ${chunked.root}, computed ${finalRoot}`
    );
  }

  if (state.totalSize !== undefined && totalBytes !== state.totalSize) {
    if (persist && isStorageAvailable()) {
      await deleteDownloadState(urlString);
    }
    throw new Error(
      `Total size mismatch for ${urlString}: ` +
      `server declared ${state.totalSize} bytes but assembled ${totalBytes} bytes`
    );
  }

  // Clean up storage
  if (persist && isStorageAvailable()) {
    await deleteDownloadState(urlString);
  }

  return {
    data: result.buffer as ArrayBuffer,
    resumed,
    chunksResumed,
    totalChunks,
    totalBytes,
  };
}

/**
 * Error thrown when a chunk fails verification
 */
export class ChunkVerificationError extends Error {
  constructor(
    public readonly url: string,
    public readonly chunkIndex: number,
    public readonly expectedHash: SRIString,
    public readonly actualHash: SRIString,
    public readonly bytesVerified: number,
    public readonly totalBytes?: number
  ) {
    const progress = totalBytes
      ? ` (${Math.round(bytesVerified / totalBytes * 100)}% complete)`
      : '';

    super(
      `Chunk ${chunkIndex} verification failed for ${url}${progress}\n` +
      `  Expected: ${expectedHash}\n` +
      `  Actual:   ${actualHash}\n\n` +
      `This could indicate:\n` +
      `  - File corruption during transfer\n` +
      `  - CDN serving wrong content\n` +
      `  - Potential tampering\n\n` +
      `The download can be retried - verified chunks are preserved.`
    );
    this.name = 'ChunkVerificationError';
  }
}

/**
 * Error thrown when a server response is incompatible with resumable
 * range semantics (ignored Range, wrong Content-Range, or changing size).
 *
 * The persisted download state has already been cleared when this is thrown,
 * so the next attempt starts cleanly instead of stitching corrupt bytes.
 */
export class RangeResponseError extends Error {
  constructor(public readonly url: string, reason: string) {
    super(`Invalid range response for ${url}: ${reason}`);
    this.name = 'RangeResponseError';
  }
}

/**
 * Check if a download can be resumed
 */
export async function canResume(url: string): Promise<boolean> {
  if (!isStorageAvailable()) return false;

  const state = await loadDownloadState(url);
  return state !== null && state.verifiedChunks > 0;
}

/**
 * Get progress of an in-progress or paused download
 */
export async function getDownloadProgress(url: string): Promise<{
  chunksVerified: number;
  totalChunks: number;
  bytesVerified: number;
  totalBytes?: number;
  startedAt: number;
  lastUpdated: number;
} | null> {
  if (!isStorageAvailable()) return null;

  const state = await loadDownloadState(url);
  if (!state) return null;

  const totalChunks = state.chunked.hashes?.length || 0;

  return {
    chunksVerified: state.verifiedChunks,
    totalChunks,
    bytesVerified: state.bytesVerified,
    totalBytes: state.totalSize,
    startedAt: state.startedAt,
    lastUpdated: state.lastUpdated,
  };
}

/**
 * Cancel and clear a download
 */
export async function cancelDownload(url: string): Promise<void> {
  if (!isStorageAvailable()) return;
  await deleteDownloadState(url);
}

// ============ Internal helpers ============

/**
 * Parsed fields of a `Content-Range: bytes start-end/total` header
 */
interface ParsedContentRange {
  start: number;
  end: number;
  totalSize?: number;
}

/**
 * Abort the download and wipe persisted state when the server violates
 * range semantics. Returns never so callers can rely on control-flow
 * narrowing after invoking it.
 */
async function failClosed(
  url: string,
  persist: boolean,
  reason: string
): Promise<never> {
  if (persist && isStorageAvailable()) {
    await deleteDownloadState(url);
  }
  throw new RangeResponseError(url, reason);
}

/**
 * Parse and strictly validate a 206 Content-Range header against the
 * requested interval and any previously observed total size.
 */
function parseContentRange(
  headerValue: string | null,
  requestedStart: number,
  requestedEnd: number,
  knownTotalSize: number | undefined
): ParsedContentRange {
  if (!headerValue) {
    throw new Error(
      `206 response is missing a Content-Range header ` +
      `(requested bytes ${requestedStart}-${requestedEnd})`
    );
  }

  const match = headerValue.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/);
  if (!match) {
    throw new Error(`malformed Content-Range header: ${headerValue}`);
  }

  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const totalSize = match[3] === '*' ? undefined : parseInt(match[3], 10);

  if (start !== requestedStart) {
    throw new Error(
      `Content-Range start ${start} does not match requested start ${requestedStart} ` +
      `(${headerValue})`
    );
  }

  if (end < start) {
    throw new Error(`Content-Range end precedes start (${headerValue})`);
  }

  if (end > requestedEnd) {
    throw new Error(
      `Content-Range end ${end} exceeds requested end ${requestedEnd} ` +
      `(${headerValue})`
    );
  }

  if (totalSize !== undefined) {
    if (end >= totalSize) {
      throw new Error(
        `Content-Range end ${end} must be smaller than total size ${totalSize} ` +
        `(${headerValue})`
      );
    }

    if (knownTotalSize !== undefined && totalSize !== knownTotalSize) {
      throw new Error(
        `Content-Range total size ${totalSize} does not match previously observed ` +
        `total ${knownTotalSize} (${headerValue})`
      );
    }
  }

  return { start, end, totalSize };
}

/**
 * Result of replaying stored chunks through hash verification
 */
interface ReplayResult {
  chunks: Map<number, ArrayBuffer>;
  bytesVerified: number;
}

/**
 * Re-hash every persisted chunk claimed by the saved state before trusting
 * it for resume. Returns null when any chunk is missing or mismatches its
 * manifest hash, which forces a clean restart.
 */
async function replayStoredChunks(
  storedChunks: Map<number, ArrayBuffer>,
  verifiedChunks: number,
  expectedHashes: SRIString[]
): Promise<ReplayResult | null> {
  if (verifiedChunks < 0 || verifiedChunks > expectedHashes.length) {
    return null;
  }

  const replayed = new Map<number, ArrayBuffer>();
  let bytesVerified = 0;

  for (let index = 0; index < verifiedChunks; index++) {
    const data = storedChunks.get(index);
    if (!data) {
      return null;
    }

    const actualHash = await hashChunk(new Uint8Array(data));
    if (actualHash !== expectedHashes[index]) {
      return null;
    }

    replayed.set(index, data);
    bytesVerified += data.byteLength;
  }

  return { chunks: replayed, bytesVerified };
}

/**
 * Resolve the hash algorithm from an SRI string
 */
function algorithmFromSri(sri: SRIString): 'sha256' | 'sha384' | 'sha512' {
  if (sri.startsWith('sha256-')) return 'sha256';
  if (sri.startsWith('sha384-')) return 'sha384';
  if (sri.startsWith('sha512-')) return 'sha512';
  throw new Error(`Unknown algorithm in SRI: ${sri}`);
}

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeout: number,
  fetchImpl: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Hash a chunk using SubtleCrypto (fast enough for small chunks)
 */
async function hashChunk(data: Uint8Array): Promise<SRIString> {
  // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  const hashBase64 = btoa(String.fromCharCode(...hashArray));
  return `sha256-${hashBase64}` as SRIString;
}
