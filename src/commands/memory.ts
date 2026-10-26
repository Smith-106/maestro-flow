import type { Command } from 'commander';
import { MemoryProjectionError, MEMORY_PROJECTION_ERROR_CODES, type MemoryProjectionRequest } from '../../shared/memory-projection.js';
import { getProjectRoot } from '../utils/path-validator.js';

/** Explicit canonical projections only; all record and mutation gates live in the runtime. */
export function registerMemoryCommand(program: Command): void {
  const memory = program.command('memory')
    .description('Explicit remote projections of existing canonical knowledge (never edits local knowledge)')
    .configureOutput({ outputError: (_message, write) => write('{"error":"invalid-request","canonicalMutation":false}\n') });
  for (const action of ['preview', 'save', 'update', 'remove', 'status', 'reconcile'] as const) {
    const command = memory.command(`${action} <canonicalId>`)
      .requiredOption('--provider <id>', 'explicit configured provider ID')
      .option('--read-only-probe', 'reject remote access before configuration or credentials')
      .option('--timeout-ms <milliseconds>', 'bounded operation deadline (1–30000ms)')
      .option('--json', 'emit JSON (also the default output format)');
    if (action === 'save' || action === 'update' || action === 'remove') {
      command
        .option('--write', 'explicitly authorize this remote mutation')
        .option('--ack-no-remote-cas', 'acknowledge that upstream has no atomic compare-and-swap')
        .option('--operation-id <id>', 'unique durable operation ID; confirmed identical replays do not resend')
        .option('--expected-record-hash <sha256>', 'preview record hash (required for save/update)')
        .option('--expected-remote-hash <sha256>', 'previous remote hash (required for update/remove)');
      if (action === 'remove') command.option('--ack-cascade', 'acknowledge remote delete may rewrite other pages');
    }
    if (action === 'reconcile') command.option('--operation-id <id>', 'existing operation to inspect; never resend a mutation');
    command.action(async (canonicalId: string, options: Record<string, unknown>) => {
      try {
        let timeoutMs: number | undefined;
        if (options.timeoutMs !== undefined) {
          if (typeof options.timeoutMs !== 'string' || !/^\d+$/.test(options.timeoutMs)) throw new MemoryProjectionError('invalid-request');
          timeoutMs = Number(options.timeoutMs);
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new MemoryProjectionError('invalid-request');
        }
        const request: MemoryProjectionRequest = { action, canonicalId, providerId: options.provider as string };
        // Do not manufacture false write/ack flags on read-only operations.
        for (const key of ['write', 'ackNoRemoteCas', 'ackCascade', 'operationId', 'expectedRecordHash', 'expectedRemoteHash'] as const) {
          if (options[key] !== undefined) Object.assign(request, { [key]: options[key] });
        }
        const { runMemoryProjection } = await import('../memory/runtime.js');
        const result = await runMemoryProjection(request, { projectRoot: getProjectRoot(),
          executionMode: options.readOnlyProbe === true ? 'read-only-probe' : 'default', timeoutMs });
        console.log(JSON.stringify(result));
      } catch (error) {
        const code = error instanceof MemoryProjectionError && MEMORY_PROJECTION_ERROR_CODES.includes(error.code) ? error.code : 'provider-error';
        console.error(JSON.stringify({ error: code, canonicalMutation: false }));
        process.exitCode = 1;
      }
    });
  }
}
