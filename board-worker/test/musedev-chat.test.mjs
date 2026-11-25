// Offline Store contract tests with in-memory SQLite. No Worker or real keys.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(new URL('../src/', import.meta.url).href)
      && specifier.startsWith('./') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { Store, DEFAULT_LIMITS } = await import('../src/store.ts');
const { chooseByOrder, parseOrder } = await import('../src/route.ts');
const { parseKeys } = await import('../src/keys.ts');

const owner = 'page:owner';
const muse = 'muse-dev';
const token1 = '12222222-2222-4222-8222-222222222222';
const token2 = '22222222-2222-4222-8222-222222222222';
function fixture(statusOnly = []) {
  const db = new DatabaseSync(':memory:');
  let n = 0;
  let depth = 0;
  const store = new Store({
    sql: { exec(sql, ...args) {
      const stmt = db.prepare(sql);
      const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return Object.assign(rows, { toArray: () => rows, one: () => rows[0] });
    } },
    transactionSync(fn) {
      const id = 'test' + ++depth;
      db.exec('SAVEPOINT ' + id);
      try { const result = fn(); db.exec('RELEASE ' + id); return result; }
      catch (e) { db.exec('ROLLBACK TO ' + id); db.exec('RELEASE ' + id); throw e; }
      finally { --depth; }
    },
  }, DEFAULT_LIMITS, null, statusOnly);
  store.init();
  return { store, write: (obj, actor = owner) => store.ownerWrite(actor, obj, (_day, prefix) => (prefix || 'test/') + ++n),
    count: table => db.prepare('SELECT count(*) AS n FROM ' + table).get().n };
}
const payload = (submission_id = token1, extra = {}) => ({
  op: 'chat_start_muse', project: 'chat', title: '合成の短い調査', submission_id, ...extra,
});
const ids = (x) => ({ item_id: x.item.item_id, request_id: x.handoff.request_id });
const reroute = (x, to = 'vps-devin') => ({ op: 'chat_reroute_muse', ...ids(x), to });

test('one owner submission creates one linked item/request, replay never starts work', () => {
  const { store, write, count } = fixture();
  const created = write(payload());
  assert.equal(created.handoff.to, muse);
  assert.equal(created.handoff.requested_by, owner);
  assert.equal(created.handoff.state, 'requested');
  assert.deepEqual(ids(write(payload())), ids(created));
  assert.equal(write(payload()).changed, false);
  assert.equal(count('board_items'), 1);
  assert.equal(count('chat_messages'), 0);
  assert.throws(() => write(payload(token1, { title: '別の依頼' })), { code: 'HANDOFF_CONFLICT' });
  assert.throws(() => write(payload(token2), 'vps-devin'), { code: 'FORBIDDEN' });
  assert.equal(store.myWork('vps-devin', {}, true).items.length, 0);
  assert.equal(store.myWork(muse, {}, true).items[0].handoff.request_id, created.handoff.request_id);
});

test('actual winning actor and answer survive re-reading the same conversation', () => {
  const { store, write } = fixture();
  const created = write(payload());
  const id = ids(created);
  assert.throws(() => store.acceptHandoff('vps-devin', id, true), { code: 'NOT_FOUND' });
  const accepted = store.acceptHandoff(muse, id, true);
  assert.equal(accepted.changed, true);
  assert.equal(store.chatView(id.item_id).handoff.accepted_by, muse);
  assert.equal(store.acceptHandoff(muse, id, true).changed, false);
  assert.throws(() => write(reroute(created)), { code: 'HANDOFF_CONFLICT' });
  store.completeHandoff(muse, { ...id, generation: accepted.handoff.generation, outcome: 'done', text: '合成の回答です' }, true);
  for (let n = 0; n < 2; ++n) {
    const view = store.chatView(id.item_id);
    assert.equal(view.handoff.state, 'completed');
    assert.equal(view.handoff.accepted_by, muse);
    assert.ok(view.notes.some(n => n.actor === muse && n.text === '合成の回答です'));
  }
});

test('explicit pending-only reroute keeps the REQ and invalidates old recipient', () => {
  const { store, write } = fixture();
  const created = write(payload());
  const id = ids(created);
  store.reportRequesterDeclined(muse, { ...id, to_set_by: owner });
  assert.equal(typeof store.chatView(id.item_id).handoff.requester_declined_at, 'number');
  assert.throws(() => write({ ...reroute(created), to: 'hold' }), { code: 'INVALID' });
  assert.throws(() => write({ ...reroute(created), request_id: 'REQ-stale' }), { code: 'HANDOFF_CONFLICT' });
  assert.throws(() => store.routeForTool('vps-devin', { item_id: id.item_id, to: null }), { code: 'FORBIDDEN' });
  const moved = write(reroute(created));
  assert.deepEqual(ids(moved), id);
  assert.equal(moved.handoff.to, 'vps-devin');
  assert.equal(moved.handoff.requester_declined_at, undefined);
  assert.throws(() => store.acceptHandoff(muse, id, true), { code: 'NOT_FOUND' });
  assert.equal(store.acceptHandoff('vps-devin', id).changed, true);
});

test('paused, local and status-only work do not trigger legacy or other takers', () => {
  const { store, write } = fixture([{ project: 'quiet', actor: 'muse' }]);
  assert.throws(() => write(payload(token2, { project: 'Quiet', new_repository: true })), { code: 'FORBIDDEN' });
  const created = write(payload());
  const id = ids(created);
  assert.throws(() => write({ op: 'chat_send', item_id: id.item_id, text: '不許可', to: 'vps-devin' }), { code: 'HANDOFF_CONFLICT' });
  write({ op: 'pause', paused: true });
  assert.equal(store.chatView(id.item_id).paused, true);
  assert.throws(() => store.acceptHandoff(muse, id, true), { code: 'PAUSED' });
  write({ op: 'pause', paused: false });
  write({ op: 'scope', project: 'chat', scope: 'local' });
  const view = store.chatView(id.item_id);
  assert.equal(view.project_local, true);
  assert.equal(view.handoff.to, muse);
  assert.throws(() => store.acceptHandoff(muse, id, true), { code: 'FORBIDDEN' });
  assert.throws(() => write(payload(token2, { project: 'CHAT', new_repository: true })), { code: 'FORBIDDEN' });
  assert.deepEqual(parseOrder([muse]), [muse]);
  assert.equal(chooseByOrder([muse], () => true).to, muse);
});

test('legacy Claude and Devin chat turns still work; MuseDev does not inherit transcript tools', () => {
  const { store, write } = fixture();
  const added = write({ op: 'add', project: 'chat', title: 'legacy' });
  for (const who of ['vps-claude', 'vps-devin']) {
    const item_id = added.item.item_id;
    const view = write({ op: 'chat_send', item_id, text: '合成', to: who });
    assert.deepEqual(store.chatPending(muse).turns, []);
    assert.equal(store.chatTake(who, { item_id, seq: view.open.seq }).ok, true);
    assert.equal(store.chatReply(who, { item_id, seq: view.open.seq, text: 'legacy answer' }).ok, true);
  }
  const entries = parseKeys(JSON.stringify({ schema_version: 1, writers: [{
    actor: muse, enabled: true, token_sha256: '0'.repeat(64), policy: 'trusted',
  }] }));
  assert.equal(entries[0].policy, 'restricted');
});
