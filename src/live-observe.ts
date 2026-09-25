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
import type { Assessment, AssessmentKind, BudgetState, Decision, EvidenceSnapshot, Question, JevClient } from "./types.ts";
import { applyCompletionContinuation, applyDirectionBlock } from "./interventions.ts";
import { assessmentBudgetReason, retryRequestBudget, retryRequestBudgetReason } from "./budget.ts";
import type { ToolCallEventResult, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createRecovery, advanceRecovery, recoveryInstruction, beginRecovery, recoveryEvidenceKey, type RecoveryState, type RecoveryMode } from "./recovery.ts";

interface LiveState {
	config: SupervisorConfig;
	trace: TraceStore;
	scrub: (text: string) => string;
	client: JevClient;
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
	completionSnapshot: EvidenceSnapshot | null;
	recovery: RecoveryState;
	epoch: number;
	/** Epoch of the run that produced `completionDecision`; a mismatch is stale. */
	completionEpoch: number;
	proposalId: string;
	lastFailure: string | null;
	/** Deferred siblings of a batch already counted as one intervention. */
	deferredSiblings: number;
	/** Last guidance actually injected, so one recovery objective traces once. */
	guidanceKey: string | null;
}

/** Our own injected guidance message; the context hook drops nothing else. */
const GUIDANCE_CUSTOM_TYPE = "jev-loop-control.recovery-guidance";

