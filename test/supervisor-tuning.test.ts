import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/config.ts";
import { buildSnapshot, type Msg } from "../src/evidence.ts";
import { buildRequestBody } from "../src/jev.ts";
import { buildAssessmentPacket, buildCompletionQuestions, buildCorrectionQuestions, CORRECTION_QUESTION_VERSION, decideCorrectionAssessment, evaluateCorrectionPolicy, ledgerFromSnapshot, LifecycleTracker, shouldScheduleCheckpoint, type EvidenceLedger } from "../src/supervisor-tuning.ts";
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

function assistant(text: string, calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> = [], stopReason = "toolUse"): Msg {
	return { role: "assistant", stopReason, content: [...(text ? [{ type: "text", text }] : []), ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} }))] };
}

function productionSnapshot(userTurns: string[], requirementSummary: string, proposalText: string): EvidenceSnapshot {
	const target = assistant(proposalText, [{ id: "c-current", name: "bash", arguments: { command: "cat queue.js" } }]);
	const messages: Msg[] = [];
	for (const [index, text] of userTurns.entries()) {
		messages.push({ role: "user", content: text } as Msg);
		if (index < userTurns.length - 1) messages.push(assistant(`acknowledged turn ${index + 1}`, [], "stop"));
	}
	messages.push(target);
	return buildSnapshot({
		kind: "proposal", target, messages, executedToolCallIds: new Set(),
		requirements: [{ id: "BASE", summary: requirementSummary, origin: "manifest:BASE" }], manifest: true,
		priorInterventions: [], config: defaultConfig(), secrets: [], scope: { sessionId: "offline", taskId: "user-amendments", branch: "main" },
	});
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
	assert.ok("R-new" in anchor.criteria, "a complete retained requirement can anchor its own contract contradiction");
	assert.ok("goal" in anchor.criteria, "a fully resolved goal can be selected from the same source list");
	assert.ok("e1" in anchor.criteria);
	assert.match(anchor.instructions, /do not assume or rely on any other answer/i);
	assert.match(questions[0]!.instructions, /INSUFFICIENT_EVIDENCE/);
	assert.equal(CORRECTION_QUESTION_VERSION, "correction-v2");
});

test("production snapshot carries every later user instruction into packet selection in chronological order", () => {
	const original = "Implement a bounded queue with a capacity of ten.";
	const middle = "Correction: use capacity five rather than ten.";
	const latest = "Continue with that correction and reject negative capacity values.";
	const snapshot = productionSnapshot([original, middle, latest], "Queue operations preserve insertion order.", "Change the queue capacity from five back to ten.");
	assert.deepEqual(snapshot.sourceUserInstructions?.map((unit) => ({ text: unit.text, transportText: unit.transportText, order: unit.order })), [
		{ text: original, transportText: original, order: 0 },
		{ text: middle, transportText: middle, order: 2 },
		{ text: latest, transportText: latest, order: 4 },
	]);
	const value = ledgerFromSnapshot(snapshot);
	const later = value.requirements.filter((unit) => unit.id.startsWith("user_instruction:"));
	assert.deepEqual(later.map((unit) => unit.text), [middle, latest]);
	assert.deepEqual(later.map((unit) => unit.at), ["000000000002", "000000000004"]);
	const built = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: `proposal:${snapshot.target.proposalHash}` } });
	assert.ok(built.packet.applicable_requirements.some((unit) => unit.text === middle), "the relevant middle correction reaches the wire packet");
	assert.ok(built.packet.applicable_requirements.some((unit) => unit.text === latest), "the latest instruction is not treated as the only amendment");
	assert.ok(Object.keys(buildCorrectionQuestions(built.packet).find((question) => question.id === "evidence_anchor")!.criteria).includes("user_instruction:0002"));
	assert.doesNotMatch(built.serialized, /ELIDED|clipped/i);
});

