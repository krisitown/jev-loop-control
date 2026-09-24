import test from "node:test";
import assert from "node:assert/strict";
import { decideCompletion, decideDirection, margin, repeatedFailureFocus } from "../src/policy.ts";
import { defaultConfig, type SupervisorConfig } from "../src/config.ts";
import { buildSnapshot, type Msg } from "../src/evidence.ts";
import type { Answer, Assessment, DeterministicFact, EvidenceSnapshot, Requirement } from "../src/types.ts";

/**
 * Policy regressions for the reported adverse cases: weak MET must not buy a
 * COMPLETE, a contradicted MET must become an actual gap (not just a logged
 * reason), and completion must never invent a continuation without a strongly
 * actionable step or strongly contradicted claims.
 */

function config(): SupervisorConfig {
	return defaultConfig();
}

/** The total per-task cap now defaults to null (unlimited); cap tests set it. */
function cappedConfig(maxInterventionsPerTask: number): SupervisorConfig {
	const cfg = defaultConfig();
	cfg.limits.maxInterventionsPerTask = maxInterventionsPerTask;
	return cfg;
}

function snapshot(requirements: Requirement[], facts: DeterministicFact[] = [], truncated = false) {
	const target: Msg = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I finished the work" }] };
	const snap = buildSnapshot({
		kind: "completion",
		target,
		messages: [target],
		executedToolCallIds: new Set<string>(),
		requirements,
		manifest: true,
		priorInterventions: [],
		config: config(),
		secrets: [],
		scope: { sessionId: "s", taskId: "t", branch: "main" },
	});
	snap.facts = facts;
	snap.truncated = truncated;
	return snap;
}

function choice(p: [number, number, number, number], selected: string, confidence = 0.9): Answer {
	return { type: "choice", questionId: "q", choice: selected, probabilities: { MET: p[0]!, UNMET: p[1]!, UNVERIFIED: p[2]!, UNKNOWN: p[3]! }, confidence };
}

function ns(weights: Record<string, number>, selected: string, confidence = 0.9): Answer {
	return { type: "choice", questionId: "next_step", choice: selected, probabilities: weights, confidence };
}

function yes(noul: number): Answer {
	return { type: "noul", questionId: "final_claims_supported", noul };
}

function assessment(answers: Record<string, Answer>): Assessment {
	return {
		kind: "completion",
		ok: true,
		status: "UNCHECKED",
		answers,
		findings: [],
		notes: "",
		cost: { billedUsd: null, marketUsd: null, unknown: true },
		usage: { requestBytes: 0, responseBytes: 0, attempts: 1 },
		timings: { startedAt: "now", finishedAt: "now", ms: 1 },
		requestId: "r",
		requestHash: "h",
		responseHash: "h",
		origin: "live",
	};
}

const REQ: Requirement[] = [{ id: "R1", summary: "deliver the feature", origin: "manifest:R1" }];
const counters = { interventionsUsed: 0, terminalContinuationsUsed: 0, assessmentsUsed: 0, lastFocusKey: null, newEvidence: true };

const STRONG_MET = choice([0.92, 0.04, 0.03, 0.01], "MET");
const WEAK_MET = choice([0.55, 0.30, 0.10, 0.05], "MET");
const STRONG_COMPLETE = ns({ COMPLETE: 0.9, EXECUTE: 0.05, RESEARCH: 0.02, REPLAN: 0.01, VERIFY: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "COMPLETE");

test("margin: gap over the runner-up drives the policy thresholds", () => {
	const m = margin(STRONG_MET)!;
	assert.equal(m.selected, "MET");
	assert.ok(m.probability >= 0.8 && m.gap >= 0.2);
});

test("completion is accepted only with strong MET, strong claims, strong COMPLETE, no contradictions", () => {
	const decision = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.95), next_step: STRONG_COMPLETE }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "COMPLETE");
});

test("ADVERSE: a WEAK MET never buys COMPLETE (strong-every-requirement rule)", () => {
	const decision = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: WEAK_MET, final_claims_supported: yes(0.95), next_step: STRONG_COMPLETE }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.notEqual(decision.status, "COMPLETE", "a barely-supported MET is an unverified gap");
	// No strongly actionable step and claims are supported -> unresolved, not invented work.
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "UNRESOLVED");
});

