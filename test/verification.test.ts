import test from "node:test";
import assert from "node:assert/strict";
import {
	invokesPythonUnittest,
	parseUnittestOutput,
	parseVerification,
	selectVerificationChecks,
	verificationCheckEntry,
	VERIFICATION_CHECKS_LIMIT,
	VERIFICATION_SUMMARY_CHARS,
	type VerificationCheckEntry,
} from "../src/verification.ts";
import { buildSnapshot, type Msg } from "../src/evidence.ts";
import { buildState } from "../src/questions.ts";
import { defaultConfig } from "../src/config.ts";
import { hashJson } from "../src/redact.ts";
import type { Requirement } from "../src/types.ts";

/**
 * Verification evidence: tool STATUS and check OUTCOME are different facts, and
 * a check outcome is only ever read from the output of an actually executed
 * Python unittest command. Nothing here certifies an implementation: it reports
 * what a reported check said, or says nothing.
 */

const PASSED_OUTPUT = [
	"...",
	"----------------------------------------------------------------------",
	"Ran 3 tests in 0.021s",
	"",
	"OK",
].join("\n");

const FAILED_PIPE_OUTPUT = [
	"test_login (tests.TestAuth.test_login) ... FAIL",
	"",
	"======================================================================",
	"FAIL: test_login (tests.TestAuth.test_login)",
	"----------------------------------------------------------------------",
	"Traceback (most recent call last):",
	"  File \"tests.py\", line 12, in test_login",
	"    self.assertEqual(status, 200)",
	"AssertionError: 401 != 200",
	"",
	"----------------------------------------------------------------------",
	"Ran 4 tests in 0.108s",
	"",
	"FAILED (failures=1)",
].join("\n");

const UNittest_CMD = "python3 -m unittest discover -s tests";

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

function checks(snap: ReturnType<typeof build>): Array<Record<string, any>> {
	return (snap.representation.verification_checks ?? []) as Array<Record<string, any>>;
}

// ------------------------------------------------- parse: executed pipelines

test("parse: executed unittest pipeline that printed FAILED is a failed verification", () => {
	const result = parseVerification("bash", "python3 -m unittest discover -s tests 2>&1 | tail -40", { text: FAILED_PIPE_OUTPUT, executed: true });
	assert.ok(result && "record" in result, "the trailer is a real run's trailer");
	assert.equal(result.record.outcome, "failed");
	assert.equal(result.record.testsRun, 4);
	assert.equal(result.record.framework, "unittest");
	assert.equal(result.record.basis, "observed_output");
	assert.match(result.record.summary, /FAILED \(failures=1\)/);
	assert.match(result.record.summary, /Ran 4 tests/);
});

test("parse: passed trailer is a passed verification with the counts unchanged", () => {
	const result = parseVerification("bash", UNittest_CMD, { text: PASSED_OUTPUT, executed: true });
	assert.ok(result && "record" in result);
	assert.equal(result.record.outcome, "passed");
	assert.equal(result.record.testsRun, 3);
});

test("parse: tests must be invoked through python -m unittest, in any common shell shape", () => {
	const commands = [
		"python3 -m unittest",
		"/usr/local/bin/python3 -m unittest",
		"python -m unittest tests.test_x",
		"python3.13 -m unittest discover",
		"cd /repo/app && python3 -m unittest",
		"cd /repo && python3 -m unittest 2>&1 | tail -40",
		"make lint && python3 -m unittest || true",
		"python3 -m unittest -v 2>&1",
	];
	for (const command of commands) {
		assert.equal(invokesPythonUnittest(command), true, command);
		const parsed = parseVerification("bash", command, { text: PASSED_OUTPUT, executed: true });
		assert.ok(parsed && "record" in parsed, `${command} classifies`);
		assert.equal(parsed.record.outcome, "passed");
	}
});

test("parse: plain OK (skipped=1) is reported passed, not a broad completion claim", () => {
	const text = PASSED_OUTPUT.replace("OK", "OK (skipped=1)");
	const result = parseVerification("bash", UNittest_CMD, { text, executed: true });
	assert.ok(result && "record" in result);
	assert.equal(result.record.outcome, "passed");
	assert.equal(result.record.testsRun, 3);
	assert.match(result.record.summary, /OK \(skipped=1\)/);
});

