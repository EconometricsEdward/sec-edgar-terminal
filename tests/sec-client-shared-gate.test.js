import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecDispatchCoordinator } from '../src/utils/secClient.js';

const granted = owner => ({ allowed: true, owner, acquiredAt: '2099-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:05Z', leaseMs: 5000, waitMs: 0, cooldown: false });
const denied = (waitMs, cooldown = false) => ({ allowed: false, owner: null, acquiredAt: null, expiresAt: null, leaseMs: 5000, waitMs, cooldown });
function databaseGate() {
  let owner = null, expiresAt = 0, nextStart = 0, cooldownUntil = 0;
  const events = [];
  return {
    events,
    acquire: async identity => {
      const now = performance.now();
      if (now < cooldownUntil) return denied(Math.ceil(cooldownUntil - now), true);
      if (owner && now >= expiresAt) owner = null;
      if (owner || now < nextStart) return denied(Math.ceil(Math.max(expiresAt * Number(Boolean(owner)), nextStart) - now));
      owner = identity; expiresAt = now + 5000; events.push({ event: 'acquire', owner }); return granted(owner);
    },
    release: async (identity, { cooldownMs }) => {
      const now = performance.now();
      if (identity !== owner || now >= expiresAt) return false;
      events.push({ event: 'release', owner, cooldownMs }); owner = null; nextStart = now + 143;
      if (cooldownMs) cooldownUntil = Math.max(cooldownUntil, now + cooldownMs);
      return true;
    },
    publish: async ms => { cooldownUntil = Math.max(cooldownUntil, performance.now() + ms); return true; },
  };
}

test('deployed coordinator obtains Supabase permission before SEC dispatch and releases the same owner', async () => {
  const gate = databaseGate();
  const coordinator = createSecDispatchCoordinator({ ...gate, transport: async () => { gate.events.push({ event: 'dispatch' }); return Response.json({ ok: true }); } });
  assert.deepEqual(await (await coordinator.fetch('https://data.sec.gov/example.json', {})).json(), { ok: true });
  assert.deepEqual(gate.events.map(row => row.event), ['acquire', 'dispatch', 'release']);
  assert.equal(gate.events[0].owner, gate.events[2].owner);
  assert.equal(gate.events[2].cooldownMs, 0);
});

test('shared database permission plus actual dispatch hold spaces simultaneous requests conservatively', async () => {
  const gate = databaseGate(), starts = [];
  const originalAcquire = gate.acquire;
  // A real held lease reports at most a short poll wait, not its full lifetime.
  gate.acquire = async owner => { const value = await originalAcquire(owner); return !value.allowed && !value.cooldown ? { ...value, waitMs: Math.min(value.waitMs, 50) } : value; };
  const coordinator = createSecDispatchCoordinator({ ...gate, transport: async () => { starts.push(performance.now()); return Response.json({ ok: true }); } });
  await Promise.all([coordinator.fetch('https://data.sec.gov/one.json', {}), coordinator.fetch('https://data.sec.gov/two.json', {})]);
  assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 275, `dispatch gap was ${starts[1] - starts[0]} ms`);
});

test('an early SEC throttle is published atomically with owner release and blocks the next dispatch', async () => {
  const gate = databaseGate(); let calls = 0;
  const coordinator = createSecDispatchCoordinator({ ...gate, transport: async () => { calls++; return new Response('slow down', { status: 429, headers: { 'Retry-After': '5' } }); } });
  assert.equal((await coordinator.fetch('https://data.sec.gov/one.json', {})).status, 429);
  await assert.rejects(coordinator.fetch('https://data.sec.gov/two.json', {}), error => error.code === 'SEC_UPSTREAM_COOLDOWN');
  assert.equal(calls, 1); assert.equal(gate.events.at(-1).cooldownMs, 5000);
});

test('database failures and invalid grants fail closed without contacting any source transport', async () => {
  for (const acquire of [
    async () => { throw new Error('backend unavailable'); },
    async owner => ({ ...granted(owner), owner: 'different-owner' }),
    async owner => ({ ...granted(owner), leaseMs: 60000 }),
    async owner => ({ ...granted(owner), acquiredAt: 'invalid' }),
    async () => denied(-1),
  ]) {
    const coordinator = createSecDispatchCoordinator({ acquire, release: async () => false, transport: () => assert.fail('No SEC or alternate backend dispatch.') });
    await assert.rejects(coordinator.fetch('https://data.sec.gov/example.json', {}), error => error.code === 'SEC_RATE_GATE_UNAVAILABLE' && error.status === 503);
  }
});

