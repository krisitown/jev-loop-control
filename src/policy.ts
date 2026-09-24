/**
 * Policy: pure, deterministic decisions from validated answers plus the facts.
 *
 * No network, no Pi types, no clocks. Given the same answers and the same
 * evidence it must produce the same decision, which is what makes the trace
 * replayable and the tests meaningful.
 */

import { POLICY_INVARIANTS, type SupervisorConfig } from "./config.ts";
import type { Answer, Assessment, Decision, EvidenceSnapshot, Requirement } from "./types.ts";

export const MODE_LABELS = ["EXECUTE", "RESEARCH", "REPLAN", "VERIFY"] as const;
export type WorkMode = (typeof MODE_LABELS)[number];

const REDIRECT_MODES = ["RESEARCH", "REPLAN", "VERIFY"] as const;
const NON_VETO_OPTIONS = ["NONE", "UNKNOWN", "PROCEED", "COMPLETE"];

export interface PolicyCounters {
	interventionsUsed: number;
	terminalContinuationsUsed: number;
	assessmentsUsed: number;
	lastFocusKey: string | null;
	/** True when the evidence differs from the last intervention's evidence. */
	newEvidence: boolean;
}

export interface PolicyInput {
	kind: "direction" | "completion";
	assessment: Assessment;
	snapshot: EvidenceSnapshot;
	config: SupervisorConfig;
	counters: PolicyCounters;
}

export interface Margin {
	selected: string;
	probability: number;
	gap: number;
}

/** Selected option and its margin over the runner-up, from a choice answer. */
export function margin(answer: Answer | undefined): Margin | undefined {
	if (!answer || answer.type !== "choice") {
		return undefined;
	}
	const values = Object.entries(answer.probabilities);
	const selected = answer.probabilities[answer.choice];
	if (selected === undefined) {
		return undefined;
	}
	const others = values.filter(([option]) => option !== answer.choice).map(([, value]) => value);
	const runnerUp = others.length > 0 ? Math.max(...others) : 0;
	return { selected: answer.choice, probability: selected, gap: selected - runnerUp };
}

function strongEnough(marginOf: Margin | undefined, config: SupervisorConfig): boolean {
	return marginOf !== undefined
		&& marginOf.probability >= config.policy.probabilityThreshold
		&& marginOf.gap >= config.policy.gapThreshold;
}

function noulOf(answer: Answer | undefined): number | undefined {
	return answer?.type === "noul" ? answer.noul : undefined;
}

