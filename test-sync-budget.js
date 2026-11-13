// Offline regression test for the sync cache / budget: node test-sync-budget.js
// No network, no credentials — the transport is stubbed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installSyncCache } = require('./anylist-cache');

function makeAny() {
  const calls = [];
  const any = {
    email: 'test@example.com',
    protobuf: {
      PBUserDataResponse: {
        decode: () => ({
          shoppingListsResponse: { newLists: [] },
          mealPlanningCalendarResponse: { calendarId: 'cal' },
        }),
      },
    },
    client: {
      post: async (url) => {
        calls.push(url);
        return { body: Buffer.from('blob') };
      },
    },
  };
  return { any, calls };
}

// Each CLI invocation is a fresh process, so the in-process blob is cleared before
// every simulated call — otherwise the library's own memoisation hides the cache.
function read(any, refresh = false) {
  any._userData = null;
  return any._getUserData(refresh);
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `anylist-${label}-`));
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

(async () => {
  await check('first read syncs once, the next read is served from cache', async () => {
    const { any, calls } = makeAny();
    const cache = installSyncCache(any, { dir: tmpDir('hit'), ttlMs: 900000, minIntervalMs: 0 });
    await read(any);
    await read(any);
    assert.strictEqual(calls.length, 1, `expected 1 sync, got ${calls.length}`);
    assert.strictEqual(cache.stats.syncs, 1);
    assert.strictEqual(cache.info.fromCache, true);
  });

  await check('expired cache syncs again when the budget allows it', async () => {
    const { any, calls } = makeAny();
    installSyncCache(any, { dir: tmpDir('expire'), ttlMs: 0, minIntervalMs: 0, maxPerHour: 10 });
    await read(any);
    await read(any);
    assert.strictEqual(calls.length, 2, `expected 2 syncs, got ${calls.length}`);
  });

  await check('min interval stops back-to-back opportunistic syncs', async () => {
    const { any, calls } = makeAny();
    const cache = installSyncCache(any, { dir: tmpDir('interval'), ttlMs: 0, minIntervalMs: 60000, maxPerHour: 10 });
    await read(any);
    cache.invalidate(); // what afterWrite() does: no blob to fall back on
    await assert.rejects(() => read(any), /sync budget spent/);
    assert.strictEqual(calls.length, 1, 'the second read must not hit the network');
  });

  await check('forced reads ignore the min interval (write verification)', async () => {
    const { any, calls } = makeAny();
    installSyncCache(any, { dir: tmpDir('forced'), ttlMs: 900000, minIntervalMs: 60000, maxPerHour: 10 });
    await read(any);
    await read(any, true);
    assert.strictEqual(calls.length, 2, `expected forced sync, got ${calls.length}`);
  });

  await check('hourly cap blocks further syncs with a retry hint', async () => {
    const { any, calls } = makeAny();
    const cache = installSyncCache(any, { dir: tmpDir('cap'), ttlMs: 0, minIntervalMs: 0, maxPerHour: 2 });
    await read(any);
    await read(any);
    cache.invalidate(); // no stale fallback, so the cap must surface as an error
    let err;
    await read(any).catch(e => { err = e; });
    assert.ok(err, 'expected the third sync to be refused');
    assert.ok(err.retryAfterMs > 0, 'refusal must carry retryAfterMs');
    assert.ok(err.retryAfterMinutes >= 1);
    assert.strictEqual(calls.length, 2, `cap must hold, got ${calls.length} syncs`);
    assert.strictEqual(cache.stats.syncs, 2);
  });

  await check('forced reads respect the hourly cap too', async () => {
    const { any, calls } = makeAny();
    installSyncCache(any, { dir: tmpDir('capforced'), ttlMs: 0, minIntervalMs: 0, maxPerHour: 1 });
    await read(any, true);
    await assert.rejects(() => read(any, true), /sync budget spent/);
    assert.strictEqual(calls.length, 1);
  });

  await check('stale blob is served (and flagged) when the budget is spent', async () => {
    const dir = tmpDir('stale');
    const first = makeAny();
    const c1 = installSyncCache(first.any, { dir, ttlMs: 1, minIntervalMs: 0, maxPerHour: 1 });
    await read(first.any); // writes the blob, spends the hourly budget
    assert.strictEqual(c1.stats.syncs, 1);

    const second = makeAny();
    const c2 = installSyncCache(second.any, { dir, ttlMs: 1, minIntervalMs: 0, maxPerHour: 1 });
    await new Promise(r => setTimeout(r, 5)); // let the blob age past ttlMs
    const data = await read(second.any);
    assert.ok(data, 'stale read must still return data');
    assert.strictEqual(second.calls.length, 0, 'stale read must not hit the network');
    assert.strictEqual(c2.info.fromCache, true);
    assert.strictEqual(c2.info.stale, true, 'stale reads must be flagged');
    assert.ok(c2.info.ageSeconds >= 0);
  });

  await check('writes are counted separately from syncs', async () => {
    const { any } = makeAny();
    const cache = installSyncCache(any, { dir: tmpDir('count'), ttlMs: 900000 });
    await read(any);
    await any.client.post('data/shopping-lists/update', {});
    await any.client.post('data/shopping-lists/update', {});
    assert.strictEqual(cache.stats.syncs, 1);
    assert.strictEqual(cache.stats.writes, 2);
  });

  console.log(failures ? `\n${failures} failing` : '\nall sync-budget checks passed');
  process.exitCode = failures ? 1 : 0;
})();