test("parse: pytest-style or non-unittest invocations are never classified", () => {
	assert.equal(invokesPythonUnittest("pytest -q"), false);
	assert.equal(invokesPythonUnittest("python3 -m pytest"), false);
	assert.equal(invokesPythonUnittest("npm test"), false);
	assert.equal(invokesPythonUnittest("python3 -c 'import unittest; print(\"Ran 3 tests in 0.1s\\nOK\")'"), false, "a -c payload is not a command line");
	for (const command of ["pytest -q", "python3 -m pytest 2>&1 | tail -40", "npm test"]) {
		assert.equal(parseVerification("bash", command, { text: FAILED_PIPE_OUTPUT, executed: true }), null);
	}
});

// ------------------------------------------------- parse: what must NOT match

test("parse: no trailer, malformed trailer, or a trailer with trailing output is no verification", () => {
	const cases: Array<[string, string]> = [
		["empty", ""],
		["plain output", "build ok\nnothing ran"],
		["OK without Ran", "all fine\n\nOK"],
		["Ran without verdict", "Ran 5 tests in 0.2s\n"],
		["non-blank between Ran and OK", "Ran 5 tests in 0.2s\nnoise\nOK"],
		["output after the trailer", `${PASSED_OUTPUT}\nrm: something else`],
		["bare FAILED without counts", "Ran 2 tests in 0.1s\n\nFAILED"],
		["OK carrying failures", "Ran 2 tests in 0.1s\n\nOK (failures=1)"],
	];
	for (const [name, text] of cases) {
		assert.equal(parseVerification("bash", UNittest_CMD, { text, executed: true }), null, name);
	}
});

test("parse: trailers mentioned in read/source output are not verification", () => {
	const sourceListing = [
		"{",
		"  \"note\": \"Ran 9 tests in 1.0s\",",
		"  \"verdict\": \"OK\",",
		"}",
		"README says: \"Ran 9 tests in 1.0s\\n\\nOK\" is printed on success",
	].join("\n");
	// A read of a file that merely contains the trailer text.
	assert.equal(parseVerification("read", UNittest_CMD, { text: sourceListing, executed: true }), null, "only bash is a candidate");
	// Same text through bash with a unittest command: the trailer is not the LAST
	// non-blank line, so the final-trailer rule rejects it.
	assert.equal(parseVerification("bash", UNittest_CMD, { text: sourceListing, executed: true }), null);
	// A tool result without the executed hook proves nothing.
	assert.equal(parseVerification("bash", UNittest_CMD, { text: FAILED_PIPE_OUTPUT, executed: false }), null);
	assert.equal(parseVerification("bash", "cat run.log", { text: FAILED_PIPE_OUTPUT, executed: true }), null, "catting a log is not running tests");
});

test("parse: zero tests is unknown, never a passed suite", () => {
	const text = "----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nOK";
	const result = parseVerification("bash", UNittest_CMD, { text, executed: true });
	assert.ok(result && !("record" in result));
	assert.equal(result.unknown, "zero_tests");
});

test("parse: multiple or conflicting trailers are unknown rather than guessed", () => {
	const text = ["Ran 3 tests in 0.01s", "", "OK", "Ran 7 tests in 0.02s", "", "FAILED (failures=2)"].join("\n");
	const result = parseVerification("bash", UNittest_CMD, { text, executed: true });
	assert.ok(result && !("record" in result));
	assert.equal(result.unknown, "multipleTrailers");
});

test("parse: a known echo/printf of a summary is not a test run", () => {
	const echoed = "Ran 3 tests in 0.021s\n\nOK";
	assert.equal(parseVerification("bash", "echo \"Ran 3 tests in 0.021s\\n\\nOK\"", { text: echoed, executed: true }), null);
	assert.equal(parseVerification("bash", "printf 'Ran 3 tests in 0.021s\\n\\nOK\\n'", { text: echoed, executed: true }), null);
	assert.equal(invokesPythonUnittest("echo \"Ran 3 tests in 0.021s\""), false, "echoing is not invoking unittest");
	// A real run's shapes (progress dots, per-test FAIL block) are never second-guessed.
	const dots = "test_a (t.A.test_a) ... ok\ntest_b (t.A.test_b) ... ok\n----------------------------------------------------------------------\nRan 2 tests in 0.003s\n\nOK";
	const viaEchoShape = parseUnittestOutput(dots, { command: "sh -c 'echo hi && python3 -m unittest'" });
	assert.ok(viaEchoShape && "record" in viaEchoShape);
});

