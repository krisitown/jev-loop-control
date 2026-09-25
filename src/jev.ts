/**
 * Jev transport and answer validation.
 *
 * One HTTP POST per assessment, no SDK, no framework. The caller's abort signal
 * is honoured during both the fetch and the body read, a total deadline bounds
 * the whole exchange, and the response is capped in bytes.
 *
 * The ONE exception to "one request": an HTTP 503 is retried on a fixed backoff
 * schedule (`HTTP_503_RETRY_DELAYS_MS`: 500ms, 1000ms, 2000ms) up to
 * `HTTP_503_MAX_ATTEMPTS` total dispatched requests (initial + 3 retries).
 * Overloaded servers are the only case we pay for twice, and every attempt stays
 * inside the same total deadline and abort signal. Nothing else is ever retried:
 * no other HTTP code, no malformed or invalid response, no deadline, no
 * cancellation, no missing key.
 *
 * Answers are validated against the exact question map that was sent, using the
 * TypeSafe-compatible shapes:
 *   choice  -> { type: "choice", choice, probabilities, confidence }
 *   noul    -> { type: "noul", noul }   // noul is the probability of YES
 * A missing question, a wrong answer type, a non-finite number, an unknown
 * option, a distribution that does not close, or a choice that contradicts its
 * own distribution invalidates the assessment. Nothing is repaired.
 */

import { randomUUID } from "node:crypto";
import { hashBytes, redactText, removeLiteral } from "./redact.ts";
import { optionIds, type Answer, type Assessment, type AssessmentKind, type CostInfo, type EvidenceSnapshot, type JevClient, type Question } from "./types.ts";

/** Conservative ceiling for the compact fallback packet (comfortably below 49152). */
/** Max characters kept from any single string field in the fallback packet. */
const FALLBACK_STRING_CLIP = 2000;
/** Max items kept from any single array in the fallback packet. */
const FALLBACK_ARRAY_CLIP = 20;
/** Max requirement questions retained in a completion fallback. */
const FALLBACK_COMPLETION_REQ_MAX = 8;
/** Max IDs sampled in the omitted-ID summary. */
const FALLBACK_OMITTED_SAMPLE = 10;

export const PROBABILITY_SUM_TOLERANCE = 0.02;
export const SELECTED_PROBABILITY_TOLERANCE = 1e-6;

/** The only status ever retried. */
export const HTTP_503_RETRY_STATUS = 503;
/** The exponential wait BEFORE each retry: 500ms, 1000ms, 2000ms. */
export const HTTP_503_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
/** Total dispatched requests for one assessment: the initial one plus 3 retries. */
export const HTTP_503_MAX_ATTEMPTS = HTTP_503_RETRY_DELAYS_MS.length + 1;
/** Default overall deadline when the caller gave none. */
export const DEFAULT_JEV_DEADLINE_MS = 10_000;

/**
 * True only for "the server is overloaded right now": HTTP 503 with a
 * cancellation/deadline that did NOT happen (`aborted`). A 503 whose drain was
 * cut short by the deadline or the caller is not a trustworthy exchange and is
 * never retried.
 */
export function isRetryable503(outcome: Pick<ExchangeOutcome, "ok" | "status" | "aborted">): boolean {
	return !outcome.ok && outcome.status === HTTP_503_RETRY_STATUS && !outcome.aborted;
}

/**
 * A promise that resolves after `ms`, or rejects with "cancelled" as soon as
 * the signal aborts. The retry wait can never outlive a cancellation.
 */
export function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(1, ms));
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("cancelled"));
		};
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

export interface RetryBudgetInput {
	/** The failed 503 exchange; its unknown cost is already counted by the caller. */
	kind: AssessmentKind;
	/** Attempts already dispatched for this assessment, including failed 503s. */
	attempts: number;
}

export interface HttpClientOptions {
	endpoint: string;
	model: string;
	/** Name of the environment variable holding the key; never the key itself. */
	apiKeyEnv: string;
	deadlineMs: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	/** Extra literal values to strip from anything we store (e.g. the key). */
	secrets?: readonly string[];
	/**
	 * Optional gate for each 503 retry. The client has no budget of its own:
	 * the adapter owns the request cap and the monetary allowance, so it answers
	 * whether the next dispatched request is affordable. `undefined` means "no
	 * retry budget configured", and no retry is then ever taken.
	 */
	retryBudget?: (input: RetryBudgetInput) => { allowed: boolean; reason?: string };
}

export interface RequestBuild {
	body: string;
	bytes: number;
	hash: string;
}