export function decideDirection(input: PolicyInput): Decision {
	const { assessment, snapshot, config, counters } = input;
	const reasons: string[] = [];
	if (!assessment.ok) {
		return {
			assessment,
			apply: "none",
			status: "UNCHECKED",
			reasons: [`assessment unavailable (${assessment.failure?.message ?? "failed"}); the proposal passes through unsupervised`],
			memo: null,
			focusKey: null,
		};
	}
	const nextStep = margin(assessment.answers.next_step);
	const focus = margin(assessment.answers.focus_requirement);
	const repeat = noulOf(assessment.answers.unproductive_repeat);

	if (nextStep === undefined) {
		return { assessment, apply: "none", status: "UNCHECKED", reasons: ["no usable next_step choice; passing through"], memo: null, focusKey: null };
	}
	if (repeat !== undefined) {
		reasons.push(`repetition diagnostic P(true)=${repeat.toFixed(3)}${repeat >= config.policy.repeatDiagnosticThreshold ? " (at or above the diagnostic threshold; never a veto on its own)" : ""}`);
	}
	if (nextStep.selected === "UNCERTAIN") {
		return { assessment, apply: "none", status: "UNRESOLVED", reasons: ["next_step=UNCERTAIN; the snapshot does not support a classification"], memo: null, focusKey: null };
	}
	if (nextStep.selected === "PROCEED") {
		// A high repetition score is recorded but never vetoes a PROCEED on its own.
		return { assessment, apply: "none", status: "EXECUTE", reasons: [...reasons, `next_step=PROCEED (p=${nextStep.probability.toFixed(3)}, gap=${nextStep.gap.toFixed(3)})`], memo: null, focusKey: null };
	}
	if (!REDIRECT_MODES.includes(nextStep.selected as (typeof REDIRECT_MODES)[number])) {
		return { assessment, apply: "none", status: "UNRESOLVED", reasons: [`unexpected next_step ${nextStep.selected}`], memo: null, focusKey: null };
	}
	if (!strongEnough(nextStep, config)) {
		return {
			assessment,
			apply: "none",
			status: "EXECUTE",
			reasons: [...reasons, `next_step=${nextStep.selected} but support is below policy (p=${nextStep.probability.toFixed(3)} needs >=${config.policy.probabilityThreshold}, gap=${nextStep.gap.toFixed(3)} needs >=${config.policy.gapThreshold})`],
			memo: null,
			focusKey: null,
		};
	}
	if (POLICY_INVARIANTS.requireActionableFocus) {
		if (focus === undefined || NON_VETO_OPTIONS.includes(focus.selected) || focus.probability < config.policy.probabilityThreshold) {
			return {
				assessment,
				apply: "none",
				status: "EXECUTE",
				reasons: [...reasons, `no actionable requirement focus (focus_requirement=${focus?.selected ?? "missing"}, p=${(focus?.probability ?? 0).toFixed(3)}); a mode alone is not grounds to block`],
				memo: null,
				focusKey: null,
			};
		}
	}
	if (counters.interventionsUsed >= config.limits.maxInterventionsPerTask) {
		return {
			assessment,
			apply: "none",
			status: "UNRESOLVED",
			reasons: [...reasons, `intervention budget reached (${counters.interventionsUsed}/${config.limits.maxInterventionsPerTask}); leaving the batch unsupervised instead of escalating`],
			memo: null,
			focusKey: null,
		};
	}
	const focusKey = `direction:${nextStep.selected}:${focus?.selected ?? "none"}`;
	if (counters.lastFocusKey === focusKey && !counters.newEvidence) {
		return {
			assessment,
			apply: "none",
			status: "UNRESOLVED",
			reasons: [...reasons, `same focus and mode as the previous intervention with no new evidence (${focusKey}); suppressing the repeat`],
			memo: null,
			focusKey,
		};
	}
	const requirement = snapshot.task.requirements.find((candidate) => candidate.id === focus?.selected);
	return {
		assessment,
		apply: "block",
		status: nextStep.selected as Decision["status"],
		reasons: [...reasons, `next_step=${nextStep.selected} (p=${nextStep.probability.toFixed(3)}, gap=${nextStep.gap.toFixed(3)})`, `focus=${focus?.selected ?? "none"} (p=${(focus?.probability ?? 0).toFixed(3)})`],
		memo: directionMemo(nextStep.selected as WorkMode, requirement, snapshot),
		focusKey,
	};
}

export interface CompletionPolicyInput extends PolicyInput {
	kind: "completion";
}

