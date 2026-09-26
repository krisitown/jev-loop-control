import test from "node:test";
import assert from "node:assert/strict";
import {
	advanceRecovery,
	beginRecovery,
	createRecovery,
	openConcernKey,
	recoveryEvidenceKey,
	recoveryInstruction,
	resolveConcern,
	type RecoveryMode,
} from "../src/recovery.ts";
import { stableJson } from "../src/redact.ts";
import type { EvidenceSnapshot, SnapshotObservation } from "../src/types.ts";

/**
 * Recovery lease, duplicate suppression, concern lifecycle, and the evidence key
 * that decides whether an intervention is new. Real assertions only: a recovery
 * that cannot be distinguished from a repeat is worse than no recovery at all,
 * and a concern that expiry could silently close would report a finished fix that
 * nobody verified.
 */

let idSeq = 0;

function observation(overrides: Partial<SnapshotObservation> = {}): SnapshotObservation {
	idSeq += 1;
	return {
		id: `E${idSeq}`,
		toolName: "bash",
		toolCallId: `tc-${idSeq}`,
		ok: true,
		provenance: "executed",
		text: "output",
		arguments: { command: "make test" },
		argsHash: "ah-1",
		...overrides,
	};
}

function snapshotOf(observations: SnapshotObservation[]): EvidenceSnapshot {
	return {
		target: { kind: "proposal", proposalHash: "h", messageRef: "m" },
		task: { manifest: false, requirements: [], origin: "R0" },
		actorText: "",
		proposalText: "",
		toolCalls: [],
		observations,
		priorInterventions: [],
		facts: [],
		scope: { sessionId: "s", taskId: "t", branch: "b", snapshotHash: "sh" },
		truncated: false,
		representation: {},
	};
}

function begin(state: ReturnType<typeof createRecovery>, mode: RecoveryMode, focusKey: string, evidenceKey: string, objective = "find the bug", lease = 2): boolean {
	return beginRecovery(state, { mode, objective, focusKey, evidenceKey, at: new Date().toISOString() }, lease);
}

test("lease lasts exactly 2 proposals and then expires", () => {
	const state = createRecovery();
	assert.equal(begin(state, "RESEARCH", "f1", "e1"), true, "first application is accepted");
	assert.equal(state.active?.remainingProposals, 2);

	assert.equal(advanceRecovery(state), false, "the lease is not over after one proposal");
	assert.equal(state.active?.remainingProposals, 1);
	assert.equal(state.history[0]!.status, "active");

	assert.equal(advanceRecovery(state), true, "the second proposal exhausts the lease");
	assert.equal(state.active, null, "nothing stays active past the lease");
	assert.equal(state.history[0]!.status, "expired", "expiry is recorded in history, not silently dropped");
	assert.equal(recoveryInstruction(state), null, "an expired recovery issues no guidance");
});

test("a replaced recovery is marked expired instead of pretending to be active", () => {
	const state = createRecovery();
	begin(state, "RESEARCH", "f1", "e1");
	assert.equal(state.history.filter((entry) => entry.status === "active").length, 1);

	assert.equal(begin(state, "REPLAN", "f2", "e2", "redesign"), true, "a different focus may take over");
	assert.equal(state.active?.focusKey, "f2");
	assert.equal(state.active?.mode, "REPLAN");
	const active = state.history.filter((entry) => entry.status === "active");
	assert.equal(active.length, 1, "exactly one recovery is ever in force");
	assert.deepEqual(active.map((entry) => entry.focus), ["f2"]);
	assert.equal(state.history.find((entry) => entry.focus === "f1")!.status, "expired");
});

test("same focus with the same evidence stays suppressed even after expiry", () => {
	const state = createRecovery();
	begin(state, "RESEARCH", "f1", "e1");
	advanceRecovery(state);
	advanceRecovery(state);
	assert.equal(state.active, null, "the lease really ran out");

	assert.equal(begin(state, "RESEARCH", "f1", "e1"), false, "expiry alone never re-applies the same intervention");
	assert.equal(state.active, null, "a suppressed intervention never becomes active");
});

