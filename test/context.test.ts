import { test } from 'node:test';
import assert from 'node:assert';
import { pruneContext } from '../src/context.ts';

// Helper to create a base fixture
function createFixture(): Record<string, any> {
  return {
    observations: [],
    recent_actions: [],
    verification_checks: [],
    requirements: [],
    history: {},
    proposal: {},
    context_selection: { truncation_metadata: [] },
    omitted_evidence_ids: [],
    omitted_observation_count: 0,
  };
}

test('pruneContext retains original+middle+latest user instructions while removing old assistant turns under history budget', () => {
  const rep = createFixture();
  const turns = [
    { role: 'user', text: 'Original instruction' },
    { role: 'assistant', text: 'Old assistant response that should be removed if budget is tight' },
    { role: 'user', text: 'Middle instruction' },
    { role: 'assistant', text: 'Another old assistant response' },
    { role: 'user', text: 'Latest user instruction' },
  ];

  // Set a very small maxHistoryChars to force removal of assistant turns
  // The rendered history format is "[role]: text" joined by "\n\n"
  // We want to ensure user turns are kept.
  const result = pruneContext(rep, turns, 100);

  const historyText = result.history.text;
  assert.ok(historyText.includes('[user]: Original instruction'));
  assert.ok(historyText.includes('[user]: Middle instruction'));
  assert.ok(historyText.includes('[user]: Latest user instruction'));

  // Assistant turns should likely be removed or reduced depending on exact char count logic
  // But specifically, we check that user content remains.
  assert.ok(!historyText.includes('[assistant]: Old assistant response that should be removed if budget is tight'));
});

test('pruneContext deduplicates long requirement text from user history to ID reference while retaining full requirement and inputs unmutated', () => {
  const longReq = 'A'.repeat(85); // >= 80 chars
  const rep = createFixture();
  rep.requirements = [{ id: 'req-1', summary: longReq }];

  const turns = [
    { role: 'user', text: `Please implement this: ${longReq}` },
  ];

  const originalRep = JSON.parse(JSON.stringify(rep));
  const originalTurns = JSON.parse(JSON.stringify(turns));

  const result = pruneContext(rep, turns, 10000);

  // Check that user turn text was modified to include reference
  assert.ok(result.history.text.includes('[See task.requirements req-1]'));
  assert.ok(!result.history.text.includes(longReq));

  // Check that requirements array still has the full summary
  assert.strictEqual(result.requirements[0].summary, longReq);

  // Check inputs were not mutated
  assert.deepStrictEqual(rep, originalRep);
  assert.deepStrictEqual(turns, originalTurns);
});

test('pruneContext sets metadata representation_bytes exactly to Buffer.byteLength(JSON.stringify(output)) and estimated_tokens to ceil(bytes/2)', () => {
  const rep = createFixture();
  rep.proposal = { content: 'test' };

  const result = pruneContext(rep, [], 10000);

  const jsonStr = JSON.stringify(result);
  const expectedBytes = Buffer.byteLength(jsonStr, 'utf8');
  const expectedTokens = Math.ceil(expectedBytes / 2);

  assert.strictEqual(result.context_selection.representation_bytes, expectedBytes);
  assert.strictEqual(result.context_selection.estimated_tokens, expectedTokens);
});

test('pruneContext keeps 50KB mandatory current proposal unchanged and sets budget_exceeded true', () => {
  const rep = createFixture();
  const largeProposalContent = 'x'.repeat(50 * 1024); // 50KB
  rep.proposal = { content: largeProposalContent };

  const result = pruneContext(rep, [], 10000);

  assert.strictEqual(result.proposal.content, largeProposalContent);
  assert.strictEqual(result.context_selection.budget_exceeded, true);
});

test('pruneContext keeps large user instruction intact despite budget', () => {
  const rep = createFixture();
  const largeInstruction = 'y'.repeat(30000); // Large but single turn

  const turns = [
    { role: 'user', text: largeInstruction },
  ];

  // Even if budget is exceeded, user instructions are generally kept unless they are assistant turns being pruned?
  // The logic drops assistant turns first. If only user turns remain, it stops dropping.
  const result = pruneContext(rep, turns, 1000);

  assert.ok(result.history.text.includes(largeInstruction));
  // It might be truncated in rendering if maxHistoryChars is small?
  // Wait, the logic says: "Find oldest assistant turn... if -1 break".
  // So if only user turns remain, they are NOT dropped.
  // However, the history.text is rendered from selectedTurns.
  // If maxHistoryChars is 1000, and the user turn is 30000 chars, does it truncate the text?
  // Looking at code: `if (rendered.length <= maxHistoryChars) break;`
  // If it exceeds, it tries to drop assistant. If none, it breaks.
  // So the text remains in `selectedTurns`.
  // `refreshHistory` renders `selectedTurns`.
  // So `result.history.text` will contain the full large instruction.
  assert.strictEqual(result.history.text, `[user]: ${largeInstruction}`);
});
