import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, type Msg } from "../src/evidence.ts";
import { defaultConfig } from "../src/config.ts";
import type { Requirement } from "../src/types.ts";

function assistant(text: string, calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> = [], stopReason = "toolUse"): Msg {
	return {
		role: "assistant",
		stopReason,
		content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments ?? {} }))],
	};
}

function toolResult(toolCallId: string, text: string, opts: { isError?: boolean; toolName?: string } = {}): Msg {
	return { role: "toolResult", toolCallId, toolName: opts.toolName ?? "bash", isError: opts.isError ?? false, content: [{ type: "text", text }] };
}

const config = defaultConfig();

function build(messages: Msg[], target: Msg | undefined, executedIds: string[], overrides: Record<string, unknown> = {}) {
	return buildSnapshot({
		kind: "proposal",
		target,
		messages,
		executedToolCallIds: new Set(executedIds),
		requirements: [{ id: "R1", summary: "make it work", origin: "R0:original-request" }] as Requirement[],
		manifest: false,
		priorInterventions: [],
		config,
		secrets: ["s3cr3t-key"],
		scope: { sessionId: "s", taskId: "t", branch: "main" },
		...overrides,
	});
}

test("steering-context: 16 results => last 12 plus 2 older errors, retained nonempty", () => {
	const messages: Msg[] = [];
	const executedIds: string[] = [];
	for (let i = 1; i <= 16; i++) {
		const isError = i <= 2; // First 2 are errors
		messages.push(toolResult(`c${i}`, `result ${i}`, { isError }));
		executedIds.push(`c${i}`);
	}
	const target = assistant("done", [], "stop");
	messages.push(target);
	const snap = build(messages, target, executedIds);
	
	// Last 12 (E5-E16) + 2 older errors (E1, E2) = 14 retained
	assert.equal(snap.observations.length, 14);
	assert.ok(snap.observations.length > 0, "retained must be nonempty");
	
	const omitted = snap.representation.omitted_evidence_ids as string[];
	assert.deepEqual(omitted, ["E3", "E4"], "E3 and E4 are omitted (not last 12, not errors)");
	assert.equal(snap.representation.omitted_observation_count, 2);
});

test("steering-context: result 2000 limit represented correctly", () => {
	const longText = "x".repeat(3000);
	const messages = [toolResult("c1", longText)];
	const target = assistant("done", [], "stop");
	messages.push(target);
	const snap = build(messages, target, ["c1"]);
	
	const obs = snap.observations[0];
	assert.ok(obs);
	assert.equal(obs.text.length, 2000, "observation text capped at 2000");
	
	const meta = (snap.representation.context_selection as { truncation_metadata: Array<{ id: string; truncated: boolean; originalChars: number }> }).truncation_metadata;
	assert.equal(meta[0]!.truncated, true);
	assert.equal(meta[0]!.originalChars, 3000);
});

test("steering-context: huge historical write args bounded with hash, current proposal args intact", () => {
	const hugeArg = "y".repeat(1000);
	const target = assistant("proposal", [{ id: "c1", name: "write", arguments: { content: hugeArg } }]);
	const messages = [target];
	const snap = build(messages, target, []);
	
	// Proposal args intact
	assert.equal((snap.toolCalls[0]!.arguments as { content: string }).content.length, 1000);
	
	// Historical args in recent_actions bounded if > 600
	const recentActions = snap.representation.recent_actions as Array<{ arguments?: unknown; arguments_hash?: string; arguments_truncated?: boolean }>;
	// In this case, it's the current proposal, so it might be treated as recent? 
	// The logic says recent_actions uses observationsAll. The target's tool calls are in observationsAll if they have results.
	// Here we have no results for c1, so it's not in observationsAll/recent_actions.
	// Let's add a result for it to test historical bounding.
	const messagesWithResult = [assistant("run", [{ id: "c1", name: "write", arguments: { content: hugeArg } }]), toolResult("c1", "ok")];
	const snap2 = build(messagesWithResult, assistant("done", [], "stop"), ["c1"]);
	const ra = (snap2.representation.recent_actions as Array<{ arguments?: unknown; arguments_hash?: string; arguments_truncated?: boolean }>)[0];
	assert.ok(ra);
	assert.ok(ra.arguments_truncated, "historical args > 600 chars should be truncated in recent_actions");
	assert.ok(ra.arguments_hash, "hash preserved");
	assert.ok((ra.arguments as { _summary: string })._summary.length <= 600);
});

test("steering-context: 20k chars actor history truncated meta but snapshot.truncated false", () => {
	const longHistory = assistant("z".repeat(20000), [], "stop");
	const target = assistant("done", [], "stop");
	const snap = build([longHistory, target], target, []);
	
	assert.equal(snap.truncated, false, "snapshot.truncated is false for history truncation");
	assert.ok(snap.actorText.length < 20000);
	const historyMeta = snap.representation.history as { truncated: boolean; chars: number };
	assert.equal(historyMeta.truncated, true);
	assert.equal(historyMeta.chars, 20000);
});

test("steering-context: user corrections plus original present for short history", () => {
	const user1 = { role: "user", content: "original request" } as Msg;
	const assistant1 = assistant("attempt 1", [], "stop");
	const user2 = { role: "user", content: "correction: do it differently" } as Msg;
	const target = assistant("done", [], "stop");
	const snap = build([user1, assistant1, user2, target], target, []);
	
	assert.ok(snap.actorText.includes("original request"));
	assert.ok(snap.actorText.includes("correction: do it differently"));
});

test("steering-context: redaction/thinking excluded", () => {
	const msgWithThinking: Msg = { role: "assistant", content: [{ type: "thinking", thinking: "secret thought" }, { type: "text", text: "visible" }] };
	const target = assistant("done", [], "stop");
	const snap = build([msgWithThinking, target], target, []);
	
	assert.ok(!snap.actorText.includes("secret thought"));
	assert.ok(snap.actorText.includes("visible"));
});