test("repeated cumulative manifest text stays local while its middle amendment remains selectable", () => {
	const base = `# Full task specification\n${"All queue operations must remain deterministic and source compatible. ".repeat(220)}`.trim();
	const original = `Implement the task.\n\nSPECIFICATION:\n${base}`;
	const middle = `Continue the task.\n\nSPECIFICATION:\n${base}\n\nCorrection: capacity is five, not ten.`;
	const latest = "Continue with capacity five and reject negative values.";
	const snapshot = productionSnapshot([original, middle, latest], base, "Set queue capacity to ten before running the check.");
	assert.ok(snapshot.sourceUserInstructions?.[0]?.text.includes(base));
	assert.ok(snapshot.sourceUserInstructions?.[1]?.text.includes(base), "the complete sanitized source remains local");
	assert.equal(snapshot.sourceUserInstructions?.[1]?.transportText.includes(base), false, "the transported unit reuses exact manifest deduplication");
	assert.deepEqual(snapshot.sourceUserInstructions?.[1]?.references, ["BASE"]);
	const value = ledgerFromSnapshot(snapshot);
	const middleUnit = value.requirements.find((unit) => unit.id === "user_instruction:0002")!;
	assert.match(middleUnit.text, /Correction: capacity is five, not ten\./);
	assert.deepEqual(middleUnit.references, ["BASE"]);
	const built = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: `proposal:${snapshot.target.proposalHash}` } });
	assert.ok(built.packet.applicable_requirements.some((unit) => unit.id === middleUnit.id), "the explicit middle amendment is selectable despite the cumulative BASE text");
	assert.ok(built.packet.coverage.omitted_ids.includes("BASE"), "the large manifest source is not duplicated into the bounded packet");
	assert.ok(built.packet.coverage.unresolved_requirement_refs.includes("BASE"), "the source link stays explicit when BASE is omitted");
	const questions = buildCorrectionQuestions(built.packet);
	const anchorCriteria = questions.find((question) => question.id === "evidence_anchor")!.criteria;
	const focusCriteria = questions.find((question) => question.id === "requirement_focus")!.criteria;
	assert.equal(middleUnit.id in anchorCriteria, false, "an instruction with an omitted source dependency cannot hard-ground a correction");
	assert.equal(middleUnit.id in focusCriteria, true, "the incomplete unit remains visible as diagnostic requirement focus");
	const completeUnit = value.requirements.find((unit) => unit.id === "user_instruction:0003")!;
	assert.equal(completeUnit.id in anchorCriteria, true, "an unrelated complete retained instruction remains a valid local anchor");
	const answer = (questionId: string, choice: string, probabilities: Record<string, number>): Answer => ({ type: "choice", questionId, choice, probabilities, confidence: probabilities[choice] ?? 0 });
	const assessmentFor = (id: string): Assessment => ({
		kind: "direction", ok: true, status: "UNRESOLVED",
		answers: {
			correction_needed: answer("correction_needed", "CORRECTION_JUSTIFIED", { CORRECTION_JUSTIFIED: .94, NO_CORRECTION_JUSTIFIED: .04, INSUFFICIENT_EVIDENCE: .02 }),
			primary_concern: answer("primary_concern", "CONTRACT_CONTRADICTION", { CONTRACT_CONTRADICTION: .92, NONE: .08 }),
			evidence_anchor: answer("evidence_anchor", id, { [id]: .92, NONE: .08 }),
			requirement_focus: answer("requirement_focus", id, { [id]: .92, NONE: .08 }),
		},
		findings: [], notes: "", cost: { billedUsd: null, marketUsd: null, unknown: true }, usage: { requestBytes: 1, responseBytes: 1, attempts: 1 },
		timings: { startedAt: "now", finishedAt: "now", ms: 1 }, requestId: "req", requestHash: "request", responseHash: "response", origin: "live",
	});
	const config = defaultConfig();
	config.tuning.enabled = true;
	assert.equal(decideCorrectionAssessment(assessmentFor(middleUnit.id), snapshot, config, { packet: built.packet }).apply, "none");
	assert.equal(decideCorrectionAssessment(assessmentFor(completeUnit.id), snapshot, config, { packet: built.packet }).apply, "block");
	assert.equal(built.serialized.includes(base), false);
	assert.doesNotMatch(built.serialized, /ELIDED|clipped/i);
});

test("a single-user production request body is byte-identical to the frozen dev10 adapter", () => {
	const user = { role: "user", content: "Implement the queue safely." } as Msg;
	const target = assistant("Inspect the queue implementation.", [{ id: "c1", name: "bash", arguments: { command: "cat queue.js" } }]);
	const snapshot = buildSnapshot({
		kind: "proposal", target, messages: [user, target], executedToolCallIds: new Set(),
		requirements: [{ id: "R01", summary: "The queue capacity must reject negative values.", origin: "manifest:R01" }], manifest: true,
		priorInterventions: [], config: defaultConfig(), secrets: [], scope: { sessionId: "offline", taskId: "single-user", branch: "main" },
	});
	const built = buildAssessmentPacket(ledgerFromSnapshot(snapshot), { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: `proposal:${snapshot.target.proposalHash}` } });
	const request = buildRequestBody({ model: "typesafe-ai/jev", state: built.packet as unknown as Record<string, unknown>, questions: buildCorrectionQuestions(built.packet) });
	assert.equal(snapshot.scope.snapshotHash, "d49f561e7e50dd2a");
	assert.equal(built.hash, "bee95dab6c101fb4f6025373709577e282cae99203f5213ab5398845cb752dc4");
	assert.equal(built.serializedBytes, 849);
	assert.equal(request.hash, "f8a11520c9dce158");
	assert.equal(request.bytes, 4280);
});

