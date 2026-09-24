import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, deterministicFacts, isTerminalCandidate, resolveRequirements, snapshotToolCalls, toolCallsOf, visibleText, type Msg } from "../src/evidence.ts";
import { hashJson } from "../src/redact.ts";
import { defaultConfig } from "../src/config.ts";
import type { Requirement } from "../src/types.ts";

/**
 * Evidence regressions. The two honesty rules under test: a toolResult MESSAGE
 * is never execution proof (only the executed-tool `tool_result` hook is), and
 * nothing material is silently truncated.
 */

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

// ------------------------------------------------------------ tool call shape

test("toolCallsOf reads Pi's actual `arguments` field, with `input` only as an old-shape fallback", () => {
	const msg = assistant("doing it", [{ id: "c1", name: "bash", arguments: { command: "make test" } }]);
	const calls = toolCallsOf(msg);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.arguments, { command: "make test" }, "arguments must not silently become {}");
	// Old shape fallback:
	const old: Msg = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c2", name: "read", input: { path: "x" } }] };
	assert.deepEqual(toolCallsOf(old)[0]!.arguments, { path: "x" });
});

test("visibleText excludes thinking blocks and handles string content", () => {
	const msg: Msg = { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text: "shown" }] };
	assert.equal(visibleText(msg), "shown");
	const stringContent: Msg = { role: "user", content: "the original request" };
	assert.equal(visibleText(stringContent), "the original request");
});

test("isTerminalCandidate rejects errors, aborts, truncation, and tool-bearing messages", () => {
	assert.equal(isTerminalCandidate(assistant("done", [], "stop")), true);
	assert.equal(isTerminalCandidate(assistant("partial", [], "length")), false);
	assert.equal(isTerminalCandidate(assistant("", [{ id: "c1", name: "bash" }])), false);
	const errored: Msg = { role: "assistant", stopReason: "error", errorMessage: "boom", content: [{ type: "text", text: "x" }] };
	assert.equal(isTerminalCandidate(errored), false);
});

// ------------------------------------------------------------ requirements

test("manifest: strict, no silent drops; duplicate and reserved ids invalid", () => {
	const good = resolveRequirements({ manifestConfigured: true, manifestText: JSON.stringify({ requirements: [{ id: "R1", summary: "build" }, { id: "R2", description: "test it" }] }), r0Request: "ignored" });
	assert.equal(good.error, null);
	assert.deepEqual(good.requirements.map((r) => [r.id, r.summary]), [["R1", "build"], ["R2", "test it"]]);

	for (const [manifest, needle] of [
		[{ requirements: [{ id: "R1" }] }, "id"],
		[{ requirements: [] }, "requirements"],
		[{ requirements: [{ id: "R1", summary: "a" }, { id: "R1", summary: "dup" }] }, "repeats"],
		[{ requirements: [{ id: "NONE", summary: "collide" }] }, "collides"],
		[{ requirements: [{ id: "__proto__", summary: "x" }] }, "collides|match"],
		[{ requirements: "not a list" }, "requirements"],
		["not json at all", "not valid JSON"],
	] as Array<[unknown, string]>) {
		const bad = resolveRequirements({ manifestConfigured: true, manifestText: typeof manifest === "string" ? manifest : JSON.stringify(manifest), r0Request: "fallback" });
		assert.ok(bad.error !== null, `${JSON.stringify(manifest)} must error`);
		assert.match(bad.error, new RegExp(needle.replace("|", "|")), `error ${bad.error} should match ${needle}`);
		assert.equal(bad.requirements.length, 0, "an invalid manifest never produces a partial or fallback list");
	}
});

test("no manifest configured falls back to the R0 original request only", () => {
	const fallback = resolveRequirements({ manifestConfigured: false, r0Request: "Build a maze game" });
	assert.equal(fallback.error, null);
	assert.deepEqual(fallback.requirements, [{ id: "R1", summary: "Build a maze game", origin: "R0:original-request" }]);
});

// ------------------------------------------------------------ execution proof