/** Build the exact outgoing body. `state` is already sanitized by the caller. */
export function buildRequestBody(options: { model: string; state: Record<string, unknown>; questions: readonly Question[] }, scrub: (text: string) => string = (t) => t): RequestBuild {
	const questions: Record<string, Record<string, unknown>> = {};
	for (const question of options.questions) {
		questions[question.id] = {
			type: question.type,
			instructions: scrub(question.instructions),
			criteria: Object.fromEntries(Object.entries(question.criteria).map(([option, description]) => [option, scrub(description)])),
		};
	}
	const body = JSON.stringify({ model: options.model, state: scrubJson(options.state, scrub), questions });
	return { body, bytes: Buffer.byteLength(body, "utf8"), hash: hashBytes(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic generic JSON/string clipping with hashes. No language-specific parsing. */
function clipValue(value: unknown, depth: number = 0, maxChars: number = FALLBACK_STRING_CLIP): unknown {
	if (depth > 6) return "[depth-clipped]";
	if (typeof value === "string") {
		const chars = Array.from(value);
		if (chars.length <= maxChars) return value;
		const half = Math.floor(maxChars / 2);
		const head = chars.slice(0, half).join("");
		const tail = chars.slice(-half).join("");
		const hash = hashBytes(Buffer.from(value, "utf8"));
		return `${head}...[clipped:${hash}]...${tail}`;
	}
	if (Array.isArray(value)) {
		if (value.length <= FALLBACK_ARRAY_CLIP) return value.map((v) => clipValue(v, depth + 1, maxChars));
		const head = value.slice(0, FALLBACK_ARRAY_CLIP / 2).map((v) => clipValue(v, depth + 1, maxChars));
		const tail = value.slice(-FALLBACK_ARRAY_CLIP / 2).map((v) => clipValue(v, depth + 1, maxChars));
		const hash = hashBytes(Buffer.from(JSON.stringify(value), "utf8"));
		return [...head, `[array-clipped:${hash}]`, ...tail];
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = clipValue(v, depth + 1, maxChars);
		}
		return out;
	}
	return value;
}
/** Clone a question, clipping strings per type. */
function cloneQuestion(q: Question, clip: (s: string) => string): Question {
	if (q.type === "choice") {
		return {
			...q,
			instructions: clip(q.instructions),
			criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, clip(v)])),
		};
	}
	// noul: map true/false explicitly, clip strings
	return {
		...q,
		instructions: clip(q.instructions),
		criteria: { true: clip(q.criteria.true), false: clip(q.criteria.false) },
	};
}

function buildFallbackPacket(
	kind: AssessmentKind,
	state: Record<string, unknown>,
	questions: readonly Question[],
	scrub: (text: string) => string,
	model: string,
	maxRequestBytes: number,
): { state: Record<string, unknown>; questions: Question[]; built: RequestBuild } | null {
	const originalStateHash = hashBytes(Buffer.from(JSON.stringify(state), "utf8"));
	const originalQuestionsHash = hashBytes(Buffer.from(JSON.stringify(questions), "utf8"));
	const originalStateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
const originalQuestionsBytes = Buffer.byteLength(JSON.stringify(questions), "utf8");
	const originalRequestHash = hashBytes(buildRequestBody({ model, state, questions }, scrub).body);

	const budgets = [
		{ reqMax: 8, arrClip: 4, strClip: 500 },
		{ reqMax: 4, arrClip: 2, strClip: 200 },
		{ reqMax: 2, arrClip: 1, strClip: 100 },
	];

	for (const budget of budgets) {
		const clip = (value: unknown) => clipValue(value, 0, budget.strClip);
		const compactState: Record<string, unknown> = {};
		const evidence: Record<string, unknown> = {};
		const omittedReqIds: string[] = [];
		const omittedQIds: string[] = [];

		// Task Requirements
		if (isRecord(state.task) && Array.isArray((state.task as Record<string, unknown>).requirements)) {
			const reqs = (state.task as Record<string, unknown>).requirements as unknown[];
			const keptReqs: unknown[] = [];
			if (reqs.length <= budget.reqMax) {
				keptReqs.push(...reqs);
			} else {
				const half = Math.floor(budget.reqMax / 2);
				keptReqs.push(...reqs.slice(0, half));
				keptReqs.push(...reqs.slice(-half));
				for (let i = half; i < reqs.length - half; i++) {
					const r = reqs[i];
					if (isRecord(r) && typeof r.id === "string") omittedReqIds.push(r.id);
				}
			}
			evidence.task_requirements = keptReqs.map((r) => clip(r));
		}

const ahRaw = isRecord(state.evidence) ? state.evidence.actor_history : undefined;
		let historyClipped = false;
		if (isRecord(ahRaw) && typeof ahRaw.text === "string") {
			const rawText = ahRaw.text;
			const originalChars = Array.from(rawText).length;

			// Split into blocks separated by blank lines
const rawBlocks = rawText.split(/\n\s*\n(?=\s*(?:\[user\]:|\[assistant\]:|\[toolResult\]:))/);
			const blocks: string[] = [];
			for (const b of rawBlocks) {
				const trimmed = b.trim();
				if (trimmed.length > 0) {
					blocks.push(trimmed);
				}
			}

			// Identify user blocks
			const userIndices: number[] = [];
			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i];
				if (typeof block === 'string' && (/^\s*\[user\]:/i.test(block) || /^\s*user\s*:/i.test(block))) {
					userIndices.push(i);
				}
			}

			let selectedIndices: number[] = [];
			if (userIndices.length > 0) {
				const firstIdx = userIndices[0]!;
				const lastIdx = userIndices[userIndices.length - 1]!;
				if (firstIdx === lastIdx) {
					selectedIndices = [firstIdx];
				} else {
					selectedIndices = [firstIdx, lastIdx];
				}
			} else {
				// No user blocks: choose first and latest blocks
				if (blocks.length === 1) {
					selectedIndices = [0];
				} else if (blocks.length > 1) {
					selectedIndices = [0, blocks.length - 1];
				}
			}

			// Clip selected blocks using budget.strClip
			const clippedBlocks: string[] = [];
			for (const idx of selectedIndices) {
				const block = blocks[idx];
				if (typeof block !== 'string') continue;
				const clipped = Array.from(block).length <= budget.strClip ? block : (() => { const chars = Array.from(block); const half = Math.floor(budget.strClip / 2); return chars.slice(0, half).join('') + hashBytes(block) + chars.slice(-half).join(''); })();
				clippedBlocks.push(clipped);
				if (clipped !== block) {
					historyClipped = true;
				}
			}

			const retainedBlocks = selectedIndices.length;
			const omittedBlocks = blocks.length - retainedBlocks;
			const truncated = omittedBlocks > 0 || historyClipped;
			const joinedText = clippedBlocks.join("\n\n");

			evidence.actor_history = {
				text: joinedText,
				truncated: truncated,
				original_chars: originalChars,
				retained_blocks: retainedBlocks,
				omitted_blocks: omittedBlocks
			};
		}
		// Evidence: Arrays
		if (isRecord(state.evidence)) {
			const ev = state.evidence as Record<string, unknown>;
			for (const key of ["observations", "recent_actions", "verification_checks", "deterministic_facts", "prior_interventions"]) {
				if (Array.isArray(ev[key])) {
					const arr = ev[key] as unknown[];
					const kept = arr.slice(-budget.arrClip);
					evidence[key] = kept.map((v) => clip(v));
					if (arr.length > budget.arrClip) evidence[`${key}_omitted`] = arr.length - budget.arrClip;
				}
			}
		}

