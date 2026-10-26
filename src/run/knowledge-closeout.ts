import type { RunResponseV12 } from './protocol-schemas.js';

export type KnowledgeCloseoutTiming = 'now' | 'terminal-task-closeout';

export function knowledgeCloseoutWarning(
  sessionId: string,
  timing: KnowledgeCloseoutTiming,
): RunResponseV12['warnings'][number] {
  if (timing === 'terminal-task-closeout') {
    return {
      code: 'KNOWLEDGE_CLOSEOUT_DEFERRED',
      message: 'Continue the confirmed Run/Session chain; intermediate workers return candidate IDs without an approval detour. '
        + `The completion owner handles knowledge for Session ${sessionId} at terminal task closeout under @~/.maestro/ref/knowledge-closeout.md. `
        + 'Do not start human review or publication in this intermediate Run. Pending backlog does not block normal chain progression.',
      replacement_command: null,
    };
  }
  return {
    code: 'KNOWLEDGE_CLOSEOUT',
    message: [
      'The completion owner must handle knowledge closeout now while the host is interactive.',
      `Read @~/.maestro/ref/knowledge-closeout.md. Internally read candidates for this exact Session with maestro knowledge review ${sessionId} --json.`,
      'Present candidates and use ask-user-question (or the host equivalent): Ask itself is human review, not permission to start another review. Never send the human to CLI review.',
      'Collect explicit relationship/target and publication decisions together for the displayed fixed IDs; reuse matching prior human authorization. Machine advice is not authorization.',
      'Only execute approved fixed actions under caller authority and existing identity/evidence/fresh-receipt gates, then read back outcomes. Never auto-promote or widen with --all.',
      'No candidates, rejection, deferral, or no dialog-capable host: retain any backlog and finish normally. Knowledge closeout never blocks Session completion; do not start interaction after shutdown.',
    ].join(' '),
    replacement_command: null,
  };
}
