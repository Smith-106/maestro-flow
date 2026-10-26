import { createHash } from 'node:crypto';
import {
  MEMORY_PROJECTION_MAX_BYTES, MEMORY_PROJECTION_ERROR_CODES, MEMORY_REMOVE_MAX_BYTES, MEMORY_REMOVE_MAX_PATHS, MemoryProjectionError,
  type MemoryAdapterContext, type MemoryProjectionAdapter, type MemoryProjectionErrorCode,
} from '../../shared/memory-projection.js';
import { SearchProviderError } from '../../shared/search-provider.js';
import { validateTencentProviderConfig, type TencentProviderConfig } from '../search/providers/config.js';
import { createTencentProvider, createTencentTransport } from '../search/providers/tencent.js';

const fail = (code: MemoryProjectionErrorCode): never => { throw new MemoryProjectionError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeRef = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
  !/[\\:%?#\u0000-\u0020\u007f]/.test(value) && !value.startsWith('/') &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
function sanitize(error: unknown): never {
  if (error instanceof MemoryProjectionError) throw error;
  if (error instanceof SearchProviderError &&
      (MEMORY_PROJECTION_ERROR_CODES as readonly string[]).includes(error.code)) return fail(error.code as MemoryProjectionErrorCode);
  return fail('provider-error');
}
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { return sanitize(error); }
}

/** Raw page persistence and separately verified retrieval. Never retries a mutation. */
export function createTencentMemoryAdapter(
  config: TencentProviderConfig,
  dependencies: { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv } = {},
): MemoryProjectionAdapter {
  let c: TencentProviderConfig;
  try { c = validateTencentProviderConfig(config); } catch (error) { return sanitize(error); }
  if (c.kind !== 'tencent-wiki') return fail('invalid-config');
  const transport = createTencentTransport(c, dependencies);
  const provider = createTencentProvider(c, dependencies);
  const assetKey = createHash('sha256').update(JSON.stringify([
    c.baseUrl, c.serviceId, c.knowledgeId,
  ])).digest('hex');
  function authorize(context: MemoryAdapterContext, mutation = false): void {
    transport.authorize(context);
    if (mutation && c.writeEnabled !== true) fail('write-disabled');
  }
  function ref(pageRef: string): void { if (!safeRef(pageRef)) fail('invalid-request'); }
  const attribution = { wiki_id: c.knowledgeId, team_id: c.teamId, user_id: c.userId, agent_id: c.agentId };
  async function assertReady(context: MemoryAdapterContext): Promise<void> {
    authorize(context);
    // No implicit team selection from a remote response.
    if (!c.teamId) return fail('invalid-config');
    const data = await transport.post('/v3/wiki/get', { wiki_id: c.knowledgeId }, context);
    if (data.wiki_id !== c.knowledgeId || data.team_id !== c.teamId) return fail('scope-mismatch');
    if (data.status !== 'ready') return fail('asset-not-ready');
  }
  return {
    namespace: provider.namespace, assetKey,
    assertReady: context => guarded(() => assertReady(context)),
    read: (pageRef, context) => guarded(async () => {
      authorize(context); ref(pageRef);
      const data = await transport.post('/v3/wiki/page/read', { wiki_id: c.knowledgeId, refs: [pageRef] }, context);
      if (!Array.isArray(data.items) || data.items.length !== 1 || !object(data.items[0])) return fail('remote-response-invalid');
      const item = data.items[0];
      if (item.ref !== pageRef) return fail('scope-mismatch');
      if (item.not_found === true) {
        if (item.content !== undefined) return fail('remote-response-invalid');
        return null;
      }
      if ((item.not_found !== undefined && item.not_found !== false) || typeof item.content !== 'string' ||
          Buffer.byteLength(item.content, 'utf8') > MEMORY_PROJECTION_MAX_BYTES || item.content.includes('\0')) return fail('remote-response-invalid');
      return item.content;
    }),
    write: (pageRef, content, context) => guarded(async () => {
      authorize(context, true); ref(pageRef);
      if (typeof content !== 'string' || content.includes('\0')) return fail('invalid-request');
      if (Buffer.byteLength(content, 'utf8') > MEMORY_PROJECTION_MAX_BYTES) return fail('source-too-large');
      await assertReady(context);
      context.assertMutationCurrent?.();
      const data = await transport.post('/v3/wiki/page/write', { ...attribution, pages: [{ ref: pageRef, content }] }, context, {
        before: context.beforeMutationSend, invoked: context.onMutationSend,
      });
      if (!Array.isArray(data.items) || data.items.length !== 1 || !object(data.items[0]) ||
          typeof data.items[0].locked_injected !== 'boolean') return fail('remote-response-invalid');
      if (data.items[0].ref !== pageRef) return fail('scope-mismatch');
    }),
    remove: (pageRef, context) => guarded(async () => {
      authorize(context, true); ref(pageRef);
      await assertReady(context);
      context.assertMutationCurrent?.();
      const data = await transport.post('/v3/wiki/page/rm', { ...attribution, refs: [pageRef] }, context, {
        before: context.beforeMutationSend, invoked: context.onMutationSend,
      });
      const paths = (value: unknown): string[] => {
        if (!Array.isArray(value) || value.length > MEMORY_REMOVE_MAX_PATHS || !value.every(safeRef) ||
            new Set(value).size !== value.length) return fail('remote-response-invalid');
        return value;
      };
      const deletedPages = paths(data.deleted_pages);
      // WikiService.absToPageRef returns short refs (without wiki/ and .md),
      // unlike page/read/write which echo the supplied full reference. Preserve
      // returned effects, but compare both documented forms canonically.
      if (!deletedPages.some(value => {
        const full = value.startsWith('wiki/') ? value : `wiki/${value}`;
        return (full.endsWith('.md') ? full : `${full}.md`) === pageRef;
      })) return fail('remote-response-invalid');
      // Upstream reports a count, not paths. Preserve that fact; runtime must invalidate
      // other managed hashes conservatively rather than inventing rewritten filenames.
      const rewrittenFiles = typeof data.rewritten_files === 'number' ? [] : paths(data.rewritten_files);
      const rewrittenFileCount = typeof data.rewritten_files === 'number' ? data.rewritten_files : rewrittenFiles.length;
      if (!Number.isSafeInteger(rewrittenFileCount) || rewrittenFileCount < 0) return fail('remote-response-invalid');
      const effects = { deletedPages, rewrittenFiles, rewrittenFileCount };
      // Runtime reserves this exact JSON budget before sending. Never truncate effects:
      // an oversized result is ambiguous after send and must remain indeterminate.
      if (Buffer.byteLength(JSON.stringify(effects), 'utf8') > MEMORY_REMOVE_MAX_BYTES) return fail('remote-response-invalid');
      return effects;
    }),
    verifySearch: (pageRef, title, expectedHash, context) => guarded(async () => {
      authorize(context); ref(pageRef);
      if (typeof title !== 'string' || !title.trim() || title.length > 2048 ||
          typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) return fail('invalid-request');
      const result = await provider.search({ ...context, query: title, mode: 'lexical', filters: {}, limit: 100, candidateLimit: 100 });
      const hit = result.hits.find(candidate => candidate.ref.recordId === pageRef &&
        candidate.ref.namespace === provider.namespace && candidate.ref.providerId === c.id);
      if (!hit) return false;
      try {
        const resolved = await provider.resolver!.read({ ...hit.ref, version: expectedHash }, context);
        return resolved.ref.recordId === pageRef && resolved.ref.version === expectedHash;
      } catch (error) {
        if (error instanceof SearchProviderError && (error.code === 'stale-reference' || error.code === 'not-found')) return false;
        throw error;
      }
    }),
  };
}