// Proposal
		let proposalClipped = false;
		if (isRecord(state.proposal)) {
			const prop = state.proposal as Record<string, unknown>;
			if (typeof prop.assistant_text === "string") {
				const clipped = clip(prop.assistant_text);
				evidence.proposal_assistant_text = clipped;
				const wasClipped = JSON.stringify(clipped) !== JSON.stringify(prop.assistant_text);
				evidence.proposal_assistant_text_clipped = wasClipped;
				if (wasClipped) proposalClipped = true;
			}
			if (typeof prop.final_answer === "string") {
				const clipped = clip(prop.final_answer);
				evidence.proposal_final_answer = clipped;
				if (JSON.stringify(clipped) !== JSON.stringify(prop.final_answer)) proposalClipped = true;
			}
			if (Array.isArray(prop.tool_calls)) {
				const tcs = prop.tool_calls as unknown[];
				const kept = tcs.slice(0, budget.arrClip);
				evidence.proposal_tool_calls = kept.map((tc) => {
					const clipped = clip(tc);
					if (JSON.stringify(clipped) !== JSON.stringify(tc)) proposalClipped = true;
					return clipped;
				});
				if (tcs.length > budget.arrClip) {
					evidence.proposal_tool_calls_omitted = tcs.length - budget.arrClip;
					proposalClipped = true;
				}
			}
		}

		// Controller
		if (isRecord(state.controller)) {
			const ctrl = state.controller as Record<string, unknown>;
			if (ctrl.active_recovery_objective !== undefined) evidence.active_recovery_objective = clip(ctrl.active_recovery_objective);
			if (Array.isArray(ctrl.previous_interventions)) {
				const pi = ctrl.previous_interventions as unknown[];
				evidence.previous_interventions = pi.slice(-budget.arrClip).map((v) => clip(v));
				if (pi.length > budget.arrClip) evidence.previous_interventions_omitted = pi.length - budget.arrClip;
			}
		}

		// Questions
		const compactQuestions: Question[] = [];
		if (kind === "direction") {
			const keepRoles = new Set(["next_step", "unproductive_repeat", "focus_requirement"]);
			const retainedReqIds = new Set<string>(["NONE", "UNKNOWN"]);
			if (isRecord(state.task) && Array.isArray((state.task as Record<string, unknown>).requirements)) {
				const allReqs = (state.task as Record<string, unknown>).requirements as unknown[];
				const keptReqs: unknown[] = [];
				if (allReqs.length <= budget.reqMax) {
					keptReqs.push(...allReqs);
				} else {
					const half = Math.floor(budget.reqMax / 2);
					keptReqs.push(...allReqs.slice(0, half));
					keptReqs.push(...allReqs.slice(-half));
				}
				for (const r of keptReqs) {
					if (isRecord(r) && typeof r.id === "string") retainedReqIds.add(r.id);
				}
			}
			for (const q of questions) {
				if (keepRoles.has(q.role)) {
					if (q.role === "focus_requirement") {
						const filteredCriteria: Record<string, string> = {};
						for (const [k, v] of Object.entries(q.criteria)) {
							if (retainedReqIds.has(k)) filteredCriteria[k] = clip(v) as string;
						}
						if (q.type === "choice") {
							compactQuestions.push({
								...q,
								instructions: clip(q.instructions) as string,
								criteria: filteredCriteria,
							});
						} else {
							compactQuestions.push({
								...q,
								instructions: clip(q.instructions) as string,
								criteria: filteredCriteria,
							} as Question);
						}
					} else {
						compactQuestions.push(cloneQuestion(q, (s) => clip(s) as string));
					}
				} else {
					omittedQIds.push(q.id);
				}
			}
		} else {
			const reqQs = questions.filter((q) => q.role === "requirement");
			const otherQs = questions.filter((q) => q.role !== "requirement");
			const keptReq: Question[] = [];
			if (reqQs.length <= budget.reqMax) {
				keptReq.push(...reqQs);
			} else {
				const half = Math.floor(budget.reqMax / 2);
				keptReq.push(...reqQs.slice(0, half));
				keptReq.push(...reqQs.slice(-half));
				for (let i = half; i < reqQs.length - half; i++) omittedQIds.push(reqQs[i]!.id);
			}
			for (const q of otherQs) {
				if (q.role === "final_claims_supported" || q.role === "next_step") keptReq.push(q);
				else omittedQIds.push(q.id);
			}
			for (const q of keptReq) {
				compactQuestions.push(cloneQuestion(q, (s) => clip(s) as string));
			}
		}

		// Metadata
		const omittedSample = omittedQIds.slice(0, 8);
		const omittedHash = omittedQIds.length > 0 ? hashBytes(Buffer.from(JSON.stringify(omittedQIds), "utf8")) : "";
		const reqOmittedSample = omittedReqIds.slice(0, 8);
		const reqOmittedHash = omittedReqIds.length > 0 ? hashBytes(Buffer.from(JSON.stringify(omittedReqIds), "utf8")) : "";

		compactState._fallback = {
			partial_coverage: true,
			notice: "Omitted context is absence of evidence, not proof of missing work. Express uncertainty.",
original_request_hash: originalRequestHash,
			original_state_hash: originalStateHash,
			original_questions_hash: originalQuestionsHash,
			original_state_bytes: originalStateBytes,
			original_questions_bytes: originalQuestionsBytes,
			retained_question_count: compactQuestions.length,
			omitted_question_count: omittedQIds.length,
			omitted_id_sample: omittedSample,
			omitted_ids_hash: omittedHash,
			retained_requirement_count: (evidence.task_requirements as unknown[])?.length ?? 0,
			omitted_requirement_count: omittedReqIds.length,
			omitted_req_id_sample: reqOmittedSample,
			omitted_req_ids_hash: reqOmittedHash,
			history_clipped: historyClipped,
proposal_clipped: proposalClipped,

		};

