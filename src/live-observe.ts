import { readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type SupervisorConfig } from "./config.ts";
import { createHttpClient } from "./jev.ts";
import { buildSnapshot, resolveRequirements, isTerminalCandidate, toolCallsOf, type Msg } from "./evidence.ts";
import { buildQuestions, buildState } from "./questions.ts";
import { decideDirection, decideCompletion } from "./policy.ts";
import { TraceStore, defaultRunsDir, runId } from "./trace.ts";
import { makeScrub, redactValue } from "./redact.ts";
import type { Assessment, BudgetState, Decision, EvidenceSnapshot, Question } from "./types.ts";
import { applyCompletionContinuation, applyDirectionBlock } from "./interventions.ts";
import { assessmentBudgetReason } from "./budget.ts";
import type { ToolCallEventResult, ToolCallEvent } from "@earendil-works/pi-coding-agent";

interface LiveState {
	config: SupervisorConfig;
	trace: TraceStore;
	scrub: (text: string) => string;
	client: ReturnType<typeof createHttpClient>;
	messages: Msg[];
	executedIds: Set<string>;
	budget: BudgetState;
	assessmentsUsed: number;
	interventionsUsed: number;
	terminalContinuationsUsed: number;
	lastFocusKey: string | null;
	newEvidence: boolean;
	proposalNumber: number;
	requirements: { id: string; summary: string; origin: string }[];
	manifest: boolean;
	userTask: string;
	finalMessage: Msg | undefined;
	completionAssessed: boolean;
	startedAt: string;
	problems: string[];
	notices: string[];
	taskId: string;
	assessmentPromise: Promise<Decision | undefined> | null;
	assessmentSnapshot: EvidenceSnapshot | null;
	assessmentQuestions: Question[] | null;
	assessmentState: Record<string, unknown> | null;
	secrets: string[];
	finalStatus: string;
	batchBlocked: boolean;
	batchBlockReason: string | null;
	completionDecision: Decision | undefined;
	completionSignal: AbortSignal | undefined;
}