test("new evidence for the same focus is allowed", () => {
	const state = createRecovery();
	begin(state, "RESEARCH", "f1", "e1");
	assert.equal(begin(state, "RESEARCH", "f1", "e2"), true, "genuinely new evidence re-enables guidance");
	assert.equal(state.active?.evidenceKey, "e2");
});

test("expiry stops the guidance but keeps the concern open for a later outcome", () => {
	const state = createRecovery();
	begin(state, "REPLAN", "f1", "e1");
	assert.equal(openConcernKey(state), "f1", "while in force, the active recovery owns the concern");

	advanceRecovery(state);
	advanceRecovery(state);
	assert.equal(state.active, null, "the lease really ran out");
	assert.equal(recoveryInstruction(state), null, "expired guidance is never injected again");
	assert.equal(openConcernKey(state), "f1", "expiry does not discard the concern's identity");

	assert.equal(resolveConcern(state, "f1"), true, "a grounded RESOLVED answer can still close it");
	assert.equal(state.history[0]!.status, "resolved", "the closed concern is marked, not deleted");
	assert.equal(openConcernKey(state), null, "a resolved concern is no longer open");
	assert.equal(resolveConcern(state, "f1"), false, "nothing resolves twice");
	assert.equal(begin(state, "REPLAN", "f1", "e1"), false, "resolution does not re-arm the duplicate guard");
});

test("a grounded resolution stops an active recovery's guidance at once", () => {
	const state = createRecovery();
	begin(state, "VERIFY", "f1", "e1");
	assert.equal(resolveConcern(state, "f1"), true);
	assert.equal(state.active, null, "resolved guidance is not injected again");
	assert.equal(recoveryInstruction(state), null);
	assert.equal(state.history[0]!.status, "resolved");
	assert.equal(openConcernKey(state), null, "nothing is left to assess");
});

test("the newest concern that nothing resolved owns a later outcome", () => {
	const state = createRecovery();
	begin(state, "RESEARCH", "f1", "e1");
	begin(state, "REPLAN", "f2", "e2");
	assert.equal(openConcernKey(state), "f2", "the recovery in force is the open concern");

	assert.equal(resolveConcern(state, "f2"), true);
	assert.equal(openConcernKey(state), "f1", "a superseded-and-expired concern stays open until resolved");
	assert.equal(resolveConcern(state, "f1"), true);
	assert.equal(openConcernKey(state), null);
});

test("resolving a re-armed focus closes all leases for that same concern", () => {
	const state = createRecovery();
	begin(state, "REPLAN", "same-focus", "e1");
	advanceRecovery(state);
	advanceRecovery(state);
	begin(state, "VERIFY", "same-focus", "e2");
	advanceRecovery(state);
	advanceRecovery(state);

	assert.equal(state.history.filter((entry) => entry.focus === "same-focus" && entry.status !== "resolved").length, 2);
	assert.equal(resolveConcern(state, "same-focus"), true);
	assert.equal(openConcernKey(state), null, "older expired leases for a resolved focus cannot reopen it");
	assert.ok(state.history.every((entry) => entry.status === "resolved"));
});

test("instruction renders mode, objective, and that expiry is not completion", () => {
	const state = createRecovery();
	beginRecovery(state, { mode: "VERIFY", objective: "check the tests", focusKey: "f1", evidenceKey: "e1", at: "t1" }, 2);
	const instruction = recoveryInstruction(state);
	assert.ok(instruction, "an active recovery always renders guidance");
	assert.match(instruction, /\[Recovery: VERIFY\]/);
	assert.ok(instruction.includes("Objective: check the tests"));
	assert.ok(instruction.includes("Stay on the original user task"));
	assert.ok(instruction.includes("Expiry of this guidance does not mean the objective has been met"));
});

