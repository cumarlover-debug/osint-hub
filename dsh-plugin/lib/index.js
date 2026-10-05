// osint-hub as a DeepSeek Harness tool.
//
// The agent already exists as a CLI that decides what is worth running, runs it, reads the results into a target
// profile and keeps a dossier. This puts it in the chat as one callable tool, so a session can open a case, assign
// the work, run it and read the profile without a person typing commands.
//
// The mapping from a call to a command lives in ./plan.js, deliberately free of harness imports so it is covered by
// the project's own tests. This file only registers the tool and spawns the process.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ACTIONS, NEEDS_CONFIRM, buildInvocation, errorSummary, parseJsonOutput, resolveRoot, summarise } from './plan.js';

export const name = 'dsh-osint-hub';
export const inject = ['tools'];

const DESCRIPTION =
  'Run the local osint-hub OSINT agent against identifiers the user holds. ' +
  'case_new opens an investigation (needs values and a basis: who asked and on what authority). ' +
  'task_add turns the user\'s own words into a family of tools and shows how it read them. ' +
  'plan reports what is possible before anything runs: runnable commands, fetchable search links, form-only services, ' +
  'what is not installed, and which identifiers are worth pivoting on. ' +
  'run executes the unattended tools and fetches search links. hands opens a browser to fill and submit the services ' +
  'that answer only a form. profile reads every result into a target profile with provenance and writes the dossier. ' +
  'Both run and hands reach the network from the user\'s own connection and require confirm: true. ' +
  'Everything returned is a candidate with provenance, never a conclusion, and a non-result is still recorded as a result.';

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

function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'osint_agent',
      description: DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ACTIONS,
          description: 'case_new | task_add | task_list | plan | profile | run | hands',
        },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'case_new: the identifiers the user holds — emails, usernames, domains, phones, names.',
        },
        basis: {
          type: 'string',
          description: 'case_new: who asked, and the authority or consent for looking. Recorded and printed in the report.',
        },
        title: { type: 'string', description: 'case_new: a short title for the investigation.' },
        case: { type: 'string', description: 'Path to the case JSON. case_new returns it; every other action needs it.' },
        text: {
          type: 'string',
          description: 'task_add: the task in the user\'s own words, e.g. "find every account this username has".',
        },
        task: { type: 'string', description: 'A task id from task_add, to narrow plan/run/hands to that piece of work.' },
        out: { type: 'string', description: 'Directory for profile.json, dossier.md and report.html. Defaults beside the case.' },
        max: { type: 'integer', description: 'run/hands: how many tools to attempt. Defaults to 8 and 4.' },
        seconds: { type: 'integer', description: 'run/hands: the time budget in seconds. Defaults to 240.' },
        confirm: {
          type: 'boolean',
          description: 'run/hands: must be true. Confirms the user agreed to real requests going out from their connection.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            case: { type: 'string' },
            out: { type: 'string' },
            data: { type: 'string', description: 'The command\'s JSON result, for detail the summary leaves out.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `OSINT agent: ${args.action ?? 'action'}`,
        kind: 'other',
        rawInput: args.text ?? args.title ?? args.values ?? args.case ?? args.action,
      }),
      async execute(args) {
        let root;
        try {
          root = resolveRoot();
        } catch (e) {
          return { ok: false, action: String(args.action ?? ''), summary: e.message };
        }
        const data = existsSync(join(root, 'dist', 'api', 'tools.json')) ? join(root, 'dist', 'api', 'tools.json') : undefined;

        let invocation;
        try {
          invocation = buildInvocation(args, { root, data });
        } catch (e) {
          // A refused call is a result too: the rules the tool enforces are the useful part of the message.
          return { ok: false, action: String(args.action ?? ''), summary: e.message };
        }

        // run and hands can take minutes of real work; the process timeout covers the budget plus the tool's own
        // shutdown, so a hung service cannot hold the turn open indefinitely.
        const budget = NEEDS_CONFIRM.includes(args.action) ? (Number(args.seconds ?? 240) + 90) * 1000 : 180_000;
        const { error, stdout, stderr } = await runCli(root, invocation.argv, budget);
        const parsed = parseJsonOutput(stdout);

        if (error && !parsed) {
          return {
            ok: false,
            action: String(args.action),
            summary: `${invocation.command} failed: ${errorSummary(stderr, stdout)}`,
            ...(invocation.out && { out: invocation.out }),
          };
        }

        const summary = summarise(String(args.action), parsed, invocation.out);
        return {
          ok: true,
          action: String(args.action),
          summary,
          ...(parsed?.case && { case: String(parsed.case) }),
          ...(parsed?.profile && !parsed?.case && { case: String(args.case ?? '') }),
          ...(invocation.out && { out: invocation.out }),
          ...(parsed && { data: JSON.stringify(parsed).slice(0, 6000) }),
        };
      },
    }),
  );
}

export { apply };
