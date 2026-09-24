/**
 * Deterministic test harness for jev-loop-control.
 *
 * Everything here is SYNTHETIC. The actor is a scripted fake provider
 * (`fauxProvider` from `@earendil-works/pi-ai`, a public test double); the tools
 * are instrumented toys registered through `pi.registerTool`. No real model and
 * no Jev endpoint is contacted, and nothing here proves anything about Qwen or
 * Jev answer quality. What it does prove is how the real Pi 0.87.1 lifecycle
 * behaves around public extension hooks.
 *
 * Public API only: `createAgentSession`, `DefaultResourceLoader`,
 * `SessionManager.inMemory`, `SettingsManager.inMemory`, `ModelRuntime`,
 * inline extension factories, `pi.registerTool`, and documented events.
 * No private fields, no monkey-patched Pi internals.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionFactory,
	type ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** One ordered observation. `seq` is assigned by a single shared counter. */
export interface OrderRecord {
	seq: number;
	/** `pi:<event>` for extension hooks, `tool:*` for real tool progress. */
	at: string;
	role?: string;
	/** Sibling tool calls of a finalized assistant message as `name:id`. */
	toolCalls?: string[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	signal?: "present" | "absent";
	outcome?: string;
	/** Number of boundary drafts already accumulated. */
	entries?: number;
	continueRequested?: boolean;
	canContinue?: boolean;
	pendingMessages?: number;
	messages?: number;
	note?: string | null;
}

export interface ToyTool {
	name: string;
	executionMode?: ToolExecutionMode;
	/** Awaited inside execute(); used to hold a batch open for cancellation tests. */
	gate?: Promise<void>;
}

export interface FixtureOptions {
	/** Scripted actor turns, consumed one per provider request. */
	script: FauxResponseStep[];
	/** Toy tools to register before the session starts. */
	tools?: ToyTool[];
	/** Extensions under test, loaded after the probe. */
	extensions?: Array<ExtensionFactory | { name: string; factory: ExtensionFactory }>;
	/** Extra session settings. */
	settings?: Record<string, unknown>;
	/**
	 * Environment applied to the extension factory phase. The harness always
	 * clears `JEV_LOOP_CONTROL_*` first, so a test opts in explicitly.
	 */
	env?: Record<string, string | undefined>;
	/** Called for every AgentSession event, in dispatch order. */
	onSessionEvent?: (event: AgentSessionEvent) => void;
}

export interface Fixture {
	/** Ordered observations from hooks, tools, and provider requests. */
	readonly order: OrderRecord[];
	/** Names of tools whose `execute()` actually ran, in run order. */
	readonly executed: string[];
	/** Extension/runtime diagnostics reported through `bindExtensions({ onError })`. */
	readonly errors: Array<{ extensionPath: string; event: string; error: string }>;
	/** Every blocked network attempt made while this fixture was alive. */
	readonly networkAttempts: string[];
	/** Number of fake-provider requests so far (public faux state). */
	providerCalls(): number;
	readonly session: AgentSession;
	readonly faux: {
		state: { callCount: number };
		setResponses: (responses: FauxResponseStep[]) => void;
		appendResponses: (responses: FauxResponseStep[]) => void;
		getPendingResponseCount: () => number;
	};
	model: Model<string>;
	tempDir: string;
	dispose(): void;
}

/** A promise plus its resolver, used to hold a run at a chosen point. */
export interface Gate {
	promise: Promise<void>;
	open: () => void;
}

export function assertNoNetwork(attempts: string[]): void {
	if (attempts.length > 0) {
		throw new Error(`fixture touched the network: ${attempts.join(", ")}`);
	}
}

/** A promise plus its resolver, used to hold a run at a chosen point. */
export function createGate(): Gate {
	let open = (): void => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Refuse to let a fixture touch the network. Any attempt throws loudly. */
export class NetworkGuard {
	readonly attempts: string[] = [];
	#saved: Array<() => void> = [];

	install(): void {
		const record = (what: string): void => {
			this.attempts.push(what);
		};
		const blockedFetch = (input: unknown): never => {
			record(String(typeof input === "string" ? input : (input as { url?: string })?.url ?? "fetch"));
			throw new Error(`network access is not allowed in fixtures: ${String(input)}`);
		};
		this.#save(
			() => globalThis.fetch as unknown,
			(value) => {
				globalThis.fetch = value as typeof fetch;
			},
			blockedFetch as unknown,
		);

		for (const mod of [http, https] as const) {
			for (const key of ["request", "get"] as const) {
				const original = (mod as unknown as Record<string, unknown>)[key] as unknown;
				this.#save(
					() => (mod as unknown as Record<string, unknown>)[key] as unknown,
					(value) => {
						(mod as unknown as Record<string, unknown>)[key] = value;
					},
					(...args: unknown[]): never => {
						record(`${mod === http ? "http" : "https"}.${key}(${JSON.stringify(args[0])})`);
						throw new Error(`network access is not allowed in fixtures: ${String(args[0])}`);
					},
				);
				void original;
			}
		}
	}

