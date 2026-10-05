// The mapping from a tool call to an osint-hub command, kept free of any DeepSeek Harness imports so it can be
// tested where the harness is not installed. Everything the tool will actually do is decided here.
import { existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Every action the tool exposes, and what each one runs. */
export const ACTIONS = [
  'case_new',
  'task_add',
  'task_list',
  'plan',
  'profile',
  'run',
  'hands',
];

/** Actions that reach out to the network from the user's connection, and so require an explicit confirmation. */
export const NEEDS_CONFIRM = ['run', 'hands'];

/** Where the osint-hub checkout lives, unless the environment says otherwise. */
export const DEFAULT_ROOT = 'C:\\Users\\User\\OneDrive\\Documents\\M-in-CYS\\Side_projects\\osint-hub';

/**
 * Find the checkout. The tool cannot do anything without it, so this fails loudly with the fix rather than returning
 * an error the model will misread as "no results".
 */
export function resolveRoot(env = process.env, exists = existsSync) {
  const candidates = [env.OSINT_HUB, env.OSINT_HUB_ROOT, DEFAULT_ROOT].filter((c) => typeof c === 'string' && c);
  for (const candidate of candidates) {
    if (exists(join(candidate, 'cli', 'osint-hub.mjs'))) return candidate;
  }
  throw new Error(
    `osint-hub checkout not found. Set OSINT_HUB to the directory containing cli/osint-hub.mjs (tried: ${candidates.join(', ')})`,
  );
}

/** The CLI is invoked without a shell, so every argument is passed as data and none of it can be re-parsed. */
const push = (argv, flag, value) => {
  if (value === undefined || value === null || value === '') return;
  argv.push(flag, String(value));
};

/** A directory to keep a case's artefacts together, derived from the case file itself. */
export function outFor(casePath) {
  if (!casePath) return undefined;
  return join(dirname(casePath), `${basename(casePath).replace(/\.json$/i, '')}-out`);
}

/**
 * Turn one tool call into the command that answers it.
 *
 * @param {object} args - the model's arguments, already schema-checked.
 * @param {{ root: string, data?: string }} env - resolved checkout, and an optional local tools.json.
 * @returns {{ command: string, argv: string[], out?: string, note: string }} everything needed to spawn, plus a line
 *          describing what is being run that the caller can put in front of a person.
 */
export function buildInvocation(args, { root, data }) {
  const action = String(args?.action ?? '');
  if (!ACTIONS.includes(action)) {
    throw new Error(`unknown action "${action}"; one of: ${ACTIONS.join(', ')}`);
  }

  const out = typeof args.out === 'string' && args.out ? args.out : outFor(args.case);
  const common = ['--json'];
  if (data) common.push('--data', data);

  // The basis is the line between an investigation and a fishing trip, and the agent prints it in every report, so a
  // case cannot be opened without one.
  if (action === 'case_new') {
    if (!args.title) throw new Error('case_new needs a title');
    if (!Array.isArray(args.values) || !args.values.length) throw new Error('case_new needs values: the identifiers the user holds');
    if (!args.basis) throw new Error('case_new needs a basis: who asked, and what authority or consent they have');
    const argv = ['case', 'new', String(args.title), '--value', args.values.join(',')];
    push(argv, '--basis', args.basis);
    push(argv, '--out', args.out);
    return { command: 'case new', argv: [...argv, ...common], note: `Open a case on ${args.values.length} identifier(s)` };
  }

  if (!args.case) throw new Error(`${action} needs the case file path`);

  if (action === 'task_add') {
    if (!args.text) throw new Error('task_add needs text: the task in the user\'s own words');
    const argv = ['agent', 'task', 'add', String(args.text), String(args.case)];
    push(argv, '--out', out);
    return { command: 'agent task add', argv: [...argv, ...common], out, note: `Assign: ${args.text}` };
  }

  if (action === 'task_list') {
    const argv = ['agent', 'task', 'list', String(args.case)];
    push(argv, '--out', out);
    return { command: 'agent task list', argv: [...argv, ...common], out, note: 'List assigned tasks' };
  }

  if (action === 'plan') {
    const argv = ['agent', 'next', String(args.case)];
    push(argv, '--out', out);
    push(argv, '--task', args.task);
    return { command: 'agent next', argv: [...argv, ...common], out, note: 'See what is possible before running anything' };
  }

  if (action === 'profile') {
    const argv = ['agent', 'profile', String(args.case)];
    push(argv, '--out', out);
    return { command: 'agent profile', argv: [...argv, ...common], out, note: 'Read the results into a profile and dossier' };
  }

  // run and hands spend the user's connection and their time: the confirmation is required by the tool, not by the
  // model's judgement.
  if (NEEDS_CONFIRM.includes(action)) {
    if (args.confirm !== true) {
      throw new Error(`${action} reaches the network from the user's connection; call it again with confirm: true once the user has agreed`);
    }
    const argv = ['agent', action === 'run' ? 'run' : 'hands', String(args.case), '--yes'];
    push(argv, '--out', out);
    push(argv, '--task', args.task);
    push(argv, '--max', args.max ?? (action === 'run' ? 8 : 4));
    push(argv, '--seconds', args.seconds ?? 240);
    return {
      command: `agent ${action}`,
      argv: [...argv, ...common],
      out,
      note: action === 'run' ? 'Run the unattended tools within the budget' : 'Drive the form-only services in a browser',
    };
  }

  throw new Error(`action "${action}" is declared but not implemented`);
}

/**
 * The CLI prints one JSON object in --json mode. Other lines can appear around it, so the last complete object wins.
 */
export function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const at = text.lastIndexOf('\n{');
    if (at === -1) return undefined;
    try {
      return JSON.parse(text.slice(at + 1));
    } catch {
      return undefined;
    }
  }
}

