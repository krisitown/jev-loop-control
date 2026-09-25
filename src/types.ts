/**
 * Shared data shapes. No Pi or Node imports, so every module, test, and the
 * standalone CLI can use them.
 *
 * The assessment model follows the TypeSafe-compatible protocol: a question is
 * either a `choice` (an option map with criteria) or a `noul` (a single
 * yes/no question whose answer is the probability of YES). `noul` is therefore
 * NOT "probability of no useful signal"; on a noul answer 0.95 means 95% YES.
 * Only `choice` answers carry `probabilities` and `confidence`.
 */

import type { SupervisorConfig } from "./config.ts";
import type { VerificationRecord } from "./verification.ts";

export type Mode = SupervisorConfig["mode"];

/** Application routing roles. Question ids are routing keys, not instructions. */
export type QuestionRole =
	| "next_step"
	| "unproductive_repeat"
	| "focus_requirement"
	| "requirement"
	| "final_claims_supported"
	| "correction_needed"
	| "primary_concern"
	| "evidence_anchor"
	| "requirement_focus"
	| "completion_status";

export interface ChoiceCriteria {
	[option: string]: string;
}

export interface ChoiceQuestion {
	type: "choice";
	/** Routing key, e.g. `next_step`, `focus_requirement`, `requirement_R2`. */
	id: string;
	role: QuestionRole;
	/** Self-contained instructions; the question must carry its own meaning. */
	instructions: string;
	/** Option id -> what selecting it means. Also defines the valid options. */
	criteria: ChoiceCriteria;
	/** Requirement id when role is `requirement`. */
	requirementId?: string;
}

export interface NoulQuestion {
	type: "noul";
	id: string;
	role: QuestionRole;
	instructions: string;
	/** What YES and NO mean. The answer is the probability of YES. */
	criteria: { true: string; false: string };
	requirementId?: string;
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
	type: "choice";
	questionId: string;
	choice: string;
	/** Complete distribution over the question's options; sums to ~1. */
	probabilities: Record<string, number>;
	/** Provider-reported confidence; not necessarily P(selected). */
	confidence: number;
}

export interface NoulAnswer {
	type: "noul";
	questionId: string;
	/** Probability of YES, 0..1. */
	noul: number;
}

export type Answer = ChoiceAnswer | NoulAnswer;

export function optionIds(question: Question): string[] {
	return question.type === "choice" ? Object.keys(question.criteria) : ["true", "false"];
}

export function optionProbability(answer: Answer, option: string): number | undefined {
	return answer.type === "choice" ? answer.probabilities[option] : undefined;
}

/** YES probability of a noul answer; undefined for a choice answer. */
export function yesProbability(answer: Answer): number | undefined {
	return answer.type === "noul" ? answer.noul : undefined;
}

export interface CostInfo {
	/** Null means genuinely unknown, never 0. */
	billedUsd: number | null;
	marketUsd: number | null;
	/**
	 * True while the *billed* amount is unknown. A response that reports only a
	 * market price still leaves the billed amount unknown, so the conservative
	 * reservation stays in force.
	 */
	unknown: boolean;
}

export type AssessmentKind = "direction" | "completion";

export type AssessmentStatus =
	| "COMPLETE"
	| "EXECUTE"
	| "RESEARCH"
	| "REPLAN"
	| "VERIFY"
	| "BLOCKED"
	| "NEEDS_USER_INPUT"
	| "UNRESOLVED"
	| "UNCHECKED";

export interface Finding {
	requirementId?: string;
	/** Where the requirement came from: manifest, R0 request, or actor claim. */
	origin: string;
	summary: string;
	verdict: "met" | "unmet" | "unverified" | "contradicted";
	/** Cited evidence or deterministic fact; never an invented cause. */
	evidence: string;
}

/** One immutable assessment: the outcome of exactly one dispatched request. */
export interface Assessment {
	kind: AssessmentKind;
	/** False when the transport or the answer set was unusable. */
	ok: boolean;
	status: AssessmentStatus;
	/** Keyed by question id, matching the question map that was sent. */
	answers: Record<string, Answer>;
	findings: Finding[];
	notes: string;
	failure?: { stage: "budget" | "transport" | "response" | "validation" | "policy"; message: string };
	cost: CostInfo;
	usage: { requestBytes: number; responseBytes: number; attempts: number };
	timings: { startedAt: string; finishedAt: string; ms: number };
	requestId: string;
	/** Hashes of the exact sanitized bytes exchanged. */
	requestHash: string;
	responseHash: string;
	/**
	 * Paths of the exact sanitized bytes stored by the transport, relative to the
	 * run directory. These are the bytes that were sent and received, not a
	 * normalized re-encoding, and the hashes above describe them.
	 */
	artifacts?: { request: string | null; response: string | null };
	/**
	 * The exact sanitized outgoing body that was dispatched (bytes match
	 * `requestHash`), and the sanitized response artifact once decoded. Captured
	 * by the transport BEFORE dispatch; consumers must not rebuild fake artifacts
	 * from ids and normalized answers.
	 */
	requestBody?: string;
	responseBody?: string;
	/** Never guessed: `live` only for a real HTTP exchange. */
	origin: "live" | "synthetic" | "none";
	/**
	 * True when the live compact fallback carried partial context. This flag
	 * prevents COMPLETE even when snapshot.truncated is false and all
	 * requirements are MET, but does not affect assessment.ok or return
	 * UNCHECKED solely due to partial coverage.
	 */
	partialCoverage?: boolean;
}

