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

import { capText, hashJson, redactText, removeLiteral } from "./redact.ts";
import type {
	DeterministicFact,
	EvidenceSnapshot,
	Requirement,
	SnapshotObservation,
	SnapshotToolCall,
} from "./types.ts";
import type { SupervisorConfig } from "./config.ts";

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
	for (const message of input.messages) {
		if (!isToolResultMessage(message)) {
			continue;
		}
		const rawCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		const didExecute = rawCallId !== "" && input.executedToolCallIds.has(rawCallId);
		const toolCallId = scrub(rawCallId);
		const found = callsById.get(rawCallId);
		observationsAll.push({
			id: `E${observationsAll.length + 1}`,
			toolName: scrub(typeof message.toolName === "string" ? message.toolName : (found?.name ?? "unknown")),
			toolCallId,
			ok: message.isError !== true,
			provenance: didExecute ? "executed" : "reported_without_execution_event",
			// Result text is bounded, and the bound is visible in `representation`.
			text: capText(scrub(visibleText(message)), 1200).text,
			...(found ? { arguments: found.arguments, argsHash: found.argsHash } : {}),
		});
	}
	// The most recent results are sent in full; older ones are listed by id.
	const retained = observationsAll.slice(-6);
	const omittedObservationIds = observationsAll.slice(0, Math.max(0, observationsAll.length - 6)).map((observation) => observation.id);

	const proposalText = scrub(visibleText(input.target));
	// History excludes the candidate itself: `final_answer` must be the current
	// terminal text, not a concatenation of everything the actor said.
	const historyParts: string[] = [];
	for (const message of input.messages) {
		if (message === input.target || message.role !== "assistant") {
			continue;
		}
		const text = visibleText(message);
		if (text) {
			historyParts.push(text);
		}
	}
	const history = capText(scrub(historyParts.join("\n\n")), input.config.limits.maxEvidenceChars);
	const toolCalls = snapshotToolCalls(input.target, scrub);
	const facts = deterministicFacts(input.messages, input.executedToolCallIds, scrub);
	const priorInterventions = input.priorInterventions.slice(-5).map((entry) => ({ kind: scrub(entry.kind), at: entry.at, focus: scrub(entry.focus) }));

	// One canonical representation: hashed for identity and rendered into the
	// request. The hash and the request bytes can therefore never diverge.
	const representation: Record<string, unknown> = {
		requirements: input.requirements.map((requirement) => ({
			id: requirement.id,
			summary: scrub(requirement.summary),
			origin: scrub(requirement.origin),
		})),
		history: {
			text: history.text,
			truncated: history.truncated,
			chars: history.chars,
		},
		proposal: {
			kind: input.kind,
			text: proposalText,
			tool_calls: toolCalls,
		},
		observations: retained,
		recent_actions: observationsAll.map((observation) => ({
			tool: observation.toolName,
			tool_call_id: observation.toolCallId,
			result: observation.ok ? "success" : "error",
			executed: observation.provenance === "executed",
			evidence_id: observation.id,
			...(observation.arguments !== undefined ? { arguments: observation.arguments, arguments_hash: observation.argsHash } : {}),
		})),
		facts,
		prior_interventions: priorInterventions,
		omitted_evidence_ids: omittedObservationIds,
		omitted_observation_count: omittedObservationIds.length,
	};

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
		actorText: history.text,
		proposalText,
		toolCalls,
		observations: retained,
		priorInterventions,
		facts,
		scope: { ...input.scope, snapshotHash },
		truncated: history.truncated || serialized.length > input.config.limits.maxEvidenceChars,
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
