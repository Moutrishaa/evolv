import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ledger, BudgetError, estimateTokens } from '../../supervisor/models/ledger.js';
import { makeTempDir } from '../../test-fixtures/helpers/helpers.js';

let tmp, file;
beforeEach(() => {
  tmp = makeTempDir('evolv-ledger-');
  file = path.join(tmp.dir, 'state', 'usage.json');
});
afterEach(() => tmp.cleanup());

const make = (o = {}) => new Ledger({ file, totalBudget: 1000, changeLimit: 400, ...o });
const use = (l, id, input, output = 0) => l.record(id, { inputTokens: input, outputTokens: output });

test('a new ledger starts at zero', () => {
  const l = make();
  assert.equal(l.used(), 0);
  assert.equal(l.remaining(), 1000);
  assert.deepEqual(l.snapshot(), { used: 0, total: 1000, remaining: 1000, problem: null });
});

test('record adds input and output tokens, in total and per change', () => {
  const l = make();
  use(l, 'a', 100, 50);
  use(l, 'a', 10, 5);
  use(l, 'b', 7, 3);
  assert.equal(l.used(), 175);
  assert.equal(l.changeUsed('a'), 165);
  assert.equal(l.changeUsed('b'), 10);
  assert.equal(l.changeUsed('never'), 0);
  assert.equal(l.remaining(), 825);
});

test('totals survive a restart', () => {
  use(make(), 'a', 300, 100);
  const again = make();
  assert.equal(again.used(), 400);
  assert.equal(again.changeUsed('a'), 400);
});

test('writes are atomic: valid JSON after many records, no temp file left, a backup is kept', () => {
  const l = make({ totalBudget: 10_000_000 });
  for (let i = 0; i < 50; i++) use(l, `c${i % 5}`, 10, 5);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['usage.json', 'usage.json.bak']);
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).version, 1);
});

test('assertCanStartChange refuses once the budget is spent (exactly at the limit too)', () => {
  const l = make();
  assert.doesNotThrow(() => l.assertCanStartChange());
  use(l, 'a', 999);
  assert.doesNotThrow(() => l.assertCanStartChange());
  use(l, 'a', 1);
  assert.throws(() => l.assertCanStartChange(), (e) => e instanceof BudgetError && e.code === 'budget_exhausted' && /1000/.test(e.message));
});

test('checkBeforeCall: total budget -> budget_exhausted, per-change cap -> agent_limit', () => {
  const l = make();
  assert.doesNotThrow(() => l.checkBeforeCall('a'));
  use(l, 'a', 400);
  assert.throws(() => l.checkBeforeCall('a'), (e) => e.code === 'agent_limit' && /400/.test(e.message));
  assert.doesNotThrow(() => l.checkBeforeCall('b'), 'another change has its own cap');
  use(l, 'b', 600);
  assert.throws(() => l.checkBeforeCall('c'), (e) => e.code === 'budget_exhausted');
});

test('record rejects nonsense numbers and rounds fractions up', () => {
  const l = make();
  for (const bad of [NaN, -1, Infinity, '5', null]) {
    assert.throws(() => l.record('a', { inputTokens: bad, outputTokens: 0 }), TypeError);
  }
  l.record('a', { inputTokens: 2.2, outputTokens: 0.1 });
  assert.equal(l.changeUsed('a'), 4);
});

test('estimateTokens rounds UP: one token per 4 characters, any remainder counts', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'), 1);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('x'.repeat(9)), 3);
  assert.equal(estimateTokens('x'.repeat(10)), 3);
  assert.equal(estimateTokens('x'.repeat(401)), 101);
});

// ---- a damaged ledger must fail closed, in plain words, naming the file ----
function assertPlainProblem(message) {
  assert.ok(message.includes(file), 'must say where the file is');
  assert.match(message, /damaged|cannot be read|unreadable/i);
  assert.match(message, /no new changes|cannot start|blocked/i);
  assert.match(message, /\.bak/, 'must say about the backup');
  assert.match(message, /delete/i, 'must say how to start fresh');
  assert.ok(!/SyntaxError|Unexpected token|JSON\.parse|ENOENT|at \w+\.\w+ \(/.test(message), 'no raw error text');
}

for (const [label, content] of [
  ['garbage', 'this is not json{{'],
  ['an empty file', ''],
  ['wrong shape', '{"version":1,"totalInput":"lots","totalOutput":-5,"changes":[]}'],
  ['negative numbers', '{"version":1,"totalInput":-1,"totalOutput":0,"changes":{}}'],
  ['an unknown version', '{"version":99,"totalInput":0,"totalOutput":0,"changes":{}}'],
]) {
  test(`a damaged usage file (${label}) blocks changes, explains itself, and is never overwritten`, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const l = make(); // must NOT throw: the supervisor still has to start
    assert.ok(l.problem);
    assertPlainProblem(l.problem);
    assert.equal(l.snapshot().problem, l.problem);
    for (const call of [() => l.assertCanStartChange(), () => l.checkBeforeCall('a'), () => use(l, 'a', 1)]) {
      assert.throws(call, (e) => e instanceof BudgetError && e.code === 'ledger_unreadable' && e.message === l.problem);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), content, 'a damaged file must be left exactly as it is');
  });
}

test('once the damaged file is deleted, a fresh ledger works again', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage');
  assert.ok(make().problem);
  fs.rmSync(file);
  const l = make();
  assert.equal(l.problem, null);
  assert.doesNotThrow(() => l.assertCanStartChange());
});
