import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FacebookCooldown, FACEBOOK_COOLDOWN_MS, rateLimitError } from '../src/facebook-cooldown.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

async function setup(t, { cooldownMs = SIX_HOURS } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-cooldown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 100000;
  const messages = [];
  const options = { now: () => now, log: message => messages.push(message), cooldownMs };
  const gate = new FacebookCooldown(dir, options);
  return { gate, messages, advance: ms => { now += ms; }, restart: () => new FacebookCooldown(dir, options) };
}

test('default mode has zero cooldown and always allows requests to run and retry continuously', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fb-cooldown-default-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const messages = [];
  const gate = new FacebookCooldown(dir, { log: message => messages.push(message) });
  assert.equal(gate.canRun(111, false), true);
  assert.equal(gate.canRun(111, true), true);
  gate.pause(111);
  assert.equal(gate.canRun(111, false), true);
  let attempts = 0;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(gate.run(111, false, async () => { attempts++; throw rateLimitError(); }), { code: 'RATE_LIMITED' });
    assert.equal(gate.canRun(111, false), true);
  }
  assert.equal(attempts, 3);
  const result = await gate.run(111, false, async () => 'ok');
  assert.equal(result, 'ok');
});

test('account restriction persists across restart and permits exactly one probe after six hours when configured', async t => {
  const { gate, advance, restart, messages } = await setup(t);
  await assert.rejects(gate.run(111, true, async () => { throw rateLimitError(); }), { code: 'RATE_LIMITED' });
  assert.equal(gate.canRun(222, true), true);
  assert.equal(restart().canRun(111, true), false);
  advance(SIX_HOURS - 1);
  await assert.rejects(gate.run(111, true, () => assert.fail('too early')), { code: 'FACEBOOK_COOLDOWN' });
  advance(1);
  let release;
  const probe = gate.run(111, true, () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(gate.run(111, true, () => assert.fail('parallel probe')), { code: 'FACEBOOK_COOLDOWN' });
  await assert.rejects(gate.run(111, false, () => assert.fail('background request')), { code: 'FACEBOOK_COOLDOWN' });
  assert.equal(restart().canRun(111, true), false);
  release(['post']);
  await probe;
  assert.equal(gate.canRun(111, false), true);
  assert.equal(restart().canRun(111, false), true);
  assert.ok(messages.some(message => message.includes('KHÔI PHỤC')));
});

test('failed probe waits another six hours, including inconclusive network failures', async t => {
  const { gate, advance } = await setup(t);
  gate.pause(111);
  for (const error of [rateLimitError(), new Error('network failure')]) {
    advance(SIX_HOURS);
    await assert.rejects(gate.run(111, true, async () => { throw error; }));
    advance(SIX_HOURS - 1);
    assert.equal(gate.canRun(111, true), false);
    advance(1);
    assert.equal(gate.canRun(111, true), true);
  }
});

test('older in-flight success cannot clear a restriction and receives a stop signal', async t => {
  const { gate } = await setup(t);
  let release, canContinue;
  const old = gate.run(111, true, allowed => {
    canContinue = allowed;
    return new Promise(resolve => { release = resolve; });
  });
  gate.pause(111);
  assert.equal(canContinue(), false);
  release(['post']);
  await old;
  assert.equal(gate.canRun(111, true), false);
});
