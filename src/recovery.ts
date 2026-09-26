/**
 * Bounded recovery guidance.
 *
 * A recovery is a TEMPORARY redirect: it lasts a fixed number of proposals, then
 * expires. Expiry is not success, and a replaced recovery is marked expired in
 * the history rather than left dangling as `active`.
 *
 * The lease bounds the GUIDANCE, never the concern. An expired concern stops
 * being injected but stays open until a grounded `concern_outcome=RESOLVED`
 * answer closes it, so expiry can never be mistaken for resolution and can never
 * make a later RESOLVED answer unrecordable.
 *
 * The evidence key is what makes repeats cheap: the same focus plus the same
 * observed evidence must never trigger the same intervention twice. Therefore
 * the key is built only from EXECUTED observations (a blocked or invalid call is
 * not new evidence), from the result tuple alone (no event ids, no timestamps, so
 * replaying the same output cannot look like progress), and it keeps the full
 * argument hash so genuinely changed arguments do change the key.
 */

import { createHash } from "node:crypto";
import { stableJson } from "./redact.ts";
import type { EvidenceSnapshot } from "./types.ts";

export type RecoveryMode = "RESEARCH" | "REPLAN" | "VERIFY" | "EXECUTE";

/** How many of the most recent EXECUTED observations an evidence key summarizes. */
export const RECOVERY_EVIDENCE_WINDOW = 6;

export interface RecoveryHistoryEntry {
	kind: RecoveryMode;
	/** `resolved` is set only by a grounded RESOLVED outcome, never by expiry. */
	status: "active" | "expired" | "resolved";
	focus: string;
	at: string;
	objective: string;
	evidenceKey: string;
}

export interface RecoveryState {
	active: {
		mode: RecoveryMode;
		objective: string;
		focusKey: string;
		evidenceKey: string;
		remainingProposals: number;
		at: string;
	} | null;
	history: RecoveryHistoryEntry[];
	/** Keys of applied recoveries to suppress duplicates. Capped at 256. */
	appliedKeys: string[];
}

export function createRecovery(): RecoveryState {
	return {
		active: null,
		history: [],
		appliedKeys: [],
	};
}

export function beginRecovery(
	state: RecoveryState,
	input: {
		mode: RecoveryMode;
		objective: string;
		focusKey: string;
		evidenceKey: string;
		at: string;
	},
	lease: number = 2,
): boolean {
	const key = `${input.focusKey}:${input.evidenceKey}`;
	if (state.appliedKeys.includes(key)) {
		return false;
	}

	state.appliedKeys.push(key);
	if (state.appliedKeys.length > 256) {
		state.appliedKeys.shift();
	}

	// Anything still marked active is being replaced, so it is no longer in force.
	markActiveExpired(state);

	state.active = {
		mode: input.mode,
		objective: input.objective,
		focusKey: input.focusKey,
		evidenceKey: input.evidenceKey,
		remainingProposals: lease,
		at: input.at,
	};

	state.history.push({
		kind: input.mode,
		status: "active",
		focus: input.focusKey,
		at: input.at,
		objective: input.objective,
		evidenceKey: input.evidenceKey,
	});

	if (state.history.length > 50) {
		state.history.shift();
	}

	return true;
}

export function advanceRecovery(state: RecoveryState): boolean {
	if (!state.active) {
		return false;
	}
	const active = state.active;
	active.remainingProposals -= 1;

	if (active.remainingProposals <= 0) {
		markActiveExpired(state);
		state.active = null;
		return true;
	}

	return false;
}

/**
 * The concern whose outcome is still owed. The guidance in force owns the
 * concern; once its lease expires the most recent concern that nothing resolved
 * still carries that identity, so a later RESOLVED/PERSISTS/UNKNOWN answer has
 * something to attach to instead of being dropped.
 */
export function openConcernKey(state: RecoveryState): string | null {
	if (state.active) {
		return state.active.focusKey;
	}
	for (let index = state.history.length - 1; index >= 0; index -= 1) {
		const entry = state.history[index]!;
		if (entry.status !== "resolved") {
			return entry.focus;
		}
	}
	return null;
}

/**
 * Close an open concern on a grounded RESOLVED outcome. This is the only path to
 * `resolved`: expiry and replacement leave the concern open.
 */
export function resolveConcern(state: RecoveryState, focusKey: string): boolean {
	let matched = false;
	for (const entry of state.history) {
		// A focus key is the concern identity. It may have been re-armed after new
		// evidence, so close every historical lease for this same concern together.
		if (entry.focus === focusKey && entry.status !== "resolved") {
			entry.status = "resolved";
			matched = true;
		}
	}
	if (state.active?.focusKey === focusKey) {
		// Resolved guidance is no longer guidance: it stops being injected at once.
		state.active = null;
		matched = true;
	}
	return matched;
}

/** The one history entry currently in force, if any, becomes expired. */
function markActiveExpired(state: RecoveryState): void {
	for (const entry of state.history) {
		if (entry.status === "active") {
			entry.status = "expired";
		}
	}
}

export function recoveryInstruction(state: RecoveryState): string | null {
	if (!state.active) {
		return null;
	}

	const { mode, objective } = state.active;
	return [
		`[Recovery: ${mode}]`,
		`Objective: ${objective}`,
		`Stay on the original user task. This guidance is temporary and expires after ${state.active.remainingProposals} proposal(s).`,
		`Expiry of this guidance does not mean the objective has been met.`,
	].join("\n");
}

/**
 * Hash of what has actually been observed. Nested argument objects are serialized
 * with recursively sorted keys, so a reordered object never changes the key, while
 * a genuinely changed nested value always does.
 */
export function recoveryEvidenceKey(snapshot: EvidenceSnapshot): string {
	const executed = snapshot.observations.filter((observation) => observation.provenance === "executed");
	const recent = executed.slice(-RECOVERY_EVIDENCE_WINDOW);
	const tuples = recent.map((observation) => stableJson({
		tool_name: observation.toolName,
		args_hash: observation.argsHash ?? "",
		arguments: observation.arguments ?? null,
		ok: observation.ok,
		result: observation.text,
	}));
	// Repeating the same command and getting the same output is NOT new evidence,
	// so identical result tuples collapse to one entry.
	const deduped = [...new Set(tuples)];
	return createHash("sha256").update(stableJson(deduped)).digest("hex");
}