// ------------------------------------------------- evidence integration

test("evidence: pipeline FAILED while the tool flag stays ok=true; result says tool_completed", () => {
	const run = assistant("running", [{ id: "c1", name: "bash", arguments: { command: `${UNittest_CMD} 2>&1 | tail -40` } }]);
	const target = assistant("next", [{ id: "c2", name: "bash", arguments: { command: "ls" } }]);
	const snap = build([run, toolResult("c1", FAILED_PIPE_OUTPUT, { isError: false }), target], target, ["c1"]);

	const obs = snap.observations[0]!;
	assert.equal(obs.ok, true, "the tool's own error flag is never rewritten");
	assert.equal(obs.verification?.outcome, "failed", "the reported check outcome is separate");
	assert.equal(obs.verification?.testsRun, 4);
	assert.equal(obs.verification?.basis, "observed_output");

	const action = (snap.representation.recent_actions as Array<Record<string, any>>)[0]!;
	assert.equal(action.result, "tool_completed", "tool status, not a test verdict");
	assert.equal(action.test_outcome, "failed");
	assert.equal(action.tests_run, 4);
	assert.equal(action.executed, true);
});

test("evidence: a genuine tool error still says tool_error and is not a verification", () => {
	const run = assistant("run", [{ id: "c1", name: "bash", arguments: { command: "python3 -m unittest" } }]);
	const target = assistant("next", [], "stop");
	const snap = build([run, toolResult("c1", "ModuleNotFoundError: No module named 'x'", { isError: true }), target], target, ["c1"]);
	const action = (snap.representation.recent_actions as Array<Record<string, any>>)[0]!;
	assert.equal(action.result, "tool_error");
	assert.ok(!("test_outcome" in action), "no trailer means no check outcome is asserted");
	assert.equal(snap.observations[0]!.verification, undefined);
});

test("evidence: no verification without the executed hook or without a unittest command", () => {
	const run = assistant("run", [{ id: "c1", name: "bash", arguments: { command: UNittest_CMD } }]);
	const target = assistant("next", [], "stop");
	// Result message exists, the executed-tool hook never fired.
	const blocked = build([run, toolResult("c1", FAILED_PIPE_OUTPUT), target], target, []);
	assert.equal(blocked.observations[0]!.verification, undefined, "a result message is not execution proof");
	assert.equal(checks(blocked).length, 0);
	// Executed, but the command never invoked unittest.
	const cat = assistant("run", [{ id: "c2", name: "bash", arguments: { command: "cat last_run.log" } }]);
	const readSnap = build([cat, toolResult("c2", FAILED_PIPE_OUTPUT), target], target, ["c2"]);
	assert.equal(readSnap.observations[0]!.verification, undefined);
});

test("evidence: verification_checks keeps the latest record per exact command, in chronological order", () => {
	const failCmd = "python3 -m unittest discover -s tests 2>&1 | tail -40";
	const otherCmd = "python3 -m unittest tests.test_smoke";
	const messages: Msg[] = [];
	const executed: string[] = [];
	const add = (index: number, command: string, text: string) => {
		messages.push(assistant(`step ${index}`, [{ id: `c${index}`, name: "bash", arguments: { command } }]));
		messages.push(toolResult(`c${index}`, text));
		executed.push(`c${index}`);
	};
	add(1, failCmd, FAILED_PIPE_OUTPUT);
	add(2, otherCmd, PASSED_OUTPUT);
	add(3, failCmd, PASSED_OUTPUT);
	const target = assistant("next", [], "stop");
	messages.push(target);
	const snap = build(messages, target, executed);

	const list = checks(snap);
	assert.equal(list.length, 2, "the superseded run of the identical command is not listed twice");
	assert.deepEqual(list.map((entry) => entry.evidence_id), ["E2", "E3"], "chronological order: B first, then the latest record of A");
	assert.deepEqual(list.map((entry) => entry.outcome), ["passed", "passed"], "chronological order, latest per command");
	assert.deepEqual(list.map((entry) => entry.testsRun), [3, 3]);
	assert.equal(list[1]!.evidence_id, "E3", "the newest record of that exact command is the active one");
	assert.equal(list[1]!.command, failCmd);
	assert.equal(list[1]!.args_hash, hashJson({ command: failCmd }));
	assert.equal(list[1]!.basis, "observed_output");
	assert.match(list[1]!.source, /executed/);
	assert.deepEqual(selectVerificationChecks(list as never, 1).map((entry) => (entry as Record<string, any>).evidence_id), ["E3"], "limit 1 keeps the latest superseding record, never the first-inserted one");
	assert.equal(snap.observations[0]!.verification?.outcome, "failed", "the older FAILED record is still visible as history");
});

