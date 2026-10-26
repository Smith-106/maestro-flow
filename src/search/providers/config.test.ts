import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSearchProviderConfigs, validateTencentProviderConfig } from './config.js';

const entry = { id: 'memory', kind: 'tencent-atomic', baseUrl: 'https://example.invalid',
  apiKeyEnv: 'TEST_TENCENT_KEY', serviceId: 'service', repoId: 'repo', teamId: 'team', userId: 'user', agentId: 'agent' };

describe('read-only Tencent configuration', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'search-provider-config-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  function save(data: unknown) { writeFileSync(join(root, 'search-providers.json'), JSON.stringify(data)); }
  function load(value: unknown) { save(value); return () => loadSearchProviderConfigs(root); }

  it('absent means empty, without creating files; root is already .workflow', () => {
    expect(loadSearchProviderConfigs(root)).toEqual([]);
    expect(existsSync(join(root, 'search-providers.json'))).toBe(false);
  });
  it('defaults disabled and 3000ms, preserves explicit values and wiki binding', () => {
    save({ version: 1, providers: [entry, { id: 'wiki', kind: 'tencent-wiki',
      baseUrl: 'http://[::1]:9000/', apiKeyEnv: 'KEY', serviceId: 'svc', repoId: 'repo',
      knowledgeId: 'kb', enabled: true, timeoutMs: 10 }] });
    const configs = loadSearchProviderConfigs(root);
    expect(configs[0]).toEqual({ ...entry, enabled: false, timeoutMs: 3000 });
    expect(configs[1]).toMatchObject({ enabled: true, timeoutMs: 10, baseUrl: 'http://[::1]:9000' });
  });
  it.each(['http://localhost', 'http://127.0.0.1:80', 'http://[::1]', 'https://remote.invalid/prefix'])('allows explicit URL %s', baseUrl => {
    expect(validateTencentProviderConfig({ ...entry, baseUrl }).baseUrl).toBeTruthy();
  });
  it.each(['http://remote.invalid', 'http://127.1', 'http://2130706433', 'http://0x7f000001',
    'http://127.0.0.2', 'http://localhost.evil', 'http://localhost.', 'http://[::ffff:127.0.0.1]',
    'ftp://localhost', 'file:///tmp/test', 'https://user:secret@remote.invalid',
    'https://remote.invalid/?key=secret', 'https://remote.invalid/#secret', 'https://remote.invalid?',
    'https://remote.invalid#', 'https:\\remote.invalid', '//remote.invalid', ' https://remote.invalid'])('rejects URL %s', baseUrl => {
    expect(() => validateTencentProviderConfig({ ...entry, baseUrl })).toThrow('invalid-config');
  });
  it.each([
    null, [], {}, { version: 2, providers: [] }, { version: 1, providers: [], extra: true },
    { version: 1, providers: {} }, { version: 1, providers: Array.from({ length: 9 }, (_, i) => ({ ...entry, id: `p${i}` })) },
    { version: 1, providers: [entry, entry] },
  ])('rejects invalid root/cap/duplicates: %j', data => { expect(load(data)).toThrow('invalid-config'); });
  it.each([
    { id: 'local' }, { id: 'LOCAL' }, { id: '../evil' }, { id: '' }, { kind: 'other' },
    { baseUrl: undefined }, { repoId: '' }, { teamId: undefined }, { userId: undefined }, { agentId: undefined },
    { enabled: 'true' }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: 1.5 },
    { apiKey: 'secret' }, { apiKeyEnv: 'secret-key' }, { serviceId: 'a\r\nb' },
    { kind: 'tencent-wiki', knowledgeId: undefined }, { taskId: null }, { repoId: 'x'.repeat(257) },
  ])('fails closed on entry %j', patch => {
    expect(load({ version: 1, providers: [{ ...entry, ...patch }] })).toThrow('invalid-config');
  });
  it('keeps writeEnabled absent by default, preserves explicit false, and permits only attributed wiki writes', () => {
    expect(validateTencentProviderConfig(entry)).not.toHaveProperty('writeEnabled');
    expect(validateTencentProviderConfig({ ...entry, writeEnabled: false }).writeEnabled).toBe(false);
    const wiki = { ...entry, kind: 'tencent-wiki', knowledgeId: 'wiki', writeEnabled: true };
    expect(validateTencentProviderConfig(wiki).writeEnabled).toBe(true);
    for (const patch of [{ kind: 'tencent-atomic' }, { teamId: undefined }, { userId: undefined },
      { agentId: undefined }, { writeEnabled: 'true' }, { writeEnabled: undefined }, { writeEnabled: null }]) {
      expect(() => validateTencentProviderConfig({ ...wiki, ...patch })).toThrow('invalid-config');
    }
    save({ version: 1, providers: [wiki] });
    expect(loadSearchProviderConfigs(root)[0].writeEnabled).toBe(true);
  });
  it('accepts eight unique providers and does not read env refs', () => {
    save({ version: 1, providers: Array.from({ length: 8 }, (_, i) => ({ ...entry, id: `p${i}` })) });
    expect(loadSearchProviderConfigs(root)).toHaveLength(8);
  });
  it('rejects malformed JSON, UTF8 and files beyond 64KiB; accepts exactly 64KiB', () => {
    const file = join(root, 'search-providers.json');
    writeFileSync(file, '{');
    expect(() => loadSearchProviderConfigs(root)).toThrow('invalid-config');
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => loadSearchProviderConfigs(root)).toThrow('invalid-config');
    const json = JSON.stringify({ version: 1, providers: [entry] });
    writeFileSync(file, json.padEnd(64 * 1024, ' '));
    expect(loadSearchProviderConfigs(root)).toHaveLength(1);
    writeFileSync(file, json.padEnd(64 * 1024 + 1, ' '));
    expect(() => loadSearchProviderConfigs(root)).toThrow('invalid-config');
  });
});