const finalState: Record<string, unknown> = {
  _fallback: compactState._fallback,
  task: {
    ...(isRecord(state.task) && typeof state.task.id === 'string' && { id: state.task.id }),
    ...(isRecord(state.task) && typeof state.task.requirements_origin === 'string' && { requirements_origin: state.task.requirements_origin }),
    ...(isRecord(state.task) && typeof state.task.manifest === 'boolean' && { manifest: state.task.manifest }),
    ...(evidence.task_requirements !== undefined && { requirements: evidence.task_requirements }),
  },
  controller: {
    ...(isRecord(state.controller) && typeof state.controller.work_mode === 'string' && { work_mode: state.controller.work_mode }),
    ...(isRecord(state.controller) && typeof state.controller.proposal_number === 'number' && { proposal_number: state.controller.proposal_number }),
    ...(isRecord(state.controller) && typeof state.controller.interventions_used === 'number' && { interventions_used: state.controller.interventions_used }),
    ...(isRecord(state.controller) && (typeof state.controller.intervention_limit === 'number' || state.controller.intervention_limit === null) && { intervention_limit: state.controller.intervention_limit }),
    ...(evidence.previous_interventions !== undefined && { previous_interventions: evidence.previous_interventions }),
    ...(evidence.active_recovery_objective !== undefined && { active_recovery_objective: evidence.active_recovery_objective }),
  },
  evidence: {
    ...(isRecord(state.evidence) && typeof state.evidence.revision === 'string' && { revision: state.evidence.revision }),
    ...(isRecord(state.evidence) && isRecord(state.evidence.session) && { session: clip(state.evidence.session) }),
    ...(evidence.actor_history !== undefined && { actor_history: evidence.actor_history }),
    ...(evidence.observations !== undefined && { observations: evidence.observations }),
    ...(evidence.recent_actions !== undefined && { recent_actions: evidence.recent_actions }),
    ...(evidence.verification_checks !== undefined && { verification_checks: evidence.verification_checks }),
    ...(evidence.deterministic_facts !== undefined && { deterministic_facts: evidence.deterministic_facts }),
    ...(evidence.prior_interventions !== undefined && { prior_interventions: evidence.prior_interventions }),
    ...(evidence.known_external_blockers !== undefined && { known_external_blockers: evidence.known_external_blockers }),
    ...(isRecord(state.evidence) && typeof state.evidence.omitted_counts === 'object' && state.evidence.omitted_counts !== null && { omitted_counts: state.evidence.omitted_counts }),
    ...(isRecord(state.evidence) && typeof state.evidence.omitted_samples === 'object' && state.evidence.omitted_samples !== null && { omitted_samples: state.evidence.omitted_samples }),
    ...(evidence.context_selection !== undefined && { context_selection: evidence.context_selection }),
    ...(isRecord(state.evidence) && typeof state.evidence.redactions_present === 'boolean' && { redactions_present: state.evidence.redactions_present }),
  },
  proposal: {
    ...(isRecord(state.proposal) && typeof state.proposal.id === 'string' && { id: state.proposal.id }),
    ...(evidence.proposal_assistant_text !== undefined && { assistant_text: evidence.proposal_assistant_text }),
    ...(evidence.proposal_final_answer !== undefined && { final_answer: evidence.proposal_final_answer }),
    ...(evidence.proposal_tool_calls !== undefined && { tool_calls: evidence.proposal_tool_calls }),
  },
};
		const built = buildRequestBody({ model, state: finalState, questions: compactQuestions }, scrub);

		if (!fallbackExceedsLimits(built, maxRequestBytes ?? 24000)) {
			return { state: finalState, questions: compactQuestions, built };
		}
	}
	return null;
}