/** A short, human-shaped line for the chat, built from whatever the CLI returned. */
export function summarise(action, data, out) {
  const d = data ?? {};
  if (action === 'case_new') {
    const values = Array.isArray(d.values) ? d.values : [];
    return `Case opened: ${d.title ?? '(untitled)'} — ${values.map((v) => `${v.value} (${v.type})`).join(', ')}\nCase file: ${d.case}${out ? `\nArtefacts will go to: ${out}` : ''}`;
  }
  if (action === 'task_add') {
    const t = d.task ?? {};
    const read = Array.isArray(t.intentsLabel) && t.intentsLabel.length ? t.intentsLabel.join(' + ') : null;
    if (!read) {
      return `Task ${t.id ?? '?'} was not understood: nothing in "${t.text ?? ''}" maps to a family of work, so it proposes no tools. Rewrite it with what to look for (accounts, breaches, infrastructure, identity, documents, places, crypto, transport, phones) or say "everything".`;
    }
    const c = t.counts ?? {};
    return `Task ${t.id} — read as ${read}, about ${(t.values ?? []).join(', ') || 'the case'}\n${c.tools ?? 0} tools in scope (${c.runnable ?? 0} runnable, ${c.fetchable ?? 0} fetchable, ${c.byHand ?? 0} by hand)${t.unplaced ? `\ncould not place: "${t.unplaced}"` : ''}`;
  }
  if (action === 'task_list') {
    const tasks = Array.isArray(d.tasks) ? d.tasks : [];
    if (!tasks.length) return 'No tasks assigned.';
    return tasks
      .map((t) => {
        const p = t.progress ?? {};
        return `${t.id} [${t.status === 'done' ? 'done' : p.done ? 'started' : 'open'}] ${t.text} — ${p.done ?? 0}/${p.total ?? 0} tried`;
      })
      .join('\n');
  }
  if (action === 'plan') {
    const counts = d.counts ?? {};
    const plan = Array.isArray(d.plan) ? d.plan : [];
    const lines = plan.map((p) => `  ${p.value} (${p.type}): ${p.canRun} runnable, ${p.canFetch} fetchable, ${p.byHand} by hand, ${p.done} already tried`);
    return `${d.case ?? 'case'}: ${counts.leads ?? 0} leads from ${counts.toolsRun ?? 0} tool runs\n${lines.join('\n')}`;
  }
  if (action === 'profile' || NEEDS_CONFIRM.includes(action)) {
    const counts = d.counts ?? {};
    const run = d.run;
    const head = run ? `${run.ok}/${run.attempted} finished cleanly, ${run.findings} findings folded in${run.stopped ? ` (stopped: ${run.stopped})` : ''}\n` : '';
    const kinds = counts.byKind ? Object.entries(counts.byKind).map(([k, n]) => `${n} ${k}`).join(', ') : 'none yet';
    return `${head}${counts.leads ?? 0} leads from ${counts.toolsRun ?? 0} tool runs${counts.byKind ? `: ${kinds}` : ''}\nProfile: ${d.profile ?? '-'}\nDossier: ${d.dossier ?? '-'}${d.report ? `\nReport: ${d.report}` : ''}`;
  }
  return 'Done.';
}

/** Pull the useful tail out of a failed command without dumping the whole thing. */
export function errorSummary(stderr, stdout) {
  const text = String(stderr || stdout || '').trim();
  if (!text) return 'the command failed without saying why';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const interesting = lines.find((l) => /^error\b/i.test(l)) ?? lines[lines.length - 1];
  return interesting.slice(0, 400);
}