export interface Requirement {
	id: string;
	summary: string;
	origin: string;
}

export type FactKind =
	| "tool_executed"
	| "tool_error"
	| "tool_result_without_execution"
	| "no_execution"
	| "truncation"
	| "aborted"
	| "error"
	| "freshness";

export interface DeterministicFact {
	kind: FactKind;
	subject: string;
	value: string;
	source: string;
}

/**
 * How a tool result became known. Pi emits `toolResult` messages for blocked and
 * invalid calls too, so a result alone is never proof that a tool ran.
 */
export type ToolProvenance = "executed" | "reported_without_execution_event";

export interface SnapshotToolCall {
	id: string;
	name: string;
	/** Complete sanitized arguments. Never partially truncated. */
	arguments: unknown;
	argsHash: string;
}

export interface SnapshotObservation {
	id: string;
	toolName: string;
	toolCallId: string;
	ok: boolean;
	provenance: ToolProvenance;
	text: string;
	/**
	 * What a reported check in this tool's OWN output said, when the tool ran a
	 * recognizable check (see verification.ts). This is a check outcome, not tool
	 * status and never proof that an arbitrary implementation is correct; `ok`
	 * stays exactly the tool's own error flag. Absent when no check was observed.
	 */
	verification?: VerificationRecord;
	/**
	 * Complete sanitized arguments of the finalized call, when it was found.
	 * The snapshot keeps them complete; the rendered `recent_actions` window may
	 * summarize them, always alongside the untruncated `argsHash`.
	 */
	arguments?: unknown;
	/** Hash of the COMPLETE sanitized arguments, never of a truncated view. */
	argsHash?: string;
}

export interface EvidenceSnapshot {
	target: { kind: "proposal" | "completion"; proposalHash: string; messageRef: string };
	task: { manifest: boolean; requirements: Requirement[]; origin: string };
	/** Bounded actor text; `truncated` says whether it was bounded. */
	actorText: string;
/** Full immutable snapshot; compaction applies only to the optional wire form. */

	proposalText: string;
	toolCalls: SnapshotToolCall[];
	observations: SnapshotObservation[];
	priorInterventions: Array<{ kind: string; at: string; focus: string }>;
	facts: DeterministicFact[];
	scope: { sessionId: string; taskId: string; branch: string; snapshotHash: string };
	/**
	 * True only when the CURRENT proposal itself had to be limited. Bounded actor
	 * history, bounded historical results, and bounded historical arguments are
	 * context selection and are reported under `representation.history` and
	 * `representation.context_selection` instead, never by flipping this flag.
	 */
	truncated: boolean;
	/**
	 * The exact sanitized representation the identity hash is computed over and
	 * that the request builder renders from. One source of truth: the hash and
	 * the bytes can then never describe different data.
	 */
	representation: Record<string, unknown>;
}

export interface Decision {
	assessment: Assessment;
	apply: "block" | "continue" | "none";
	status: AssessmentStatus;
	reasons: string[];
	memo: string | null;
	/** Suppresses a repeat of the same focus/mode without new evidence. */
	focusKey: string | null;
}

export interface BudgetState {
	requestsUsed: number;
	/** Reserved conservatively when the provider returned no cost. */
	reservedUsd: number;
	billedUsd: number;
	marketUsd: number;
	unknownCosts: number;
}

export function emptyBudget(): BudgetState {
	return { requestsUsed: 0, reservedUsd: 0, billedUsd: 0, marketUsd: 0, unknownCosts: 0 };
}

/** Injectable assessment transport. Tests inject a fake; production uses HTTP. */
export interface JevClient {
	readonly origin: "live" | "synthetic";
	assess(input: {
		kind: AssessmentKind;
		snapshot: EvidenceSnapshot;
		questions: Question[];
		state: Record<string, unknown>;
		signal: AbortSignal | undefined;
		deadlineMs: number;
	}): Promise<Assessment>;
}
