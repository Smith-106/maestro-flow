import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSearchProviderConfigs } from './config.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const directory = mkdtempSync(join(tmpdir(), 'provider-special-file-')); roots.push(directory); return directory;
}

describe('provider configuration special files', () => {
  it('rejects a directory instead of treating it as an empty configuration', () => {
    const directory = root(); mkdirSync(join(directory, 'search-providers.json'));
    expect(() => loadSearchProviderConfigs(directory)).toThrow('invalid-config');
  });

  it.skipIf(process.platform === 'win32')('rejects FIFOs and symlinked FIFOs without blocking open', ({ skip }) => {
    const directory = root();
    const fifo = join(directory, 'fifo');
    const made = spawnSync('mkfifo', [fifo], { timeout: 2000 });
    if (made.error && (made.error as NodeJS.ErrnoException).code === 'ENOENT') skip('mkfifo is unavailable');
    expect(made.status).toBe(0);
    // Run the potentially blocking syscall in a bounded child, so a regression
    // fails instead of locking the entire test runner. Compile only these two
    // dependency-free modules; no built output or tsx installation is required.
    mkdirSync(join(directory, 'src', 'search', 'providers'), { recursive: true });
    mkdirSync(join(directory, 'shared'));
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    for (const [source, destination] of [
      [new URL('./config.ts', import.meta.url), join(directory, 'src', 'search', 'providers', 'config.js')],
      [new URL('../../../shared/search-provider.ts', import.meta.url), join(directory, 'shared', 'search-provider.js')],
    ] as const) {
      writeFileSync(destination, ts.transpileModule(readFileSync(source, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText);
    }
    symlinkSync(fifo, join(directory, 'search-providers.json'));
    const moduleUrl = pathToFileURL(join(directory, 'src', 'search', 'providers', 'config.js')).href;
    const script = `import {loadSearchProviderConfigs} from ${JSON.stringify(moduleUrl)}; try { loadSearchProviderConfigs(${JSON.stringify(directory)}); process.exitCode=2; } catch(error) { if(error.code!=='invalid-config')process.exitCode=3; }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000, encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });
});