export function decideCompletion(input: CompletionPolicyInput): Decision {
	const { assessment, snapshot, config, counters } = input;
	const reasons: string[] = [];
	if (!assessment.ok) {
		return {
			assessment,
			apply: "none",
			status: "UNCHECKED",
			reasons: [`completion assessment unavailable (${assessment.failure?.message ?? "failed"}); settling unchecked rather than claiming success`],
			memo: null,
			focusKey: null,
		};
	}
	const nextStep = margin(assessment.answers.next_step);
	const claims = noulOf(assessment.answers.final_claims_supported);
	const requirementAnswers = snapshot.task.requirements.map((requirement) => ({
		requirement,
		margin: margin(assessment.answers[`requirement_${requirement.id}`]),
	}));

	if (snapshot.truncated) {
		reasons.push("the evidence sent was bounded; a complete verdict is not claimable from truncated evidence");
	}
	const contradictions = snapshot.facts.filter((fact) => fact.kind === "truncation" || fact.kind === "error" || fact.kind === "aborted");
	for (const fact of contradictions) {
		reasons.push(`deterministic fact contradicts completion: ${fact.kind} on ${fact.subject} (${fact.value})`);
	}

	const unmet: Requirement[] = [];
	for (const { requirement, margin: requirementMargin } of requirementAnswers) {
		if (requirementMargin === undefined) {
			unmet.push(requirement);
			reasons.push(`${requirement.id}: no usable answer; treated as unverified`);
			continue;
		}
		if (requirementMargin.selected === "MET") {
			// "MET" is only ACCEPTED when strongly supported; a weak MET is an
			// unverified gap, never a free pass to COMPLETE.
			if (!strongEnough(requirementMargin, config)) {
				unmet.push(requirement);
				reasons.push(`${requirement.id}: reported MET but support is below policy (p=${requirementMargin.probability.toFixed(3)} needs >=${config.policy.probabilityThreshold}, gap=${requirementMargin.gap.toFixed(3)} needs >=${config.policy.gapThreshold}); treated as unverified`);
				continue;
			}
			// A measured, requirement-linked contradiction downgrades a MET claim;
			// policy cannot be talked out of a fact the runtime observed.
			const contradicted = contradictsRequirement(requirement, snapshot);
			if (contradicted !== null) {
				unmet.push(requirement);
				reasons.push(`${requirement.id}: reported MET but contradicted by ${contradicted}`);
				continue;
			}
			continue;
		}
		unmet.push(requirement);
		reasons.push(`${requirement.id}=${requirementMargin.selected} (p=${requirementMargin.probability.toFixed(3)})`);
	}

	const claimsUnsupported = claims === undefined || claims < config.policy.probabilityThreshold;
	if (claims !== undefined) {
		reasons.push(`final_claims_supported P(true)=${claims.toFixed(3)}${claimsUnsupported ? " (below threshold)" : ""}`);
	}

	const allMet = unmet.length === 0 && requirementAnswers.every((entry) => entry.margin?.selected === "MET");
	const completeSelected = nextStep?.selected === "COMPLETE";
	if (allMet && !claimsUnsupported && completeSelected && strongEnough(nextStep, config) && contradictions.length === 0 && !snapshot.truncated) {
		return {
			assessment,
			apply: "none",
			status: "COMPLETE",
			reasons: [...reasons, "all requirements MET, final claims supported, next_step=COMPLETE with sufficient margin"],
			memo: null,
			focusKey: null,
		};
	}

	if (contradictions.length > 0 || snapshot.truncated) {
		return {
			assessment,
			apply: "none",
			status: "UNRESOLVED",
			reasons,
			memo: null,
			focusKey: "completion:contradicted-evidence",
		};
	}
	if (!completeSelected && (nextStep?.selected === "BLOCKED" || nextStep?.selected === "NEEDS_USER_INPUT")) {
		// Surfaced to the user rather than answered with an automatic continuation.
		return { assessment, apply: "none", status: nextStep.selected as Decision["status"], reasons, memo: null, focusKey: `completion:${nextStep.selected}` };
	}
	if (!completeSelected && (nextStep?.selected === "UNCERTAIN" || nextStep === undefined)) {
		return { assessment, apply: "none", status: "UNRESOLVED", reasons: [...reasons, "next_step does not support a classification"], memo: null, focusKey: "completion:UNCERTAIN" };
	}

	// Completion-specific contradiction: the assessment itself strongly denies
	// that the final claims are supported. A noul answer is a YES probability, so
	// a STRONG NEGATIVE is 1 - P(yes) >= threshold; "merely below threshold" is
	// absence of support, not a measurement of contradiction.
	const claimsContradicted = claims !== undefined && 1 - claims >= config.policy.probabilityThreshold;
	// Concrete gaps: strongly classified UNMET/UNVERIFIED, a missing usable
	// answer, or a strong MET overruled by a measured fact. Weak classifications
	// are uncertainty, not a demonstrated gap.
	const concreteGap = unmet.some((requirement) => {
		const requirementMargin = margin(assessment.answers[`requirement_${requirement.id}`]);
		return requirementMargin !== undefined
			&& strongEnough(requirementMargin, config)
			&& (requirementMargin.selected === "UNMET" || requirementMargin.selected === "UNVERIFIED");
	});

	// A continuation requires BOTH a strongly actionable next step AND a concrete
	// strongly unmet/unverified requirement, OR both strongly contradicted final
	// claims AND a strong correction step. One alone is never enough: policy does
	// not invent work from a confident mode, and does not loop on a contradiction
	// the assessment cannot yet act on. All-MET with supported claims can only
	// ever reach COMPLETE here; no other intervention is invented.
	const actionableMode = nextStep !== undefined
		&& strongEnough(nextStep, config)
		&& (nextStep.selected === "EXECUTE" || nextStep.selected === "RESEARCH" || nextStep.selected === "REPLAN" || nextStep.selected === "VERIFY");
	const continueForGap = actionableMode && concreteGap;
	const continueForClaims = claimsContradicted && actionableMode;
	if (!(continueForGap || continueForClaims)) {
		return {
			assessment,
			apply: "none",
			status: "UNRESOLVED",
			reasons: [...reasons, !actionableMode
				? "no strongly actionable next step; leaving the task unresolved rather than inventing a continuation"
				: "the strong next step has no concrete strongly unmet/unverified requirement or strongly contradicted claims behind it; nothing to continue for"],
			memo: null,
			focusKey: null,
		};
	}
	// Interventions of BOTH kinds count against the per-task budget.
	if (counters.interventionsUsed >= config.limits.maxInterventionsPerTask) {
		return {
			assessment,
			apply: "none",
			status: "UNRESOLVED",
			reasons: [...reasons, `intervention budget reached (${counters.interventionsUsed}/${config.limits.maxInterventionsPerTask}); settling with an explicit unresolved status instead of continuing`],
			memo: null,
			focusKey: null,
		};
	}

	const mode = nextStep!.selected as WorkMode;
	const focusKey = `completion:${mode}:${unmet[0]?.id ?? "claims"}`;
	if (counters.lastFocusKey === focusKey && !counters.newEvidence) {
		return { assessment, apply: "none", status: "UNRESOLVED", reasons: [...reasons, `same unfinished focus as the previous continuation (${focusKey}) with no new evidence; stopping rather than looping`], memo: null, focusKey };
	}
	if (counters.terminalContinuationsUsed >= config.limits.maxTerminalContinuations) {
		return {
			assessment,
			apply: "none",
			status: "UNRESOLVED",
			reasons: [...reasons, `terminal continuation budget reached (${counters.terminalContinuationsUsed}/${config.limits.maxTerminalContinuations}); settling with an explicit unresolved status instead of continuing`],
			memo: null,
			focusKey,
		};
	}
	return {
		assessment,
		apply: "continue",
		status: mode,
		reasons,
		memo: completionMemo(mode, unmet, snapshot, claimsUnsupported),
		focusKey,
	};
}