test("ADVERSE: a contradicted MET becomes a real gap, never COMPLETE", () => {
	const failedRun: DeterministicFact = { kind: "tool_error", subject: "deliver", value: "tool executed and returned an error result", source: "pi:tool_result_hook(executed)" };
	const decision = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.97), next_step: STRONG_COMPLETE }),
		snapshot: snapshot(REQ, [failedRun]),
		config: config(),
		counters,
	});
	assert.notEqual(decision.status, "COMPLETE", "a measured failure on the requirement's own subject vetoes acceptance");
	assert.ok(decision.reasons.some((r) => r.includes("contradicted")), decision.reasons.join(";"));
});

test("ADVERSE: no invented work when everything is MET and supported but next_step=VERIFY", () => {
	const decision = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.95), next_step: ns({ VERIFY: 0.9, COMPLETE: 0.05, EXECUTE: 0.02, RESEARCH: 0.01, REPLAN: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "VERIFY") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none", "an unsupported continuation is worse than none");
	assert.equal(decision.status, "UNRESOLVED");
	assert.equal(decision.memo, null, "no false memo claiming unsupported work");
});

test("continuation requires a strong actionable step AND a concrete gap (or strongly contradicted claims)", () => {
	const strong = (weights: Record<string, number>, selected: string) => ns(weights, selected);

	// Authorized acceptance table:
	// 1) strong MET + claims .95 + strong VERIFY => NONE (VERIFY must not invent work).
	const allMetStrongVerify = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.95), next_step: strong({ COMPLETE: 0.05, EXECUTE: 0.02, RESEARCH: 0.01, REPLAN: 0.01, VERIFY: 0.9, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "VERIFY") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(allMetStrongVerify.apply, "none");
	assert.equal(allMetStrongVerify.memo, null);

	// 2) strong UNVERIFIED + claims .95 + strong VERIFY => CONTINUE VERIFY.
	const strongUnverifiedVerify = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: choice([0.03, 0.04, 0.91, 0.02], "UNVERIFIED"), final_claims_supported: yes(0.95), next_step: strong({ COMPLETE: 0.05, EXECUTE: 0.02, RESEARCH: 0.01, REPLAN: 0.01, VERIFY: 0.9, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "VERIFY") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(strongUnverifiedVerify.apply, "continue");
	assert.equal(strongUnverifiedVerify.status, "VERIFY");

	// 3) weak UNKNOWN/UNMET + supported claims + strong EXECUTE => NONE (no concrete gap).
	const weakGapStrongExecute = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: choice([0.20, 0.35, 0.25, 0.20], "UNMET"), final_claims_supported: yes(0.95), next_step: strong({ COMPLETE: 0.05, EXECUTE: 0.9, RESEARCH: 0.02, REPLAN: 0.01, VERIFY: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "EXECUTE") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(weakGapStrongExecute.apply, "none");
	assert.equal(weakGapStrongExecute.status, "UNRESOLVED");

	// 4) strong MET + claims .6 (below threshold is absence of support, NOT a
	//    strong contradiction) + strong COMPLETE => NONE, never a correction loop.
	const mehClaims = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.6), next_step: STRONG_COMPLETE }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(mehClaims.apply, "none");

	// 5) strong MET + claims .1 => 1-P(yes)=0.9 >= .8 is a STRONG contradiction;
	//    with a strong correction step this CONTINUES to correct the answer.
	const contradictedClaims = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.1), next_step: strong({ COMPLETE: 0.05, EXECUTE: 0.02, RESEARCH: 0.01, REPLAN: 0.01, VERIFY: 0.9, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "VERIFY") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(contradictedClaims.apply, "continue", "a measured negative on the final claims is a concrete reason to continue");

	// 6) the same contradiction with only a WEAK step => NONE (no action confidence).
	const contradictedWeakStep = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.1), next_step: strong({ COMPLETE: 0.35, EXECUTE: 0.2, RESEARCH: 0.1, REPLAN: 0.1, VERIFY: 0.15, NEEDS_USER_INPUT: 0.04, BLOCKED: 0.03, UNCERTAIN: 0.03 }, "VERIFY") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(contradictedWeakStep.apply, "none");

	// 7) strong UNMET but next_step=COMPLETE is inconsistent: no mode is invented.
	const inconsistent = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: choice([0.03, 0.92, 0.03, 0.02], "UNMET"), final_claims_supported: yes(0.95), next_step: STRONG_COMPLETE }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(inconsistent.apply, "none");
	assert.notEqual(inconsistent.status, "COMPLETE", "an answer set that contradicts itself never claims completion");
	assert.equal(inconsistent.status, "UNRESOLVED");

	// 8) all-MET + supported claims + strong EXECUTE/RESEARCH/REPLAN never invents work.
	for (const mode of ["EXECUTE", "RESEARCH", "REPLAN"] as const) {
		const weights: Record<string, number> = { COMPLETE: 0.05, EXECUTE: 0.02, RESEARCH: 0.01, REPLAN: 0.01, VERIFY: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 };
		weights[mode] = 0.9;
		const invented = decideCompletion({
			kind: "completion",
			assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.95), next_step: strong(weights, mode) }),
			snapshot: snapshot(REQ),
			config: config(),
			counters,
		});
		assert.equal(invented.apply, "none", `all-MET must not invent ${mode} work`);
		assert.equal(invented.status, "UNRESOLVED");
	}

	// 9) a concrete strong UNMET + strong EXECUTE legitimately continues.
	const actionable = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: choice([0.05, 0.9, 0.03, 0.02], "UNMET"), final_claims_supported: yes(0.95), next_step: strong({ COMPLETE: 0.05, EXECUTE: 0.9, RESEARCH: 0.02, REPLAN: 0.01, VERIFY: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "EXECUTE") }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(actionable.apply, "continue");
	assert.equal(actionable.status, "EXECUTE");
	assert.ok(actionable.memo!.includes("R1"));
});