test("a goal reference absent from the ledger remains unresolved and cannot ground a contract block", () => {
	const value = ledger();
	value.userGoal.references = ["absent"];
	value.requirements = [];
	const packet = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } }).packet;
	assert.deepEqual(packet.coverage.unresolved_requirement_refs, ["absent"]);
	const focus = buildCorrectionQuestions(packet).find((question) => question.id === "requirement_focus")!;
	assert.equal("USER_GOAL" in focus.criteria, false);
	const anchor = buildCorrectionQuestions(packet).find((question) => question.id === "evidence_anchor")!;
	assert.equal("USER_GOAL" in anchor.criteria, false, "an unresolved goal is not offered through the anchor question either");
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

test("a resolved prior intervention is ledgered resolved and is not an open concern", () => {
	const snapshot: EvidenceSnapshot = {
		target: { kind: "proposal", proposalHash: "hash", messageRef: "assistant:1" },
		task: { manifest: false, requirements: [], origin: "user" },
		actorText: "continue", proposalText: "run the focused check", toolCalls: [], observations: [], sourceObservations: [], facts: [],
		priorInterventions: [
			// An expired-but-unresolved concern and one a grounded RESOLVED closed.
			{ kind: "REPLAN", at: "2026-01-01T00:00:01.000Z", focus: "reconsider the contradicted diagnosis" },
			{ kind: "VERIFY", at: "2026-01-01T00:00:02.000Z", focus: "address the unresolved obligation", status: "resolved" },
		],
		scope: { sessionId: "session", taskId: "task", branch: "main", snapshotHash: "snapshot" }, truncated: false, representation: {},
	};
	const value = ledgerFromSnapshot(snapshot);
	assert.deepEqual(value.concerns?.map((unit) => unit.status), ["open", "resolved"], "an unmarked concern is open; only a resolution is not");
	const packet = buildAssessmentPacket(value, { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: `proposal:${snapshot.target.proposalHash}` } }).packet;
	assert.deepEqual(packet.open_concerns.map((unit) => unit.text), ["reconsider the contradicted diagnosis"]);
	assert.equal(buildCorrectionQuestions(packet).some((question) => question.id === "concern_outcome"), true, "the still-open concern keeps its outcome question");
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

test("a requirement anchor is grounded and guidance quotes that same supplied unit", () => {
	const packet = buildAssessmentPacket(ledger(), { selector: "s2", softPayloadBytes: 4096, assessmentScope: { kind: "proposal", targetId: "p1" } }).packet;
	const answer = (questionId: string, choice: string, probabilities: Record<string, number>): Answer => ({ type: "choice", questionId, choice, probabilities, confidence: probabilities[choice] ?? 0 });
	const assessment: Assessment = {
		kind: "direction", ok: true, status: "UNRESOLVED",
		answers: {
			correction_needed: answer("correction_needed", "CORRECTION_JUSTIFIED", { CORRECTION_JUSTIFIED: .92, NO_CORRECTION_JUSTIFIED: .05, INSUFFICIENT_EVIDENCE: .03 }),
			primary_concern: answer("primary_concern", "CONTRACT_CONTRADICTION", { CONTRACT_CONTRADICTION: .9, NONE: .1 }),
			evidence_anchor: answer("evidence_anchor", "R-new", { "R-new": .9, NONE: .1 }),
			requirement_focus: answer("requirement_focus", "R-new", { "R-new": .9, NONE: .1 }),
		},
		findings: [], notes: "", cost: { billedUsd: null, marketUsd: null, unknown: true }, usage: { requestBytes: 1, responseBytes: 1, attempts: 1 },
		timings: { startedAt: "now", finishedAt: "now", ms: 1 }, requestId: "req", requestHash: "request", responseHash: "response", origin: "live",
	};
	const snapshot: EvidenceSnapshot = {
		target: { kind: "proposal", proposalHash: "hash", messageRef: "assistant:1" },
		task: { manifest: false, requirements: [{ id: "R-new", summary: "replace old timeout only for network calls", origin: "turn:4" }], origin: "user" },
		actorText: "Preserve required behavior", proposalText: "change all timeouts", toolCalls: [], observations: [], sourceObservations: [], priorInterventions: [], facts: [],
		scope: { sessionId: "session", taskId: "task", branch: "main", snapshotHash: "snapshot" }, truncated: false, representation: {},
	};
	const config = defaultConfig();
	config.tuning.enabled = true;
	const decision = decideCorrectionAssessment(assessment, snapshot, config, { packet });
	assert.equal(decision.apply, "block");
	assert.match(decision.memo ?? "", /Source anchor \(R-new, source turn:4\): replace old timeout only for network calls/);
	assert.equal((decision.memo ?? "").split("replace old timeout only for network calls").length - 1, 1, "one supplied requirement is not duplicated as a second invented source");
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
		concern: { choice: "NONE", probabilities: { NONE: .9 } }, anchor: { choice: "R-new", probabilities: { "R-new": .9, NONE: .1 } },
		requirement: { choice: "R-new", probabilities: { "R-new": .9, NONE: .1 } }, availableAnchorIds: ["R-new"], availableRequirementIds: ["R-new"],
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
