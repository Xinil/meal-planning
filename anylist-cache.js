/**
 * Transport layer for the AnyList client: sync cache, sync budget, request accounting.
 *
 * AnyList's `data/user-data/get` (full sync) is the endpoint that gets accounts in
 * trouble. The account owner received an "excessive downloading" warning plus a
 * one-hour API pause after a burst of syncs, and the API itself answers
 * `429 {"error":"sync_rate_limited","retry_after":<seconds>}`, failing every read for
 * the rest of the window. Each `getLists()` / `getRecipes()` call in the library
 * triggers a sync, so the client must spend them carefully.
 *
 * installSyncCache(any, opts) replaces `any._getUserData` with a version that:
 *   - reuses the in-process blob when refreshCache is false (library default),
 *   - reuses the disk copy while it is younger than `ttlMs` (default 15 min),
 *   - returns the stale disk copy (flagged fromCache/ageSeconds) when a refresh is
 *     not allowed yet, so the caller can say "as of N minutes ago",
 *   - otherwise syncs, stores the raw protobuf bytes, and records the call in a
 *     rolling-hour budget file.
 *
 * Forced reads (verification after a write, `--fresh`) are always allowed but are
 * counted and capped by `maxPerHour`; when that is spent the caller gets
 * `retryAfterSeconds` instead of another 429 from the vendor.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '.cache');
const HOUR_MS = 3600000;

function installSyncCache(any, options) {
  const opts = options || {};
  const ttlMs = opts.ttlMs === undefined ? 900000 : opts.ttlMs; // 15 min
  const dir = opts.dir || DEFAULT_DIR;
  const maxPerHour = opts.maxPerHour === undefined ? 10 : opts.maxPerHour;
  const minIntervalMs = opts.minIntervalMs === undefined ? 45000 : opts.minIntervalMs;
  const budgetFile = opts.budgetFile || path.join(dir, 'sync-budget.json');

  const key = crypto.createHash('sha1').update(String(any.email || 'anonymous')).digest('hex').slice(0, 12);
  const file = path.join(dir, `user-data-${key}.bin`);

  const stats = { syncs: 0, writes: 0, cacheHits: 0, forced: 0 };
  const info = { fromCache: false, ageSeconds: null, stale: false };

  // count non-sync POSTs (writes) for reporting
  const realPost = any.client.post.bind(any.client);
  any.client.post = function countedPost(url, postOptions) {
    if (String(url).indexOf('user-data/get') === -1) stats.writes += 1;
    return realPost(url, postOptions);
  };

  function readBudget() {
    try {
      const stamps = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
      if (!Array.isArray(stamps)) return [];
      return stamps.filter(t => Date.now() - t < HOUR_MS);
    } catch (e) {
      return [];
    }
  }

  function writeBudget(stamps) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(budgetFile, JSON.stringify(stamps), 'utf8');
    } catch (e) { /* budget tracking is best-effort */ }
  }

  function budgetError(retryMs) {
    const waitMs = Math.max(retryMs, 1000);
    const err = new Error('sync budget spent: too many AnyList syncs this hour');
    err.retryAfterMs = waitMs;
    err.retryAfterMinutes = Math.ceil(waitMs / 60000);
    return err;
  }

  function decode(body) {
    any._userData = any.protobuf.PBUserDataResponse.decode(body);
    any.calendarId = any._userData.mealPlanningCalendarResponse.calendarId;
    return any._userData;
  }

  // null | {fresh:true, data} | {stale:true, ageMs, body}
  function readCache() {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return null;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    if (ttlMs > 0 && ageMs <= ttlMs) {
      info.fromCache = true;
      info.ageSeconds = Math.round(ageMs / 1000);
      info.stale = false;
      stats.cacheHits += 1;
      try {
        return { fresh: true, data: decode(fs.readFileSync(file)) };
      } catch (e) {
        return null;
      }
    }
    return { stale: true, ageMs, body: fs.readFileSync(file) };
  }

  function serveStale(cached) {
    info.fromCache = true;
    info.stale = true;
    info.ageSeconds = Math.round(cached.ageMs / 1000);
    return decode(cached.body);
  }

  function storeCache(body) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body);
    } catch (e) { /* cache is best-effort */ }
  }

  any._getUserData = async function cachedUserData(refreshCache) {
    if (!refreshCache && any._userData) return any._userData;

    const stamps = readBudget();
    const sinceLast = stamps.length ? Date.now() - stamps[stamps.length - 1] : null;
    const cached = refreshCache ? null : readCache();

    if (!refreshCache) {
      if (cached && cached.fresh) return cached.data;
      if (stamps.length >= maxPerHour) {
        if (cached && cached.stale) return serveStale(cached);
        throw budgetError(HOUR_MS - (Date.now() - stamps[0]));
      }
      if (sinceLast !== null && sinceLast < minIntervalMs) {
        if (cached && cached.stale) return serveStale(cached);
        throw budgetError(minIntervalMs - sinceLast);
      }
    } else {
      if (stamps.length >= maxPerHour) throw budgetError(HOUR_MS - (Date.now() - stamps[0]));
      stats.forced += 1;
    }

    const result = await any.client.post('data/user-data/get', { retry: 0 });
    storeCache(result.body);
    stamps.push(Date.now());
    writeBudget(stamps);
    stats.syncs += 1;
    info.fromCache = false;
    info.ageSeconds = 0;
    info.stale = false;
    return decode(result.body);
  };

  return {
    file,
    stats,
    info,
    invalidate() {
      try {
        fs.unlinkSync(file);
      } catch (e) { /* nothing cached */ }
    },
  };
}

/**
 * Turn a client error into an actionable message, surfacing the vendor's rate limit
 * and our own budget limits.
 */
function describeError(err) {
  const response = err && err.response;
  if (response && response.statusCode === 429) {
    let retryAfter;
    try {
      const body = Buffer.isBuffer(response.body) ? response.body.toString() : String(response.body || '');
      retryAfter = JSON.parse(body).retry_after;
    } catch (e) { /* fall through to header */ }
    if (!retryAfter && response.headers) retryAfter = response.headers['retry-after'];
    return {
      ok: false,
      error: 'AnyList rate limit hit (sync_rate_limited). Wait before retrying.',
      retryAfterSeconds: retryAfter || null,
      retryAfterMinutes: retryAfter ? Math.ceil(Number(retryAfter) / 60) : null,
      hint: 'Batch writes with add-many/remove-many (one sync per command) instead of one command per item.',
    };
  }
  if (err && err.retryAfterMs) {
    return {
      ok: false,
      error: err.message,
      retryAfterSeconds: Math.round(err.retryAfterMs / 1000),
      retryAfterMinutes: err.retryAfterMinutes,
    };
  }
  return { ok: false, error: String(err && err.message ? err.message : err) };
}

module.exports = { installSyncCache, describeError, HOUR_MS };
