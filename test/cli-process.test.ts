import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/**
 * Real-process proof: the shipped `src/index.ts` is loaded by the real Pi CLI
 * through jiti, the fake actor is registered as a provider by an extension
 * factory, and a toy tool records actual execution to a separate file.
 *
 * Offline, scripted, and synthetic. It proves packaging and lifecycle
 * compatibility (public hooks, TS loading, provider registration, tool
 * execution), not model or Jev quality.
 */

/**
 * Run a child to completion with a hard kill timeout.
 *
 * `stdin` is deliberately `ignore`: Pi's print mode drains piped standard input
 * to end-of-file before it starts the session, so an inherited open stdin pipe
 * makes the child wait forever. `execFile`/`spawn` defaults leave that pipe open.
 */
function runChild(
	bin: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`child timed out after ${options.timeout}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, options.timeout);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code });
		});
	});
}

interface PiCli {
	cliPath: string;
	packageRoot: string;
}

/**
 * Locate the real CLI entry without guessing the install layout: resolve the
 * package's public entry, then step out of `dist/` to the package root, which is
 * where `package.json` (and therefore the version) actually lives.
 */
function findPiCli(): PiCli | undefined {
	try {
		// The public entry is an ESM-only export map entry, so resolve it as a module.
		const main = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const packageRoot = dirname(dirname(main));
		const cliPath = join(packageRoot, "dist", "bundle", "cli.js");
		if (!existsSync(cliPath) || !existsSync(join(packageRoot, "package.json"))) {
			return undefined;
		}
		return { cliPath, packageRoot };
	}
	catch {
		return undefined;
	}
}

function piVersion(packageRoot: string): string {
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
	return manifest.version ?? "unknown";
}

/**
 * The real-process fixture spawns the real Pi CLI (about 0.3 seconds here) and
 * needs no network and no model. Skip it with `JEV_SKIP_CLI_PROCESS=1 npm test`
 * on machines where launching a second Node process is restricted.
 */
function cliFixtureEnabled(): boolean {
	return process.env.JEV_SKIP_CLI_PROCESS !== "1";
}

/**
 * Minimal child environment. Pi state is redirected to the fixture directory and
 * the developer's own Pi configuration, proxy settings, and provider keys are not
 * passed down.
 */
function childEnv(tempDir: string): NodeJS.ProcessEnv {
	const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PWD", "SHELL", "USER", "LOGNAME"];
	if (process.platform === "win32") {
		allowed.push("SystemRoot", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA");
	}
	const env: NodeJS.ProcessEnv = {};
	for (const key of allowed) {
		const value = process.env[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return {
		...env,
		PI_CODING_AGENT_DIR: join(tempDir, "pi-home"),
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		JEV_LOOP_CONTROL_MODE: "observe",
		JEV_LOOP_CONTROL_TRACE: join(tempDir, "trace.jsonl"),
		JEV_FAKE_SCRIPT: join(tempDir, "script.json"),
		JEV_TOY_LOG: join(tempDir, "marks.log"),
		JEV_NETWORK_LOG: join(tempDir, "network.log"),
	};
}

test("the shipped extension loads in a real Pi CLI process and traces the episode", {
	skip: cliFixtureEnabled() ? false : "JEV_SKIP_CLI_PROCESS=1",
}, async (t) => {
	const pi = findPiCli();
	if (!pi) {
		t.skip("the Pi CLI is not installed in this checkout (run npm ci)");
		return;
	}
	const tempDir = mkdtempSync(join(tmpdir(), "jev-cli-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));

	const scriptPath = join(tempDir, "script.json");
	writeFileSync(
		scriptPath,
		JSON.stringify([
			{ toolCalls: [{ name: "mark", args: { note: "one" }, id: "call-1" }] },
			{ text: "all done" },
		]),
		"utf8",
	);
	const marksPath = join(tempDir, "marks.log");
	const tracePath = join(tempDir, "trace.jsonl");
	const networkPath = join(tempDir, "network.log");
	writeFileSync(marksPath, "", "utf8");
	writeFileSync(networkPath, "", "utf8");

	const here = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(here, "..");
	const args = [
		"--import",
		join(here, "fixtures", "no-network.mjs"),
		pi.cliPath,
		"--offline",
		"--no-session",
		"--no-builtin-tools",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--provider",
		"jev-fake",
		"--model",
		"fake-actor",
		"--extension",
		join(here, "fixtures", "cli-fake-actor.ts"),
		"--extension",
		join(here, "fixtures", "cli-toy-tools.ts"),
		"--extension",
		join(repoRoot, "src", "index.ts"),
		"--print",
		"do the thing",
	];

	const { stdout } = await runChild(process.execPath, args, {
		cwd: repoRoot,
		env: childEnv(tempDir),
		timeout: 90_000,
	});

	assert.match(stdout, /all done/, "the scripted answer must reach standard output");
	assert.equal(readFileSync(networkPath, "utf8").trim(), "", "the child process must not touch the network");

	const marks = readFileSync(marksPath, "utf8").trim().split("\n").filter(Boolean);
	assert.equal(marks.length, 1, "the toy tool executed exactly once");
	assert.match(marks[0] ?? "", /executed call-1/);

	const lines = readFileSync(tracePath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as {
			seq: number;
			type: string;
			role?: string;
			toolCalls?: string[];
			signal?: string;
			mode?: string;
			effectiveMode?: string;
		});
	const types = lines.map((line) => line.type);
	assert.equal(lines[0]?.type, "bootstrap_config");
	assert.equal(lines[0]?.mode, "observe");

	const proposal = lines.find((line) => line.role === "assistant" && (line.toolCalls?.length ?? 0) === 1);
	const proposalIndex = proposal === undefined ? -1 : lines.indexOf(proposal);
	const hookIndex = types.indexOf("tool_call");
	const executionIndex = types.indexOf("tool_execution_end");
	assert.ok(proposalIndex >= 0, "the finalized proposal must be observable");
	assert.ok(proposalIndex < hookIndex, "the whole message is final before preflight");
	assert.ok(hookIndex < executionIndex, "preflight precedes the tool result");

	const settle = lines.find((line) => line.type === "agent_before_settle");
	assert.equal(settle?.signal, "absent", "the pre-settlement signal gap also shows in the real process");

	// Order in a real print-mode process: settle before the shutdown record, and
	// `session_shutdown` is the final line of the trace.
	assert.deepEqual(types.slice(0, 4), ["bootstrap_config", "session_start", "input", "agent_start"]);
	assert.equal(types.at(-1), "session_shutdown", "the trace ends with shutdown");
	assert.ok(
		types.lastIndexOf("agent_settled") > types.lastIndexOf("agent_before_settle"),
		"settlement follows the boundary",
	);
	assert.ok(
		types.lastIndexOf("agent_settled") < types.lastIndexOf("session_shutdown"),
		"the agent settles before shutdown",
	);
	assert.ok(
		types.indexOf("message_end") < types.indexOf("tool_call"),
		"the finalized proposal precedes preflight",
	);
	assert.ok(
		types.indexOf("tool_call") < types.indexOf("tool_execution_end"),
		"preflight precedes tool completion",
	);

	// Record the version actually exercised so the artifact stays honest.
	t.diagnostic(`Pi CLI ${piVersion(pi.packageRoot)} at ${pi.cliPath}`);
});