test("terminal continuation budget and the total per-task intervention budget both bind", () => {
	const inputs = {
		kind: "completion" as const,
		assessment: assessment({ requirement_R1: choice([0.05, 0.9, 0.03, 0.02], "UNMET"), final_claims_supported: yes(0.95), next_step: ns({ EXECUTE: 0.9, COMPLETE: 0.05, RESEARCH: 0.02, REPLAN: 0.01, VERIFY: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "EXECUTE") }),
		snapshot: snapshot(REQ),
		// The default cap is null (unlimited), so a cap test must set it.
		config: cappedConfig(3),
	};
	const atTerminalCap = decideCompletion({ ...inputs, counters: { ...counters, terminalContinuationsUsed: 2 } });
	assert.equal(atTerminalCap.apply, "none");
	assert.ok(atTerminalCap.reasons.some((r) => r.includes("terminal continuation budget")));

	const atTotalCap = decideCompletion({ ...inputs, counters: { ...counters, interventionsUsed: 3 } });
	assert.equal(atTotalCap.apply, "none", "maxInterventionsPerTask also caps completions, not just direction blocks");
	assert.ok(atTotalCap.reasons.some((r) => r.includes("intervention budget")));
});

test("repeat suppression: same focus and mode without new evidence does not loop", () => {
	const inputs = {
		kind: "completion" as const,
		assessment: assessment({ requirement_R1: choice([0.05, 0.9, 0.03, 0.02], "UNMET"), final_claims_supported: yes(0.95), next_step: ns({ EXECUTE: 0.9, COMPLETE: 0.05, RESEARCH: 0.02, REPLAN: 0.01, VERIFY: 0.01, NEEDS_USER_INPUT: 0.005, BLOCKED: 0.005, UNCERTAIN: 0.0 }, "EXECUTE") }),
		snapshot: snapshot(REQ),
		config: config(),
	};
	const first = decideCompletion({ ...inputs, counters });
	assert.equal(first.apply, "continue");
	const repeat = decideCompletion({ ...inputs, counters: { ...counters, lastFocusKey: first.focusKey, newEvidence: false } });
	assert.equal(repeat.apply, "none");
	assert.ok(repeat.reasons.some((r) => r.includes("no new evidence")));
});

test("truncated evidence never yields COMPLETE", () => {
	const decision = decideCompletion({
		kind: "completion",
		assessment: assessment({ requirement_R1: STRONG_MET, final_claims_supported: yes(0.95), next_step: STRONG_COMPLETE }),
		snapshot: snapshot(REQ, [], true),
		config: config(),
		counters,
	});
	assert.notEqual(decision.status, "COMPLETE");
	assert.equal(decision.status, "UNRESOLVED");
});

test("BLOCKED/NEEDS_USER_INPUT surface to the user, never an automatic continuation", () => {
	for (const mode of ["BLOCKED", "NEEDS_USER_INPUT"] as const) {
		const decision = decideCompletion({
			kind: "completion",
			assessment: assessment({ requirement_R1: choice([0.05, 0.9, 0.03, 0.02], "UNMET"), final_claims_supported: yes(0.95), next_step: ns({ [mode]: 0.9, COMPLETE: 0.05, EXECUTE: 0.02, RESEARCH: 0.02, REPLAN: 0.01, VERIFY: 0.01, UNCERTAIN: 0.005 }, mode) }),
			snapshot: snapshot(REQ),
			config: config(),
			counters,
		});
		assert.equal(decision.apply, "none");
		assert.equal(decision.status, mode);
	}
});

test("assessment failure never becomes claimed success", () => {
	const failed = { ...assessment({}), ok: false, failure: { stage: "transport" as const, message: "deadline exceeded" } };
	const decision = decideCompletion({ kind: "completion", assessment: failed, snapshot: snapshot(REQ), config: config(), counters });
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "UNCHECKED");
});