export function liveObserve(pi: ExtensionAPI): void {
	let state: LiveState | undefined;
	let activation = { reason: "session not started", configPath: "", cwd: "", mode: "off", enabled: false, hint: "apiKeyEnv must name an environment variable such as AI_GATEWAY_API_KEY. Export that variable before launching Pi; restart after environment changes." };
	let activationScrub = makeScrub([]);

	pi.on("session_start", (_event, ctx) => {
		state = undefined;
		const { config, problems, notices } = loadConfig(ctx.cwd);
		activationScrub = makeScrub([process.env[config.jev.apiKeyEnv] ?? ""]);
		activation.hint = "apiKeyEnv must name an environment variable such as AI_GATEWAY_API_KEY. Export that variable before launching Pi; restart after environment changes.";

		const envConfigPath = process.env.JEV_LOOP_CONTROL_CONFIG;
		const trimmedEnvPath = envConfigPath ? envConfigPath.trim() : "";
		const resolvedConfigPath = trimmedEnvPath ? resolve(ctx.cwd, trimmedEnvPath) : (config.configPath || "(built-in defaults)");

		activation.configPath = resolvedConfigPath;
		activation.cwd = ctx.cwd;
		activation.mode = config.mode;
		activation.enabled = config.jev.enabled;

		if (problems.length > 0) {
			activation.reason = problems.join("; ");
			const msg = `jev-loop-control: configuration problems: ${problems.join("; ")}`;
			if (ctx.hasUI) ctx.ui.notify(activationScrub(msg), "warning");
			else console.error(activationScrub(msg));
			return;
		}
		if (config.mode === "off") {
			activation.reason = "mode is off";
			activation.hint = "Set mode to observe or enforce";
			console.error(`jev-loop-control: mode=off; no live assessments`);
			return;
		}
		if (!config.jev.enabled) {
			activation.reason = "jev disabled";
			activation.hint = "Enable jev in config";
			console.error(`jev-loop-control: jev.enabled=false; no live assessments`);
			return;
		}

		const apiKey = process.env[config.jev.apiKeyEnv];
		if (!apiKey) {
			activation.reason = `missing ${config.jev.apiKeyEnv}`;
			activation.hint = `Export ${config.jev.apiKeyEnv} as environment variable and restart Pi`;
			console.error(`jev-loop-control: ${config.jev.apiKeyEnv} not set; live assessments disabled`);
			return;
		}

		const runIdStr = runId();
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
		const traceDir = config.trace.dir ? join(config.trace.dir, runIdStr) : defaultRunsDir(agentDir, runIdStr);
		const trace = new TraceStore({ dir: traceDir, artifacts: config.trace.artifacts, runId: runIdStr, scrub: makeScrub([apiKey]) });

		const client = createHttpClient({
			endpoint: config.jev.endpoint,
			model: config.jev.model,
			apiKeyEnv: config.jev.apiKeyEnv,
			deadlineMs: config.jev.deadlineMs,
			maxRequestBytes: config.jev.maxRequestBytes,
			maxResponseBytes: config.jev.maxResponseBytes,
			secrets: [apiKey],
		});

		state = {
			config,
			trace,
			scrub: makeScrub([apiKey]),
			client,
			messages: [],
			executedIds: new Set(),
			budget: { requestsUsed: 0, reservedUsd: 0, billedUsd: 0, marketUsd: 0, unknownCosts: 0 },
			assessmentsUsed: 0,
			interventionsUsed: 0,
			terminalContinuationsUsed: 0,
			lastFocusKey: null,
			newEvidence: true,
			proposalNumber: 0,
			requirements: [],
			manifest: false,
			userTask: "",
			finalMessage: undefined,
			completionAssessed: false,
			startedAt: new Date().toISOString(),
			problems,
			notices,
			taskId: "",
			assessmentPromise: null,
			assessmentSnapshot: null,
			assessmentQuestions: null,
			assessmentState: null,
			secrets: [apiKey],
			finalStatus: "UNCHECKED",
			batchBlocked: false,
			batchBlockReason: null,
			completionDecision: undefined,
			completionSignal: undefined,
		};

		activation.reason = "";
		trace.manifest({ configPath: config.configPath, mode: config.mode, runId: runIdStr });
		console.error(`jev-loop-control: ${config.mode} active, run dir: ${traceDir}`);
	});

	pi.on("input", (event) => {
		if (!state) return;
		if (event.source !== "extension") {
			state.userTask = typeof event.text === "string" ? event.text : "";
			state.taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			state.messages = [];
			state.executedIds = new Set();
			state.finalMessage = undefined;
			state.completionAssessed = false;
			state.assessmentPromise = null;
			state.assessmentSnapshot = null;
			state.assessmentQuestions = null;
			state.assessmentState = null;
			state.finalStatus = "UNCHECKED";
			state.completionDecision = undefined;
			state.completionSignal = undefined;
			state.batchBlocked = false;
			state.batchBlockReason = null;
			state.interventionsUsed = 0;
			state.terminalContinuationsUsed = 0;
			state.lastFocusKey = null;

			let manifestText: string | undefined;
			if (state.config.taskManifestPath !== null) {
				try {
					manifestText = readFileSync(state.config.taskManifestPath, "utf8");
				}
				catch (e) {
					console.error(`jev-loop-control: failed to read task manifest: ${e}`);
					state.requirements = [];
					state.manifest = false;
					return;
				}
			}
			const reqs = resolveRequirements({
				manifestText,
				manifestConfigured: state.config.taskManifestPath !== null,
				r0Request: state.userTask,
			});
			if (reqs.error) {
				console.error(`jev-loop-control: requirements error: ${reqs.error}`);
				state.requirements = [];
				state.manifest = false;
				return;
			}
			state.requirements = reqs.requirements;
			state.manifest = reqs.requirements.length > 1 || state.config.taskManifestPath !== null;
		}
		return undefined;
	});

	pi.on("message_end", (event) => {
		if (!state) return;
		const msg = event.message as Msg;
		state.messages.push(msg);
		if (msg.role === "assistant") {
			state.finalMessage = msg;
			if (toolCallsOf(msg).length > 0) {
				state.assessmentPromise = null;
				state.batchBlocked = false;
				state.batchBlockReason = null;
			} else {
				state.trace.record("final_candidate", { content: redactValue(msg.content, state.secrets) });
			}
		}
	});

	pi.on("tool_execution_start", (event) => {
		if (!state) return;
		state.executedIds.add(event.toolCallId);
		state.newEvidence = true;
		state.trace.record("tool_execution_start", { toolCallId: event.toolCallId, toolName: event.toolName });
	});

	pi.on("tool_result", (event) => {
		if (!state) return;
		state.trace.record("tool_result", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			content: redactValue(event.content, state.secrets),
		});
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state) return undefined;
		const s = state;

		s.trace.record("tool_call", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			actualApply: "none",
		});

		if (s.batchBlocked && s.config.mode === "enforce" && s.trace.enabled && !ctx.signal?.aborted) {
			s.trace.record("intervention.block", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				reason: s.batchBlockReason,
				actualApply: "block",
			});
			return { block: true, reason: s.batchBlockReason ?? "supervisor blocked" };
		}

		if (s.assessmentPromise) {
			const decision = await s.assessmentPromise;
			return applyToolCallDecision(s, decision, event, ctx);
		}

		const budgetReason = assessmentBudgetReason(s.config, s.budget, s.assessmentsUsed);
		if (s.requirements.length === 0) {
			s.trace.record("assessment_skipped", { reason: "missing_requirements" });
			return undefined;
		}
		if (budgetReason) {
			s.trace.record("assessment_skipped", { reason: budgetReason });
			return undefined;
		}

		const target = s.messages.at(-1);
		const snapshot = buildSnapshot({
			kind: "proposal",
			target,
			messages: [...s.messages],
			executedToolCallIds: new Set(s.executedIds),
			requirements: [...s.requirements],
			manifest: s.manifest,
			priorInterventions: [],
			config: s.config,
			secrets: s.secrets,
			scope: {
				sessionId: ctx.sessionManager.getSessionId(),
				taskId: s.taskId,
				branch: ctx.sessionManager.getLeafId() ?? "main",
			},
		});

		const questions = buildQuestions("direction", snapshot);
		const controller = {
			workMode: "EXECUTE",
			proposalNumber: s.proposalNumber,
			interventionsUsed: s.interventionsUsed,
			interventionLimit: s.config.limits.maxInterventionsPerTask,
			previousInterventions: [],
		};
		const stateEnvelope = buildState({ kind: "direction", snapshot, controller, proposalId: `p${s.proposalNumber}` });

		const reserve = s.config.budget.reserveUsdPerRequest;
		s.budget.reservedUsd += reserve;
		s.budget.requestsUsed++;
		s.assessmentsUsed++;
		s.proposalNumber++;

		const promise = s.client.assess({
			kind: "direction",
			snapshot,
			questions,
			state: stateEnvelope,
			signal: ctx.signal,
			deadlineMs: s.config.jev.deadlineMs,
		}).then((a) => {
			if (a.cost.billedUsd !== null) {
				s.budget.billedUsd += a.cost.billedUsd;
				s.budget.reservedUsd -= reserve;
			} else {
				s.budget.unknownCosts++;
			}
			if (a.cost.marketUsd !== null) s.budget.marketUsd += a.cost.marketUsd;

			const requestPath = a.requestBody !== undefined ? s.trace.artifact("request", a.requestBody, a.requestId) : null;
			const responsePath = a.responseBody !== undefined ? s.trace.artifact("response", a.responseBody, a.requestId) : null;
			a.artifacts = { request: requestPath, response: responsePath };

			const decision = decideDirection({ kind: "direction", assessment: a, snapshot, config: s.config, counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed, assessmentsUsed: s.assessmentsUsed, lastFocusKey: s.lastFocusKey, newEvidence: s.newEvidence } });
			s.trace.record("direction_assessment", {
				ok: a.ok,
				answers: a.answers,
				failure: a.failure,
				usage: a.usage,
				timings: a.timings,
				cost: a.cost,
				requestId: a.requestId,
				requestHash: a.requestHash,
				responseHash: a.responseHash,
				artifacts: a.artifacts,
				status: decision.status,
				reasons: decision.reasons,
				recommendedApply: decision.apply,
				actualApply: "none",
			});
			return decision;
		}).catch((e) => {
			s.budget.reservedUsd -= reserve;
			s.trace.record("assessment_failure", { kind: "direction", error: String(e) });
			return undefined;
		});

		s.assessmentPromise = promise;
		s.assessmentSnapshot = snapshot;
		s.assessmentQuestions = questions;
		s.assessmentState = stateEnvelope;

		const decision = await promise;
		return applyToolCallDecision(s, decision, event, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state) return;
		const s = state;
		const last = event.messages.at(-1) as Msg | undefined;
		if (last && isTerminalCandidate(last)) {
			s.finalMessage = last;
			if (!s.completionAssessed) {
				s.completionAssessed = true;

				const budgetReason = assessmentBudgetReason(s.config, s.budget, s.assessmentsUsed);
				if (s.requirements.length === 0) {
					s.trace.record("assessment_skipped", { reason: "missing_requirements" });
					return;
				}
				if (budgetReason) {
					s.trace.record("assessment_skipped", { reason: budgetReason });
					return;
				}

				const snapshot = buildSnapshot({
					kind: "completion",
					target: last,
					messages: [...s.messages],
					executedToolCallIds: new Set(s.executedIds),
					requirements: [...s.requirements],
					manifest: s.manifest,
					priorInterventions: [],
					config: s.config,
					secrets: s.secrets,
					scope: {
						sessionId: ctx.sessionManager.getSessionId(),
						taskId: s.taskId,
						branch: ctx.sessionManager.getLeafId() ?? "main",
					},
				});
				const questions = buildQuestions("completion", snapshot);
				const controller = {
					workMode: "EXECUTE",
					proposalNumber: s.proposalNumber,
					interventionsUsed: s.interventionsUsed,
					interventionLimit: s.config.limits.maxInterventionsPerTask,
					previousInterventions: [],
				};
				const stateEnvelope = buildState({ kind: "completion", snapshot, controller, proposalId: "final" });

				const reserve = s.config.budget.reserveUsdPerRequest;
				s.budget.reservedUsd += reserve;
				s.budget.requestsUsed++;
				s.assessmentsUsed++;

				try {
					const a = await s.client.assess({
						kind: "completion",
						snapshot,
						questions,
						state: stateEnvelope,
						signal: ctx.signal,
						deadlineMs: s.config.jev.deadlineMs,
					});
					if (a.cost.billedUsd !== null) {
						s.budget.billedUsd += a.cost.billedUsd;
						s.budget.reservedUsd -= reserve;
					} else {
						s.budget.unknownCosts++;
					}
					if (a.cost.marketUsd !== null) s.budget.marketUsd += a.cost.marketUsd;

					const requestPath = a.requestBody !== undefined ? s.trace.artifact("request", a.requestBody, a.requestId) : null;
					const responsePath = a.responseBody !== undefined ? s.trace.artifact("response", a.responseBody, a.requestId) : null;
					a.artifacts = { request: requestPath, response: responsePath };

					const decision = decideCompletion({ kind: "completion", assessment: a, snapshot, config: s.config, counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed, assessmentsUsed: s.assessmentsUsed, lastFocusKey: s.lastFocusKey, newEvidence: s.newEvidence } });
					s.trace.record("completion_assessment", {
						ok: a.ok,
						answers: a.answers,
						failure: a.failure,
						usage: a.usage,
						timings: a.timings,
						cost: a.cost,
						requestId: a.requestId,
						requestHash: a.requestHash,
						responseHash: a.responseHash,
						artifacts: a.artifacts,
						status: decision.status,
						reasons: decision.reasons,
						recommendedApply: decision.apply,
						actualApply: "none",
					});
					s.finalStatus = decision.status;
					s.completionDecision = decision;
					s.completionSignal = ctx.signal;
				} catch (e) {
					s.budget.reservedUsd -= reserve;
					s.trace.record("assessment_failure", { kind: "completion", error: String(e) });
				}
			}
		}
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!state) return undefined;
		const s = state;
		if (!s.completionDecision) return undefined;
		const result = applyCompletionContinuation(event, s.completionDecision, {
			mode: s.config.mode,
			traceEnabled: s.trace.enabled,
			signal: s.completionSignal,
			maxInterventionsPerTask: s.config.limits.maxInterventionsPerTask,
			maxTerminalContinuations: s.config.limits.maxTerminalContinuations,
			interventionsUsed: s.interventionsUsed,
			terminalContinuationsUsed: s.terminalContinuationsUsed,
		});
		const decision = s.completionDecision;
		if (result) {
			s.interventionsUsed++;
			s.terminalContinuationsUsed++;
			s.lastFocusKey = decision.focusKey;
			s.newEvidence = false;
			s.trace.record("intervention.continuation", {
				status: decision.status,
				reasons: decision.reasons,
				memo: decision.memo,
				counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed },
			});
			s.completionAssessed = false;
		}
		s.completionDecision = undefined;
		return result;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state) return;
		const finalStatus = state.finalStatus;
		state.trace.writeJson("summary.json", {
			runId: state.trace.runId,
			mode: state.config.mode,
			origin: "live",
			finalStatus,
			actualInterventions: state.interventionsUsed,
			terminalContinuations: state.terminalContinuationsUsed,
			assessments: state.assessmentsUsed,
			requests: state.budget.requestsUsed,
			budget: state.budget,
			cwd: ctx.cwd,
			tracePath: state.trace.dir,
			startedAt: state.startedAt,
			finishedAt: new Date().toISOString(),
			problems: state.problems,
			notices: state.notices,
			errors: [],
		});
	});

	pi.on("session_shutdown", () => {
		if (state) {
			state.trace.record("session_shutdown");
		}
	});

	pi.registerCommand("jev-status", {
		description: "Show jev-loop-control status",
		handler: async (_args, ctx) => {
			if (!state) {
				const info = { active: false, ...activation };
				const scrubbed = activationScrub(JSON.stringify(info, null, 2));
				if (ctx.hasUI) ctx.ui.notify(scrubbed);
				else console.error(scrubbed);
				return;
			}
			const status = {
				active: true,
				mode: state.config.mode,
				configPath: activation.configPath,
				cwd: activation.cwd,
				limits: {
					maxRequests: state.config.budget.maxRequests,
					allowanceUsd: state.config.budget.allowanceUsd,
					maxAssessments: state.config.limits.maxAssessments,
				},
				requests: state.budget.requestsUsed,
				assessments: state.assessmentsUsed,
				budget: state.budget,
				traceDir: state.trace.dir,
			};
			const scrubbed = activationScrub(JSON.stringify(status, null, 2));
			if (ctx.hasUI) ctx.ui.notify(scrubbed);
			else console.error(scrubbed);
		},
	});

	function applyToolCallDecision(s: LiveState, decision: Decision | undefined, event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
		if (s.batchBlocked && s.config.mode === "enforce" && s.trace.enabled && !ctx.signal?.aborted) {
			s.trace.record("intervention.block", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				reason: s.batchBlockReason,
				actualApply: "block",
			});
			return { block: true, reason: s.batchBlockReason ?? "supervisor blocked" };
		}

		if (decision && decision.apply === "block" && s.config.mode === "enforce" && s.trace.enabled && !ctx.signal?.aborted && s.interventionsUsed < s.config.limits.maxInterventionsPerTask) {
			s.batchBlocked = true;
			s.batchBlockReason = decision.memo ?? "supervisor blocked";
			s.interventionsUsed++;
			s.lastFocusKey = decision.focusKey;
			s.newEvidence = false;
			s.trace.record("intervention.block", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				reason: s.batchBlockReason,
				actualApply: "block",
				status: decision.status,
				reasons: decision.reasons,
				memo: decision.memo,
				counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed },
			});
			return applyDirectionBlock(decision, s.config.mode);
		}
		return undefined;
	}

	pi.registerCommand("jev-trace", {
		description: "Show jev-loop-control trace path",
		handler: async (_args, ctx) => {
			if (!state) {
				const info = { active: false, ...activation };
				const scrubbed = activationScrub(JSON.stringify(info, null, 2));
				if (ctx.hasUI) ctx.ui.notify(scrubbed);
				else console.error(scrubbed);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(state.trace.dir);
			else console.error(state.trace.dir);
		},
	});
}
