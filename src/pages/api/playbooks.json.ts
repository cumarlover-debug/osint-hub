// Public, static JSON of the playbooks, used by the CLI.
import { playbooks } from '../../lib/playbooks';

export function GET() {
  return new Response(JSON.stringify({ version: 1, generated: new Date().toISOString(), playbooks }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