function fallbackExceedsLimits(built: RequestBuild, maxRequestBytes: number): boolean {
	if (built.bytes > maxRequestBytes) return true;
	const bodyBytes = Buffer.byteLength(built.body, "utf8");
	if (Math.ceil(bodyBytes / 2) > 32000) return true;
	try {
		const parsed = JSON.parse(built.body);
		const stateBytes = Buffer.byteLength(JSON.stringify(parsed.state), "utf8");
		let maxQBytes = 0;
		if (parsed.questions) {
			for (const q of Object.values(parsed.questions)) {
				const len = Buffer.byteLength(JSON.stringify(q), "utf8");
				if (len > maxQBytes) maxQBytes = len;
			}
		}
		if (Math.ceil((stateBytes + maxQBytes) / 2) > 16000) return true;
	} catch {
		return true;
	}
	return false;
}
export type ValidationResult =
	| { ok: true; answers: Record<string, Answer>; cost: CostInfo; providerId: string | null }
	| { ok: false; problems: string[]; cost: CostInfo; providerId: string | null };

/** Strictly validate a decoded response against the questions that were sent. */
export function validateResponse(payload: unknown, questions: readonly Question[]): ValidationResult {
	const unknownCost: CostInfo = { billedUsd: null, marketUsd: null, unknown: true };
	if (!isRecord(payload)) {
		return { ok: false, problems: ["response is not a JSON object"], cost: unknownCost, providerId: null };
	}
	const cost = readCost(payload);
	const providerId = typeof payload.id === "string" ? payload.id : typeof payload.request_id === "string" ? payload.request_id : null;
	const rawAnswers = payload.answers;
	if (rawAnswers === undefined) {
		return { ok: false, problems: ["response has no `answers`"], cost, providerId };
	}
	const entries: Array<[string, unknown]> = Array.isArray(rawAnswers)
		? rawAnswers.map((item, index) => [isRecord(item) ? String(item.id ?? item.question_id ?? index) : String(index), item] as [string, unknown])
		: isRecord(rawAnswers)
			? Object.entries(rawAnswers)
			: [];
	const byId = new Map(entries);
	const problems: string[] = [];
	const answers: Record<string, Answer> = {};

	for (const question of questions) {
		const raw = byId.get(question.id);
		if (raw === undefined) {
			problems.push(`${question.id}: missing answer`);
			continue;
		}
		if (!isRecord(raw)) {
			problems.push(`${question.id}: answer is not an object`);
			continue;
		}
		// A missing `type` is not inferred: the protocol says what each answer is.
		const type = raw.type;
		if (type !== question.type) {
			problems.push(`${question.id}: answer type ${JSON.stringify(type)} does not match the ${question.type} question`);
			continue;
		}
		if (question.type === "noul") {
			const noul = raw.noul;
			if (typeof noul !== "number" || !Number.isFinite(noul)) {
				problems.push(`${question.id}: noul must be a finite number`);
				continue;
			}
			if (noul < 0 || noul > 1) {
				problems.push(`${question.id}: noul ${noul} is outside 0..1`);
				continue;
			}
			answers[question.id] = { type: "noul", questionId: question.id, noul };
			continue;
		}

		const options = optionIds(question);
		const probabilities = raw.probabilities;
		if (!isRecord(probabilities)) {
			problems.push(`${question.id}: choice answer has no probabilities object`);
			continue;
		}
		const distribution: Record<string, number> = {};
		let malformed = false;
		for (const option of options) {
			const value = probabilities[option];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
				problems.push(`${question.id}: probability for ${option} is not a finite number in 0..1`);
				malformed = true;
				break;
			}
			distribution[option] = value;
		}
		if (malformed) {
			continue;
		}
		for (const key of Object.keys(probabilities)) {
			if (!options.includes(key)) {
				problems.push(`${question.id}: distribution contains the unknown option ${key}`);
				malformed = true;
			}
		}
		if (malformed) {
			continue;
		}
		const sum = options.reduce((total, option) => total + distribution[option]!, 0);
		if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
			problems.push(`${question.id}: distribution sums to ${sum.toFixed(4)}, more than ${PROBABILITY_SUM_TOLERANCE} from 1`);
			continue;
		}
		const choice = raw.choice;
		if (typeof choice !== "string" || !options.includes(choice)) {
			problems.push(`${question.id}: choice ${JSON.stringify(choice)} is not one of ${options.join(", ")}`);
			continue;
		}
		const best = Math.max(...options.map((option) => distribution[option]!));
		if (distribution[choice]! < best - SELECTED_PROBABILITY_TOLERANCE) {
			problems.push(`${question.id}: choice ${choice} contradicts its own distribution`);
			continue;
		}
		const confidence = raw.confidence;
		if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
			problems.push(`${question.id}: confidence must be a finite number in 0..1`);
			continue;
		}
		answers[question.id] = { type: "choice", questionId: question.id, choice, probabilities: distribution, confidence };
	}
	if (problems.length > 0) {
		return { ok: false, problems, cost, providerId };
	}
	return { ok: true, answers, cost, providerId };
}