// ---------------------------------------------------------------- direction

test("direction: strong redirect with actionable focus blocks; weak signals pass through", () => {
	const cfg = config();
	const snap = snapshot(REQ);
	const base = { kind: "direction" as const, snapshot: snap, config: cfg, counters };
	const block = decideDirection({
		...base,
		assessment: assessment({
			next_step: ns({ RESEARCH: 0.9, PROCEED: 0.05, REPLAN: 0.02, VERIFY: 0.02, UNCERTAIN: 0.01 }, "RESEARCH"),
			unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.9 },
			focus_requirement: ns({ R1: 0.9, R2: 0.05, NONE: 0.03, UNKNOWN: 0.02 }, "R1"),
		}),
	});
	assert.equal(block.apply, "block");
	assert.equal(block.status, "RESEARCH");
	assert.ok(block.reasons.some((r) => r.includes("diagnostic") && r.includes("never a veto")), "the repeat score is recorded but never a veto on its own");

	const weakFocus = decideDirection({
		...base,
		assessment: assessment({
			next_step: ns({ RESEARCH: 0.9, PROCEED: 0.05, REPLAN: 0.02, VERIFY: 0.02, UNCERTAIN: 0.01 }, "RESEARCH"),
			unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.1 },
			focus_requirement: ns({ R1: 0.4, R2: 0.1, NONE: 0.4, UNKNOWN: 0.1 }, "NONE"),
		}),
	});
	assert.equal(weakFocus.apply, "none", "a mode alone is not grounds to block; focus must be actionable");
	assert.equal(weakFocus.status, "UNRESOLVED", "no actionable focus is unresolved, never an executed verdict");
	assert.ok(weakFocus.reasons.some((r) => r.includes("no_actionable_focus")), weakFocus.reasons.join(";"));
});

test("direction: a weak corrective next_step is UNRESOLVED, not EXECUTE (weak_support)", () => {
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({
			next_step: ns({ RESEARCH: 0.55, PROCEED: 0.30, REPLAN: 0.10, VERIFY: 0.03, UNCERTAIN: 0.02 }, "RESEARCH"),
			unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.1 },
			focus_requirement: ns({ R1: 0.9, R2: 0.05, NONE: 0.03, UNKNOWN: 0.02 }, "R1"),
		}),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "UNRESOLVED", "thin support for a redirect is not evidence that executing is right");
	assert.ok(decision.reasons.some((r) => r.includes("weak_support")), decision.reasons.join(";"));
});

