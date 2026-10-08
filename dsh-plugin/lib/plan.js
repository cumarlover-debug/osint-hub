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

/** The tool's identity, as the harness sees it. */
export const TOOL_NAME = 'osint_agent';

export const TOOL_DESCRIPTION =
  'Run the local osint-hub OSINT agent against identifiers the user holds. ' +
  'case_new opens an investigation (needs values and a basis: who asked and on what authority). ' +
  "task_add turns the user's own words into a family of tools and shows how it read them. " +
  'plan reports what is possible before anything runs: runnable commands, fetchable search links, form-only services, ' +
  'what is not installed, and which identifiers are worth pivoting on. ' +
  'run executes the unattended tools and fetches search links. hands opens a browser to fill and submit the services ' +
  'that answer only a form. profile reads every result into a target profile with provenance and writes the dossier. ' +
  "Both run and hands reach the network from the user's own connection and require confirm: true. " +
  'Everything returned is a candidate with provenance, never a conclusion, and a non-result is still recorded as a result. ' +
  'Pass remote "wsl:kali-linux" (or an ssh host) to run the command-line tools on the machine that has them.';

/** The tool's parameters in the harness's spec form: each property carries `required`, which is what its registry reads. */
export const PARAMETERS = {
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
  remote: {
    type: 'string',
    description: 'Run the command-line tools elsewhere: "wsl:<distro>" for a distro on this computer, or an ssh host.',
  },
};

/** What a call returns. The detail rides in `data` as JSON, so the shape stays small. */
export const OUTPUT_SCHEMA = {
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
};

/** One property, in the order the harness writes it, with inline `required` removed. */
function propertyOf(def) {
  const { required: _required, ...rest } = def ?? {};
  const prop = {};
  for (const key of ['type', 'description', 'enum', 'items']) if (rest[key] !== undefined) prop[key] = rest[key];
  for (const [k, v] of Object.entries(rest)) if (!(k in prop)) prop[k] = v;
  return prop;
}

function propertiesOf(spec) {
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(spec ?? {})) {
    properties[key] = propertyOf(def);
    if (def?.required === true) required.push(key);
  }
  return { properties, required };
}

/**
 * Turn a spec in the harness's author-facing form into the JSON Schema its registry validates against.
 *
 * Written out here rather than imported from the harness. A plugin that imports `@deepseek-ai/dsh-tools` cannot resolve
 * it from a profile - the harness's packages live inside the harness installation, not beside the plugin - and that
 * failure is quiet at boot: the tool simply never appears in any session. The selftest checks this conversion against
 * the harness's own, so the two cannot drift without a test failing.
 *
 * Two shapes arrive here: a parameter map, whose keys are argument names, and an output schema that already names its
 * own `type`.
 */
export function toJsonSchema(spec) {
  const source = spec ?? {};
  const isNamedSchema = 'type' in source || 'additionalProperties' in source;
  if (!isNamedSchema) {
    const { properties, required } = propertiesOf(source);
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  const { properties, ...rest } = source;
  if (!properties) return { ...rest };
  const built = propertiesOf(properties);
  return { ...rest, properties: built.properties, ...(built.required.length ? { required: built.required } : {}) };
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
  // Where the command-line tools run. Accepting the argument without passing it on is how a tool promises to use Kali
  // and quietly uses the local machine instead, so it belongs in the arguments every action gets.
  if (args.remote) common.push('--remote', String(args.remote));

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
    const where = d.remote ? ` — tools run on ${d.remote.label}, which has ${d.remote.found} of the ${d.remote.total} this case needs` : '';
    const lines = plan.map(
      (p) =>
        `  ${p.value} (${p.type}): ${p.canRun} runnable${typeof p.ready === 'number' ? ` (${p.ready} ready${d.remote ? ' there' : ' here'})` : ''}, ${p.canFetch} fetchable, ${p.byHand} by hand, ${p.done} already tried`,
    );
    const warning =
      d.remote && plan.length && plan.every((p) => (p.ready ?? 0) === 0)
        ? `\nNo tool this case needs is installed on ${d.remote.label}. Install them there (node scripts/kali-setup.sh --pipx, and --apt with sudo), or run locally.`
        : '';
    return `${d.case ?? 'case'}: ${counts.leads ?? 0} leads from ${counts.toolsRun ?? 0} tool runs${where}\n${lines.join('\n')}${warning}`;
  }
  if (action === 'profile' || NEEDS_CONFIRM.includes(action)) {
    const counts = d.counts ?? {};
    const run = d.run;
    const where = d.remote ? `on ${d.remote.label}` : 'locally';
    const head = run ? `${run.ok}/${run.attempted} finished cleanly ${where}, ${run.findings} findings folded in${run.stopped ? ` (stopped: ${run.stopped})` : ''}\n` : '';
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