/**
 * Deterministic facts that contradict a requirement claim. This is the one place
 * where policy can overrule an answer, and only with a fact the runtime
 * OBSERVED on the execution path: a tool run for this task reported an error,
 * or the final output was truncated/aborted/errored. A mere prose mention of
 * "tests" or "checks" in a requirement is not a measurement and proves nothing.
 */
function contradictsRequirement(requirement: Requirement, snapshot: EvidenceSnapshot): string | null {
	const failed = snapshot.facts.filter((fact) => fact.kind === "tool_error" && factMatches(fact.subject, requirement));
	if (failed.length > 0) {
		return failed[0]!.source;
	}
	const terminal = snapshot.facts.filter((fact) => fact.kind === "truncation" || fact.kind === "aborted" || fact.kind === "error");
	if (terminal.length > 0) {
		return terminal[0]!.source;
	}
	return null;
}

/** Conservative subject match: only an explicit mention ties a failing tool to a requirement. */
function factMatches(subject: string, requirement: Requirement): boolean {
	const haystack = `${requirement.id} ${requirement.summary}`.toLowerCase();
	const needle = subject.toLowerCase().trim();
	return needle !== "" && needle !== "unknown" && haystack.includes(needle);
}

function directionMemo(mode: WorkMode, requirement: Requirement | undefined, snapshot: EvidenceSnapshot): string {
	const focus = requirement === undefined
		? "the requirement most affected could not be identified from the supplied evidence"
		: `requirement ${requirement.id}: “${requirement.summary}”`;
	return [
		`[Supervisor intervention: ${mode}]`,
		`The proposed actions were not executed because the current step needs ${mode.toLowerCase()} before it addresses ${focus}.`,
		`This decision came from an assessment of the supplied evidence; it is not a tool failure, a permission denial, or a safety judgement.`,
		`Revise the step against the evidence (recent actions and observed results) before proposing another implementation step. Keep the original task and Pi's normal controls unchanged.`,
		`Evidence revision: ${snapshot.scope.snapshotHash}`,
	].join("\n");
}

function completionMemo(mode: WorkMode, unmet: readonly Requirement[], snapshot: EvidenceSnapshot, claimsUnsupported: boolean): string {
	const list = unmet.length === 0
		? "- the final answer's support claims were not established by the supplied evidence"
		: unmet.map((requirement) => `- ${requirement.id} (${requirement.origin}): ${requirement.summary}`).join("\n");
	return [
		`[Supervisor completion check: ${mode}]`,
		`The completion claim was not accepted. Unmet or unverified requirements:`,
		list,
		claimsUnsupported ? "The final answer asserts results that the supplied evidence does not establish." : "",
		`Continue the same task from this concrete gap (${mode}). Do not treat this as a user instruction to change scope, and do not re-ask for authorization.`,
		`Evidence revision: ${snapshot.scope.snapshotHash}`,
	].filter(Boolean).join("\n");
}
