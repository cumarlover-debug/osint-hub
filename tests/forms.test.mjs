// The rule that decides whether an unreachable directory entry becomes one the agent can attempt. Getting it wrong
// in one direction leaves a tool unusable; getting it wrong in the other points a browser driver at a signup form
// with a target's address in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchFormIn } from '../scripts/lib/forms.mjs';

test('finds an input of type search', () => {
  assert.deepEqual(searchFormIn('<form><input type="search" name="anything"></form>'), { reason: 'an input of type search (anything)' });
});

test('finds a search box by the name it tends to use', () => {
  assert.deepEqual(searchFormIn('<form action="/s"><input name="q"><button>Go</button></form>'), { reason: 'an input named "q"' });
  assert.ok(searchFormIn('<form><input id="search-terms" type="text"></form>'));
  assert.ok(searchFormIn('<form><input name="email" placeholder="target@example.com"></form>'));
});

test('refuses a signup form even though its input looks like a search box', () => {
  // The exact trap: a page selling a service has <input type="email"> on it, and typing a target's address there
  // registers them for something.
  const signup = '<form action="/auth/signup"><input type="email" name="email"><input type="password" name="password"></form>';
  assert.equal(searchFormIn(signup), null);
  const subscribe = '<form action="/subscribe"><input name="email" placeholder="Your email"><p>Get started free</p></form>';
  assert.equal(searchFormIn(subscribe), null);
  const newsletter = '<form><input name="newsletter" type="text"></form>';
  assert.equal(searchFormIn(newsletter), null);
});

test('refuses a page whose search-shaped input sits in a signup context', () => {
  const html = '<div>Sign up to continue <input name="email"></div>';
  assert.equal(searchFormIn(html), null);
});

test('still finds a search box on a page that merely links to a login', () => {
  // A site-wide "Log in" link in the header must not disqualify the page: this is the case that was missed when the
  // auth check looked at the whole document instead of the form.
  const html = '<nav><a href="/login">Log in</a></nav><form><input name="Search"></form>';
  assert.deepEqual(searchFormIn(html), { reason: 'an input named "Search"' });
});

test('recognises a form marked as search whatever its fields are called', () => {
  assert.deepEqual(searchFormIn('<form role="search"><input name="whatever"></form>'), { reason: 'a form with role=search' });
});

test('reports a bot wall rather than treating it as a page with nothing on it', () => {
  assert.deepEqual(searchFormIn('<title>Just a moment...</title>'), { wall: true });
  assert.deepEqual(searchFormIn('Automated traffic is not allowed on this site'), { wall: true });
  assert.deepEqual(searchFormIn('<h1>This domain is for sale</h1>'), { wall: true });
});

test('returns nothing for a page with only a contact form or no form at all', () => {
  assert.equal(searchFormIn('<form action="/contact"><input name="your-message"><textarea></textarea></form>'), null);
  assert.equal(searchFormIn('<p>An article about nothing in particular.</p>'), null);
  assert.equal(searchFormIn(''), null);
});