test("evidence key ignores ids and times and collapses identical repeated results", () => {
	const base = [observation({ toolName: "read", argsHash: "ah-1", arguments: { path: "/a" }, text: "content" })];
	const replayed = [observation({ toolName: "read", argsHash: "ah-1", arguments: { path: "/a" }, text: "content" })];
	assert.equal(recoveryEvidenceKey(snapshotOf(base)), recoveryEvidenceKey(snapshotOf(replayed)), "event ids are not evidence");

	const repeated = recoveryEvidenceKey(snapshotOf([
		...base,
		observation({ toolName: "read", argsHash: "ah-1", arguments: { path: "/a" }, text: "content" }),
		observation({ toolName: "read", argsHash: "ah-1", arguments: { path: "/a" }, text: "content" }),
	]));
	assert.equal(repeated, recoveryEvidenceKey(snapshotOf(base)), "the same result repeated without new information is not new evidence");

	const changed = recoveryEvidenceKey(snapshotOf([...base, observation({ toolName: "bash", argsHash: "ah-2", arguments: { command: "make test" }, text: "different output" })]));
	assert.notEqual(changed, recoveryEvidenceKey(snapshotOf(base)), "a genuinely different result is new evidence");
});

test("evidence key covers nested arguments with stable key ordering", () => {
	const nested = (extra: Record<string, unknown>, hash: string) => snapshotOf([
		observation({ arguments: { payload: { alpha: 1, beta: ["x", { gamma: 2, delta: extra }] } }, argsHash: hash }),
	]);
	const changedNested = recoveryEvidenceKey(nested({ gamma: 2 }, "ah-2"));
	assert.notEqual(changedNested, recoveryEvidenceKey(nested({ gamma: 3 }, "ah-3")), "a changed nested value changes the key");

	// Key order in the object itself must not matter: the serialization is canonical.
	const reordered = snapshotOf([observation({ arguments: { payload: { beta: [{ delta: {}, gamma: 2 }], alpha: 1 } }, argsHash: "ah-2" })]);
	assert.notEqual(recoveryEvidenceKey(reordered), changedNested, "a changed nested VALUE still changes the key even if order also changed");

	const sameContent = snapshotOf([observation({ arguments: { payload: { alpha: 1, beta: ["x", { delta: {}, gamma: 2 }] } }, argsHash: "ah-2" })]);
	const otherOrder = snapshotOf([observation({ arguments: { payload: { beta: [["x", { delta: {}, gamma: 2 }]], alpha: 1 } }, argsHash: "ah-2" })]);
	assert.notEqual(recoveryEvidenceKey(sameContent), recoveryEvidenceKey(otherOrder), "array order is meaningful and stays meaningful");
	// The canonical form sorts object keys at every depth.
	assert.equal(stableJson({ b: 1, a: { d: 2, c: 1 } }), stableJson({ a: { c: 1, d: 2 }, b: 1 }));
});

test("evidence key ignores observations that never executed", () => {
	const executed = snapshotOf([observation({ argsHash: "ah-1", text: "did work" })]);
	const plusBlocked = snapshotOf([
		observation({ argsHash: "ah-1", text: "did work" }),
		observation({ argsHash: "ah-2", text: "blocked by policy", provenance: "reported_without_execution_event" }),
	]);
	assert.equal(recoveryEvidenceKey(plusBlocked), recoveryEvidenceKey(executed), "a blocked or invalid call is not new evidence");

	const onlyBlocked = snapshotOf([
		observation({ argsHash: "ah-1", text: "did work" }),
		observation({ argsHash: "ah-2", text: "blocked by policy", provenance: "reported_without_execution_event" }),
		observation({ argsHash: "ah-3", text: "blocked again", provenance: "reported_without_execution_event" }),
	]);
	assert.equal(recoveryEvidenceKey(onlyBlocked), recoveryEvidenceKey(executed), "no execution means no progress to reward");
});

test("evidence key summarizes only the most recent executed observations", () => {
	const window = 6;
	const old = Array.from({ length: 10 }, (_unused, index) => observation({ argsHash: `old-${index}`, text: `old ${index}` }));
	const fresh = Array.from({ length: window }, (_unused, index) => observation({ argsHash: `new-${index}`, text: `new ${index}` }));
	const withoutAncient = snapshotOf(fresh);
	const withAncient = snapshotOf([...old, ...fresh]);
	assert.equal(recoveryEvidenceKey(withAncient), recoveryEvidenceKey(withoutAncient), "observations pushed out of the window stop mattering");

	const shifted = snapshotOf([...fresh.slice(1), observation({ argsHash: "newer", text: "newest output" })]);
	assert.notEqual(recoveryEvidenceKey(shifted), recoveryEvidenceKey(withoutAncient), "new work inside the window is detected");
});