test("a toolResult MESSAGE without the executed-tool hook is an observation, never execution", () => {
	const messages = [assistant("running", [{ id: "call-1", name: "bash", arguments: { command: "make test" } }]), toolResult("call-1", "tests pass", { toolName: "bash" })];
	// The hook never fired for call-1 (blocked/invalid call still produces a message).
	const facts = deterministicFacts(messages, new Set<string>(), (t) => t);
	const kinds = facts.map((f) => f.kind);
	assert.ok(kinds.includes("tool_result_without_execution"), kinds.join(","));
	assert.ok(!kinds.includes("tool_executed") && !kinds.includes("tool_error"), "no execution may be claimed without the hook");
	const fact = facts.find((f) => f.kind === "tool_result_without_execution")!;
	assert.equal(fact.subject, "bash");

	// With the executed-tool hook id, the same result becomes an execution receipt.
	const executed = deterministicFacts(messages, new Set(["call-1"]), (t) => t);
	assert.ok(executed.some((f) => f.kind === "tool_executed"));

	// An error result WITH hook proof is an executed failure, not a phantom.
	const failed = deterministicFacts([messages[0]!, toolResult("call-1", "make: Error 2", { isError: true })], new Set(["call-1"]), (t) => t);
	assert.ok(failed.some((f) => f.kind === "tool_error"));
});

test("freshness is unknown unless measured; zero results is stated; secrets scrub from facts", () => {
	const facts = deterministicFacts([toolResult("c1", "token=sk-leakedvalue999")], new Set(["c1"]), (t) => t.replaceAll("sk-leakedvalue999", "[REDACTED]"));
	assert.ok(facts.some((f) => f.kind === "freshness" && f.value.includes("unknown")));
	assert.ok(!JSON.stringify(facts).includes("sk-leakedvalue999"));
	const none = deterministicFacts([assistant("hi", [], "stop")], new Set<string>(), (t) => t);
	assert.ok(none.some((f) => f.kind === "no_execution"));
});

// ------------------------------------------------------------ snapshots

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

test("snapshot: full sanitized arguments of the current proposal, no 400-char summary", () => {
	const hugeArg = "y".repeat(5000);
	const target = assistant("proposal", [{ id: "c1", name: "write", arguments: { content: hugeArg } }]);
	const snap = build([target], target, []);
	assert.equal(snap.toolCalls.length, 1);
	assert.equal((snap.toolCalls[0]!.arguments as { content: string }).content.length, 5000, "arguments are complete, never summarized");
	assert.ok(JSON.stringify(snap.representation).includes(hugeArg), "the representation carries the full arguments the hash describes");
});

test("snapshot: blocked results carry no executed flag but keep provenance and arguments", () => {
	const target = assistant("run", [{ id: "c1", name: "bash", arguments: { command: "make test" } }]);
	const messages = [target, toolResult("c1", "blocked by policy", { toolName: "bash" })];
	const snap = build(messages, target, []); // no hook receipts
	const obs = snap.representation.recent_actions as Array<Record<string, unknown>>;
	assert.equal(obs[0]!.executed, false);
	assert.ok(obs[0]!.arguments, "recent actions keep the observed arguments for repeat detection");
	const snapExecuted = build(messages, target, ["c1"]);
	assert.equal((snapExecuted.representation.recent_actions as Array<Record<string, unknown>>)[0]!.executed, true);
});

test("snapshot: final_answer/proposal text is ONLY the current candidate, history is separate", () => {
	const older = assistant("earlier attempt, it failed", [], "stop");
	const target = assistant("the current candidate", [], "stop");
	const snap = build([older, target], target, []);
	assert.equal(snap.proposalText, "the current candidate");
	assert.ok(snap.actorText.includes("earlier attempt"), "history is a separate bounded field");
	const state = JSON.stringify(snap.representation);
	assert.ok(!state.includes("earlier attempt, it failed\n\nthe current candidate"), "the two are never concatenated into one answer");
});