test('a lost acquisition reply releases only its own committed lease before another request', async () => {
  const gate = databaseGate(), acquire = gate.acquire; let loseReply = true, starts = 0;
  const coordinator = createSecDispatchCoordinator({ ...gate, acquire: async owner => {
    const reply = await acquire(owner);
    if (reply.allowed && loseReply) { loseReply = false; throw new DOMException('Reply deadline', 'TimeoutError'); }
    return reply;
  }, transport: async () => { starts++; return Response.json({ ok: true }); } });
  await assert.rejects(coordinator.fetch('https://data.sec.gov/first.json', {}), { code: 'SEC_RATE_GATE_UNAVAILABLE' });
  assert.equal(starts, 0);
  assert.deepEqual(gate.events.map(event => event.event), ['acquire', 'release']);
  assert.equal(gate.events[0].owner, gate.events[1].owner);
  assert.equal(gate.events[1].cooldownMs, 0);
  assert.equal((await coordinator.fetch('https://data.sec.gov/next.json', {})).status, 200);
  assert.equal(starts, 1);
});

test('cancelled acquisition cleans up its uncertain owner without using the cancelled signal', async () => {
  const controller = new AbortController(), events = [];
  const coordinator = createSecDispatchCoordinator({ acquire: async owner => {
    events.push(['acquire', owner]); controller.abort(); throw controller.signal.reason;
  }, release: async (owner, options) => { events.push(['release', owner]); assert.equal(options.signal, undefined); return true; },
  transport: () => assert.fail('A cancelled acquisition cannot dispatch.') });
  await assert.rejects(coordinator.fetch('https://data.sec.gov/first.json', {}, controller.signal), { name: 'AbortError' });
  assert.equal(events.length, 2); assert.equal(events[0][1], events[1][1]);
});

test('uncertain acquisition cleanup is bounded and cannot turn failure into source permission', async t => {
  const original = globalThis.setTimeout, timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    timers.push(delay); return original(callback, delay === 2000 ? 5 : delay, ...args);
  });
  const coordinator = createSecDispatchCoordinator({ acquire: async () => { throw new Error('Lost reply'); },
    release: () => new Promise(() => {}), transport: () => assert.fail('No fallback permission is allowed.') });
  await assert.rejects(coordinator.fetch('https://data.sec.gov/first.json', {}), { code: 'SEC_RATE_GATE_UNAVAILABLE' });
  assert.deepEqual(timers, [2000]);
});

test('unarmed and ten-minute migration cooldowns do not poll or bypass shared coordination', async () => {
  for (const waitMs of [300000, 600000]) {
    let attempts = 0;
    const coordinator = createSecDispatchCoordinator({ acquire: async () => { attempts++; return denied(waitMs, true); }, transport: () => assert.fail('Migration handoff cannot dispatch.') });
    await assert.rejects(coordinator.fetch('https://data.sec.gov/example.json', {}), error => error.code === 'SEC_UPSTREAM_COOLDOWN');
    assert.equal(attempts, 1);
  }
});

test('late grant replies are rejected using monotonic elapsed time without trusting server wall clocks', async () => {
  let time = 0, releases = 0;
  const coordinator = createSecDispatchCoordinator({ now: () => time,
    acquire: async owner => { time = 4501; return granted(owner); },
    release: async () => { releases++; return true; }, transport: () => assert.fail('Expired permission must not dispatch.') });
  await assert.rejects(coordinator.fetch('https://data.sec.gov/example.json', {}), /arrived too late/);
  assert.equal(releases, 1);
});

test('permission is checked again immediately before dispatch after event-loop delay', async () => {
  const times = [0, 0, 0, 5000, 5000]; let releases = 0;
  const coordinator = createSecDispatchCoordinator({ now: () => times.shift() ?? 5000,
    acquire: async owner => granted(owner), release: async () => { releases++; return true; },
    transport: () => assert.fail('Permission expired between acquisition and dispatch.') });
  await assert.rejects(coordinator.fetch('https://data.sec.gov/example.json', {}), /expired before use/);
  assert.equal(releases, 1);
});

test('caller cancellation after acquisition releases permission without dispatching', async () => {
  const controller = new AbortController(); let releases = 0;
  const coordinator = createSecDispatchCoordinator({ acquire: async owner => { controller.abort(); return granted(owner); },
    release: async () => { releases++; return true; }, transport: () => assert.fail('Aborted caller cannot dispatch.') });
  await assert.rejects(coordinator.fetch('https://data.sec.gov/example.json', {}, controller.signal), { name: 'AbortError' });
  assert.equal(releases, 1);
});

test('failed release preserves the database lease rather than creating a second fallback permission', async () => {
  const gate = databaseGate(); let calls = 0;
  const coordinator = createSecDispatchCoordinator({ ...gate, release: async () => { throw new Error('release unavailable'); },
    transport: async () => { calls++; return Response.json({ ok: true }); } });
  assert.equal((await coordinator.fetch('https://data.sec.gov/one.json', {})).status, 200);
  await assert.rejects(coordinator.fetch('https://data.sec.gov/two.json', {}), error => error.code === 'SEC_RATE_GATE_SATURATED');
  assert.equal(calls, 1);
});

test('provider cooldown publication is bounded independently of the migration handoff window', async () => {
  const published = [];
  const coordinator = createSecDispatchCoordinator({ publish: async ms => { published.push(ms); return true; } });
  assert.equal(await coordinator.publishCooldown(600000), true);
  assert.equal(await coordinator.publishCooldown(0), false);
  assert.deepEqual(published, [300000]);
});
