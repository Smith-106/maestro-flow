#!/usr/bin/env node
/** Built CLI + MCP + Dashboard acceptance against an ephemeral loopback mock only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtEntrypoints = [
  'dist/src/cli.js',
  'dist/src/memory/runtime.js',
  'dist/src/tools/memory-store.js',
  'dashboard/dist-server/dashboard/src/server/routes/memory-projections.js',
];
for (const file of builtEntrypoints) {
  try { await access(join(root, file)); }
  catch { throw new Error(`Built memory projection entrypoint is missing: ${file}; run npm run build first.`); }
}

const project = await mkdtemp(join(tmpdir(), 'maestro-memory-projection-smoke-'));
const workflow = join(project, '.workflow');
const repoId = '11111111-1111-4111-8111-111111111111';
const wikiId = 'wiki-memory-smoke';
const secret = 'synthetic-memory-smoke-key';
const remotePages = new Map();
const requests = [];
const mockFailures = [];
let ambiguousWriteCount = 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function response(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: status >= 200 && status < 300 ? 0 : 1, data }));
}
function titleOf(content) {
  const match = /^title:\s*(.*?)\s*$/m.exec(content);
  return match?.[1]?.replace(/^['"]|['"]$/g, '') ?? '';
}
function safeSyntheticRef(value) {
  return typeof value === 'string' && value.startsWith(`wiki/maestro/${repoId}/`) &&
    /^wiki\/maestro\/[0-9a-f-]{36}\/[a-f0-9]{64}\.md$/.test(value);
}
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > 300_000) throw new Error('mock request too large');
    }
    const body = JSON.parse(raw);
    assert.equal(req.method, 'POST');
    assert.equal(req.socket.remoteAddress, '127.0.0.1');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers['x-tdai-service-id'], 'memory-smoke-service');
    const path = req.url;
    requests.push({ path, body });

    if (path === '/v3/wiki/get') {
      assert.deepEqual(body, { wiki_id: wikiId });
      response(res, { wiki_id: wikiId, team_id: 'memory-smoke-team', status: 'ready' });
      return;
    }
    if (path === '/v3/wiki/page/read') {
      assert.equal(body.wiki_id, wikiId);
      assert(Array.isArray(body.refs) && body.refs.length === 1 && safeSyntheticRef(body.refs[0]));
      const ref = body.refs[0];
      const content = remotePages.get(ref);
      response(res, { items: [content === undefined ? { ref, not_found: true } : { ref, content }] });
      return;
    }
    if (path === '/v3/wiki/page/write') {
      assert.deepEqual(Object.keys(body).sort(), ['agent_id', 'pages', 'team_id', 'user_id', 'wiki_id'].sort());
      assert.equal(body.wiki_id, wikiId);
      assert.equal(body.team_id, 'memory-smoke-team');
      assert.equal(body.user_id, 'memory-smoke-user');
      assert.equal(body.agent_id, 'memory-smoke-agent');
      assert(Array.isArray(body.pages) && body.pages.length === 1);
      const page = body.pages[0];
      assert.deepEqual(Object.keys(page).sort(), ['content', 'ref'].sort());
      assert(safeSyntheticRef(page.ref));
      assert.equal(typeof page.content, 'string');
      remotePages.set(page.ref, page.content);
      // Model an ambiguous response after the mutation reached storage. The
      // client must persist indeterminate and reconcile; it must not resend.
      if (page.content.includes('spec:project:uncertain')) {
        ambiguousWriteCount += 1;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{"code":503}');
        return;
      }
      response(res, { items: [{ ref: page.ref, locked_injected: true }] });
      return;
    }
    if (path === '/v3/wiki/page/rm') {
      assert.deepEqual(Object.keys(body).sort(), ['agent_id', 'refs', 'team_id', 'user_id', 'wiki_id'].sort());
      assert.equal(body.wiki_id, wikiId);
      assert.equal(body.team_id, 'memory-smoke-team');
      assert.equal(body.user_id, 'memory-smoke-user');
      assert.equal(body.agent_id, 'memory-smoke-agent');
      assert(Array.isArray(body.refs) && body.refs.length === 1 && safeSyntheticRef(body.refs[0]));
      const ref = body.refs[0];
      remotePages.delete(ref);
      // Real WikiService reports short deletion refs and only a rewrite count.
      response(res, { deleted_pages: [ref.replace(/^wiki\//, '').replace(/\.md$/, '')], rewritten_files: 2 });
      return;
    }
    if (path === '/v3/tools/call') {
      assert.equal(body.knowledge_id, wikiId);
      if (body.tool_name === 'search') {
        assert.equal(typeof body.params?.query, 'string');
        const query = body.params.query.toLocaleLowerCase();
        const hits = [...remotePages.entries()]
          .filter(([, content]) => titleOf(content).toLocaleLowerCase().includes(query))
          .slice(0, body.params.limit)
          .map(([ref, content]) => ({ path: ref, title: titleOf(content), snippet: content.slice(-512), score: 1 }));
        response(res, { results: hits, count: hits.length });
        return;
      }
      if (body.tool_name === 'read_page') {
        assert(Array.isArray(body.params?.refs) && body.params.refs.length === 1 && safeSyntheticRef(body.params.refs[0]));
        const ref = body.params.refs[0];
        const content = remotePages.get(ref);
        response(res, { items: [content === undefined ? { ref, not_found: true } : { ref, content }] });
        return;
      }
      throw new Error('unexpected wiki tool');
    }
    throw new Error(`unexpected request path: ${path}`);
  } catch (error) {
    mockFailures.push(error instanceof Error ? error.message : 'mock request failed');
    if (!res.headersSent) response(res, {}, 500);
    else res.end();
  }
});

let childCount = 0;
let guardedConnections = 0;
let blockedAttempts = 0;
try {
  await mkdir(join(workflow, 'specs'), { recursive: true });
  await writeFile(join(workflow, 'repository.json'), JSON.stringify({
    schema_version: 'repository-identity/1.0', repo_id: repoId,
    repo_name: 'memory-projection-smoke', created_at: '2026-01-01T00:00:00.000Z',
  }));
  const sources = new Map();
  const putSpec = async (slug, title, body) => {
    const path = join(workflow, 'specs', `${slug}.md`);
    const text = `---\ntitle: ${title}\n---\n${body}\n`;
    await writeFile(path, text, 'utf8');
    sources.set(path, text);
    return path;
  };
  const cachePath = await putSpec('cache', 'Projection smoke cache', 'Synthetic canonical cache record, version one.');
  const secondPath = await putSpec('second', 'Projection smoke second', 'A sibling canonical record for cascade invalidation.');
  const uncertainPath = await putSpec('uncertain', 'Projection smoke uncertain', 'Synthetic record for lost response reconciliation.');

  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  assert(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const guard = join(project, 'network-guard.cjs');
  await writeFile(guard, `
    const fs = require('node:fs');
    const net = require('node:net');
    const original = net.Socket.prototype.connect;
    const audit = { allowed: 0, blocked: 0 };
    process.on('exit', () => fs.writeFileSync(process.env.MAESTRO_MEMORY_SMOKE_AUDIT, JSON.stringify(audit)));
    net.Socket.prototype.connect = function (...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const options = first !== null && typeof first === 'object'
        ? first
        : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
      if (options.host !== '127.0.0.1' || Number(options.port) !== ${address.port}) {
        audit.blocked += 1;
        throw new Error('memory-smoke-network-blocked');
      }
      audit.allowed += 1;
      return original.apply(this, args);
    };
  `);

  const platformKeys = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SystemDrive'];
  const environment = Object.fromEntries(platformKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(environment, {
    HOME: project, USERPROFILE: project, APPDATA: project, LOCALAPPDATA: project,
    TMP: project, TEMP: project, MAESTRO_PROJECT_ROOT: project, MAESTRO_MEMORY_SMOKE_KEY: secret,
  });
  async function child(args, expectedExit = 0, expectedBlocked = 0) {
    const auditPath = join(project, `network-${++childCount}.json`);
    let stdout = '';
    let stderr = '';
    let actualExit = 0;
    try {
      ({ stdout, stderr } = await exec(process.execPath, ['--require', guard, ...args], {
        cwd: root, env: { ...environment, MAESTRO_MEMORY_SMOKE_AUDIT: auditPath },
        timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      }));
    } catch (error) {
      if (expectedExit === 0 || error.code !== expectedExit) throw error;
      actualExit = error.code;
      stdout = error.stdout ?? '';
      stderr = error.stderr ?? '';
    }
    assert.equal(actualExit, expectedExit);
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    assert.equal(audit.blocked, expectedBlocked, 'unexpected non-mock connection attempted');
    guardedConnections += audit.allowed;
    blockedAttempts += audit.blocked;
    return { stdout, stderr };
  }
  const parseLastJson = value => {
    const line = value.trim().split(/\r?\n/).reverse().find(candidate => candidate.trim().startsWith('{'));
    assert(line, `expected JSON output, got: ${value.slice(-1000)}`);
    return JSON.parse(line);
  };
  async function cli(action, canonicalId, args = [], exit = 0) {
    const { stdout, stderr } = await child([join(root, 'bin', 'maestro.js'), 'memory', action, canonicalId,
      '--provider', 'wiki', '--json', ...args], exit);
    return parseLastJson(exit === 0 ? stdout : stderr);
  }
  function saveArgs(operationId, recordHash) {
    return ['--write', '--ack-no-remote-cas', '--operation-id', operationId, '--expected-record-hash', recordHash];
  }
  function updateArgs(operationId, recordHash, remoteHash) {
    return [...saveArgs(operationId, recordHash), '--expected-remote-hash', remoteHash];
  }
  function removeArgs(operationId, remoteHash) {
    return ['--write', '--ack-no-remote-cas', '--ack-cascade', '--operation-id', operationId, '--expected-remote-hash', remoteHash];
  }
  async function writeConfig(config) {
    await writeFile(join(workflow, 'search-providers.json'), JSON.stringify({ version: 1, providers: [config] }), 'utf8');
  }
  let config = {
    id: 'wiki', kind: 'tencent-wiki', enabled: true, writeEnabled: true,
    baseUrl: endpoint, apiKeyEnv: 'MAESTRO_MEMORY_SMOKE_KEY', serviceId: 'memory-smoke-service',
    repoId, teamId: 'memory-smoke-team', userId: 'memory-smoke-user', agentId: 'memory-smoke-agent',
    knowledgeId: wikiId, timeoutMs: 3000,
  };
  await writeConfig(config);

  const guardCheck = await child(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { Socket } from 'node:net';
    const socket = new Socket();
    try { assert.throws(() => socket.connect({ host: '203.0.113.1', port: 443 }), /memory-smoke-network-blocked/); }
    finally { socket.destroy(); }
    console.log(JSON.stringify({ blocked: true }));
  `], 0, 1);
  assert.equal(parseLastJson(guardCheck.stdout).blocked, true);

  const pathsBefore = requests.length;
  const preview = await cli('preview', 'spec:project:cache');
  assert.equal(preview.status, 'preview');
  assert.equal(preview.snapshot.canonicalId, 'spec:project:cache');
  assert.equal(requests.length, pathsBefore, 'preview must remain local-only');

  const probe = await cli('save', 'spec:project:cache', [...saveArgs('probe-op', preview.snapshot.recordHash), '--read-only-probe'], 1);
  assert.equal(probe.error, 'probe-forbidden');
  assert.equal(requests.length, pathsBefore, 'probe must reject before configuration-backed remote access');

  const badHash = await cli('save', 'spec:project:cache', saveArgs('bad-hash-op', '0'.repeat(64)), 1);
  assert.equal(badHash.error, 'hash-mismatch');
  assert.equal(requests.length, pathsBefore, 'record hash mismatch must not reach the mock');

  config = { ...config, enabled: false };
  await writeConfig(config);
  const disabled = await cli('save', 'spec:project:cache', saveArgs('disabled-op', preview.snapshot.recordHash), 1);
  assert.equal(disabled.error, 'disabled-provider');
  assert.equal(requests.length, pathsBefore, 'disabled provider must not reach the mock');
  assert.equal((await cli('status', 'spec:project:cache')).status, 'not-managed');
  assert.equal(requests.length, pathsBefore, 'status is local-only even for a disabled provider');

  config = { ...config, enabled: true, writeEnabled: false };
  await writeConfig(config);
  const writeDisabled = await cli('save', 'spec:project:cache', saveArgs('write-disabled-op', preview.snapshot.recordHash), 1);
  assert.equal(writeDisabled.error, 'write-disabled');
  assert.equal(requests.length, pathsBefore, 'write-disabled provider must not reach the mock');
  config = { ...config, writeEnabled: true };
  await writeConfig(config);

  const saved = await cli('save', 'spec:project:cache', saveArgs('save-cache-one', preview.snapshot.recordHash));
  assert.equal(saved.status, 'stored');
  assert.equal(saved.receipt.searchability, 'verified');
  const cacheRef = saved.receipt.pageRef;
  assert.equal(sha256(remotePages.get(cacheRef)), preview.snapshot.remoteContentHash, 'raw stored bytes must match the preview hash');
  assert.equal(await readFile(cachePath, 'utf8'), sources.get(cachePath), 'save must not modify canonical source');
  assert(requests.some(item => item.path === '/v3/tools/call' && item.body.tool_name === 'search'));
  assert(requests.some(item => item.path === '/v3/tools/call' && item.body.tool_name === 'read_page'));

  // Cross-entrypoint identical operation replay must return the durable result
  // without issuing another upstream write.
  const mcpUrl = pathToFileURL(join(root, 'dist/src/tools/memory-store.js')).href;
  const mcpReplayRequest = {
    action: 'save', providerId: 'wiki', canonicalId: 'spec:project:cache',
    operationId: 'save-cache-one', write: true, ackNoRemoteCas: true,
    expectedRecordHash: preview.snapshot.recordHash,
  };
  const writesBeforeReplay = requests.filter(item => item.path === '/v3/wiki/page/write').length;
  const mcpReplay = await child(['--input-type=module', '-e', `
    import { handler } from ${JSON.stringify(mcpUrl)};
    const response = await handler(${JSON.stringify(mcpReplayRequest)});
    console.log(JSON.stringify(response));
  `]);
  const replay = parseLastJson(mcpReplay.stdout);
  assert.equal(replay.success, true);
  assert.deepEqual(replay.result.receipt, saved.receipt);
  assert.equal(requests.filter(item => item.path === '/v3/wiki/page/write').length, writesBeforeReplay);

  const dashboardUrl = pathToFileURL(join(root, 'dashboard/dist-server/dashboard/src/server/routes/memory-projections.js')).href;
  async function dashboard(request) {
    const output = await child(['--input-type=module', '-e', `
      import { Hono } from 'hono';
      import { registerMemoryProjectionRoutes } from ${JSON.stringify(dashboardUrl)};
      const context = { workflowRoot: ${JSON.stringify(workflow)} };
      const app = new Hono();
      registerMemoryProjectionRoutes(app, () => context, candidate => candidate === context);
      const response = await app.request('/api/wiki/memory', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(request)}) });
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `]);
    const response = parseLastJson(output.stdout);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  // Snapshot-backed actions must run from the emitted Dashboard package scope,
  // not just remove/reconcile, which never load the canonical parser module.
  const secondPreview = await dashboard({ action: 'preview', providerId: 'wiki', canonicalId: 'spec:project:second' });
  assert.equal(secondPreview.status, 'preview');
  const secondSaved = await dashboard({ action: 'save', providerId: 'wiki', canonicalId: 'spec:project:second',
    write: true, ackNoRemoteCas: true, operationId: 'save-second-one', expectedRecordHash: secondPreview.snapshot.recordHash });
  assert.equal(secondSaved.status, 'stored');
  const dashboardUpdated = await dashboard({ action: 'update', providerId: 'wiki', canonicalId: 'spec:project:second',
    write: true, ackNoRemoteCas: true, operationId: 'update-second-two', expectedRecordHash: secondPreview.snapshot.recordHash,
    expectedRemoteHash: secondSaved.receipt.desiredRemoteHash });
  assert.equal(dashboardUpdated.status, 'stored');
  assert.equal(await readFile(secondPath, 'utf8'), sources.get(secondPath));

  const wrongRemoteHash = await cli('update', 'spec:project:cache', updateArgs(
    'wrong-remote-hash', preview.snapshot.recordHash, '0'.repeat(64)), 1);
  assert.equal(wrongRemoteHash.error, 'hash-mismatch');

  const updatedSource = '---\ntitle: Projection smoke cache\n---\nSynthetic canonical cache record, version two.\n';
  await writeFile(cachePath, updatedSource, 'utf8');
  sources.set(cachePath, updatedSource);
  const updatePreview = await cli('preview', 'spec:project:cache');
  assert.notEqual(updatePreview.snapshot.recordHash, preview.snapshot.recordHash);
  const updateRequest = {
    action: 'update', providerId: 'wiki', canonicalId: 'spec:project:cache',
    operationId: 'update-cache-two', write: true, ackNoRemoteCas: true,
    expectedRecordHash: updatePreview.snapshot.recordHash,
    expectedRemoteHash: saved.receipt.desiredRemoteHash,
  };
  const mcpUpdate = await child(['--input-type=module', '-e', `
    import { handler } from ${JSON.stringify(mcpUrl)};
    const response = await handler(${JSON.stringify(updateRequest)});
    console.log(JSON.stringify(response));
  `]);
  const updated = parseLastJson(mcpUpdate.stdout);
  assert.equal(updated.success, true);
  assert.equal(updated.result.status, 'stored');
  assert.equal(updated.result.receipt.searchability, 'verified');
  assert.equal(sha256(remotePages.get(cacheRef)), updatePreview.snapshot.remoteContentHash);
  assert.equal(await readFile(cachePath, 'utf8'), updatedSource, 'update must leave the edited canonical source byte-for-byte unchanged');

  const removeRequest = {
    action: 'remove', providerId: 'wiki', canonicalId: 'spec:project:cache',
    operationId: 'remove-cache-three', write: true, ackNoRemoteCas: true,
    expectedRemoteHash: updated.result.receipt.desiredRemoteHash, ackCascade: true,
  };
  const beforeBadCascade = requests.length;
  const dashboardBadCascade = await child(['--input-type=module', '-e', `
    import { Hono } from 'hono';
    import { registerMemoryProjectionRoutes } from ${JSON.stringify(dashboardUrl)};
    const context = { workflowRoot: ${JSON.stringify(workflow)} };
    const app = new Hono();
    registerMemoryProjectionRoutes(app, () => context, candidate => candidate === context);
    const response = await app.request('/api/wiki/memory', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...${JSON.stringify(removeRequest)}, ackCascade: undefined }) });
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `]);
  const rejectedCascade = parseLastJson(dashboardBadCascade.stdout);
  assert.equal(rejectedCascade.status, 400);
  assert.equal(rejectedCascade.body.error, 'invalid-request');
  assert.equal(requests.length, beforeBadCascade, 'unacknowledged cascade must not reach the mock');

  const dashboardRemove = await child(['--input-type=module', '-e', `
    import { Hono } from 'hono';
    import { registerMemoryProjectionRoutes } from ${JSON.stringify(dashboardUrl)};
    const context = { workflowRoot: ${JSON.stringify(workflow)} };
    const app = new Hono();
    registerMemoryProjectionRoutes(app, () => context, candidate => candidate === context);
    const response = await app.request('/api/wiki/memory', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(removeRequest)}) });
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `]);
  const removed = parseLastJson(dashboardRemove.stdout);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.status, 'removed');
  assert.deepEqual(removed.body.receipt.effects, { deletedPages: [cacheRef.replace(/^wiki\//, '').replace(/\.md$/, '')], rewrittenFiles: [], rewrittenFileCount: 2 });
  assert.equal(remotePages.has(cacheRef), false);
  assert.equal(await readFile(cachePath, 'utf8'), updatedSource, 'remove must not delete or rewrite canonical source');
  const invalidated = await cli('status', 'spec:project:second');
  assert.equal(invalidated.status, 'invalidated', 'unknown cascade paths conservatively invalidate other stored receipts');

  const uncertainPreview = await cli('preview', 'spec:project:uncertain');
  const uncertainArgs = saveArgs('save-uncertain-one', uncertainPreview.snapshot.recordHash);
  const uncertain = await cli('save', 'spec:project:uncertain', uncertainArgs);
  assert.equal(uncertain.status, 'indeterminate');
  assert.equal(remotePages.has(uncertain.receipt.pageRef), true, 'mock applies the write before returning an ambiguous error');
  assert.equal(ambiguousWriteCount, 1);
  const writesBeforeIndeterminateReplay = requests.filter(item => item.path === '/v3/wiki/page/write').length;
  const replayedUncertain = await cli('save', 'spec:project:uncertain', uncertainArgs);
  assert.equal(replayedUncertain.status, 'indeterminate');
  assert.equal(requests.filter(item => item.path === '/v3/wiki/page/write').length, writesBeforeIndeterminateReplay,
    'identical replay of an ambiguous send must not retry the write');
  const blockedWhileUncertain = await cli('save', 'spec:project:second', saveArgs('blocked-by-uncertain', secondPreview.snapshot.recordHash), 1);
  assert.equal(blockedWhileUncertain.error, 'pending-operation');
  assert.equal(requests.filter(item => item.path === '/v3/wiki/page/write').length, writesBeforeIndeterminateReplay);

  const dashboardReconcile = await child(['--input-type=module', '-e', `
    import { Hono } from 'hono';
    import { registerMemoryProjectionRoutes } from ${JSON.stringify(dashboardUrl)};
    const context = { workflowRoot: ${JSON.stringify(workflow)} };
    const app = new Hono();
    registerMemoryProjectionRoutes(app, () => context, candidate => candidate === context);
    const response = await app.request('/api/wiki/memory', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reconcile', providerId: 'wiki', canonicalId: 'spec:project:uncertain', operationId: 'save-uncertain-one' }) });
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `]);
  const reconciled = parseLastJson(dashboardReconcile.stdout);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.status, 'stored');
  assert.equal(reconciled.body.receipt.searchability, 'verified');
  assert.equal(ambiguousWriteCount, 1, 'reconcile may read/search but never resend the mutation');
  assert.equal((await cli('status', 'spec:project:uncertain')).status, 'stored');

  for (const [path, expected] of sources) assert.equal(await readFile(path, 'utf8'), expected, `projection changed canonical source: ${path}`);
  assert.deepEqual(mockFailures, [], `mock rejected an unexpected request: ${mockFailures.join('; ')}`);
  assert(requests.length > 0);
  assert(requests.every(item => ['/v3/wiki/get', '/v3/wiki/page/read', '/v3/wiki/page/write', '/v3/wiki/page/rm', '/v3/tools/call'].includes(item.path)));
  assert(guardedConnections > 0);
  assert.equal(blockedAttempts, 1, 'only the explicit network-guard self-test was blocked');
  console.log(JSON.stringify({
    ok: true, builtCli: true, builtMcp: true, builtDashboard: true, dashboardSnapshotActions: true,
    probeRejectedBeforeNetwork: true, disabledProviderNoNetwork: true, writeDisabledNoNetwork: true,
    hashMismatchNoWrite: true, storedSearchReadHashVerified: true, updateAndRemove: true,
    localSourcesUnchanged: true, cascadeCountUnknownPathsInvalidatedConservatively: true,
    idempotentReplayNoResend: true, indeterminateAndReadOnlyReconcile: true,
    mockRequests: requests.length, mockWrites: requests.filter(item => item.path === '/v3/wiki/page/write').length,
    guardedMockConnections: guardedConnections, guardSelfTestBlocked: blockedAttempts,
  }));
} finally {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  await rm(project, { recursive: true, force: true });
}
