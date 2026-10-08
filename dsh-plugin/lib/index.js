// osint-hub as a DeepSeek Harness tool.
//
// The agent already exists as a CLI that decides what is worth running, runs it, reads the results into a target
// profile and keeps a dossier. This puts it in the chat as one callable tool, so a session can open a case, assign the
// work, run it and read the profile without a person typing commands.
//
// This file deliberately imports nothing from the harness. An earlier version imported `defineTool` from
// `@deepseek-ai/dsh-tools`, which cannot be resolved from a profile: the harness's packages live inside the harness
// installation rather than beside the plugin, and the import fails at boot - silently, as far as the tool list is
// concerned, because the tool simply never appears. The definition is built here instead, and the selftest checks its
// schema against the harness's own conversion so the two cannot drift without a test failing.
//
// The mapping from a call to a command lives in ./plan.js, free of harness imports so the project's tests cover it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIONS,
  NEEDS_CONFIRM,
  OUTPUT_SCHEMA,
  PARAMETERS,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  buildInvocation,
  errorSummary,
  parseJsonOutput,
  resolveRoot,
  summarise,
  toJsonSchema,
} from './plan.js';

export const name = 'dsh-osint-hub';
export const inject = ['tools'];

/** Spawn the CLI without a shell, so arguments are data and nothing can be re-interpreted. */
function runCli(root, argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(root, 'cli', 'osint-hub.mjs'), ...argv],
      { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

async function execute(args) {
  const action = String(args?.action ?? '');
  let root;
  try {
    root = resolveRoot();
  } catch (e) {
    return { ok: false, action, summary: e.message };
  }
  const data = existsSync(join(root, 'dist', 'api', 'tools.json')) ? join(root, 'dist', 'api', 'tools.json') : undefined;

  let invocation;
  try {
    invocation = buildInvocation(args, { root, data });
  } catch (e) {
    // A refused call is a result too: the rule the tool enforces is the useful part of the message.
    return { ok: false, action, summary: e.message };
  }

  // run and hands can take minutes of real work; the process timeout covers the budget plus the tool's own shutdown,
  // so a hung service cannot hold the turn open indefinitely.
  const budget = NEEDS_CONFIRM.includes(action) ? (Number(args.seconds ?? 240) + 90) * 1000 : 180_000;
  const { error, stdout, stderr } = await runCli(root, invocation.argv, budget);
  const parsed = parseJsonOutput(stdout);

  if (error && !parsed) {
    return {
      ok: false,
      action,
      summary: `${invocation.command} failed: ${errorSummary(stderr, stdout)}`,
      ...(invocation.out && { out: invocation.out }),
    };
  }

  return {
    ok: true,
    action,
    summary: summarise(action, parsed, invocation.out),
    ...(parsed?.case && { case: String(parsed.case) }),
    ...(invocation.out && { out: invocation.out }),
    ...(parsed && { data: JSON.stringify(parsed).slice(0, 6000) }),
  };
}

/** The plain tool definition the registry takes: a name, a description, a JSON Schema, and what to run. */
export const tool = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: toJsonSchema(PARAMETERS),
  output: {
    schema: toJsonSchema(OUTPUT_SCHEMA),
    render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `OSINT agent: ${args?.action ?? 'action'}`,
    kind: 'other',
    rawInput: args?.text ?? args?.title ?? args?.values ?? args?.case ?? args?.action,
  }),
  execute,
  isConcurrencySafe: (args) => !NEEDS_CONFIRM.includes(String(args?.action ?? '')),
};

export function apply(ctx) {
  ctx.tools.register(tool);
}

export { ACTIONS };