export function liveObserve(pi: ExtensionAPI, dependencies?: { client?: JevClient; fetchImpl?: typeof fetch }): void {
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

		// The live client is built before the session state exists, so the retry
		// gate reads this shared object: the adapter mutates it in place, and the
		// transport sees the counts as they are at the moment a 503 arrives.
		const budgetProbe: BudgetState = { requestsUsed: 0, reservedUsd: 0, billedUsd: 0, marketUsd: 0, unknownCosts: 0 };

		const client = dependencies?.client ?? createHttpClient({
			endpoint: config.jev.endpoint,
			// Tests script the wire here; production leaves it undefined and uses fetch.
			...(dependencies?.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
			model: config.jev.model,
			apiKeyEnv: config.jev.apiKeyEnv,
			deadlineMs: config.jev.deadlineMs,
			maxRequestBytes: config.jev.maxRequestBytes,
			maxResponseBytes: config.jev.maxResponseBytes,
			secrets: [apiKey],
			// With a scripted fetch the key never belongs in the real environment, so
			// the client gets its own env copy; production keeps reading process.env.
			...(dependencies?.fetchImpl ? { env: { ...process.env, [config.jev.apiKeyEnv]: apiKey } } : {}),
			// The one HTTP 503 retry spends from the same caps as any request, and
			// this is asked at retry time against the attempts already DISPATCHED
			// (the adapter's own counter only learns the total at settlement), so
			// `budget.maxRequests` really does decide whether the next request goes
			// out, and an already-dispatched attempt is never counted twice.
			retryBudget: ({ attempts }) => {
				const extra = Math.max(0, attempts - 1);
				const probe: BudgetState = {
					requestsUsed: budgetProbe.requestsUsed + extra,
					reservedUsd: budgetProbe.reservedUsd + extra * config.budget.reserveUsdPerRequest,
					billedUsd: budgetProbe.billedUsd,
					marketUsd: budgetProbe.marketUsd,
					unknownCosts: budgetProbe.unknownCosts,
				};
				return retryRequestBudget(config, probe);
			},
		});

		state = {
			config,
			trace,
			scrub: makeScrub([apiKey]),
			client,
			messages: [],
			executedIds: new Set(),
			budget: budgetProbe,
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
			completionSnapshot: null,
			recovery: createRecovery(),
			epoch: 0,
			completionEpoch: -1,
			proposalId: "",
			lastFailure: null,
			deferredSiblings: 0,
			guidanceKey: null,
		};

		activation.reason = "";
		trace.manifest({ configPath: config.configPath, mode: config.mode, runId: runIdStr });
		console.error(`jev-loop-control: ${config.mode} active, run dir: ${traceDir}`);
	});

	pi.on("input", (event) => {
		if (!state) return;
		if (event.source !== "extension") {
			const newText = typeof event.text === "string" ? event.text : "";
			if (state.userTask) {
				state.userTask += "\n\n--- Follow-up Correction ---\n" + newText;
			} else {
				state.userTask = newText;
			}
			if (!state.taskId) {
				state.taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			}
			state.finalMessage = undefined;
			state.completionAssessed = false;
			state.assessmentPromise = null;
			state.assessmentSnapshot = null;
			state.assessmentQuestions = null;
			state.assessmentState = null;
			state.finalStatus = "UNCHECKED";
			state.completionDecision = undefined;
			state.completionSignal = undefined;
			state.completionSnapshot = null;
			state.batchBlocked = false;
			state.batchBlockReason = null;
			state.epoch++;

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
			state.proposalNumber++;
			state.proposalId = `p${state.proposalNumber}`;
			if (state.recovery.active) {
				const prevActive = state.recovery.active;
				const expired = advanceRecovery(state.recovery);
				if (expired) {
					state.trace.record("recovery.expired", { mode: prevActive.mode, objective: prevActive.objective });
				}
			}
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
		state.trace.record("tool_execution_start", { toolCallId: event.toolCallId, toolName: event.toolName });
	});

	pi.on("tool_result", (event) => {
		if (!state) return;
		state.executedIds.add(event.toolCallId);
		state.newEvidence = true;
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
		const epoch = s.epoch;

		s.trace.record("tool_call", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			actualApply: "none",
		});

		if (s.batchBlocked && s.config.mode === "enforce" && s.trace.enabled && !ctx.signal?.aborted) {
			deferSiblingBlock(s, event);
			return { block: true, reason: s.batchBlockReason ?? "supervisor blocked" };
		}

		if (s.assessmentPromise) {
			const decision = await s.assessmentPromise;
			if (state !== s || s.epoch !== epoch) return undefined;
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
			priorInterventions: s.recovery.history.map(h => ({ kind: h.kind, at: h.at, focus: h.objective })),
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
			workMode: s.recovery.active?.mode ?? "EXECUTE",
			proposalNumber: s.proposalNumber,
			interventionsUsed: s.interventionsUsed,
			interventionLimit: s.config.limits.maxInterventionsPerTask,
			previousInterventions: s.recovery.history.map(h => ({ kind: h.kind, status: h.status, focus: h.focus, at: h.at })),
			recoveryObjective: s.recovery.active?.objective,
		};
		const stateEnvelope = buildState({ kind: "direction", snapshot, controller, proposalId: s.proposalId });

		const reserve = s.config.budget.reserveUsdPerRequest;
		s.budget.reservedUsd += reserve;
		s.budget.requestsUsed++;
		s.assessmentsUsed++;

		const promise = s.client.assess({
			kind: "direction",
			snapshot,
			questions,
			state: stateEnvelope,
			signal: ctx.signal,
			deadlineMs: s.config.jev.deadlineMs,
		}).then((a) => {
			if (a.usage.attempts === 0) {
				s.budget.reservedUsd -= reserve;
				s.budget.requestsUsed--;
			} else {
				if (a.cost.billedUsd !== null) {
					s.budget.billedUsd += a.cost.billedUsd;
					s.budget.reservedUsd -= reserve;
				} else {
					s.budget.unknownCosts++;
				}
				if (a.cost.marketUsd !== null) s.budget.marketUsd += a.cost.marketUsd;
				accountRetryRequests(s, a, "direction");
			}

			const requestPath = a.requestBody !== undefined ? s.trace.artifact("request", a.requestBody, a.requestId) : null;
			const responsePath = a.responseBody !== undefined ? s.trace.artifact("response", a.responseBody, a.requestId) : null;
			a.artifacts = { request: requestPath, response: responsePath };

			const decision = decideDirection({ kind: "direction", assessment: a, snapshot, config: s.config, counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed, assessmentsUsed: s.assessmentsUsed, lastFocusKey: s.lastFocusKey, newEvidence: s.newEvidence } });
			if (!a.ok) {
				const msg = s.scrub(a.failure?.message ?? "assessment failed");
				if (s.lastFailure !== msg) {
					console.error(msg);
					s.lastFailure = msg;
				}
			} else {
				s.lastFailure = null;
			}
			s.trace.record("direction_assessment", {
				ok: a.ok,
				retry: retryOutcomeNote(a),
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
				proposalId: s.proposalId,
				contextSelection: snapshot.representation.context_selection,
				partialCoverage: a.partialCoverage ?? false,
			});
			return decision;
		}).catch((e) => {
			s.budget.reservedUsd -= reserve;
			const msg = s.scrub(String(e));
			if (s.lastFailure !== msg) {
				console.error(msg);
				s.lastFailure = msg;
			}
			s.trace.record("assessment_failure", { kind: "direction", error: msg });
			return undefined;
		});

		s.assessmentPromise = promise;
		s.assessmentSnapshot = snapshot;
		s.assessmentQuestions = questions;
		s.assessmentState = stateEnvelope;

		const decision = await promise;
		if (state !== s || s.epoch !== epoch) return undefined;
		return applyToolCallDecision(s, decision, event, ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state) return;
		const s = state;
		const epoch = s.epoch;
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
					priorInterventions: s.recovery.history.map(h => ({ kind: h.kind, at: h.at, focus: h.objective })),
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
					workMode: s.recovery.active?.mode ?? "EXECUTE",
					proposalNumber: s.proposalNumber,
					interventionsUsed: s.interventionsUsed,
					interventionLimit: s.config.limits.maxInterventionsPerTask,
					previousInterventions: s.recovery.history.map(h => ({ kind: h.kind, status: h.status, focus: h.focus, at: h.at })),
					recoveryObjective: s.recovery.active?.objective,
				};
				const stateEnvelope = buildState({ kind: "completion", snapshot, controller, proposalId: s.proposalId });

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
					if (a.usage.attempts === 0) {
						s.budget.reservedUsd -= reserve;
						s.budget.requestsUsed--;
					} else {
						if (a.cost.billedUsd !== null) {
							s.budget.billedUsd += a.cost.billedUsd;
							s.budget.reservedUsd -= reserve;
						} else {
							s.budget.unknownCosts++;
						}
						if (a.cost.marketUsd !== null) s.budget.marketUsd += a.cost.marketUsd;
						accountRetryRequests(s, a, "completion");
					}

					const requestPath = a.requestBody !== undefined ? s.trace.artifact("request", a.requestBody, a.requestId) : null;
					const responsePath = a.responseBody !== undefined ? s.trace.artifact("response", a.responseBody, a.requestId) : null;
					a.artifacts = { request: requestPath, response: responsePath };

					const decision = decideCompletion({ kind: "completion", assessment: a, snapshot, config: s.config, counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed, assessmentsUsed: s.assessmentsUsed, lastFocusKey: s.lastFocusKey, newEvidence: s.newEvidence } });
					if (!a.ok) {
						const msg = s.scrub(a.failure?.message ?? "assessment failed");
						if (s.lastFailure !== msg) {
							console.error(msg);
							s.lastFailure = msg;
						}
					} else {
						s.lastFailure = null;
					}
					s.trace.record("completion_assessment", {
						ok: a.ok,
						retry: retryOutcomeNote(a),
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
						proposalId: s.proposalId,
						contextSelection: snapshot.representation.context_selection,
						partialCoverage: a.partialCoverage ?? false,
					});
					if (state !== s || s.epoch !== epoch) return;
					s.finalStatus = decision.status;
					s.completionDecision = decision;
					s.completionSignal = ctx.signal;
					s.completionSnapshot = snapshot;
					s.completionEpoch = epoch;
				} catch (e) {
					s.budget.reservedUsd -= reserve;
					const msg = s.scrub(String(e));
					if (s.lastFailure !== msg) {
						console.error(msg);
						s.lastFailure = msg;
					}
					s.trace.record("assessment_failure", { kind: "completion", error: msg });
				}
			}
		}
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!state) return undefined;
		const s = state;
		if (!s.completionDecision) return undefined;
		// A decision from a superseded run never acts on this boundary.
		if (s.completionEpoch !== s.epoch) {
			s.trace.record("intervention.suppressed", {
				reason: "stale_epoch",
				proposalId: s.proposalId,
				requestId: s.completionDecision.assessment.requestId,
			});
			s.completionDecision = undefined;
			return undefined;
		}
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
			if (s.completionSnapshot && decision.memo && decision.focusKey) {
				const applied = beginRecovery(s.recovery, {
					mode: decision.status as RecoveryMode,
					objective: decision.memo,
					focusKey: decision.focusKey,
					evidenceKey: recoveryEvidenceKey(s.completionSnapshot),
					at: new Date().toISOString(),
				}, s.config.limits.proposalLease);
				if (!applied) {
					s.trace.record("intervention.suppressed", {
						reason: "duplicate_objective_evidence",
						previousFocusKey: decision.focusKey,
						objectiveMatchesPrior: s.recovery.active?.objective === decision.memo,
						evidenceMatchesPrior: s.recovery.active?.evidenceKey === recoveryEvidenceKey(s.completionSnapshot),
						proposalId: s.proposalId,
						requestId: decision.assessment.requestId,
					});
					s.completionDecision = undefined;
					return undefined;
				}
			}
			s.interventionsUsed++;
			s.terminalContinuationsUsed++;
			s.lastFocusKey = decision.focusKey;
			s.newEvidence = false;
			s.trace.record("intervention.continuation", {
				status: decision.status,
				reasons: decision.reasons,
				memo: decision.memo,
				actualApply: "continue",
				mode: decision.status,
				objective: decision.memo,
				proposalId: s.proposalId,
				requestId: decision.assessment.requestId,
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
			origin: state.client.origin,
			finalStatus,
			lastFailure: state.lastFailure,
			actualInterventions: state.interventionsUsed,
			deferredSiblings: state.deferredSiblings,
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
			errors: state.trace.failure !== null ? [state.trace.failure] : [],
			traceFailure: state.trace.failure,
		});
	});

	pi.on("session_shutdown", () => {
		if (state) {
			state.trace.record("session_shutdown");
		}
	});

	pi.on("context", (event, ctx) => {
		if (!state) return undefined;
		const s = state;
		if (s.config.mode !== "enforce") return undefined;
		if (!s.trace.enabled) return undefined;
		if (ctx.signal?.aborted) return undefined;

		// Only our own previous guidance is dropped; everything else, including Pi's
		// prompt and tool state, passes through untouched.
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === GUIDANCE_CUSTOM_TYPE));
		const instruction = recoveryInstruction(s.recovery);
		if (instruction && s.recovery.active) {
			messages.push({
				role: "custom",
				customType: GUIDANCE_CUSTOM_TYPE,
				content: instruction,
				display: false,
				timestamp: Date.now(),
			});
			const key = `${s.recovery.active.focusKey}:${s.recovery.active.objective}`;
			if (s.guidanceKey !== key) {
				s.guidanceKey = key;
				s.trace.record("recovery.guidance", {
					mode: s.recovery.active.mode,
					objective: s.recovery.active.objective,
					remainingProposals: s.recovery.active.remainingProposals,
					proposalId: s.proposalId,
					content: instruction,
				});
			}
		}
		else {
			s.guidanceKey = null;
		}
		return { messages };
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
					maxInterventions: state.config.limits.maxInterventionsPerTask,
				},
				requests: state.budget.requestsUsed,
				assessments: state.assessmentsUsed,
				budget: state.budget,
				traceDir: state.trace.dir,
				activeRecovery: state.recovery.active,
				lastFailure: state.lastFailure,
			};
			const scrubbed = activationScrub(JSON.stringify(status, null, 2));
			if (ctx.hasUI) ctx.ui.notify(scrubbed);
			else console.error(scrubbed);
		},
	});

	/**
	 * A 503 retry inside one assessment is ONE assessment, not two: the adapter
	 * already counted and reserved for the assessment, and the failed first request
	 * left an unknown cost that stays unknown. What the adapter owes is the honest
	 * REQUEST count for the second dispatch, so a retry can never hide from
	 * `budget.maxRequests`, and it never counts as another assessment.
	 */
	function accountRetryRequests(s: LiveState, a: Assessment, kind: AssessmentKind): void {
		const extra = a.usage.attempts - 1;
		if (extra <= 0) return;
		s.budget.requestsUsed += extra;
		// The FIRST 503's cost is always unknown, regardless of what the retry
		// finally reports: the first request was reserved, and a settled final cost
		// only settles that one reservation. So each extra dispatch arms its own
		// reservation and stays an unknown cost, even on a known-cost success.
		s.budget.reservedUsd += s.config.budget.reserveUsdPerRequest * extra;
		s.budget.unknownCosts += extra;
		s.trace.record("assessment.retry", {
			kind,
			extraRequests: extra,
			attempts: a.usage.attempts,
			unknownCosts: extra,
			reservedUsd: s.config.budget.reserveUsdPerRequest * extra,
			requestId: a.requestId,
			note: retryOutcomeNote(a),
			counters: { requests: s.budget.requestsUsed, assessments: s.assessmentsUsed },
		});
	}

	/** The retry status the transport reported, or null when there was no 503. */
	function retryOutcomeNote(a: Assessment): string | null {
		const message = `${a.notes ?? ""} ${a.failure?.message ?? ""}`;
		const match = /(http 503[^;]*)/.exec(message);
		return match ? match[1]!.trim() : null;
	}

	function applyToolCallDecision(s: LiveState, decision: Decision | undefined, event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
		if (s.batchBlocked && s.config.mode === "enforce" && s.trace.enabled && !ctx.signal?.aborted) {
			deferSiblingBlock(s, event);
			return { block: true, reason: s.batchBlockReason ?? "supervisor blocked" };
		}

		const cap = s.config.limits.maxInterventionsPerTask;
		if (decision && decision.apply === "block" && s.config.mode === "enforce" && s.trace.enabled && !ctx.signal?.aborted && (cap === null || s.interventionsUsed < cap)) {
			if (s.assessmentSnapshot && decision.memo && decision.focusKey && ["RESEARCH", "REPLAN", "VERIFY", "EXECUTE"].includes(decision.status)) {
				const applied = beginRecovery(s.recovery, {
					mode: decision.status as RecoveryMode,
					objective: decision.memo,
					focusKey: decision.focusKey,
					evidenceKey: recoveryEvidenceKey(s.assessmentSnapshot),
					at: new Date().toISOString(),
				}, s.config.limits.proposalLease);
				if (!applied) {
					s.trace.record("intervention.suppressed", {
						reason: "duplicate_objective_evidence",
						previousFocusKey: decision.focusKey,
						objectiveMatchesPrior: s.recovery.active?.objective === decision.memo,
						evidenceMatchesPrior: s.recovery.active?.evidenceKey === recoveryEvidenceKey(s.assessmentSnapshot),
						proposalId: s.proposalId,
						requestId: decision.assessment.requestId,
					});
					return undefined;
				}
			}
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
				sibling: false,
				status: decision.status,
				reasons: decision.reasons,
				memo: decision.memo,
				proposalId: s.proposalId,
				requestId: decision.assessment.requestId,
				mode: decision.status,
				objective: decision.memo,
				counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed },
			});
			return applyDirectionBlock(decision, s.config.mode);
		}
		return undefined;
	}

	/**
	 * A deferred sibling of an already-counted batch is NOT another intervention.
	 * It traces as part of the same block (same proposalId) so the counts in the
	 * trace and in summary.json are real rather than per-tool-inflated.
	 */
	function deferSiblingBlock(s: LiveState, event: ToolCallEvent): void {
		s.deferredSiblings++;
		s.trace.record("intervention.block", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			reason: s.batchBlockReason,
			actualApply: "block",
			sibling: true,
			proposalId: s.proposalId,
			counters: { interventionsUsed: s.interventionsUsed, terminalContinuationsUsed: s.terminalContinuationsUsed },
		});
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