test("evidence: zero-test, malformed, and non-executed fixtures produce no checks at all", () => {
	const zero = "Ran 0 tests in 0.000s\n\nOK";
	const messages = [
		assistant("a", [{ id: "z1", name: "bash", arguments: { command: UNittest_CMD } }]),
		toolResult("z1", zero),
		assistant("b", [{ id: "z2", name: "bash", arguments: { command: "python3 -m unittest" } }]),
		toolResult("z2", "Ran 3 tests in 0.1s\nmaybe\nOK"),
		assistant("c", [{ id: "z3", name: "bash", arguments: { command: UNittest_CMD } }]),
		toolResult("z3", FAILED_PIPE_OUTPUT),
		assistant("next", [], "stop"),
	];
	const snap = build(messages, messages.at(-1), ["z1", "z2"]);
	assert.equal(checks(snap).length, 0, "zero tests, malformed trailers, and hook-less results stay unclassified");
	assert.equal(snap.observations[0]!.verification, undefined);
});

test("evidence: summaries are bounded, redacted, and never duplicate the unbounded source", () => {
	const huge = "F".repeat(5000);
	const noisy = `FAIL: test_big (t.T.test_big)\n${huge}\n\n----------------------------------------------------------------------\nRan 2 tests in 0.1s\n\nFAILED (failures=1)`;
	const messages = [
		assistant("run", [{ id: "h1", name: "bash", arguments: { command: "python3 -m unittest 2>&1 | tail -400" } }]),
		toolResult("h1", noisy),
		assistant("next", [], "stop"),
	];
	const snap = build(messages, messages.at(-1), ["h1"]);
	const entry = checks(snap)[0]!;
	assert.ok(entry.summary.length <= VERIFICATION_SUMMARY_CHARS, `summary bounded, got ${entry.summary.length}`);
	assert.ok(!JSON.stringify(entry).includes(huge), "the raw output is not copied into the check record");
	// Only the bounded observation text (already capped) may carry the block, so
	// no unbounded second copy of the source is stored anywhere.
	assert.ok(!JSON.stringify(snap.representation.verification_checks).includes(huge), "the check record stays a bounded summary");
	assert.ok(!JSON.stringify(snap.representation.verification_checks).includes("s3cr3t-key"));

	// Secrets inside the failure block are redacted like everything else, even
	// though the trailer itself must be parsed from RAW output.
	const leaky = `FAIL: test_key (t.T.test_key)\nAssertionError: apiKey: s3cr3t-key != 200\n\n----------------------------------------------------------------------\nRan 1 test in 0.1s\n\nFAILED (failures=1)`;
	const leakyMessages = [
		assistant("run", [{ id: "s1", name: "bash", arguments: { command: UNittest_CMD } }]),
		toolResult("s1", leaky),
		assistant("next", [], "stop"),
	];
	const leakySnap = build(leakyMessages, leakyMessages.at(-1), ["s1"]);
	assert.ok(leaky.includes("s3cr3t-key"), "the fixture really carried the configured secret");
	assert.ok(!JSON.stringify(leakySnap.representation).includes("s3cr3t-key"), "no configured secret survives anywhere");
	assert.ok(checks(leakySnap).length === 1, "and the failing trailer was still recognized");
	// The summary is summarized from the RAW text (parsing must see the real
	// trailer), so it is scrubbed again before storage.
	assert.ok(!checks(leakySnap)[0]!.summary.includes("s3cr3t-key"), "the stored summary keeps no secret");
	assert.ok(!JSON.stringify((leakySnap.observations[0] as { verification?: { summary: string } }).verification).includes("s3cr3t-key"), "the observation's verification stays redacted too");
});