	restore(): void {
		for (const restore of this.#saved.splice(0).reverse()) {
			restore();
		}
	}

	#save(get: () => unknown, set: (value: unknown) => void, replacement: unknown): void {
		const original = get();
		set(replacement);
		this.#saved.push(() => set(original));
	}
}

/**
 * Build a session with the fake actor, toy tools, and an ordering probe.
 *
 * The probe is itself an inline extension, so ordering comes from real Pi hook
 * dispatch rather than from hand-invoked callbacks.
 */
export async function createFixture(options: FixtureOptions): Promise<Fixture> {
	const tempDir = mkdtempSync(join(tmpdir(), "jev-loop-control-"));
	const agentDir = join(tempDir, "agent");
	const order: OrderRecord[] = [];
	const executed: string[] = [];
	const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
	let seq = 0;
	const push = (at: string, fields: Omit<OrderRecord, "seq" | "at"> = {}): void => {
		order.push({ seq: seq++, at, ...fields });
	};

	// Keep every Pi path out of the developer's real ~/.pi.
	process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-home");
	process.env.PI_OFFLINE = "1";
	process.env.PI_TELEMETRY = "0";
	process.env.JEV_LOOP_CONTROL_MODE = undefined;
	process.env.JEV_LOOP_CONTROL_TRACE = undefined;
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (value === undefined) {
			delete process.env[key];
		}
		else {
			// `{tempDir}` lets a test point the extension at fixture storage.
			process.env[key] = value.replaceAll("{tempDir}", tempDir);
		}
	}

	const guard = new NetworkGuard();
	guard.install();

	const faux = fauxProvider({
		provider: "jev-fake",
		// One chunk per block: streamed deltas do not vary run to run.
		tokenSize: { min: 100_000, max: 100_000 },
		models: [{ id: "fake-actor", name: "Fake Actor", reasoning: false, input: ["text"] }],
	});
	faux.setResponses(options.script);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const model = modelRuntime.getModel("jev-fake", "fake-actor") as Model<string> | undefined;
	if (!model) {
		throw new Error("fake actor model was not registered");
	}

	const tools = options.tools ?? [];
	const toolExtension: ExtensionFactory = (pi) => {
		for (const tool of tools) {
			pi.registerTool({
				name: tool.name,
				label: tool.name,
				description: `Synthetic toy tool ${tool.name}. It records that it executed.`,
				parameters: Type.Object({ note: Type.Optional(Type.String()) }),
				...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
				execute: async (_toolCallId, params, signal) => {
					push("tool:enter", { toolName: tool.name, toolCallId: _toolCallId });
					if (tool.gate) {
						await tool.gate;
					}
					if (signal?.aborted) {
						// The tool observed cancellation before recording any effect.
						push("tool:aborted", { toolName: tool.name, toolCallId: _toolCallId });
						throw new Error("synthetic tool aborted before recording an effect");
					}
					executed.push(tool.name);
					push("tool:effect", {
						toolName: tool.name,
						toolCallId: _toolCallId,
						note: (params as { note?: string }).note ?? null,
					});
					return {
						content: [{ type: "text" as const, text: `executed:${tool.name}` }],
						details: { executed: true },
					};
				},
			});
		}
	};

	const probe: ExtensionFactory = (pi) => {
		const observedSignal = (ctx: { signal: AbortSignal | undefined }): "present" | "absent" =>
			ctx.signal === undefined ? "absent" : "present";

		pi.on("message_end", (event) => {
			push("pi:message_end", {
				role: event.message.role,
				toolCalls: toolCallsOf(event.message).map((block) => `${block.name}:${block.id}`),
			});
		});
		pi.on("tool_execution_start", (event) => {
			push("pi:tool_execution_start", { toolName: event.toolName, toolCallId: event.toolCallId });
		});
		pi.on("tool_call", (event, ctx) => {
			push("pi:tool_call", {
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				signal: observedSignal(ctx),
			});
			return undefined;
		});
		pi.on("tool_result", (event) => {
			push("pi:tool_result", { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
		});
		pi.on("tool_execution_end", (event) => {
			push("pi:tool_execution_end", { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
		});
		pi.on("agent_start", (_event, ctx) => {
			push("pi:agent_start", { signal: observedSignal(ctx) });
		});
		pi.on("agent_end", (event, ctx) => {
			push("pi:agent_end", { messages: event.messages.length, signal: observedSignal(ctx) });
		});
		pi.on("agent_before_settle", (event, ctx) => {
			push("pi:agent_before_settle", {
				outcome: event.outcome,
				entries: event.entries.length,
				continueRequested: event.continue,
				canContinue: event.context.canContinue,
				pendingMessages: event.context.pendingMessages.length,
				signal: observedSignal(ctx),
			});
			return undefined;
		});
		pi.on("agent_settled", () => {
			push("pi:agent_settled");
		});
	};

	const loader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Synthetic fixture system prompt. Call tools only when instructed.",
		extensionFactories: [
			{ name: "fixture-tools", factory: toolExtension },
			{ name: "fixture-probe", factory: probe },
			...options.extensions ?? [],
		],
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(tempDir),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			enableAnalytics: false,
			enableInstallTelemetry: false,
			cacheWarming: "off",
			...options.settings,
		}),
		noTools: "builtin",
	});

	if (options.onSessionEvent) {
		const listener = options.onSessionEvent;
		session.subscribe(listener);
	}
	// Public binding point for extension diagnostics, including a boundary
	// continuation that had no runnable model context.
	await session.bindExtensions({
		onError: (error) => {
			errors.push({ extensionPath: error.extensionPath, event: error.event, error: error.error });
		},
	});

	return {
		order,
		executed,
		errors,
		networkAttempts: guard.attempts,
		providerCalls: () => faux.state.callCount,
		session,
		faux,
		model,
		tempDir,
		dispose() {
			session.dispose();
			guard.restore();
			try {
				assertNoNetwork(guard.attempts);
			}
			finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}

export { fauxAssistantMessage, fauxToolCall, Type };
export type { FauxResponseStep };

/** Tool-call blocks of a finalized assistant message, without unsafe casts. */
export function toolCallsOf(message: unknown): Array<{ id: string; name: string }> {
	const value = message as { role?: unknown; content?: unknown };
	if (value.role !== "assistant" || !Array.isArray(value.content)) {
		return [];
	}
	const blocks = value.content as Array<{ type?: unknown; id?: unknown; name?: unknown }>;
	return blocks
		.filter((block) => block?.type === "toolCall")
		.map((block) => ({ id: String(block.id ?? ""), name: String(block.name ?? "") }));
}