test("snapshot: omitted evidence ids are honest; redaction and truncation are distinct", () => {
	const messages: Msg[] = [];
	for (let i = 1; i <= 20; i++) {
		// One older error (E7) so both retention rules are exercised at once.
		messages.push(toolResult(`c${i}`, `result ${i}`, { isError: i === 7 }));
	}
	const target = assistant("done", [], "stop");
	messages.push(target);
	const snap = build(messages, target, messages.slice(0, 20).map((_, i) => `c${i + 1}`));
	const omitted = snap.representation.omitted_evidence_ids as string[];
	assert.deepEqual(omitted, ["E1", "E2", "E3", "E4", "E5", "E6", "E8"], "exactly the older, non-retained ids are listed");
	assert.equal(snap.representation.omitted_observation_count, 7);
	assert.equal(snap.observations.length, 13, "12 most recent results plus the one older error");
	assert.ok(snap.observations.some((observation) => observation.id === "E7"), "an older error survives its window");

	// Redaction: the secret leaks nowhere, and the mark is REDACTION, not ELISION.
	const leaky = assistant("used key s3cr3t-key", [{ id: "x", name: "bash", arguments: { apiKey: "s3cr3t-key" } }]);
	const redacted = build([leaky], leaky, []);
	assert.ok(!JSON.stringify(redacted.representation).includes("s3cr3t-key"), "no configured secret survives");
	assert.ok(JSON.stringify(redacted.representation).includes("[REDACTED]"));

	// Bounded HISTORY is context selection recorded on the history itself, with the
	// elision mark. It is not a limitation of the current proposal, so the snapshot
	// flag stays false (see steering-context.test.ts).
	const longHistory = assistant("z".repeat(20000), [], "stop");
	const truncatedSnap = build([longHistory, target], target, []);
	const historyMeta = truncatedSnap.representation.history as { text: string; truncated: boolean; chars: number };
	assert.equal(historyMeta.truncated, true, "history bounds are reported on representation.history");
	assert.equal(historyMeta.chars, 20000, "exact original character count, not the labeled rendering");
	assert.equal(truncatedSnap.truncated, false, "bounded history never claims a truncated proposal");
	assert.ok(truncatedSnap.actorText.includes("[ELIDED]") || truncatedSnap.actorText.includes("characters elided"));
	assert.ok(truncatedSnap.actorText.endsWith("z".repeat(100)), "the MOST RECENT text is kept, not a prefix");
});

test("snapshot: identity hash covers the exact sanitized representation", () => {
	const target = assistant("x", [{ id: "c1", name: "bash", arguments: { apiKey: "s3cr3t-key", cmd: "ls" } }]);
	const snap = build([target], target, []);
	const rep = snap.representation;
	delete (rep as { snapshotHash?: string }).snapshotHash;
	// The stored hash equals a hash of the representation itself (recomputable by an auditor).
	assert.equal(snap.scope.snapshotHash, hashJson(rep));
});

test("snapshot: historical arguments are bounded to a 600-char summary, current proposal arguments stay full", () => {
	const secretPayload = "q".repeat(4000);
	const older = assistant("earlier", [{ id: "old-1", name: "write", arguments: { path: "a.ts", content: secretPayload } }]);
	const olderResult = toolResult("old-1", "wrote a.ts");
	const target = assistant("now", [{ id: "new-1", name: "write", arguments: { path: "b.ts", content: secretPayload } }]);
	const snap = build([older, olderResult, target], target, ["old-1"]);

	// The proposal's own arguments: complete, never summarized.
	const proposalArgs = snap.toolCalls[0]!.arguments as { content: string };
	assert.equal(proposalArgs.content.length, 4000, "the current proposal keeps full arguments");
	assert.ok(JSON.stringify(snap.representation.proposal).includes(secretPayload), "and the representation carries them in full");

	// The historical call: bounded summary, original hash retained.
	const action = (snap.representation.recent_actions as Array<Record<string, any>>)[0]!;
	assert.equal(action.arguments_truncated, true);
	assert.ok(action.arguments._summary.length <= 600, `summary is bounded, got ${action.arguments._summary.length}`);
	assert.ok(!JSON.stringify(action).includes(secretPayload), "the full historical payload is not sent twice");
	assert.equal(action.arguments_chars, action.arguments._original_chars);
	// The hash is of the ORIGINAL arguments, so a repeat is still detected exactly.
	assert.equal(action.arguments_hash, hashJson({ path: "a.ts", content: secretPayload }));
	assert.notEqual(action.arguments_hash, hashJson({ _summary: action.arguments._summary }));
	assert.equal((snap.representation.context_selection as { arguments_truncated_count: number }).arguments_truncated_count, 1);
});

