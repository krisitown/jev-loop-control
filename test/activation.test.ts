import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../src/index.ts";

type PiAPI = Parameters<typeof extension>[0];

function setup(t: any, config?: object, envOverrides?: Record<string, string>) {
  const envKeys = ["JEV_LOOP_CONTROL_CONFIG", "JEV_LOOP_CONTROL_MODE", "JEV_LOOP_CONTROL_TRACE", "AI_GATEWAY_API_KEY", "PI_CODING_AGENT_DIR"];
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }

  const tempDir = mkdtempSync(join(tmpdir(), "jev-test-"));
  const piHome = join(tempDir, "pi-home");
  process.env.PI_CODING_AGENT_DIR = piHome;

  if (config) {
    const configPath = join(tempDir, "jev-loop-control.config.json");
    const cfg = { ...config, trace: { dir: join(tempDir, "runs") } };
    writeFileSync(configPath, JSON.stringify(cfg));
    // Do NOT set JEV_LOOP_CONTROL_CONFIG here to allow autodiscovery in cwd
  }

  if (envOverrides) {
    for (const [k, v] of Object.entries(envOverrides)) {
      process.env[k] = v;
    }
  }

  const events: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, (...args: any[]) => any> = {};
  const notifications: string[] = [];

  const ctx = {
    cwd: tempDir,
    hasUI: true,
    ui: {
      notify: (text: string, type?: string) => {
        notifications.push(text);
      },
    },
  };

  const fakeAPI: PiAPI = {
    on: (eventName: string, callback: (...args: any[]) => any) => {
      events[eventName] = callback;
      return () => {};
    },
    registerCommand: (name: string, opts: { description: string; handler: (...args: any[]) => any }) => {
      commands[name] = opts.handler;
    },
  } as unknown as PiAPI;

  extension(fakeAPI);

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  assert.ok(events["session_start"], "session_start event handler must be registered");
  events["session_start"]({ type: "session_start" }, ctx);

  const status = async () => {
    assert.ok(commands["jev-status"], "jev-status command must be registered");
    await commands["jev-status"]("", ctx);
    const last = notifications.at(-1);
    assert.ok(last, "A notification must be captured");
    return JSON.parse(last);
  };

  return { status, events, ctx };
}

test("(a) NO CONFIG FILE + fakekey -> active true, mode enforce, configPath='(built-in defaults)', three caps null", async (t) => {
  const { status } = setup(t, undefined, { AI_GATEWAY_API_KEY: "synthetic-key" });
  const s = await status();
  assert.equal(s.active, true);
  assert.equal(s.mode, "enforce");
  assert.equal(s.configPath, "(built-in defaults)");
  assert.equal(s.limits.maxRequests, null);
  assert.equal(s.limits.allowanceUsd, null);
  assert.equal(s.limits.maxAssessments, null);
});

test("(b) optional cwd config observe with key -> active mode observe actual path", async (t) => {
  const { status } = setup(t, { mode: "observe", jev: { enabled: true } }, { AI_GATEWAY_API_KEY: "synthetic-key" });
  const s = await status();
  assert.equal(s.active, true);
  assert.equal(s.mode, "observe");
  assert.ok(s.configPath.endsWith("jev-loop-control.config.json"));
});

test("(c) no file/no key -> inactive reason includes AI_GATEWAY_API_KEY and not set, message_end no throw", async (t) => {
  const { status, events, ctx } = setup(t, undefined, {});
  const s = await status();
  assert.equal(s.active, false);
  assert.match(s.reason, /AI_GATEWAY_API_KEY/);
  assert.match(s.reason, /not set/);

  assert.ok(events["message_end"], "message_end event handler must be registered");
  await events["message_end"]({ message: { role: "assistant", content: [] } }, ctx);
});

test("(d) explicit relative missing.json -> inactive error does not exist, configPath join(ctx.cwd, missing.json)", async (t) => {
  const { status, ctx } = setup(t, undefined, { JEV_LOOP_CONTROL_CONFIG: "missing.json" });
  const s = await status();
  assert.equal(s.active, false);
  assert.match(s.reason, /does not exist/);
  assert.equal(s.configPath, join(ctx.cwd, "missing.json"));
});

test("(e) optional cwd config off + no key -> inactive reason mode off, not missing key", async (t) => {
  const { status } = setup(t, { mode: "off", jev: { enabled: true } }, {});
  const s = await status();
  assert.equal(s.active, false);
  assert.match(s.reason, /mode is off/);
  assert.ok(!s.reason.includes("missing"));
});