function readCost(payload: Record<string, unknown>): CostInfo {
	const source = isRecord(payload.cost) ? payload.cost : isRecord(payload.usage) && isRecord(payload.usage.cost) ? payload.usage.cost : undefined;
	// A negative charge is a malformed response, not a discount: it reads as unknown.
	const pick = (key: string): number | null => {
		const value = source?.[key];
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
	};
	const billedUsd = pick("billed_usd") ?? pick("billed") ?? pick("usd");
	const marketUsd = pick("market_usd") ?? pick("market");
	// An absent charge field is unknown, never zero. `unknown` tracks the BILLED
	// amount only: a market price alone does not settle what we were charged, so
	// the conservative reservation stays in force even when market is known.
	return { billedUsd, marketUsd, unknown: billedUsd === null };
}

export interface ExchangeOutcome {
	/** How many HTTP requests this exchange actually dispatched (1 or 0). */
	attempts: number;
	ok: boolean;
	status: number | null;
	bytes: number;
	/** Populated when the JSON decoded. */
	payload?: unknown;
	/** The raw response text actually read (caller still scrubs it). */
	responseText?: string;
	error?: string;
	timedOut: boolean;
	aborted: boolean;
}

/**
 * One bounded HTTP attempt. The abort signal and the deadline both interrupt the
 * fetch and the body read; the body read is additionally capped in bytes.
 */
