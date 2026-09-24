import test from "node:test";
import assert from "node:assert/strict";
import { applyCompletionContinuation, applyDirectionBlock } from "../src/interventions.ts";
import type { Decision, Assessment } from "../src/types.ts";
import type { AgentBeforeSettleEvent } from "@earendil-works/pi-coding-agent";

function syntheticDecision(apply: Decision["apply"], memo: string | null = null): Decision {
	return {
		assessment: { kind: "completion", ok: true, status: "EXECUTE", answers: {}, findings: [], notes: "", cost: { billedUsd: 0, marketUsd: 0, unknown: false }, usage: { requestBytes: 0, responseBytes: 0, attempts: 1 }, timings: { startedAt: "", finishedAt: "", ms: 0 }, requestId: "", requestHash: "", responseHash: "", origin: "synthetic" } as Assessment,
		apply,
		status: "EXECUTE",
		reasons: ["test"],
		memo,
		focusKey: "test",
	};
}

function syntheticEvent(overrides: Partial<AgentBeforeSettleEvent> = {}): AgentBeforeSettleEvent {
	return {
		type: "agent_before_settle",
		context: {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		},
		entries: [],
		continue: false,
		outcome: "completed",
		...overrides,
	} as AgentBeforeSettleEvent;
}

test("completion continuation returns undefined in observe mode", () => {
	const decision = syntheticDecision("continue", "memo");
	const event = syntheticEvent();
	const result = applyCompletionContinuation(event, decision, {
		mode: "observe",
		traceEnabled: true,
		signal: undefined,
		maxInterventionsPerTask: 1,
		maxTerminalContinuations: 1,
		interventionsUsed: 0,
		terminalContinuationsUsed: 0,
	});
	assert.equal(result, undefined);
});

test("completion continuation produces continuation in enforce mode", () => {
	const decision = syntheticDecision("continue", "memo");
	const event = syntheticEvent();
	const result = applyCompletionContinuation(event, decision, {
		mode: "enforce",
		traceEnabled: true,
		signal: undefined,
		maxInterventionsPerTask: 1,
		maxTerminalContinuations: 1,
		interventionsUsed: 0,
		terminalContinuationsUsed: 0,
	});
	assert.ok(result);
	assert.equal(result?.continue, true);
	assert.ok(result.entries);
	assert.equal(result.entries.length, 1);
	assert.equal((result.entries[0] as any).content, "memo");
});

test("completion continuation skips when pendingMessages exist", () => {
	const decision = syntheticDecision("continue", "memo");
	const event = syntheticEvent({ context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [{ role: "user", content: "queued", timestamp: 0 }], canContinue: false } });
	const result = applyCompletionContinuation(event, decision, {
		mode: "enforce",
		traceEnabled: true,
		signal: undefined,
		maxInterventionsPerTask: 1,
		maxTerminalContinuations: 1,
		interventionsUsed: 0,
		terminalContinuationsUsed: 0,
	});
	assert.equal(result, undefined);
});

test("completion continuation skips when budget exhausted", () => {
	const decision = syntheticDecision("continue", "memo");
	const event = syntheticEvent();
	const result = applyCompletionContinuation(event, decision, {
		mode: "enforce",
		traceEnabled: true,
		signal: undefined,
		maxInterventionsPerTask: 1,
		maxTerminalContinuations: 1,
		interventionsUsed: 1,
		terminalContinuationsUsed: 0,
	});
	assert.equal(result, undefined);
});

test("direction block returns undefined in observe mode", () => {
	const decision = syntheticDecision("block", "memo");
	const result = applyDirectionBlock(decision, "observe");
	assert.equal(result, undefined);
});

test("direction block returns block in enforce mode", () => {
	const decision = syntheticDecision("block", "memo");
	const result = applyDirectionBlock(decision, "enforce");
	assert.ok(result);
	assert.equal(result?.block, true);
	assert.equal(result?.reason, "memo");
});

test("completion continuation skips when signal aborted", () => {
	const decision = syntheticDecision("continue", "memo");
	const event = syntheticEvent();
	const controller = new AbortController();
	controller.abort();
	const result = applyCompletionContinuation(event, decision, {
		mode: "enforce",
		traceEnabled: true,
		signal: controller.signal,
		maxInterventionsPerTask: 1,
		maxTerminalContinuations: 1,
		interventionsUsed: 0,
		terminalContinuationsUsed: 0,
	});
	assert.equal(result, undefined);
});

test("direction block returns undefined for apply:none", () => {
	const decision = syntheticDecision("none", "memo");
	const result = applyDirectionBlock(decision, "enforce");
	assert.equal(result, undefined);
});
