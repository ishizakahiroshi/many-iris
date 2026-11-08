import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ storage = new Map(), failStatus = false, wrongTask = false } = {}) {
  const elements = new Map(), buttons = [], calls = [];
  const node = () => ({ value: '', textContent: '', hidden: false, disabled: false, children: [], scrollCalls:0,
    scrollIntoView() { this.scrollCalls++; },
    append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const get = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  for (const id of ['connect', 'token', 'state', 'tasks', 'detail', 'title', 'source', 'run-state', 'start', 'approve', 'reject', 'execute', 'stop', 'refresh']) get(id);
  for (const id of ['start', 'approve', 'reject', 'execute', 'stop', 'refresh']) buttons.push(get(id));
  let resolveStart;
  const sandbox = { document: { getElementById: get, querySelectorAll: () => buttons,
    createElement: () => { const button = node(); buttons.push(button); return button; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID: () => 'synthetic-id' },
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      let data;
      if (request.op === 'list') data = { total: 2, tasks: [{ id: 'A', title: 'Synthetic A' }, { id: 'B', title: 'Synthetic B' }] };
      else if (request.op === 'detail') data = { id: request.task_id, title: request.task_id, source: 'Synthetic source', revision: 1, source_hash: '0'.repeat(64) };
      else if (request.op === 'start') data = await new Promise(resolve => { resolveStart = resolve; });
      else if (request.op === 'status') {
        if (failStatus) throw new Error('synthetic network failure');
        data = { run_id: request.run_id, task_id: wrongTask ? 'B' : 'A', state: 'waiting' };
      } else data = { run_id: request.run_id, task_id: 'A', state: 'stopped' };
      return { json: async () => ({ ok: true, data }) };
    } };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return { get, calls, context, storage, resolve: () => resolveStart({ run_id: 'run-A', task_id: 'A', state: 'waiting' }) };
}
async function connectAndSelect(harness) {
  harness.get('token').value = 'synthetic-fixture-token';
  harness.get('connect').onsubmit({ preventDefault() {} }); await tick();
  harness.get('tasks').children[0].onclick(); await tick();
}

const delayed = fixture();
await connectAndSelect(delayed);
delayed.get('start').onclick(); await tick();
assert.equal(delayed.get('stop').disabled, true);
delayed.get('tasks').children[1].onclick(); await tick();
assert.equal(vm.runInContext('selected.id', delayed.context), 'A');
assert.equal(delayed.calls.filter(call => call.op === 'detail' && call.task_id === 'B').length, 0);
delayed.resolve(); await tick();
assert.equal(vm.runInContext('run.task_id', delayed.context), 'A');
assert.equal(delayed.get('stop').disabled, false);
assert.equal(delayed.get('detail').scrollCalls, 1);
delayed.get('back').onclick();
assert.equal(vm.runInContext('run', delayed.context), null);
assert.equal(delayed.get('detail').hidden, true);
delayed.get('tasks').children[0].onclick(); await tick();
assert.equal(vm.runInContext('run.run_id', delayed.context), 'run-A');

const failed = fixture({ failStatus: true });
await connectAndSelect(failed);
failed.get('start').onclick(); await tick(); failed.resolve(); await tick();
assert.match(failed.storage.get('iris-experiment-runs'), /run-A/);
const recovered = fixture({ storage: failed.storage });
await connectAndSelect(recovered);
assert.equal(vm.runInContext('run.run_id', recovered.context), 'run-A');
assert.equal(recovered.calls.filter(call => call.op === 'start').length, 0);
assert.equal([...failed.storage.values()].some(value => value.includes('synthetic-fixture-token')), false);

const wrong = fixture({ wrongTask: true });
await connectAndSelect(wrong);
wrong.get('start').onclick(); await tick(); wrong.resolve(); await tick();
assert.equal(vm.runInContext('run', wrong.context), null);
wrong.get('stop').onclick(); await tick();
assert.equal(wrong.calls.filter(call => call.op === 'stop').length, 0);
console.log('3 UI regression scenarios passed: pending selection, recovery after status failure, mismatched run rejection');