test("snapshot: result truncation metadata is keyed by evidence id, never by a redacted tool-call id", () => {
	// The tool-call id itself carries the secret, so a lookup of the raw message by
	// the REDACTED id would miss and report 0 chars for a 3000-char result.
	const long = "r".repeat(3000);
	const leakyId = "call-s3cr3t-key-1";
	const messages = [assistant("run", [{ id: leakyId, name: "bash", arguments: { command: "make test" } }]), toolResult(leakyId, long)];
	const target = assistant("done", [], "stop");
	messages.push(target);
	const snap = build(messages, target, [leakyId]);

	const meta = (snap.representation.context_selection as { truncation_metadata: Array<Record<string, any>> }).truncation_metadata;
	assert.equal(meta.length, snap.observations.length, "metadata covers exactly the retained observations");
	assert.deepEqual(meta.map((entry) => entry.id), snap.observations.map((observation) => observation.id), "keyed by EID");
	assert.equal(meta[0]!.truncated, true);
	assert.equal(meta[0]!.originalChars, 3000, "raw length is known without looking the message up by redacted id");
	assert.equal(meta[0]!.retainedChars, 2000, "retained text is exactly the stated bound");
	assert.equal(snap.observations[0]!.text.length, 2000);
	assert.ok(!JSON.stringify(snap.representation).includes("s3cr3t-key"), "the id is redacted everywhere");
	assert.equal(meta[0]!.tool_call_id, "call-[REDACTED]-1");
	assert.equal(snap.truncated, false, "bounded results are context selection, not a truncated proposal");
});

test("snapshot: bounded history keeps the MOST RECENT turns and states exact original chars", () => {
	const turns: Msg[] = [];
	for (let i = 1; i <= 6; i++) {
		turns.push(assistant(`turn ${i} ${"m".repeat(4000)}`, [], "stop"));
	}
	const target = assistant("done", [], "stop");
	const snap = build([...turns, target], target, []);
	const history = snap.representation.history as { text: string; truncated: boolean; chars: number; elided_chars: number; turns: number; turns_omitted: number };

	assert.equal(history.truncated, true);
	assert.equal(history.chars, 6 * (7 + 4000), "exact original content chars: 6 turns x (`turn N ` + 4000)");
	assert.equal(snap.truncated, false, "a bounded transcript is not a truncated proposal");
	assert.ok(snap.actorText.length <= config.limits.maxEvidenceChars, "the bound is honored by the bytes");
	assert.ok(snap.actorText.includes("turn 6"), "newest text survives");
	assert.ok(!snap.actorText.includes("turn 1 "), "oldest text is what gets dropped");
	assert.ok(snap.actorText.includes("characters elided"));
	assert.ok(history.elided_chars > 0 && history.turns_omitted > 0);
});

test("snapshotToolCalls: names and argument strings are scrubbed before hashing", () => {
	const target = assistant("t", [{ id: "c1", name: "bash", arguments: { cmd: "echo s3cr3t-key" } }]);
	const calls = snapshotToolCalls(target, (t) => t.replaceAll("s3cr3t-key", "[REDACTED]"));
	assert.ok(!JSON.stringify(calls).includes("s3cr3t-key"));
	assert.equal(calls[0]!.argsHash.length, 16);
});
