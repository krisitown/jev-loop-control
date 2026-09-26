/**
 * Evidence snapshots.
 *
 * Everything here is derived from what Pi actually reported: finalized messages,
 * finalized tool calls, and actual `toolResult` messages. Two honesty rules
 * dominate this file:
 *
 *   1. A `toolResult` MESSAGE or a `tool_execution_end` EVENT is not proof of
 *      execution: both are also produced for blocked and invalid calls. Only the
 *      public executed-tool `tool_result` HOOK marks the execution path, and the
 *      controller captures executed ids there.
 *   2. Nothing is silently trimmed. Actor history is bounded and the elision is
 *      recorded; the current proposal's own text and arguments are kept complete,
 *      and a proposal that is too large to send is skipped by the controller
 *      instead of being assessed in pieces.
 *
 * No reasoning/thinking blocks are copied. Everything is redacted before hashing,
 * and the identity hash is computed over the exact sanitized representation that
 * the request builder renders from.
 */

import { capText, ELISION_MARK, hashJson, redactText, removeLiteral } from "./redact.ts";
import {
	parseVerification,
	selectVerificationChecks,
	verificationCheckEntry,
	type VerificationCheckEntry,
} from "./verification.ts";
import type {
	DeterministicFact,
	EvidenceSnapshot,
	Requirement,
	SnapshotObservation,
	SnapshotToolCall,
} from "./types.ts";
import type { SupervisorConfig } from "./config.ts";
import { deduplicateUserText, pruneContext } from "./context.ts";

/** Minimal structural view of a Pi message; avoids importing Pi types here. */
export interface Msg {
	role: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	isError?: boolean;
	toolName?: string;
	toolCallId?: string;
}

