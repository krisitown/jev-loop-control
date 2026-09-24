import test from "node:test";
import assert from "node:assert/strict";
import { buildQuestions, buildState, questionMap } from "../src/questions.ts";
import { buildSnapshot, type Msg } from "../src/evidence.ts";
import { defaultConfig } from "../src/config.ts";
import type { Requirement } from "../src/types.ts";

/** Question-shape regressions: direction is exactly 3 questions, completion is R+2. */

function snapshotWith(requirements: Requirement[]) {
	const target: Msg = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
	return buildSnapshot({
		kind: "completion",
		target,
		messages: [target],
		executedToolCallIds: new Set<string>(),
		requirements,
		manifest: requirements[0]?.origin.startsWith("manifest") ?? false,
		priorInterventions: [],
		config: defaultConfig(),
		secrets: [],
		scope: { sessionId: "s", taskId: "t", branch: "main" },
	});
}

const REQUIREMENTS: Requirement[] = [
	{ id: "R1", summary: "build the maze", origin: "manifest:R1" },
	{ id: "R2", summary: "verify with tests", origin: "manifest:R2" },
];

test("direction: exactly 3 questions with the mandated ids and types", () => {
	const questions = buildQuestions("direction", snapshotWith(REQUIREMENTS));
	assert.equal(questions.length, 3, "direction never grows with sibling count");
	const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
	assert.equal(byId.next_step!.type, "choice");
	assert.equal(byId.unproductive_repeat!.type, "noul", "the repeat diagnostic is a YES-probability question");
	assert.equal(byId.focus_requirement!.type, "choice");
	assert.deepEqual(Object.keys(byId.unproductive_repeat!.criteria).sort(), ["false", "true"]);
	for (const q of questions) {
		assert.ok(q.instructions.length > 0);
		assert.ok(Object.values(q.criteria).every((description) => description.length > 0));
	}
	// Focus options carry the requirement ids plus NONE/UNKNOWN.
	assert.deepEqual(Object.keys(byId.focus_requirement!.criteria), ["R1", "R2", "NONE", "UNKNOWN"]);
});

test("completion: exactly R+2, one question per requirement plus claims and next_step", () => {
	const questions = buildQuestions("completion", snapshotWith(REQUIREMENTS));
	assert.equal(questions.length, REQUIREMENTS.length + 2);
	const ids = questions.map((q) => q.id);
	assert.deepEqual(ids, ["requirement_R1", "requirement_R2", "final_claims_supported", "next_step"]);
	assert.equal(questions[0]!.type, "choice");
	assert.deepEqual(Object.keys(questions[0]!.criteria), ["MET", "UNMET", "UNVERIFIED", "UNKNOWN"]);
	assert.equal((questions[0] as { requirementId?: string }).requirementId, "R1");
	assert.equal(questions.find((q) => q.id === "final_claims_supported")!.type, "noul");
});

test("questionMap carries the protocol fields only: type, instructions, criteria", () => {
	const map = questionMap(buildQuestions("direction", snapshotWith(REQUIREMENTS)));
	for (const entry of Object.values(map)) {
		assert.deepEqual(Object.keys(entry).sort(), ["criteria", "instructions", "type"]);
	}
});

test("buildState: final_answer is only the current candidate; omission and redaction are reported separately", () => {
	const snapshot = snapshotWith(REQUIREMENTS);
	const state = buildState({
		kind: "completion",
		snapshot,
		proposalId: "p1",
		controller: { workMode: "EXECUTE", proposalNumber: 1, interventionsUsed: 0, interventionLimit: 3, previousInterventions: [] },
	});
	const proposal = state.proposal as { id: string; final_answer?: string; tool_calls?: unknown[]; assistant_text?: string };
	assert.equal(proposal.final_answer, "done");
	assert.equal(proposal.assistant_text, undefined, "a completion proposal carries no separate actor history in final_answer");
	const evidence = state.evidence as Record<string, unknown>;
	assert.ok(Array.isArray(evidence.omitted_evidence_ids));
	assert.equal(typeof evidence.omitted_observation_count, "number");
	assert.equal(typeof evidence.redactions_present, "boolean");
	const task = state.task as { requirements: Array<{ id: string; description: string }> };
	assert.deepEqual(task.requirements.map((r) => r.id), ["R1", "R2"]);
});

test("buildState: direction renders the proposal's tool calls, completion does not", () => {
	const target: Msg = { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "let me" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] };
	const snapshot = buildSnapshot({
		kind: "proposal",
		target,
		messages: [target],
		executedToolCallIds: new Set<string>(),
		requirements: REQUIREMENTS,
		manifest: false,
		priorInterventions: [],
		config: defaultConfig(),
		secrets: [],
		scope: { sessionId: "s", taskId: "t", branch: "main" },
	});
	const dir = buildState({ kind: "direction", snapshot, proposalId: "p", controller: { workMode: "EXECUTE", proposalNumber: 1, interventionsUsed: 0, interventionLimit: 3, previousInterventions: [] } });
	const proposal = dir.proposal as { tool_calls: unknown[]; final_answer?: string };
	assert.equal(proposal.tool_calls.length, 1);
	assert.equal(proposal.final_answer, undefined);
});