test("evidence: older failed verifications are retained outside the recent window, as verifications", () => {
	const messages: Msg[] = [];
	const executed: string[] = [];
	// E1: an executed unittest failure with no tool error (piped run).
	messages.push(assistant("run tests", [{ id: "c0", name: "bash", arguments: { command: "python3 -m unittest" } }]));
	messages.push(toolResult("c0", FAILED_PIPE_OUTPUT));
	executed.push("c0");
	for (let i = 1; i <= 20; i++) {
		messages.push(assistant(`step ${i}`, [{ id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }]));
		messages.push(toolResult(`c${i}`, `out ${i}`));
		executed.push(`c${i}`);
	}
	const target = assistant("next", [], "stop");
	messages.push(target);
	const snap = build(messages, target, executed);

	assert.equal(snap.representation.omitted_observation_count, 8, "only non-signal results drop out of the 12-result window");
	assert.ok(snap.observations.some((observation) => observation.id === "E1"), "the older failed verification survives");
	const action = (snap.representation.recent_actions as Array<Record<string, any>>).find((entry) => entry.evidence_id === "E1")!;
	assert.equal(action.result, "tool_completed", "it is retained as a verification, never reported as a tool_error");
	assert.equal(action.test_outcome, "failed");
});

test("state: evidence.verification_checks renders the canonical records and hashes consistently", () => {
	const messages = [
		assistant("run", [{ id: "c1", name: "bash", arguments: { command: "python3 -m unittest 2>&1 | tail -40" } }]),
		toolResult("c1", FAILED_PIPE_OUTPUT),
		assistant("next", [{ id: "c2", name: "bash", arguments: { command: "ls" } }]),
	];
	const snap = build(messages, messages.at(-1), ["c1"]);
	const state = buildState({
		kind: "direction",
		snapshot: snap,
		proposalId: "p1",
		controller: { workMode: "EXECUTE", proposalNumber: 1, interventionsUsed: 0, interventionLimit: null, previousInterventions: [] },
	});
	const evidence = state.evidence as Record<string, any>;
	assert.deepEqual(evidence.verification_checks, checks(snap), "the state renders the exact canonical values");
	assert.equal(evidence.verification_checks[0]!.command, "python3 -m unittest 2>&1 | tail -40", "the exact command is present to reason about");
	// The same raw evidence must hash consistently, and verification must add no
	// second unbounded copy of the source output.
	const raw = (snap.observations[0] as { text: string }).text;
	assert.ok(raw.includes("FAILED (failures=1)"), "the retained observation text holds the one raw copy");
	assert.ok(checks(snap)[0]!.summary.includes("FAILED (failures=1)"), "and the check record summarizes it, bounded");
	assert.ok(checks(snap)[0]!.summary.length < raw.length, "the check record is strictly smaller than the source");
	const stateJson = JSON.stringify(state);
	assert.equal(stateJson.split(snap.proposalText).length - 1, 1, "the proposal text appears exactly once in the state");
	assert.ok(!stateJson.includes("earlier attempt"), "nothing outside the snapshot is added to the state");
	// Same raw evidence hashes the same way, twice over.
	const again = build(messages, messages.at(-1), ["c1"]);
	assert.equal(snap.scope.snapshotHash, again.scope.snapshotHash);
	assert.equal(hashJson(snap.representation), hashJson(again.representation));
	// A verification record changes the identity hash: it is part of the evidence.
	const withoutHook = build(messages, messages.at(-1), []);
	assert.notEqual(snap.scope.snapshotHash, withoutHook.scope.snapshotHash);
});

test("selectors: limit is newest-first, keeps order, and never infers a supersession across commands", () => {
	const entry = (id: string, argsHash: string, outcome: "passed" | "failed"): VerificationCheckEntry => verificationCheckEntry({
		evidenceId: id,
		toolCallId: `call-${id}`,
		command: `python3 -m unittest ${id}`,
		commandChars: 600,
		argsHash,
		record: { framework: "unittest", outcome, testsRun: 2, summary: `Ran 2 tests OK (${id})`, basis: "observed_output" },
	});
	const many = Array.from({ length: 8 }, (_, index) => entry(`E${index + 1}`, `hash-${index % 8}`, index % 2 === 0 ? "passed" : "failed"));
	const selected = selectVerificationChecks(many);
	assert.equal(selected.length, VERIFICATION_CHECKS_LIMIT);
	assert.deepEqual(selected.map((e) => e.evidence_id), ["E5", "E6", "E7", "E8"], "most recent, chronological");
	// Selecting the latest per hash keeps CHRONOLOGICAL order: A(fail), B(pass),
	// A(pass) yields B then the latest A, and limit 1 returns the latest A.
	const dupes = selectVerificationChecks([entry("A", "h", "failed"), entry("B", "k", "passed"), entry("A2", "h", "passed")]);
	assert.deepEqual(dupes.map((e) => e.evidence_id), ["B", "A2"], "the latest record of A moves to its chronological place");
	assert.deepEqual(selectVerificationChecks([entry("A", "h", "failed"), entry("B", "k", "passed"), entry("A2", "h", "passed")], 1).map((e) => e.evidence_id), ["A2"], "limit 1 returns the latest A, never the superseded first one");
	// Different commands are simply different records; nothing re-labels an older one.
	const mixed = selectVerificationChecks([entry("E1", "same", "failed"), entry("E2", "other", "passed")]);
	assert.deepEqual(mixed.map((e) => [e.evidence_id, e.outcome]), [["E1", "failed"], ["E2", "passed"]]);
});

