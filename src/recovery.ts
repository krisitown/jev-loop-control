import { createHash } from "node:crypto";
import type { EvidenceSnapshot } from "./types.ts";

export type RecoveryMode = "RESEARCH" | "REPLAN" | "VERIFY" | "EXECUTE";

export interface RecoveryHistoryEntry {
	kind: RecoveryMode;
	status: "active" | "expired";
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

	state.active.remainingProposals -= 1;

	if (state.active.remainingProposals <= 0) {
		const entry = state.history.find(
			(h) => h.focus === state.active!.focusKey && h.evidenceKey === state.active!.evidenceKey && h.status === "active",
		);
		if (entry) {
			entry.status = "expired";
		}
		state.active = null;
		return true;
	}

	return false;
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

export function recoveryEvidenceKey(snapshot: EvidenceSnapshot): string {
	const recent = snapshot.observations.slice(-6);
	const items = recent.map((obs) => ({
		toolName: obs.toolName,
		arguments: obs.arguments,
		text: obs.text,
		ok: obs.ok,
	}));

	const stable = JSON.stringify(items, Object.keys(items[0] || {}).sort());
	return createHash("sha256").update(stable).digest("hex");
}
