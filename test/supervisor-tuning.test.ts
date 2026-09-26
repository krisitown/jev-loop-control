import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import { buildRequestBody } from "../src/jev.ts";
import { buildAssessmentPacket, buildCompletionQuestions, buildCorrectionQuestions, decideCorrectionAssessment, evaluateCorrectionPolicy, ledgerFromSnapshot, LifecycleTracker, shouldScheduleCheckpoint, type EvidenceLedger } from "../src/supervisor-tuning.ts";
import type { Answer, Assessment, EvidenceSnapshot } from "../src/types.ts";

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
	assert.ok("p1" in anchor.criteria, "the exact proposal can anchor a proposal-versus-contract concern");
	assert.ok("e1" in anchor.criteria);
	assert.match(questions[0]!.instructions, /INSUFFICIENT_EVIDENCE/);
});

test("a goal reference absent from the ledger remains unresolved and cannot ground a contract block", () => {
	const value = ledger();
	value.userGoal.references = ["absent"];
	value.requirements = [];
	const packet = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } }).packet;
	assert.deepEqual(packet.coverage.unresolved_requirement_refs, ["absent"]);
	const focus = buildCorrectionQuestions(packet).find((question) => question.id === "requirement_focus")!;
	assert.equal("USER_GOAL" in focus.criteria, false);
	const result = evaluateCorrectionPolicy({
		correction: { choice: "CORRECTION_JUSTIFIED", probabilities: { CORRECTION_JUSTIFIED: .92, NO_CORRECTION_JUSTIFIED: .05, INSUFFICIENT_EVIDENCE: .03 } },
		concern: { choice: "CONTRACT_CONTRADICTION", probabilities: { CONTRACT_CONTRADICTION: .9, NONE: .1 } },
		anchor: { choice: "p1", probabilities: { p1: .9, NONE: .1 } },
		requirement: { choice: "USER_GOAL", probabilities: { USER_GOAL: .9, NONE: .1 } },
		availableAnchorIds: ["p1"], availableRequirementIds: [],
	}, { softThreshold: .62, strongThreshold: .84, softMinGap: .12, strongMinGap: .24, strongConcerns: ["CONTRACT_CONTRADICTION"] });
	assert.equal(result.action, "none");
	assert.equal(result.suppressionReason, "unsupported_grounding");
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
	const diffuseAuxiliary = {
		...base,
		concern: { choice: "CONTRACT_CONTRADICTION", probabilities: { CONTRACT_CONTRADICTION: .31, CONTRADICTED_DIAGNOSIS: .29, NONE: .2, INSUFFICIENT_EVIDENCE: .2 } },
		anchor: { choice: "e1", probabilities: { e1: .4, e2: .35, NONE: .15, UNKNOWN: .1 } },
	};
	const downgraded = evaluateCorrectionPolicy(diffuseAuxiliary, profile);
	assert.equal(downgraded.action, "soft", "ambiguous auxiliary selections cannot hard-block");
	assert.equal(downgraded.strongGrounding, false);
});

test("protected material that exceeds the target stays whole and reports oversize", () => {
	const value = ledger();
	value.proposals[0]!.text = `start-${"λ".repeat(10_000)}-end`;
	const result = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } });
	assert.equal(result.overSoftTarget, true);
	assert.equal(result.packet.current_proposal?.text, value.proposals[0]!.text);
	assert.doesNotMatch(result.serialized, /clipped|elided/);
});

