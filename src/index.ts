/**
 * jev-loop-control — Pi extension entry point.
 *
 * Live mode is default unless JEV_LOOP_CONTROL_TRACE is explicitly set (legacy).
 * JEV_LOOP_CONTROL_CONFIG selects live off/observe/enforce modes with Jev.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { liveObserve } from "./live-observe.ts";

/** Mode names shared by live config and legacy diagnostic parser. */
export type SupervisorMode = "off" | "observe" | "enforce";

export interface BootstrapConfig {
	mode: SupervisorMode;
	/** Legacy diagnostic effective mode. */
	effectiveMode: "off" | "observe";
	tracePath: string | undefined;
	/** Human-readable reasons for a downgrade, recorded once in the trace. */
	diagnostics: string[];
}

export function resolveBootstrapConfig(env: NodeJS.ProcessEnv = process.env): BootstrapConfig {
	const diagnostics: string[] = [];
	const rawMode = (env.JEV_LOOP_CONTROL_MODE ?? "off").trim().toLowerCase();
	let mode: SupervisorMode;
	switch (rawMode) {
		case "off":
		case "observe":
		case "enforce":
			mode = rawMode;
			break;
		default:
			mode = "off";
			diagnostics.push(`invalid JEV_LOOP_CONTROL_MODE "${rawMode}"; using off`);
	}

	const rawPath = env.JEV_LOOP_CONTROL_TRACE?.trim();
	const tracePath = rawPath ? resolve(rawPath) : undefined;

	let effectiveMode: "off" | "observe" = mode === "off" ? "off" : "observe";
	if (mode === "enforce") {
		diagnostics.push("enforce is not implemented in jev-loop-control 0.1.0; running as observe");
	}
	if (effectiveMode === "observe" && !tracePath) {
		effectiveMode = "off";
		diagnostics.push("JEV_LOOP_CONTROL_TRACE is required for observe; observing disabled");
	}

	return { mode, effectiveMode, tracePath, diagnostics };
}

/** One appended line of the trace. `seq` is process-local and monotonic. */
interface TraceRecord {
	seq: number;
	at: string;
	type: string;
	[key: string]: unknown;
}

class TraceWriter {
	#seq = 0;
	#path: string | undefined;
	#failureReported = false;

	constructor(path: string | undefined) {
		this.#path = path;
	}

	get path(): string | undefined {
		return this.#path;
	}

	record(type: string, fields: Record<string, unknown> = {}): void {
		if (!this.#path) {
			return;
		}
		const record: TraceRecord = { seq: this.#seq++, at: new Date().toISOString(), type, ...fields };
		try {
			// Synchronous append keeps ordering identical to handler ordering.
			appendFileSync(this.#path, `${JSON.stringify(record)}\n`, "utf8");
		}
		catch (error) {
			if (!this.#failureReported) {
				this.#failureReported = true;
				console.error(`jev-loop-control: trace write failed, tracing disabled: ${String(error)}`);
			}
			this.#path = undefined;
		}
	}
}

function describeMessage(message: unknown): Record<string, unknown> {
	if (!message || typeof message !== "object") {
		return { shape: typeof message };
	}
	const value = message as { role?: unknown; content?: unknown; stopReason?: unknown };
	const blocks = Array.isArray(value.content) ? value.content : [];
	const blockTypes: string[] = [];
	const toolCalls: Array<{ id: string; name: string }> = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const candidate = block as { type?: unknown; id?: unknown; name?: unknown };
		const type = typeof candidate.type === "string" ? candidate.type : "unknown";
		blockTypes.push(type);
		if (type === "toolCall") {
			toolCalls.push({
				id: typeof candidate.id === "string" ? candidate.id : "",
				name: typeof candidate.name === "string" ? candidate.name : "",
			});
		}
	}
	return {
		role: value.role,
		blockTypes,
		toolCalls,
		...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
	};
}

export default function jevLoopControl(pi: ExtensionAPI): void {
	// Live-observe path: default unless explicit legacy TRACE is set.
	if (process.env.JEV_LOOP_CONTROL_CONFIG || !process.env.JEV_LOOP_CONTROL_TRACE) {
		liveObserve(pi);
		return;
	}

	const config = resolveBootstrapConfig();
	if (config.effectiveMode !== "observe") {
		// "off" registers nothing at all: no hooks, no timers, no file handles.
		return;
	}

	const trace = new TraceWriter(config.tracePath);
	const signalState = (ctx: ExtensionContext): "present" | "absent" =>
		ctx.signal === undefined ? "absent" : "present";

	trace.record("bootstrap_config", {
		package: "jev-loop-control",
		version: "0.1.0",
		mode: config.mode,
		effectiveMode: config.effectiveMode,
		tracePath: trace.path,
		diagnostics: config.diagnostics,
	});

	pi.on("session_start", (_event, ctx) => {
		trace.record("session_start", { cwd: ctx.cwd, mode: ctx.mode, isIdle: ctx.isIdle() });
	});

	pi.on("message_end", (event, ctx) => {
		trace.record("message_end", { ...describeMessage(event.message), signal: signalState(ctx) });
	});

	pi.on("tool_execution_start", (event) => {
		trace.record("tool_execution_start", { toolCallId: event.toolCallId, toolName: event.toolName });
	});

	pi.on("tool_call", (event) => {
		trace.record("tool_call", { toolCallId: event.toolCallId, toolName: event.toolName });
		// Observation only: never block, never mutate.
		return undefined;
	});

	pi.on("tool_result", (event) => {
		trace.record("tool_result", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
	});

	pi.on("tool_execution_end", (event) => {
		trace.record("tool_execution_end", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		trace.record("agent_start", { signal: signalState(ctx) });
	});

	pi.on("agent_end", (event, ctx) => {
		trace.record("agent_end", { messageCount: event.messages.length, signal: signalState(ctx) });
	});

	pi.on("agent_before_settle", (event, ctx) => {
		trace.record("agent_before_settle", {
			outcome: event.outcome,
			entries: event.entries.length,
			continueRequested: event.continue,
			canContinue: event.context.canContinue,
			pendingMessages: event.context.pendingMessages.length,
			signal: signalState(ctx),
		});
		// Observation only: no entries, no continuation request.
		return undefined;
	});

	pi.on("agent_settled", () => {
		trace.record("agent_settled");
	});

	pi.on("input", (event) => {
		trace.record("input", { source: event.source, streamingBehavior: event.streamingBehavior ?? null });
		return undefined;
	});

	pi.on("session_shutdown", (event) => {
		trace.record("session_shutdown", { reason: event.reason });
	});
}