test("direction: intervention budget reached leaves the batch unsupervised rather than escalating", () => {
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({
			next_step: ns({ RESEARCH: 0.9, PROCEED: 0.05, REPLAN: 0.02, VERIFY: 0.02, UNCERTAIN: 0.01 }, "RESEARCH"),
			unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.2 },
			focus_requirement: ns({ R1: 0.9, R2: 0.05, NONE: 0.03, UNKNOWN: 0.02 }, "R1"),
		}),
		snapshot: snapshot(REQ),
		config: cappedConfig(3),
		counters: { ...counters, interventionsUsed: 3 },
	});
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "UNRESOLVED");
});

test("direction: the same focus and mode without new evidence is suppressed", () => {
	const inputs = {
		kind: "direction" as const,
		assessment: assessment({
			next_step: ns({ RESEARCH: 0.9, PROCEED: 0.05, REPLAN: 0.02, VERIFY: 0.02, UNCERTAIN: 0.01 }, "RESEARCH"),
			unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.2 },
			focus_requirement: ns({ R1: 0.9, R2: 0.05, NONE: 0.03, UNKNOWN: 0.02 }, "R1"),
		}),
		snapshot: snapshot(REQ),
		config: config(),
	};
	const first = decideDirection({ ...inputs, counters });
	assert.equal(first.apply, "block");
	const repeat = decideDirection({ ...inputs, counters: { ...counters, interventionsUsed: 1, lastFocusKey: first.focusKey, newEvidence: false } });
	assert.equal(repeat.apply, "none");
	assert.ok(repeat.reasons.some((r) => r.includes("suppressing the repeat")));
});

// -------------------------------------------------- repeated-failure focus

/**
 * A snapshot whose executed path shows the SAME call (identical arguments) failing
 * twice, plus a proposal that repeats exactly that call. `proposalArgs` lets a
 * test vary the current proposal while keeping the failure history identical.
 */
function repeatSnapshot(proposalArgs: Record<string, unknown> = { path: "a.txt", text: "v1" }): ReturnType<typeof snapshot> {
	const failedCall = (id: string) => assistantTurn(`run ${id}`, [{ id, name: "write", arguments: proposalArgs }]);
	const messages: Msg[] = [];
	// Two older results outside the six-observation window: they must not trigger.
	messages.push(failedCall("c-old-1"), toolResult("c-old-1", "old failure", { isError: true, toolName: "write" }));
	messages.push(failedCall("c-old-2"), toolResult("c-old-2", "old failure", { isError: true, toolName: "write" }));
	// The six executed observations that matter: E3..E8 in the snapshot.
	const recent = [
		["c1", false], ["c2", true], ["c3", false], ["c4", true], ["c5", false], ["c6", true],
	] as const;
	for (const [id, ok] of recent) {
		messages.push(failedCall(id), toolResult(id, ok ? "ok" : "failed", { isError: !ok, toolName: "write" }));
	}
	const target = assistant("same write again", [{ id: "c7", name: "write", arguments: proposalArgs }], "toolUse");
	messages.push(target);
	return buildSnapshot({
		kind: "proposal",
		target,
		messages,
		executedToolCallIds: new Set(["c-old-1", "c-old-2", "c1", "c2", "c3", "c4", "c5", "c6"]),
		requirements: REQ,
		manifest: false,
		priorInterventions: [],
		config: config(),
		secrets: [],
		scope: { sessionId: "s", taskId: "t", branch: "main" },
	});
}

function assistantTurn(text: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Msg {
	return { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text }, ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments }))] };
}

/** An assistant turn; `calls` may be empty for a terminal text message. */
function assistant(text: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [], stopReason = "toolUse"): Msg {
	return assistantTurn(text, calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })));
}

function toolResult(toolCallId: string, text: string, opts: { isError?: boolean; toolName?: string }): Msg {
	return { role: "toolResult", toolCallId, toolName: opts.toolName ?? "bash", isError: opts.isError ?? false, content: [{ type: "text", text }] };
}