test("parse: malformed FAILED trailer with progress dots is null even with Ran trailer", () => {
	const malformed = [
		"test_a (t.A.test_a) ... ok",
		"test_b (t.A.test_b) ... FAIL",
		"",
		"======================================================================",
		"FAIL: test_b (t.A.test_b)",
		"----------------------------------------------------------------------",
		"Traceback (most recent call last):",
		"  File \"tests.py\", line 12, in test_b",
		"    self.assertEqual(status, 200)",
		"AssertionError: 401 != 200",
		"",
		"----------------------------------------------------------------------",
		"Ran 2 tests in 0.1s",
		"",
		"FAILED(nonsense)",
	].join("\n");

	const run = assistant("run", [{ id: "c1", name: "bash", arguments: { command: UNittest_CMD } }]);
	const target = assistant("next", [], "stop");
	const snap = build([run, toolResult("c1", malformed), target], target, ["c1"]);

	assert.equal(snap.observations[0]!.verification, undefined, "malformed FAILED trailer yields no verification record");
});

test("evidence: observation retention keeps latest 2 of 4 older problematic observations plus 12 new successful ones", () => {
	const messages: Msg[] = [];
	const executed: string[] = [];

	// Create 4 older problematic observations
	// E1: actual tool error
	messages.push(assistant("run tests 1", [{ id: "c1", name: "bash", arguments: { command: "python3 -m unittest" } }]));
	messages.push(toolResult("c1", "ModuleNotFoundError: No module named 'x'", { isError: true }));
	executed.push("c1");

	// E2: unittest failed verification with tool ok
	messages.push(assistant("run tests 2", [{ id: "c2", name: "bash", arguments: { command: UNittest_CMD } }]));
	messages.push(toolResult("c2", FAILED_PIPE_OUTPUT, { isError: false }));
	executed.push("c2");

	// E3: actual tool error
	messages.push(assistant("run tests 3", [{ id: "c3", name: "bash", arguments: { command: "python3 -m unittest" } }]));
	messages.push(toolResult("c3", "SyntaxError: invalid syntax", { isError: true }));
	executed.push("c3");

	// E4: unittest failed verification with tool ok
	messages.push(assistant("run tests 4", [{ id: "c4", name: "bash", arguments: { command: UNittest_CMD } }]));
	messages.push(toolResult("c4", FAILED_PIPE_OUTPUT, { isError: false }));
	executed.push("c4");

	// Create 12 new successful normal observations
	for (let i = 5; i <= 16; i++) {
		messages.push(assistant(`step ${i}`, [{ id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }]));
		messages.push(toolResult(`c${i}`, `out ${i}`));
		executed.push(`c${i}`);
    }

    const target = assistant("next", [], "stop");
    messages.push(target);
    const snap = build(messages, target, executed);

    // Assert total retained observations is 14 (2 older + 12 new)
    assert.equal(snap.observations.length, 14, `expected 14 retained observations, got ${snap.observations.length}`);

    // Assert retained older IDs are latest 2 of the four (E3 and E4)
    const retainedIds = snap.observations.map((obs) => obs.id);
    assert.ok(retainedIds.includes("E3"), "E3 should be retained as it is one of the latest 2 problematic observations");
    assert.ok(retainedIds.includes("E4"), "E4 should be retained as it is one of the latest 2 problematic observations");
    assert.ok(!retainedIds.includes("E1"), "E1 should be omitted as it is not among the latest 2 problematic observations");
    assert.ok(!retainedIds.includes("E2"), "E2 should be omitted as it is not among the latest 2 problematic observations");
});