export async function postAssessment(options: {
	endpoint: string;
	apiKey: string;
	body: string;
	deadlineMs: number;
	maxResponseBytes: number;
	signal: AbortSignal | undefined;
	fetchImpl?: typeof fetch;
}): Promise<ExchangeOutcome> {
	const controller = new AbortController();
	const external = options.signal;
	let timedOut = false;
	let settled = false;
	// 0 until a request is actually put on the wire.
	let attempts = 0;

	const onExternalAbort = (): void => {
		if (!settled) {
			controller.abort(external?.reason ?? new Error("aborted by the host run"));
		}
	};
	if (external) {
		if (external.aborted) {
			return { attempts: 0, ok: false, status: null, bytes: 0, error: "cancelled before dispatch", timedOut: false, aborted: true };
		}
		external.addEventListener("abort", onExternalAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("deadline exceeded"));
	}, Math.max(1, options.deadlineMs));

	const doFetch = options.fetchImpl ?? fetch;
	try {
		attempts = 1;
		const response = await doFetch(options.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${options.apiKey}` },
			body: options.body,
			signal: controller.signal,
		});
		if (!response.ok) {
			// Drain a small error body so a connection is not left dangling, but a
			// cancellation/deadline during the drain still means "no trustworthy exchange".
			const drained = await readCapped(response, 8192, controller.signal).catch(() => undefined);
			if (controller.signal.aborted) {
				return { attempts, ok: false, status: response.status, bytes: 0, error: timedOut ? "deadline exceeded" : "cancelled", timedOut, aborted: true };
			}
			return { attempts, ok: false, status: response.status, bytes: 0, error: `HTTP ${response.status}`, responseText: drained?.text, timedOut, aborted: false };
		}
		const read = await readCapped(response, options.maxResponseBytes, controller.signal);
		// A cancellation or deadline at ANY point of the read, including one that
		// made reader.cancel() resolve `done` over complete-looking partial bytes,
		// can never produce a success path.
		if (controller.signal.aborted) {
			return { attempts, ok: false, status: response.status, bytes: read.bytes, error: timedOut ? "deadline exceeded" : "cancelled", timedOut, aborted: true };
		}
		if (read.tooLarge) {
			return { attempts, ok: false, status: response.status, bytes: read.bytes, error: `response exceeds ${options.maxResponseBytes} bytes`, timedOut, aborted: controller.signal.aborted };
		}
		try {
			const payload = JSON.parse(read.text) as unknown;
			return { attempts, ok: true, status: response.status, bytes: read.bytes, payload, responseText: read.text, timedOut: false, aborted: false };
		}
		catch {
			return { attempts, ok: false, status: response.status, bytes: read.bytes, error: "response body is not valid JSON", responseText: read.text.slice(0, 8192), timedOut, aborted: false };
		}
	}
	catch (error) {
		const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
		return {
			attempts,
			ok: false,
			status: null,
			bytes: 0,
			error: timedOut ? "deadline exceeded" : aborted ? "cancelled" : "transport error: request failed",
			timedOut,
			aborted,
		};
	}
	finally {
		settled = true;
		clearTimeout(timer);
		if (external) {
			external.removeEventListener("abort", onExternalAbort);
		}
	}
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
	// Check BEFORE acquiring the body: a listener registered on an already-aborted
	// signal never fires, so an `abort`-based unblock would hang forever.
	if (signal.aborted) {
		void response.body?.cancel().catch(() => undefined);
		return { text: "", bytes: 0, tooLarge: false };
	}
	if (!response.body) {
		const text = await response.text();
		const bytes = Buffer.byteLength(text, "utf8");
		return { text, bytes, tooLarge: bytes > maxBytes };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let tooLarge = false;
	const onAbort = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	// Re-check immediately after registration: the signal may have aborted in the
	// gap between the first check and the listener, and no further event will come.
	if (signal.aborted) {
		onAbort();
	}
	try {
		for (;;) {
			if (signal.aborted) {
				onAbort();
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (signal.aborted) {
				// Bytes received after cancellation are discarded, never accepted.
				chunks.length = 0;
				bytes = 0;
				break;
			}
			if (value) {
				chunks.push(value);
				bytes += value.byteLength;
				if (bytes > maxBytes) {
					tooLarge = true;
					await reader.cancel().catch(() => undefined);
					break;
				}
			}
		}
	}
	finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	const merged = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), bytes, tooLarge };
}

/** The production client: real HTTP, strict validation, compact oversize fallback. */
export function createHttpClient(options: HttpClientOptions): JevClient {
	const env = options.env ?? process.env;
	const scrub = (text: string): string => removeLiteral(redactText(text), options.secrets ?? []);
	return {
		origin: "live",
		async assess({ kind, snapshot, questions, state, signal, deadlineMs }): Promise<Assessment> {
			const startedAt = new Date().toISOString();
			const start = performance.now();
			const finish = (assessment: Omit<Assessment, "kind" | "timings">): Assessment => ({
				...assessment,
				kind,
				timings: { startedAt, finishedAt: new Date().toISOString(), ms: Math.round(performance.now() - start) },
			});

			const apiKey = env[options.apiKeyEnv];
			if (!apiKey) {
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: "",
					failure: { stage: "transport", message: `environment variable ${options.apiKeyEnv} is not set` },
					cost: { billedUsd: null, marketUsd: null, unknown: true },
					usage: { requestBytes: 0, responseBytes: 0, attempts: 0 },
					requestId: randomUUID(),
					requestHash: "",
					responseHash: "",
					origin: "live",
				});
			}

			const built = buildRequestBody({ model: options.model, state, questions }, scrub);
			// The exact sanitized outgoing bytes, captured BEFORE dispatch; the
			// request hash describes these bytes and nothing else.
			const requestBody = scrub(built.body);
			const requestHash = hashBytes(requestBody);
			const requestId = randomUUID();
			const responseArtifact = (outcome: ExchangeOutcome): { responseBody: string | undefined; responseHash: string } => {
				if (outcome.responseText === undefined) {
					return { responseBody: undefined, responseHash: "" };
				}
				// Validation/provider errors are scrubbed for the configured key too.
				const responseBody = scrub(outcome.responseText);
				return { responseBody, responseHash: hashBytes(responseBody) };
			};

			// Determine if the original request exceeds limits.
			const originalExceedsConfigured = built.bytes > options.maxRequestBytes;
			const originalExceedsConservative = (() => {
				const parsed = JSON.parse(requestBody);
				const bodyBytes = Buffer.byteLength(requestBody, 'utf8');
				const stateBytes = Buffer.byteLength(JSON.stringify(parsed.state), 'utf8');
				let maxQBytes = 0;
				for (const [id, q] of Object.entries(parsed.questions)) {
					const len = Buffer.byteLength(JSON.stringify({ [id]: q }), 'utf8');
					if (len > maxQBytes) maxQBytes = len;
				}
				const estTotal = Math.ceil(bodyBytes / 2);
				const estStateLongest = Math.ceil((stateBytes + maxQBytes) / 2);
				return estTotal > 32000 || estStateLongest > 16000;
			})();

			// Select the final packet and questions for dispatch.
			let dispatchBody: string;
			let dispatchBytes: number;
			let dispatchHash: string;
			let dispatchQuestions: readonly Question[];
			let fallbackNote: string | null = null;

			if (originalExceedsConfigured || originalExceedsConservative) {
				// Build compact fallback packet from already-scrubbed state and exact questions.
				const fallback = buildFallbackPacket(kind, state, questions, scrub, options.model, options.maxRequestBytes);
				if (fallback === null) {
					return finish({
						ok: false,
						status: "UNCHECKED",
						answers: {},
						findings: [],
						notes: "",
						failure: { stage: "budget", message: "oversize fallback still exceeds configured/conservative limits" },
						cost: { billedUsd: null, marketUsd: null, unknown: true },
						usage: { requestBytes: built.bytes, responseBytes: 0, attempts: 0 },
						requestId,
						requestHash,
						requestBody,
						responseHash: "",
						origin: "live",
						partialCoverage: true,
					});
				}

				dispatchBody = fallback.built.body;
				dispatchBytes = fallback.built.bytes;
				dispatchHash = fallback.built.hash;
				dispatchQuestions = fallback.questions;
				fallbackNote = "fallback partial context sent";
			} else {
				dispatchBody = requestBody;
				dispatchBytes = built.bytes;
				dispatchHash = requestHash;
				dispatchQuestions = questions;
			}

			// Use the selected packet for dispatch.
			const finalRequestBody = dispatchBody;
			const finalRequestHash = dispatchHash;
			const finalRequestBytes = dispatchBytes;
			const finalQuestions = dispatchQuestions;

			// --- dispatch, with the 503 retry schedule --------------------------------
			// Every failure except a clean HTTP 503 is final. A 503 is retried on the
			// exponential waits (500/1000/2000ms) up to HTTP_503_MAX_ATTEMPTS dispatched
			// requests, inside the same total deadline and abort signal, and only when
			// the caller's retry budget allows the next dispatched request. The gate is
			// asked BEFORE every retry with the actual attempts dispatched so far.
			const dispatch = (remainingMs: number): Promise<ExchangeOutcome> => postAssessment({
				endpoint: options.endpoint,
				apiKey,
				body: finalRequestBody,
				deadlineMs: remainingMs,
				maxResponseBytes: options.maxResponseBytes,
				signal,
				fetchImpl: options.fetchImpl,
			});

			const overallDeadlineMs = deadlineMs > 0 ? deadlineMs : DEFAULT_JEV_DEADLINE_MS;
			let exchange = await dispatch(overallDeadlineMs);
			let attempts = exchange.attempts;
			let retryNote: string | null = null;
			while (!exchange.ok && isRetryable503(exchange)) {
				if (attempts >= HTTP_503_MAX_ATTEMPTS) {
					retryNote ??= `http 503: retry limit reached after ${attempts} attempts`;
					break;
				}
				// The failed attempt's cost is unknown and stays unknown; the caller's
				// reservation for it stays armed. This asks for room for ONE more,
				// with the actual attempts dispatched so far.
				const budget = options.retryBudget?.({ kind, attempts });
				if (!budget?.allowed) {
					retryNote = `http 503: no retry (${budget?.reason ?? "retry budget not configured"})`;
					break;
				}
				const waitMs = HTTP_503_RETRY_DELAYS_MS[attempts - 1] ?? HTTP_503_RETRY_DELAYS_MS.at(-1)!;
				const remaining = overallDeadlineMs - Math.round(performance.now() - start);
				if (remaining <= waitMs) {
					// A retry could not fit inside the original total deadline.
					retryNote = `http 503: no retry (deadline has ${Math.max(0, remaining)}ms left, below the ${waitMs}ms retry wait)`;
					break;
				}
				try {
					await sleepOrAbort(waitMs, signal);
					// Recompute AFTER the wait: `remaining` is the pre-wait value,
					// and dispatching with it would stretch the deadline by the wait.
					const remainingAfterWait = overallDeadlineMs - Math.round(performance.now() - start);
					if (remainingAfterWait <= 0) {
						// The wait ate the whole deadline: no further request goes out.
						retryNote = `http 503: retry skipped (deadline exhausted during the ${waitMs}ms wait)`;
						break;
					}
					const retry = await dispatch(remainingAfterWait);
					attempts += retry.attempts;
					exchange = retry;
					retryNote = `http 503 retried ${attempts - 1} time(s) after exponential waits: ${retry.ok ? "succeeded" : retry.error ?? "still failing"}`;
				}
				catch {
					// Cancelled during a wait: no further request was dispatched.
					retryNote = `http 503: retry cancelled during the ${waitMs}ms wait`;
					break;
				}
				if (!isRetryable503(exchange)) {
					break;
				}
			}
			const artifact = responseArtifact(exchange);

			if (!exchange.ok) {
				const transportNote = scrub([exchange.error ?? "request failed", retryNote, fallbackNote].filter(Boolean).join("; "));
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: transportNote,
					failure: { stage: "transport", message: transportNote },
					cost: { billedUsd: null, marketUsd: null, unknown: true },
					usage: { requestBytes: finalRequestBytes, responseBytes: exchange.bytes, attempts },
					requestId,
					requestHash: finalRequestHash,
					requestBody: finalRequestBody,
					responseHash: artifact.responseHash,
					...(artifact.responseBody !== undefined ? { responseBody: artifact.responseBody } : {}),
					origin: "live",
					partialCoverage: fallbackNote !== null,
				});
			}

			const validated = validateResponse(exchange.payload, finalQuestions);
			if (!validated.ok) {
				return finish({
					ok: false,
					status: "UNCHECKED",
					answers: {},
					findings: [],
					notes: scrub([validated.problems.join("; "), fallbackNote].filter(Boolean).join("; ")),
					failure: { stage: "validation", message: scrub(validated.problems.join("; ")) },
					cost: validated.cost,
					usage: { requestBytes: finalRequestBytes, responseBytes: exchange.bytes, attempts },
					requestId,
					requestHash: finalRequestHash,
					requestBody: finalRequestBody,
					responseHash: artifact.responseHash,
					...(artifact.responseBody !== undefined ? { responseBody: artifact.responseBody } : {}),
					origin: "live",
					partialCoverage: fallbackNote !== null,
				});
			}
			return finish({
				ok: true,
				// The transport does not decide policy; policy.ts does. `UNCHECKED`
				// here means "answers are valid, no verdict applied yet".
				status: "UNCHECKED",
				answers: validated.answers,
				findings: [],
				// A 503 that a retry rescued is still worth saying so: the attempt count
				// tells how many requests went out, and the first failure is not hidden.
				notes: scrub([validated.providerId ? `provider id ${validated.providerId}` : "", retryNote, fallbackNote].filter(Boolean).join("; ")),
				cost: validated.cost,
				usage: { requestBytes: finalRequestBytes, responseBytes: exchange.bytes, attempts },
				requestId,
				requestHash: finalRequestHash,
				requestBody: finalRequestBody,
				responseHash: artifact.responseHash,
				...(artifact.responseBody !== undefined ? { responseBody: artifact.responseBody } : {}),
				origin: "live",
				partialCoverage: fallbackNote !== null,
			});
		},
	};
}

function scrubJson(value: unknown, scrub: (text: string) => string): unknown {
	if (typeof value === "string") {
		return scrub(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => scrubJson(item, scrub));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubJson(item, scrub)]));
	}
	return value;
}

/** Snapshot type re-exported for callers that only need the client. */
export type { AssessmentKind, EvidenceSnapshot };