const STRONG_RESEARCH = ns({ RESEARCH: 0.9, PROCEED: 0.05, REPLAN: 0.02, VERIFY: 0.02, UNCERTAIN: 0.01 }, "RESEARCH");
const NO_FOCUS = ns({ NONE: 0.7, UNKNOWN: 0.2, R1: 0.1 }, "NONE");

test("repeated failure: strong corrective + no focus + measured identical failures blocks with cited evidence", () => {
	const snap = repeatSnapshot();
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({ next_step: STRONG_RESEARCH, unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.9 }, focus_requirement: NO_FOCUS }),
		snapshot: snap,
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "block", "the repeated failure is a measured fact, so it is a legitimate focus");
	assert.equal(decision.status, "RESEARCH");
	assert.ok(decision.reasons.some((r) => r.includes("repeated_failure_focus")), decision.reasons.join(";"));
	assert.ok(decision.memo!.includes("E") && /\bE\d/.test(decision.memo!), `the memo must cite evidence ids: ${decision.memo}`);
	assert.ok(!/because\b.*because/.test(decision.memo!), "no invented causal story");
});

test("repeated failure: never fires on the repetition diagnostic alone (no measured failures)", () => {
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({ next_step: STRONG_RESEARCH, unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.97 }, focus_requirement: NO_FOCUS }),
		snapshot: snapshot(REQ),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "UNRESOLVED");
	assert.ok(decision.reasons.some((r) => r.includes("no_actionable_focus")), decision.reasons.join(";"));
});

test("repeated failure: a proposal that changes the arguments is not a repeat", () => {
	const changed = repeatSnapshot({ path: "a.txt", text: "v1" });
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({ next_step: STRONG_RESEARCH, unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.9 }, focus_requirement: NO_FOCUS }),
		snapshot: changedWithDifferentArgs(changed),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none", "changed arguments are a changed approach, not a repeated failure");
	assert.equal(decision.status, "UNRESOLVED");
});

/** Same evidence, but the current proposal calls the tool with different arguments. */
function changedWithDifferentArgs(snap: EvidenceSnapshot): EvidenceSnapshot {
	const args = { path: "a.txt", text: "materially different approach" };
	const call = { id: "c7", name: "write", arguments: args, argsHash: hashJsonForTest(args) };
	return { ...snap, toolCalls: [call] };
}

function hashJsonForTest(value: unknown): string {
	// Any value distinct from the failed calls' hash is enough: policy compares hashes.
	return `different-hash:${JSON.stringify(value).length}`;
}

test("repeated failure: below the diagnostic threshold the measured repeat still does not fire", () => {
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({ next_step: STRONG_RESEARCH, unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.84 }, focus_requirement: NO_FOCUS }),
		snapshot: repeatSnapshot(),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none");
	assert.ok(decision.reasons.some((r) => r.includes("no_actionable_focus")), decision.reasons.join(";"));
});

test("repeated failure: a strong PROCEED is never overridden by repetition", () => {
	const decision = decideDirection({
		kind: "direction",
		assessment: assessment({
			next_step: ns({ PROCEED: 0.9, RESEARCH: 0.05, REPLAN: 0.03, VERIFY: 0.01, UNCERTAIN: 0.01 }, "PROCEED"),
			unproductive_repeat: { type: "noul", questionId: "unproductive_repeat", noul: 0.99 },
			focus_requirement: NO_FOCUS,
		}),
		snapshot: repeatSnapshot(),
		config: config(),
		counters,
	});
	assert.equal(decision.apply, "none");
	assert.equal(decision.status, "EXECUTE", "PROCEED plus a high repeat score is still a pass-through");
	assert.ok(decision.reasons.some((r) => r.includes("repeat_never_vetoes_proceed")), decision.reasons.join(";"));
});

test("repeated failure: the detector requires executed failures with identical args", () => {
	const snap = repeatSnapshot();
	assert.ok(repeatedFailureFocus(snap, config(), 0.9), "the fixture itself must contain the measured repeat");
	assert.equal(repeatedFailureFocus(snap, config(), 0.5), null, "the diagnostic threshold is required");
	assert.equal(repeatedFailureFocus(snapshot(REQ), config(), 0.9), null, "no executed failures, no fallback");
});
