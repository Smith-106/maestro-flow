#!/usr/bin/env node
/** Built CLI + MCP + Dashboard acceptance against an ephemeral loopback mock only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = await mkdtemp(join(tmpdir(), 'maestro-built-provider-'));
const workflow = join(project, '.workflow');
const repoId = '11111111-1111-4111-8111-111111111111';
const requests = [];
const server = createServer(async (req, res) => {
  try {
    let source = '';
    for await (const chunk of req) {
      source += chunk;
      if (source.length > 16_384) throw new Error('mock request too large');
    }
    const body = JSON.parse(source);
    requests.push({ path: req.url, tool: body.tool_name });
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer smoke-only-key');
    assert.equal(req.headers['x-tdai-service-id'], 'service');
    let data;
    if (req.url === '/v3/atomic/search') {
      assert.equal(body.team_id, 'team'); assert.equal(body.user_id, 'user'); assert.equal(body.agent_id, 'agent');
      data = { items: [{ id: 'atomic-one', type: 'instruction', content: 'External cache advice', version: 0,
        team_id: 'team', user_id: 'user', agent_id: 'agent', score: 0.9 }] };
    } else {
      assert.equal(req.url, '/v3/tools/call'); assert.equal(body.knowledge_id, 'wiki-one');
      assert(['search', 'read_page'].includes(body.tool_name));
      if (body.tool_name === 'read_page') {
        assert.deepEqual(body.params.refs, ['wiki/cache.md']);
        data = { items: [{ ref: 'wiki/cache.md', content: '# Actual source\nCache reference.' }] };
      } else data = { results: [{ path: 'wiki/cache.md', title: 'Cache reference', snippet: 'External preview', score: 1 }], count: 1 };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, data }));
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"code":500}');
  }
});
try {
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
const address = server.address();
assert(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}`;
// Do not inherit credentials, proxies, NODE_OPTIONS or real user configuration.
const platformKeys = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SystemDrive'];
const environment = Object.fromEntries(platformKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(environment, { HOME: project, USERPROFILE: project, APPDATA: project, LOCALAPPDATA: project,
  TMP: project, TEMP: project, MAESTRO_PROJECT_ROOT: project, MAESTRO_PROVIDER_SMOKE_KEY: 'smoke-only-key' });
// All Node HTTP/fetch/TLS connections pass through Socket.connect. Fail closed
// before DNS/connect for anything except this mock's exact numeric address/port.
const guard = join(project, 'network-guard.cjs');
await writeFile(guard, `
  const {writeFileSync}=require('node:fs');
  const {Socket}=require('node:net');
  const original=Socket.prototype.connect;
  const audit={allowed:0,blocked:0};
  process.on('exit',()=>writeFileSync(process.env.MAESTRO_SMOKE_AUDIT,JSON.stringify(audit)));
  Socket.prototype.connect=function(...args){
    const first=Array.isArray(args[0])?args[0][0]:args[0];
    const options=first!==null&&typeof first==='object'?first:{port:first,host:typeof args[1]==='string'?args[1]:'localhost'};
    if(options.host!=='127.0.0.1'||Number(options.port)!==${address.port}){
      audit.blocked++; throw new Error('smoke-network-blocked');
    }
    audit.allowed++; return original.apply(this,args);
  };
`);
let childCount = 0;
let guardedConnections = 0;
let blockedAttempts = 0;
async function child(args, expectedExit = 0, expectedBlocked = 0) {
  const auditPath = join(project, `network-${++childCount}.json`);
  let stdout;
  let actualExit = 0;
  try { ({ stdout } = await exec(process.execPath, ['--require', guard, ...args], {
    cwd: root, env: { ...environment, MAESTRO_SMOKE_AUDIT: auditPath }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  })); }
  catch (error) {
    if (expectedExit === 0 || error.code !== expectedExit) throw error;
    actualExit = error.code;
    stdout = error.stdout;
  }
  assert.equal(actualExit, expectedExit);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  assert.equal(audit.blocked, expectedBlocked, 'unexpected non-mock connection attempted');
  guardedConnections += audit.allowed; blockedAttempts += audit.blocked;
  return JSON.parse(stdout);
}
function cli(...args) { return [join(root, 'bin', 'maestro.js'), 'search', 'cache', '--workflow-root', project, '--json', ...args]; }
const configs = [
  { id: 'memory', kind: 'tencent-atomic', enabled: true, baseUrl: endpoint, apiKeyEnv: 'MAESTRO_PROVIDER_SMOKE_KEY', serviceId: 'service',
    repoId, teamId: 'team', userId: 'user', agentId: 'agent' },
  { id: 'wiki', kind: 'tencent-wiki', enabled: true, baseUrl: endpoint, apiKeyEnv: 'MAESTRO_PROVIDER_SMOKE_KEY', serviceId: 'service', repoId, knowledgeId: 'wiki-one' },
];
const save = () => writeFile(join(workflow, 'search-providers.json'), JSON.stringify({ version: 1, providers: configs }));
  const guardCheck = await child(['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import {Socket} from 'node:net';
    const socket=new Socket();
    try { assert.throws(()=>socket.connect({host:'203.0.113.1',port:443}),/smoke-network-blocked/); }
    finally { socket.destroy(); }
    console.log(JSON.stringify({blocked:true}));
  `], 0, 1);
  assert.equal(guardCheck.blocked, true);
  await mkdir(join(workflow, 'specs'), { recursive: true });
  await writeFile(join(workflow, 'repository.json'), JSON.stringify({ schema_version: 'repository-identity/1.0', repo_id: repoId,
    repo_name: 'provider-smoke', created_at: '2026-01-01T00:00:00.000Z' }));
  await writeFile(join(workflow, 'specs', 'cache.md'), '---\ntitle: Cache policy\n---\nLocal cache invalidation.');
  await save();
  const remote = await child(cli('--providers', 'memory'));
  assert.equal(remote.schemaVersion, 'maestro-search/1.0');
  assert.equal(remote.results[0].trust, 'external'); assert.equal(remote.results[0].referenceOnly, true);
  assert.equal(remote.results[0].kind, 'memory'); assert.equal(remote.mutationAuthorized, false);
  assert.equal(remote.providers[0].status, 'degraded'); assert.equal(requests.length, 1);
  const probe = await child(cli('--providers', 'memory', '--read-only-probe'), 1);
  assert.equal(probe.error, 'probe-forbidden'); assert.equal(requests.length, 1);
  const local = await child(cli('--providers', 'local', '--wiki-only', '--read-only-probe'));
  assert.equal(local.results[0].ref.providerId, 'local'); assert.equal(local.results[0].trust, 'local');
  assert.equal(requests.length, 1);
  const files = await readdir(workflow);
  for (const name of ['search-cache.json', 'wiki-index.json', 'search-daemon.json', 'embedding-index.bin']) assert(!files.includes(name));
  configs[0].enabled = false; await save();
  const disabled = await child(cli('--providers', 'memory'), 1);
  assert.equal(disabled.error, 'disabled-provider'); assert.equal(requests.length, 1);
  const legacy = await child(cli('--type', 'template'));
  assert.equal(legacy.query, 'cache'); assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(legacy).sort(), (legacy.count === 0 ? ['query', 'count', 'results', 'hint'] : ['query', 'count', 'results']).sort());
  assert(Array.isArray(legacy.results)); assert(Number.isInteger(legacy.count)); assert.equal(legacy.count, legacy.results.length);
  if (legacy.count === 0) assert.equal(typeof legacy.hint, 'string');
  for (const item of legacy.results) {
    assert.deepEqual(Object.keys(item).sort(), ['source', 'id', 'kind', 'name', 'preview', 'openCommand', 'filePath', 'referenceOnly'].sort());
    for (const key of ['id', 'name', 'preview', 'openCommand', 'filePath']) assert.equal(typeof item[key], 'string');
    assert.equal(item.source, 'arch-kb'); assert.equal(item.kind, 'template'); assert.equal(item.referenceOnly, true);
  }

  // The parent HTTP server remains responsive while these built clients run.
  const mcpUrl = pathToFileURL(join(root, 'dist', 'src', 'tools', 'wiki-search.js')).href;
  const routesUrl = pathToFileURL(join(root, 'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'routes', 'search-providers.js')).href;
  const indexerUrl = pathToFileURL(join(root, 'dashboard', 'dist-server', 'dashboard', 'src', 'server', 'wiki', 'wiki-indexer.js')).href;
  const integrated = await child(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {Hono} from 'hono';
    import {handler} from ${JSON.stringify(mcpUrl)};
    import {registerSearchProviderRoutes} from ${JSON.stringify(routesUrl)};
    import {WikiIndexer} from ${JSON.stringify(indexerUrl)};
    const mcp = await handler({query:'cache',providers:['wiki']});
    assert.equal(mcp.success,true); assert.equal(mcp.result.results[0].trust,'external');
    const indexer=new WikiIndexer({workflowRoot:${JSON.stringify(workflow)},role:'hermetic',includeCliSessions:false});
    try {
      const context={workflowRoot:${JSON.stringify(workflow)},indexer}; const app=new Hono();
      registerSearchProviderRoutes(app,()=>context,c=>c===context);
      const search=await app.request('/api/wiki/search',{method:'POST',body:JSON.stringify({query:'cache',providers:['wiki']})});
      assert.equal(search.status,200); const batch=await search.json();
      assert.equal(batch.results[0].kind,'document'); assert.equal(batch.results[0].referenceOnly,true);
      const source=await app.request('/api/wiki/search/read',{method:'POST',body:JSON.stringify({ref:batch.results[0].ref})});
      assert.equal(source.status,200); const read=await source.json();
      assert.equal(read.content,'# Actual source\\nCache reference.'); assert.equal(read.ref.version,createHash('sha256').update(read.content).digest('hex'));
      console.log(JSON.stringify({mcp:true,dashboardSearch:true,dashboardRead:true}));
    } finally {await indexer.close();}
  `]);
  assert.deepEqual(integrated, { mcp: true, dashboardSearch: true, dashboardRead: true });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(request => request.path), ['/v3/atomic/search', '/v3/tools/call', '/v3/tools/call', '/v3/tools/call']);
  assert(guardedConnections > 0); assert.equal(blockedAttempts, 1); // intentional guard self-test only
  console.log(JSON.stringify({ ok: true, builtCli: true, probeNoRemote: true, disabledNoRemote: true, legacyUnchanged: true,
    ...integrated, mockRequests: requests.length, guardedMockConnections: guardedConnections, guardSelfTestBlocked: blockedAttempts }));
} finally {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  await rm(project, { recursive: true, force: true });
}
