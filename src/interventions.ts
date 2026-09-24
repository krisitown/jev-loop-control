import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { Decision, Mode } from "./types.ts";

export interface CompletionContinuationContext {
	mode: Mode;
	traceEnabled: boolean;
	signal: AbortSignal | undefined;
	maxInterventionsPerTask: number;
	maxTerminalContinuations: number;
	interventionsUsed: number;
	terminalContinuationsUsed: number;
}

export function applyCompletionContinuation(
	event: AgentBeforeSettleEvent,
	decision: Decision,
	ctx: CompletionContinuationContext,
): AgentBeforeSettleEventResult | undefined {
	if (ctx.mode !== "enforce") return undefined;
	if (!ctx.traceEnabled) return undefined;
	if (ctx.signal?.aborted) return undefined;
	if (event.outcome !== "completed") return undefined;
	if (event.context.pendingMessages.length > 0) return undefined;
	if (event.continue) return undefined;
	if (event.entries.length > 0) return undefined;
	if (decision.apply !== "continue") return undefined;
	if (ctx.interventionsUsed >= ctx.maxInterventionsPerTask) return undefined;
	if (ctx.terminalContinuationsUsed >= ctx.maxTerminalContinuations) return undefined;

	return {
		entries: [
			...event.entries,
			{
				type: "custom_message",
				customType: "jev-loop-control.completion-continuation",
				content: decision.memo ?? "",
				display: false,
			},
		],
		continue: true,
	};
}

export function applyDirectionBlock(
	decision: Decision,
	mode: Mode,
): ToolCallEventResult | undefined {
	if (mode !== "enforce") return undefined;
	if (decision.apply !== "block") return undefined;
	return {
		block: true,
		reason: decision.memo ?? "supervisor blocked",
	};
}
