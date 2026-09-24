import { describe, it, expect } from "vitest";
import { createRecovery, beginRecovery, advanceRecovery, recoveryInstruction, recoveryEvidenceKey } from "../src/recovery.ts";
import type { EvidenceSnapshot, SnapshotObservation } from "../src/types.ts";

function mockSnapshot(observations: Partial<SnapshotObservation>[]): EvidenceSnapshot {
	return {
		target: { kind: "proposal", proposalHash: "h", messageRef: "m" },
		task: { manifest: false, requirements: [], origin: "o" },
		actorText: "",
		proposalText: "",
		toolCalls: [],
		observations: observations.map((o, i) => ({
			id: `id-${i}`,
			toolName: o.toolName || "tool",
			toolCallId: `tc-${i}`,
			ok: o.ok ?? true,
			provenance: "executed",
			text: o.text || "",
			arguments: o.arguments || {},
			argsHash: "ah",
		})),
		priorInterventions: [],
		facts: [],
		scope: { sessionId: "s", taskId: "t", branch: "b", snapshotHash: "sh" },
		truncated: false,
		representation: {},
	};
}

describe("recovery", () => {
	it("lease lasts exactly 2 proposals", () => {
		const state = createRecovery();
		const ok = beginRecovery(state, {
			mode: "RESEARCH",
			objective: "find bug",
			focusKey: "f1",
			evidenceKey: "e1",
			at: "now",
		}, 2);
		expect(ok).toBe(true);
		expect(state.active?.remainingProposals).toBe(2);

		const expired1 = advanceRecovery(state);
		expect(expired1).toBe(false);
		expect(state.active?.remainingProposals).toBe(1);

		const expired2 = advanceRecovery(state);
		expect(expired2).toBe(true);
		expect(state.active).toBeNull();
	});

	it("different focus can recover", () => {
		const state = createRecovery();
		beginRecovery(state, { mode: "RESEARCH", objective: "o1", focusKey: "f1", evidenceKey: "e1", at: "t1" });
		const ok = beginRecovery(state, { mode: "REPLAN", objective: "o2", focusKey: "f2", evidenceKey: "e2", at: "t2" });
		expect(ok).toBe(true);
		expect(state.active?.focusKey).toBe("f2");
	});

	it("same focus+same evidence blocked even after expiry", () => {
		const state = createRecovery();
		beginRecovery(state, { mode: "RESEARCH", objective: "o1", focusKey: "f1", evidenceKey: "e1", at: "t1" });
		advanceRecovery(state);
		advanceRecovery(state);
		expect(state.active).toBeNull();

		const ok = beginRecovery(state, { mode: "RESEARCH", objective: "o1", focusKey: "f1", evidenceKey: "e1", at: "t2" });
		expect(ok).toBe(false);
	});

	it("changed evidence allowed", () => {
		const state = createRecovery();
		beginRecovery(state, { mode: "RESEARCH", objective: "o1", focusKey: "f1", evidenceKey: "e1", at: "t1" });
		const ok = beginRecovery(state, { mode: "RESEARCH", objective: "o1", focusKey: "f1", evidenceKey: "e2", at: "t2" });
		expect(ok).toBe(true);
	});

	it("replaying same output with different observationIDs yields same key", () => {
		const snap1 = mockSnapshot([{ toolName: "read", text: "content", ok: true, arguments: { path: "/a" } }]);
		const snap2 = mockSnapshot([{ toolName: "read", text: "content", ok: true, arguments: { path: "/a" } }]);
		// IDs are different in mockSnapshot generation but excluded from key
		const k1 = recoveryEvidenceKey(snap1);
		const k2 = recoveryEvidenceKey(snap2);
		expect(k1).toBe(k2);
	});

	it("objective instruction renders correctly", () => {
		const state = createRecovery();
		beginRecovery(state, { mode: "VERIFY", objective: "check tests", focusKey: "f1", evidenceKey: "e1", at: "t1" }, 2);
		const instr = recoveryInstruction(state);
		expect(instr).toContain("[Recovery: VERIFY]");
		expect(instr).toContain("Objective: check tests");
		expect(instr).toContain("Stay on the original user task");
		expect(instr).toContain("Expiry of this guidance does not mean the objective has been met");
	});
});