export interface ToolCallBlock {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface PriorIntervention {
	kind: string;
	at: string;
	focus: string;
}

/** Option ids that a requirement id must never be allowed to impersonate. */
export const RESERVED_REQUIREMENT_IDS = [
	"NONE",
	"UNKNOWN",
	"MET",
	"UNMET",
	"UNVERIFIED",
	"COMPLETE",
	"PROCEED",
	"EXECUTE",
	"RESEARCH",
	"REPLAN",
	"VERIFY",
	"BLOCKED",
	"NEEDS_USER_INPUT",
	"UNCERTAIN",
	"true",
	"false",
	"__proto__",
	"prototype",
	"constructor",
] as const;

const REQUIREMENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

/** Character budget of one retained tool-result text, and of one historical call's arguments. */
export const OBSERVATION_TEXT_CHARS = 2000;
export const OBSERVATION_ARGS_CHARS = 600;
/** How many of the most recent observations `recent_actions` summarizes. */
const RECENT_ACTIONS_WINDOW = 24;
const FACTS_WINDOW = 24;
/**
 * Retention of results: the most recent N, plus the most recent M ERRORS older
 * than that window. With fewer results than N nothing is omitted at all.
 */
const RECENT_RESULTS = 12;
const ERROR_HISTORY = 2;
/** `[assistant]: ` / `[user]: ` per-turn labels are formatting, so they are budgeted separately from `chars`. */
const HISTORY_LABEL_OVERHEAD = 13;

export interface HistoryTurn {
	role: string;
	text: string;
}

export interface ObservationTruncation {
	/** Evidence id (`E1`, `E2`, ...), never a redacted tool-call id. */
	id: string;
	/** Redacted tool-call id, for cross-reference only; never used as a lookup key. */
	tool_call_id: string;
	truncated: boolean;
	originalChars: number;
	retainedChars: number;
}

export interface BoundedHistory {
	text: string;
	truncated: boolean;
	/** Exact character count of the ORIGINAL turn content (turn labels are formatting). */
	chars: number;
	/** Exact character count of the rendered text that was dropped. */
	elided_chars: number;
	turns: number;
	turns_omitted: number;
}

/**
 * Cap to EXACTLY `maxChars`.
 *
 * `capText` from redact.ts renders head + marker + tail, but it sizes head/tail
 * from `maxChars` and appends the marker text AFTER them, so its result is
 * `maxChars + 42` and its split leaves content unused. A stated bound the bytes
 * do not honor is not a bound, so the split is solved here instead: keep as much
 * head as fits once the tail and the marker are accounted for, so the retained
 * text hits the stated bound exactly (head >= 1, tail >= 1, marker retained).
 */
function capTo(text: string, maxChars: number): { text: string; truncated: boolean; chars: number } {
	const chars = text.length;
	if (chars <= maxChars) {
		return { text, truncated: false, chars };
	}
	const tail = Math.max(1, Math.floor(maxChars * 0.3));
	for (let head = Math.max(1, Math.ceil(maxChars * 0.6)); head >= 1; head--) {
		const kept = head + tail;
		if (kept >= maxChars) {
			continue;
		}
		const candidate = `${text.slice(0, head)}\n${ELISION_MARK} ${chars - kept} characters elided ${ELISION_MARK}\n${text.slice(chars - tail)}`;
		if (candidate.length === maxChars) {
			return { text: candidate, truncated: true, chars };
		}
		if (candidate.length < maxChars) {
			// Marker digits shrank; pad by extending the head to hit the bound exactly.
			const grown = head + (maxChars - candidate.length);
			if (grown + tail < maxChars && grown <= chars - tail) {
				return { text: `${text.slice(0, grown)}\n${ELISION_MARK} ${chars - grown - tail} characters elided ${ELISION_MARK}\n${text.slice(chars - tail)}`, truncated: true, chars };
			}
			return { text: candidate.slice(0, maxChars), truncated: true, chars };
		}
	}
	return { text: text.slice(0, maxChars), truncated: true, chars };
}

/**
 * Bound an actor/user transcript to `maxChars` by keeping the MOST RECENT turns
 * (the boundary turn keeps its own tail), then stating exactly what was dropped.
 * Character accounting counts original turn content only: `[role]: ` labels and
 * the blank-line separators are rendering, and would otherwise inflate `chars`.
 */
export function boundHistory(turns: readonly HistoryTurn[], maxChars: number): BoundedHistory {
	const render = (turn: HistoryTurn): string => `[${turn.role}]: ${turn.text}`;
	const chars = turns.reduce((total, turn) => total + turn.text.length, 0);
	const rendered = turns.map(render);
	const joined = rendered.join("\n\n");
	if (joined.length <= maxChars) {
		return { text: joined, truncated: false, chars, elided_chars: 0, turns: turns.length, turns_omitted: 0 };
	}
	// Room for the elision marker itself, so `text` never exceeds maxChars.
	const reserve = Math.min(64, Math.max(16, Math.floor(maxChars / 8)));
	const budget = Math.max(0, maxChars - reserve);
	const kept: string[] = [];
	let used = 0;
	let boundary = 0;
	for (let index = rendered.length - 1; index >= 0; index--) {
		const piece = rendered[index]!;
		const cost = kept.length === 0 ? piece.length : piece.length + 2;
		if (used + cost <= budget) {
			kept.unshift(piece);
			used += cost;
			boundary = index;
			continue;
		}
		// Boundary turn: keep its most recent characters, then everything older is out.
		const room = budget - used - (kept.length === 0 ? 0 : 2);
		if (room > 0) {
			kept.unshift(piece.slice(piece.length - room));
			boundary = index;
		}
		break;
	}
	const body = kept.join("\n\n");
	// Exact arithmetic: the rendered transcript minus what survived is what was dropped.
	const elided = Math.max(0, joined.length - body.length);
	const marker = `${ELISION_MARK} ${elided} characters elided ${ELISION_MARK}\n`;
	return { text: `${marker}${body}`, truncated: true, chars, elided_chars: elided, turns: turns.length, turns_omitted: boundary };
}

export function isToolResultMessage(message: Msg | undefined): boolean {
	return message !== undefined && (message.role === "toolResult" || message.role === "tool_result" || message.role === "tool");
}

/** Visible text only; thinking blocks are excluded on purpose. */
export function visibleText(message: Msg | undefined): string {
	const parts: string[] = [];
	for (const block of blocksOf(message)) {
		if (typeof block === "string") {
			parts.push(block);
		}
		else if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}

export function toolCallsOf(message: Msg | undefined): ToolCallBlock[] {
	const out: ToolCallBlock[] = [];
	for (const block of blocksOf(message)) {
		if (!isRecord(block) || block.type !== "toolCall") {
			continue;
		}
		// Pi's finalized tool call carries `arguments`; `input` is accepted only
		// as an older-shape fallback so the value never silently becomes {}.
		const raw = block.arguments !== undefined ? block.arguments : block.input;
		out.push({
			id: typeof block.id === "string" ? block.id : "",
			name: typeof block.name === "string" ? block.name : "unknown",
			arguments: isRecord(raw) ? raw : {},
		});
	}
	return out;
}

export function hasToolCalls(message: Msg | undefined): boolean {
	return toolCallsOf(message).length > 0;
}

/** True only for a normally finished, tool-free assistant turn. */
export function isTerminalCandidate(message: Msg | undefined): boolean {
	if (!message || message.role !== "assistant") {
		return false;
	}
	// Errors, aborts, and truncations are never successful completion.
	if (message.stopReason !== undefined && message.stopReason !== "stop") {
		return false;
	}
	if (typeof message.errorMessage === "string" && message.errorMessage !== "") {
		return false;
	}
	return !hasToolCalls(message);
}

export interface RequirementsResult {
	requirements: Requirement[];
	/** Set when a configured manifest could not be honored. Never fall back then. */
	error: string | null;
}

/**
 * Requirements from an immutable manifest, or the single R0 original request.
 * A configured-but-invalid manifest is an error, not a reason to guess: only the
 * absence of a manifest falls back to R0.
 */
export function resolveRequirements(input: {
	manifestText?: string;
	manifestConfigured: boolean;
	r0Request: string;
}): RequirementsResult {
	if (input.manifestConfigured) {
		if (typeof input.manifestText !== "string") {
			return { requirements: [], error: "task manifest was configured but could not be read" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(input.manifestText) as unknown;
		}
		catch {
			return { requirements: [], error: "task manifest is not valid JSON" };
		}
		const list = isRecord(parsed) && Array.isArray(parsed.requirements) ? parsed.requirements : undefined;
		if (!list || list.length === 0) {
			return { requirements: [], error: "task manifest has no `requirements` array" };
		}
		const requirements: Requirement[] = [];
		const seen = new Set<string>();
		for (const [index, item] of list.entries()) {
			if (!isRecord(item)) {
				return { requirements: [], error: `task manifest requirement ${index + 1} is not an object` };
			}
			const id = typeof item.id === "string" ? item.id.trim() : "";
			const summary = typeof item.summary === "string" ? item.summary : typeof item.description === "string" ? item.description : "";
			if (!id || !summary.trim()) {
				return { requirements: [], error: `task manifest requirement ${index + 1} needs both \`id\` and \`summary\`` };
			}
			if (!REQUIREMENT_ID_PATTERN.test(id)) {
				return { requirements: [], error: `task manifest requirement id "${id}" must match ${REQUIREMENT_ID_PATTERN}` };
			}
			if ((RESERVED_REQUIREMENT_IDS as readonly string[]).includes(id)) {
				return { requirements: [], error: `task manifest requirement id "${id}" collides with a protocol option id` };
			}
			if (seen.has(id)) {
				return { requirements: [], error: `task manifest repeats requirement id "${id}"` };
			}
			seen.add(id);
			requirements.push({ id, summary: summary.trim(), origin: `manifest:${id}` });
		}
		return { requirements, error: null };
	}

	const request = input.r0Request.trim();
	if (!request) {
		return { requirements: [{ id: "R1", summary: "(no actor-visible request text was captured)", origin: "fallback:unavailable" }], error: null };
	}
	return { requirements: [{ id: "R1", summary: request, origin: "R0:original-request" }], error: null };
}

/**
 * What actually happened, as facts an assessment is not allowed to overrule.
 * `executedToolCallIds` must come from real execution events.
 */
export function deterministicFacts(messages: readonly Msg[], executedToolCallIds: ReadonlySet<string>, scrub: (text: string) => string): DeterministicFact[] {
	const facts: DeterministicFact[] = [];
	let results = 0;
	let executed = 0;
	for (const message of messages) {
		if (!isToolResultMessage(message)) {
			continue;
		}
		results += 1;
		const subject = scrub(typeof message.toolName === "string" ? message.toolName : scrub(message.toolCallId ?? "unknown"));
		const failed = message.isError === true;
		const didExecute = typeof message.toolCallId === "string" && executedToolCallIds.has(message.toolCallId);
		if (didExecute && failed) {
			executed += 1;
			facts.push({
				kind: "tool_error",
				subject,
				value: scrub(`tool executed and returned an error result; text: ${visibleText(message).slice(0, 400)}`),
				source: "pi:tool_result_hook(executed)",
			});
		}
		else if (didExecute) {
			executed += 1;
			facts.push({ kind: "tool_executed", subject, value: "tool executed and returned without the error flag", source: "pi:tool_result_hook(executed)" });
		}
		else {
			// Blocked, invalid, or deferred: a result message exists, nothing executed.
			facts.push({
				kind: "tool_result_without_execution",
				subject,
				value: scrub(`a tool result message exists with no executed-tool hook receipt (blocked, deferred, or invalid call)${failed ? "; reported as an error result" : ""}; text: ${visibleText(message).slice(0, 400)}`),
				source: "pi:toolResult_message(no tool_result hook)",
			});
		}
	}
	if (results === 0) {
		facts.push({ kind: "no_execution", subject: "this run", value: "no tool result was reported in this run", source: "pi:tool_result(count=0)" });
	}
	const last = messages.at(-1);
	if (last && last.role === "assistant") {
		for (const [reason, kind, value] of [
			["aborted", "aborted", "stopReason=aborted"],
			["error", "error", "stopReason=error"],
			["length", "truncation", "stopReason=length; output was truncated"],
		] as const) {
			if (last.stopReason === reason) {
				facts.push({ kind, subject: "final message", value, source: scrub("pi:agent_end") });
			}
		}
	}
	// Freshness is not measurable from outside a project's own harness in a
	// general workspace, so it stays explicitly unknown rather than guessed.
	facts.push({ kind: "freshness", subject: "tests/artifacts", value: "unknown (revision/freshness not measured by the supervisor)", source: "supervisor:policy" });
	void executed;
	return facts;
}

export interface SnapshotInput {
	kind: "proposal" | "completion";
	/** The finalized proposal message, or the final message for completion. */
	target: Msg | undefined;
	/** All messages of the current run, in order. */
	messages: readonly Msg[];
	/** Ids that produced the executed-tool `tool_result` HOOK (the only execution proof). */
	executedToolCallIds: ReadonlySet<string>;
	requirements: Requirement[];
	manifest: boolean;
	priorInterventions: readonly PriorIntervention[];
	config: SupervisorConfig;
	secrets: readonly string[];
	scope: { sessionId: string; taskId: string; branch: string };
}

/** Every finalized tool call of the target message, with complete arguments. */
export function snapshotToolCalls(target: Msg | undefined, scrub: (text: string) => string): SnapshotToolCall[] {
	return toolCallsOf(target).map((call) => {
		const sanitizedArgs = sanitizeValue(call.arguments, scrub);
		return { id: call.id, name: scrub(call.name), arguments: sanitizedArgs, argsHash: hashJson(sanitizedArgs) };
	});
}

export function buildSnapshot(input: SnapshotInput): EvidenceSnapshot {
	const scrub = (text: string): string => removeLiteral(redactText(text), input.secrets);
	// Arguments of every finalized call, keyed by tool-call id, so a result can be
	// tied back to the exact action that produced it (repeat detection needs this).
	const callsById = new Map<string, { name: string; arguments: unknown; argsHash: string }>();
	for (const message of input.messages) {
		for (const call of toolCallsOf(message)) {
			if (!call.id || callsById.has(call.id)) {
				continue;
			}
			const sanitized = sanitizeValue(call.arguments, scrub);
			callsById.set(call.id, { name: scrub(call.name), arguments: sanitized, argsHash: hashJson(sanitized) });
		}
	}
	const observationsAll: SnapshotObservation[] = [];
	// The ORIGINAL command and raw output of each executed bash call, so a
	// verification trailer is recognized before any truncation or redaction can
	// hide it. Parsed only for calls the executed-tool hook proved.
	const rawBashById = new Map<string, { command: string; text: string }>();
	// Evidence id -> the RAW command of that call, keyed by evidence id so the
	// rendered check records never need a lookup by (redacted) tool-call id.
	const rawCommandById = new Map<string, string>();
	// Truncation metadata is recorded AT CREATION, keyed by the observation's own
	// evidence id, and computed from the raw text of THAT message. Looking a result
	// up later by its (redacted) tool-call id would compare a sanitized id against
	// unsanitized messages and silently report zeros for any id carrying a secret.
	const truncationById = new Map<string, ObservationTruncation>();
	const sourceObservations: Array<{ id: string; text: string; source: string }> = [];
	// Same rule for arguments: the observation carries a bounded SUMMARY, and the
	// hash stays that of the COMPLETE arguments. Capping only `recent_actions` was
	// not enough, because `observations` shipped the full old write content too.
	const boundedArgsById = new Map<string, { value: unknown; truncated: boolean; chars: number }>();
	for (const message of input.messages) {
		if (!isToolResultMessage(message)) {
			continue;
		}
		const rawCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		const didExecute = rawCallId !== "" && input.executedToolCallIds.has(rawCallId);
		const rawToolName = typeof message.toolName === "string" ? message.toolName : (callsById.get(rawCallId)?.name ?? "");
		const toolCallId = scrub(rawCallId);
		const found = callsById.get(rawCallId);
		const id = `E${observationsAll.length + 1}`;
		// Verification candidates need the RAW command of this call, so the parse
		// runs on the original command line, never a redacted view.
		if (didExecute && rawToolName === "bash") {
			const rawArgs = found?.arguments;
			const rawCommand = isRecord(rawArgs) && typeof rawArgs.command === "string" ? rawArgs.command : "";
			if (rawCommand) {
				rawBashById.set(rawCallId, { command: rawCommand, text: visibleText(message) });
				rawCommandById.set(id, rawCommand);
			}
		}
		if (found) {
			const rendered = JSON.stringify(found.arguments);
			const bounded = capTo(rendered, OBSERVATION_ARGS_CHARS);
			boundedArgsById.set(id, bounded.truncated
				? { value: { _summary: bounded.text, _original_chars: bounded.chars }, truncated: true, chars: bounded.chars }
				: { value: found.arguments, truncated: false, chars: rendered.length });
		}
		// Result text is bounded, and the bound is visible in `representation`.
		const capped = capTo(scrub(visibleText(message)), OBSERVATION_TEXT_CHARS);
		sourceObservations.push({ id, text: scrub(visibleText(message)), source: `pi:${scrub(rawToolName || "unknown")}:tool_result(${didExecute ? "executed" : "reported"})` });
		truncationById.set(id, {
			id,
			tool_call_id: toolCallId,
			truncated: capped.truncated,
			originalChars: capped.chars,
			retainedChars: capped.text.length,
		});
		observationsAll.push({
			id,
			toolName: scrub(typeof message.toolName === "string" ? message.toolName : (found?.name ?? "unknown")),
			toolCallId,
			ok: message.isError !== true,
			provenance: didExecute ? "executed" : "reported_without_execution_event",
			// `capText` puts its marker OUTSIDE the requested budget (head+tail plus the
			// marker text), so cap content at `budget - markerOverhead(budget)` to make
			// the retained text exactly `OBSERVATION_TEXT_CHARS`.
			text: capped.text,
			// The check outcome of this call's own output, when it ran Python unittest.
			...(didExecute && rawBashById.has(rawCallId)
				? (() => {
					const raw = rawBashById.get(rawCallId)!;
					const outcome = parseVerification("bash", raw.command, { text: raw.text, executed: true });
					return outcome && "record" in outcome
						? { verification: { ...outcome.record, summary: scrub(outcome.record.summary) } }
						: {};
				})()
				: {}),
			...(found ? { arguments: boundedArgsById.get(id)!.value, argsHash: found.argsHash } : {}),
		});
	}
	// Retention: the most recent RECENT_RESULTS results, plus the most recent
	// ERROR_HISTORY errors that fall outside that window, so a failure is never
	// forgotten just because the actor kept working. Ids are positional, so an
	// omitted observation is still reported under its original id.
	const lastWindowStart = Math.max(0, observationsAll.length - RECENT_RESULTS);
	const lastIds = new Set(observationsAll.slice(lastWindowStart).map((observation) => observation.id));
	const olderProblems = observationsAll.filter((observation, index) => index < lastWindowStart && (!observation.ok || observation.verification?.outcome === "failed")).slice(-ERROR_HISTORY);
	const keptPositions = new Set<number>([
		...observationsAll.slice(lastWindowStart).map((observation) => observationsAll.indexOf(observation)),
		...olderProblems.map((observation) => observationsAll.indexOf(observation)),
	]);
	const retained = observationsAll.filter((_, index) => keptPositions.has(index));
	const omittedObservationIds = observationsAll.filter((_, index) => !keptPositions.has(index)).map((observation) => observation.id);

	// Metadata only for what is actually retained; a dropped observation is already
	// listed by id in `omitted_evidence_ids`.
	const truncationMeta = retained.map((observation) => truncationById.get(observation.id)!);

	const argumentsTruncatedCount = observationsAll
		.slice(-RECENT_ACTIONS_WINDOW)
		.filter((observation) => boundedArgsById.get(observation.id)?.truncated === true)
		.length;

	const verificationChecks: VerificationCheckEntry[] = selectVerificationChecks(
		observationsAll
			.filter((observation) => observation.provenance === "executed" && observation.verification !== undefined)
			.map((observation) => {
				return verificationCheckEntry({
					evidenceId: observation.id,
					toolCallId: observation.toolCallId,
					command: scrub(rawCommandById.get(observation.id) ?? ""),
					commandChars: OBSERVATION_ARGS_CHARS,
					argsHash: observation.argsHash ?? "",
					record: observation.verification!,
					source: `pi:${observation.toolName}:tool_result(executed)`,
				});
			}),
	);

	const proposalText = scrub(visibleText(input.target));
	// History excludes the candidate itself: `final_answer` must be the current
	// terminal text, not a concatenation of everything the actor said. When it must
	// be bounded, the MOST RECENT turns are kept (the oldest content is dropped),
	// never a fixed prefix of the transcript.
	const historyTurns: HistoryTurn[] = [];
	const sourceUserInstructions: NonNullable<EvidenceSnapshot["sourceUserInstructions"]> = [];
	let userOrdinal = 0;
	for (const [order, message] of input.messages.entries()) {
		if (message === input.target) continue;
		if (message.role !== "assistant" && message.role !== "user") continue;
		const text = scrub(visibleText(message));
		if (text) {
			historyTurns.push({ role: message.role, text });
			if (message.role === "user") {
				userOrdinal++;
				const transport = deduplicateUserText(text, input.requirements);
				sourceUserInstructions.push({
					id: `user_instruction:${String(userOrdinal).padStart(4, "0")}`,
					text,
					transportText: transport.text,
					source: refOf(message, input.messages, scrub),
					order,
					...(transport.references.length > 0 ? { references: transport.references } : {}),
				});
			}
		}
	}
	const historyBudget = Math.max(0, input.config.limits.maxEvidenceChars - HISTORY_LABEL_OVERHEAD * Math.max(1, historyTurns.length));
	const history = boundHistory(historyTurns, historyBudget);
	const toolCalls = snapshotToolCalls(input.target, scrub);
	const facts = deterministicFacts(input.messages, input.executedToolCallIds, scrub);
	const priorInterventions = input.priorInterventions.slice(-5).map((entry) => ({ kind: scrub(entry.kind), at: entry.at, focus: scrub(entry.focus) }));

	// One canonical representation: hashed for identity and rendered into the
	// request. The hash and the request bytes can therefore never diverge.
	let representation: Record<string, unknown> = {
		requirements: input.requirements.map((requirement) => ({
			id: requirement.id,
			summary: scrub(requirement.summary),
			origin: scrub(requirement.origin),
		})),
		history: {
			text: history.text,
			truncated: history.truncated,
			chars: history.chars,
			rendered_chars: history.truncated ? history.chars + HISTORY_LABEL_OVERHEAD * history.turns + 2 * Math.max(0, history.turns - 1) : history.text.length,
			elided_chars: history.elided_chars,
			turns: history.turns,
			turns_omitted: history.turns_omitted,
		},
		proposal: {
			kind: input.kind,
			text: proposalText,
			tool_calls: toolCalls,
		},
		observations: retained,
		recent_actions: (() => {
			const recent = observationsAll.slice(-RECENT_ACTIONS_WINDOW);
			const retainedIds = new Set(retained.map((o) => o.id));
			return recent.map((observation) => {
				// Observation arguments are already bounded at creation; the ORIGINAL
				// argument hash is kept so a repeat is still detected exactly. The current
				// proposal's own arguments are never bounded (see `proposal.tool_calls`).
				return {
					tool: observation.toolName,
					tool_call_id: observation.toolCallId,
					// Tool STATUS, not a check outcome: `success` used to be read as
					// "the tests passed", which a piped unittest run proved false.
					result: observation.ok ? "tool_completed" : "tool_error",
					// An explicit reported check outcome, whenever the tool's own
					// output carried a recognizable unittest trailer.
					...(observation.verification
						? {
							test_outcome: observation.verification.outcome,
							tests_run: observation.verification.testsRun,
							test_basis: observation.verification.basis,
						}
						: {}),
					executed: observation.provenance === "executed",
					evidence_id: observation.id,
					arguments_hash: observation.argsHash,
					...(retainedIds.has(observation.id)
						? { arguments_ref: observation.id }
						: { arguments_omitted: true }),
				};
			});
		})(),
		facts: facts.slice(-FACTS_WINDOW),
		facts_omitted_count: Math.max(0, facts.length - FACTS_WINDOW),
		prior_interventions: priorInterventions,
		// Latest reported check outcomes (max 4, newest of each exact command).
		// A bounded summary in this snapshot, never a persistent ledger.
		verification_checks: verificationChecks,
		omitted_evidence_ids: omittedObservationIds,
		omitted_observation_count: omittedObservationIds.length,
		context_selection: {
			truncation_metadata: truncationMeta,
			recent_actions_count: Math.min(RECENT_ACTIONS_WINDOW, observationsAll.length),
			facts_count: Math.min(FACTS_WINDOW, facts.length),
			arguments_truncated_count: argumentsTruncatedCount,
			history_turns_omitted: history.turns_omitted,
		},
	};

	representation = pruneContext(representation, historyTurns, historyBudget);
	const snapshotHash = hashJson(representation);
	const serialized = JSON.stringify(representation);
	return {
		target: {
			kind: input.kind,
			proposalHash: hashJson({ text: proposalText, tool_calls: toolCalls }),
			messageRef: refOf(input.target, input.messages, scrub),
		},
		task: {
			manifest: input.manifest,
			requirements: input.requirements.map((requirement) => ({ ...requirement, summary: scrub(requirement.summary), origin: scrub(requirement.origin) })),
			origin: scrub(input.requirements[0]?.origin ?? "unknown"),
		},
		actorText: (representation.history as { text: string }).text,
		proposalText,
		toolCalls,
		observations: representation.observations as SnapshotObservation[],
		sourceObservations,
		sourceUserInstructions,
		priorInterventions,
		facts,
		scope: { ...input.scope, snapshotHash },
		// Bounded HISTORY or bounded HISTORICAL arguments are context selection, not
		// a limitation of the thing being assessed. `truncated` is reserved for the
		// current proposal itself, which this builder never trims.
		truncated: false,
		representation,
	};
}

/** True when any part of the payload carries a redaction mark. */
export function hasRedactions(snapshot: EvidenceSnapshot): boolean {
	return JSON.stringify(snapshot.representation).includes("[REDACTED]");
}

/** Byte size of the exact representation the identity hash describes. */
export function representationBytes(snapshot: EvidenceSnapshot): number {
	return Buffer.byteLength(JSON.stringify(snapshot.representation), "utf8");
}

function refOf(target: Msg | undefined, messages: readonly Msg[], scrub: (text: string) => string): string {
	if (!target) {
		return "absent";
	}
	const index = messages.lastIndexOf(target);
	return `run:${index}:${hashJson({ role: target.role, text: capText(scrub(visibleText(target)), 2000).text, calls: toolCallsOf(target).map((call) => [call.id, scrub(call.name)]) }, 8)}`;
}

function blocksOf(message: Msg | undefined): unknown[] {
	if (!message || message.content === undefined) {
		return [];
	}
	if (typeof message.content === "string") {
		return [{ type: "text", text: message.content }];
	}
	return Array.isArray(message.content) ? message.content as unknown[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Scrub every string inside a value so argument hashes are honest too. */
function sanitizeValue(value: unknown, scrub: (text: string) => string): unknown {
	if (typeof value === "string") {
		return scrub(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item, scrub));
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[scrub(key)] = sanitizeValue(item, scrub);
		}
		return out;
	}
	return value;
}