test("B8-sized adapter resolves compact goal references before contract grounding", () => {
	const stories = Array.from({ length: 40 }, (_, index) => {
		const number = index + 1;
		return `# Story ${number}\nRequirement ${number}: preserve behavior ${number}; ${`detail-${number} `.repeat(75)}`;
	});
	const specification = `# RelayBoard campaign — batch 08\n\nBaseline HTTP contract.\n\n${stories.join("\n\n")}`;
	const actorGoal = "Implement the supplied RelayBoard batch specification in the current project. Work autonomously and run meaningful tests.";
	const config = defaultConfig();
	config.tuning.enabled = true;
	// Exact adapter shape measured from the frozen B8 campaign: context compaction
	// retained the actor objective and replaced the 37KB BASE source with this ref.
	const compactGoal = `${actorGoal}\n\nSPECIFICATION:\n[See task.requirements BASE]`;
	const requirements = [
			{ id: "BASE", summary: specification, origin: "manifest:BASE" },
			...stories.map((summary, index) => ({ id: `S${String(index + 1).padStart(2, "0")}`, summary, origin: `manifest:S${String(index + 1).padStart(2, "0")}` })),
	];
	const snapshot: EvidenceSnapshot = {
		target: { kind: "proposal", proposalHash: "b8-proposal", messageRef: "message:assistant:1" },
		task: { manifest: true, requirements, origin: "manifest:BASE" },
		actorText: compactGoal,
		proposalText: "Inspect Story 40 before changing its webhook behavior.",
		toolCalls: [{ id: "call-b8", name: "bash", arguments: { command: "rg webhook relayboard" }, argsHash: "b8-args" }],
		observations: [], sourceObservations: [], priorInterventions: [], facts: [],
		scope: { sessionId: "offline", taskId: "relayboard-b8", branch: "main", snapshotHash: "b8-snapshot" },
		truncated: false,
		representation: { history: { text: `[user]: ${compactGoal}` }, recent_actions: [] },
	};
	const ledger = ledgerFromSnapshot(snapshot);
	assert.equal(ledger.userGoal.text, actorGoal, "wire goal keeps the explicit objective, not a dangling compact-context marker");
	assert.deepEqual(ledger.userGoal.references, ["BASE"], "the complete source dependency remains explicit and local");

	const wireTarget = 24_576;
	const targetId = `proposal:${snapshot.target.proposalHash}`;
	let built = buildAssessmentPacket(ledger, { selector: "s2", softPayloadBytes: wireTarget, assessmentScope: { kind: "proposal", targetId } });
	let questions = buildCorrectionQuestions(built.packet);
	const firstEnvelope = buildRequestBody({ model: "typesafe-ai/jev", state: built.packet as unknown as Record<string, unknown>, questions });
	if (firstEnvelope.bytes > wireTarget) {
		const reducedTarget = Math.max(1024, wireTarget - (firstEnvelope.bytes - built.serializedBytes));
		built = buildAssessmentPacket(ledger, { selector: "s2", softPayloadBytes: reducedTarget, assessmentScope: { kind: "proposal", targetId } });
		questions = buildCorrectionQuestions(built.packet);
	}
	const finalEnvelope = buildRequestBody({ model: "typesafe-ai/jev", state: built.packet as unknown as Record<string, unknown>, questions });
	assert.equal(built.packet.current_proposal?.id, targetId);
	assert.equal(built.packet.coverage.local, "sufficient", "retained local sources remain assessable");
	assert.ok(built.packet.coverage.omitted_ids.includes("BASE"), "the 40-story BASE superset is optional, never protected into an oversize packet");
	assert.deepEqual(built.packet.coverage.unresolved_requirement_refs, ["BASE"]);
	assert.equal(built.packet.applicable_requirements.some((unit) => unit.id === "BASE"), false);
	assert.ok(built.packet.applicable_requirements.length > 0, "specific retained requirements can still ground a local contradiction");
	assert.equal("USER_GOAL" in questions.find((question) => question.id === "requirement_focus")!.criteria, false);
	assert.deepEqual(questions.map((question) => question.id), ["correction_needed", "primary_concern", "evidence_anchor", "requirement_focus"]);
	assert.ok(finalEnvelope.bytes <= wireTarget, `complete packet and questions fit the production wire target: ${finalEnvelope.bytes}`);

	const answer = (questionId: string, choice: string, probabilities: Record<string, number>): Answer => ({ type: "choice", questionId, choice, probabilities, confidence: probabilities[choice] ?? 0 });
	const assessment = (requirementId: string): Assessment => ({
		kind: "direction", ok: true, status: "UNRESOLVED",
		answers: {
			correction_needed: answer("correction_needed", "CORRECTION_JUSTIFIED", { CORRECTION_JUSTIFIED: .92, NO_CORRECTION_JUSTIFIED: .05, INSUFFICIENT_EVIDENCE: .03 }),
			primary_concern: answer("primary_concern", "CONTRACT_CONTRADICTION", { CONTRACT_CONTRADICTION: .9, NONE: .1 }),
			evidence_anchor: answer("evidence_anchor", targetId, { [targetId]: .9, NONE: .1 }),
			requirement_focus: answer("requirement_focus", requirementId, { [requirementId]: .9, NONE: .1 }),
		},
		findings: [], notes: "", cost: { billedUsd: null, marketUsd: null, unknown: true }, usage: { requestBytes: finalEnvelope.bytes, responseBytes: 0, attempts: 1 },
		timings: { startedAt: "now", finishedAt: "now", ms: 1 }, requestId: "offline", requestHash: finalEnvelope.hash, responseHash: "offline", origin: "live",
	});
	const retainedId = built.packet.applicable_requirements[0]!.id;
	assert.equal(decideCorrectionAssessment(assessment(retainedId), snapshot, config, { packet: built.packet }).apply, "block", "a retained source can still justify a strong local correction");
	const unresolvedGoal = decideCorrectionAssessment(assessment("USER_GOAL"), snapshot, config, { packet: built.packet });
	assert.equal(unresolvedGoal.apply, "none", "a goal with an omitted source dependency cannot hard-block");
	assert.match(unresolvedGoal.reasons.join(" "), /unsupported_grounding/);
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
