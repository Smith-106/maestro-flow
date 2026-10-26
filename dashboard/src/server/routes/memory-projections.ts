import type { Hono } from 'hono';
import { dirname } from 'node:path';
import { MemoryProjectionError, MEMORY_PROJECTION_ERROR_CODES } from '../../../../shared/memory-projection.js';

const MAX_BODY_BYTES = 16_384;
interface Context { workflowRoot: string }
function invalid(): never { throw new MemoryProjectionError('invalid-request'); }

/** Bound bytes AND stream time before parsing controls supplied inside the body. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) invalid();
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) invalid();
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let onAbort!: () => void;
  const deadline = AbortSignal.timeout(5_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new MemoryProjectionError(request.signal.aborted ? 'aborted' : 'timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) invalid();
      parts.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
  catch { invalid(); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid();
  return body as Record<string, unknown>;
}

function status(code: string): 400 | 403 | 404 | 408 | 409 | 502 {
  if (['scope-mismatch', 'probe-forbidden', 'disabled-provider', 'write-disabled'].includes(code)) return 403;
  if (['unknown-provider', 'not-found'].includes(code)) return 404;
  if (['aborted', 'timeout'].includes(code)) return 408;
  if (['hash-mismatch', 'remote-conflict', 'not-managed', 'asset-not-ready', 'operation-conflict', 'pending-operation', 'asset-locked', 'source-changed'].includes(code)) return 409;
  if (['invalid-request', 'invalid-config', 'unsupported-source', 'source-too-large', 'ambiguous-source'].includes(code)) return 400;
  return 502;
}

/** No authoring or independently implemented permission semantics: runtime gates every action. */
export function registerMemoryProjectionRoutes<T extends Context>(
  app: Hono, getContext: () => T, isCurrent: (context: T) => boolean,
): void {
  app.post('/api/wiki/memory', async c => {
    const context = getContext();
    try {
      const { readOnlyProbe, timeoutMs, ...request } = await readBody(c.req.raw);
      if (readOnlyProbe !== undefined && typeof readOnlyProbe !== 'boolean') invalid();
      if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) invalid();
      if (!isCurrent(context)) throw new MemoryProjectionError('scope-mismatch');
      const { runMemoryProjection } = await import('../../../../src/memory/runtime.js');
      const result = await runMemoryProjection(request, {
        projectRoot: dirname(context.workflowRoot),
        executionMode: readOnlyProbe === true ? 'read-only-probe' : 'default',
        timeoutMs: timeoutMs as number | undefined,
        signal: c.req.raw.signal,
        assertCurrent: () => isCurrent(context),
      });
      if (!isCurrent(context)) throw new MemoryProjectionError('scope-mismatch');
      return c.json(result);
    } catch (error) {
      const code = error instanceof MemoryProjectionError && MEMORY_PROJECTION_ERROR_CODES.includes(error.code) ? error.code : 'provider-error';
      return c.json({ error: code, canonicalMutation: false }, status(code));
    }
  });
}
