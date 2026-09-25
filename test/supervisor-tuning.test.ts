import assert from "node:assert/strict";
import test from "node:test";
import { buildAssessmentPacket, buildCompletionQuestions, buildCorrectionQuestions, evaluateCorrectionPolicy, LifecycleTracker, shouldScheduleCheckpoint, type EvidenceLedger } from "../src/supervisor-tuning.ts";

function ledger(extra = ""): EvidenceLedger {
	return {
		userGoal: { id: "goal", kind: "requirement", text: "Preserve unicode Ω and required behavior", source: "user", protected: true },
		requirements: [
			{ id: "R-old", kind: "requirement", text: `accept input ${extra}`, source: "turn:1" },
			{ id: "R-new", kind: "requirement", text: "replace old timeout only for network calls", source: "turn:4", supersedes: ["R-old"] },
		],
		proposals: [{ id: "p1", kind: "proposal", text: "change network timeout then run focused test", source: "assistant:8", protected: true, references: ["timeout"] }],
		observations: [
			{ id: "e1", kind: "observation", text: "focused test failed: timeout still old", source: "tool:t1", references: ["timeout"] },
			{ id: "e2", kind: "observation", text: "irrelevant " + "x".repeat(8000), source: "tool:t2" },
		],
		trajectory: [{ id: "t1", kind: "trajectory", text: "old attempt -> failure -> changed proposal", source: "session", references: ["e1", "p1"] }],
	};
}

test("S2 protects exact proposal and relevant units within a serialized-byte target", () => {
	const result = buildAssessmentPacket(ledger(), { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } });
	assert.equal(result.packet.current_proposal?.text, "change network timeout then run focused test");
	assert.ok(result.packet.recent_evidence.some((item) => item.id === "e1"));
	assert.ok(result.packet.trajectory.some((item) => item.id === "t1"));
	assert.ok(result.packet.coverage.omitted_ids.includes("e2"));
	assert.equal(result.tokenCount, null);
	assert.equal(result.tokenCountMethod, "unavailable");
	assert.ok(result.serializedBytes <= 4096);
});

test("missing target is explicit insufficient coverage", () => {
	const result = buildAssessmentPacket(ledger(), { selector: "s1", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "missing" } });
	assert.equal(result.packet.current_proposal, null);
	assert.equal(result.packet.coverage.local, "insufficient");
	assert.equal(result.packet.coverage.unavailable_target, true);
});

test("questions stay intact and expose every retained neutral source id", () => {
	const packet = buildAssessmentPacket(ledger(), { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } }).packet;
	const questions = buildCorrectionQuestions(packet);
	assert.deepEqual(questions.map((q) => q.id), ["correction_needed", "primary_concern", "evidence_anchor", "requirement_focus"]);
	const anchor = questions[2]!;
	assert.ok("e1" in anchor.criteria);
	assert.match(questions[0]!.instructions, /INSUFFICIENT_EVIDENCE/);
});

test("completion distinguishes contradicted from not established", () => {
	const packet = buildAssessmentPacket(ledger(), { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "completion", targetId: "p1" } }).packet;
	const question = buildCompletionQuestions(packet)[0]!;
	assert.equal(question.id, "completion_status");
	assert.deepEqual(Object.keys(question.criteria), ["SUPPORTED", "CONTRADICTED", "NOT_ESTABLISHED"]);
});

test("an open concern receives an independent semantic outcome question", () => {
	const value = ledger();
	value.concerns = [{ id: "c1", kind: "concern", text: "prior timeout contradiction", source: "jev:r1", status: "open" }];
	const packet = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } }).packet;
	const outcome = buildCorrectionQuestions(packet).find((question) => question.id === "concern_outcome");
	assert.deepEqual(Object.keys(outcome?.criteria ?? {}), ["RESOLVED", "PERSISTS", "UNKNOWN"]);
	assert.match(outcome?.instructions ?? "", /acknowledgement alone is not resolution/);
});

test("strong action requires supported grounding and a qualifying concern", () => {
	const base = {
		correction: { choice: "CORRECTION_JUSTIFIED", probabilities: { CORRECTION_JUSTIFIED: .9, NO_CORRECTION_JUSTIFIED: .08, INSUFFICIENT_EVIDENCE: .02 } },
		concern: { choice: "CONTRACT_CONTRADICTION", probabilities: { CONTRACT_CONTRADICTION: .9, NONE: .1 } },
		anchor: { choice: "e1", probabilities: { e1: .8, NONE: .2 } },
		requirement: { choice: "R-new", probabilities: { "R-new": .9, NONE: .1 } },
		availableAnchorIds: ["e1"], availableRequirementIds: ["R-new"],
	};
	const profile = { softThreshold: .62, strongThreshold: .84, softMinGap: .12, strongMinGap: .24, strongConcerns: ["CONTRACT_CONTRADICTION"] };
	assert.equal(evaluateCorrectionPolicy(base, profile).action, "strong");
	assert.equal(evaluateCorrectionPolicy({ ...base, availableAnchorIds: [] }, profile).suppressionReason, "unsupported_grounding");
});

test("productive proposal is not converted into a correction", () => {
	const result = evaluateCorrectionPolicy({
		correction: { choice: "NO_CORRECTION_JUSTIFIED", probabilities: { NO_CORRECTION_JUSTIFIED: .88, CORRECTION_JUSTIFIED: .08, INSUFFICIENT_EVIDENCE: .04 } },
		concern: { choice: "NONE", probabilities: { NONE: .9 } }, anchor: { choice: "NONE", probabilities: { NONE: .9 } },
		availableAnchorIds: [], availableRequirementIds: [],
	}, { softThreshold: .62, strongThreshold: .84, softMinGap: .12, strongMinGap: .24, strongConcerns: [] });
	assert.equal(result.action, "none");
	assert.equal(result.suppressionReason, "already_addressed");
});

test("lifecycle distinguishes queued from delivered and resolved", () => {
	const tracker = new LifecycleTracker();
	for (const stage of ["selected", "applied", "queued"] as const) tracker.record({ concernId: "c1", stage, at: stage });
	assert.equal(tracker.isDelivered("c1"), false);
	tracker.record({ concernId: "c1", stage: "delivered", at: "4" });
	tracker.record({ concernId: "c1", stage: "actor_response", at: "5" });
	assert.equal(tracker.isResolved("c1"), false);
	tracker.record({ concernId: "c1", stage: "resolved", at: "6" });
	assert.equal(tracker.isResolved("c1"), true);
});

test("scheduler uses evidence dedupe, cooldown, and explicit intervals", () => {
	const profile = { proposalEvery: 2, toolResultEvery: 3, completion: true, cooldownCheckpoints: 1 };
	assert.deepEqual(shouldScheduleCheckpoint({ kind: "proposal", ordinal: 2, evidenceHash: "a", checkpointsSinceAssessment: 1 }, profile), { scheduled: true, reason: "proposal_interval" });
	assert.equal(shouldScheduleCheckpoint({ kind: "completion", ordinal: 1, evidenceHash: "a", lastEvidenceHash: "a" }, profile).reason, "duplicate_issue");
});
