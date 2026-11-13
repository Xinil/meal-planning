/**
 * Disk cache for AnyList's full-sync endpoint (`data/user-data/get`).
 *
 * That endpoint is aggressively rate limited: exceed it and the API answers
 * 429 `{"error":"sync_rate_limited","retry_after":3483}` and every read fails for
 * the remainder of the window. Every `getLists()` / `getRecipes()` call in the
 * library triggers one of these syncs, so a handful of CLI invocations in a
 * burst (each one a fresh login) is enough to trip it.
 *
 * `installSyncCache(any, ...)` replaces `any._getUserData` with a version that:
 *   - reuses the in-process blob when refreshCache is false (library default behaviour),
 *   - otherwise reuses a cached copy from disk if it is younger than `ttlMs`,
 *   - otherwise performs the sync and stores the raw protobuf bytes.
 *
 * Forced reads (`getLists(true)`, `getMealPlanningCalendarEvents(true)`) always hit
 * the network, so post-write verification stays honest. Call `invalidate()` after a
 * write so the next command's cached read does not miss the change.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.join(__dirname, '.cache');

function installSyncCache(any, { ttlMs = 300000, dir = DEFAULT_DIR } = {}) {
  const key = crypto.createHash('sha1').update(String(any.email || 'anonymous')).digest('hex').slice(0, 12);
  const file = path.join(dir, `user-data-${key}.bin`);

  const decode = body => {
    any._userData = any.protobuf.PBUserDataResponse.decode(body);
    any.calendarId = any._userData.mealPlanningCalendarResponse.calendarId;
    return any._userData;
  };

  const readCache = () => {
    if (!ttlMs || ttlMs <= 0) return null;
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > ttlMs) return null;
      return decode(fs.readFileSync(file));
    } catch (e) {
      return null;
    }
  };

  const writeCache = body => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body);
    } catch (e) { /* cache is best-effort */ }
  };

  any._getUserData = async refreshCache => {
    if (!refreshCache && any._userData) return any._userData;
    if (!refreshCache) {
      const cached = readCache();
      if (cached) return cached;
    }
    const result = await any.client.post('data/user-data/get');
    writeCache(result.body);
    return decode(result.body);
  };

  return {
    file,
    invalidate() {
      try { fs.unlinkSync(file); } catch (e) { /* nothing cached */ }
    },
  };
}

/**
 * Turn a got error into an actionable message, surfacing AnyList's rate limit.
 */
function describeError(err) {
  const response = err && err.response;
  if (response && response.statusCode === 429) {
    let retryAfter;
    try {
      const body = Buffer.isBuffer(response.body) ? response.body.toString() : String(response.body || '');
      retryAfter = JSON.parse(body).retry_after;
    } catch (e) { /* fall through to header */ }
    if (!retryAfter && response.headers && response.headers['retry-after']) {
      retryAfter = Number(response.headers['retry-after']);
    }
    const minutes = retryAfter ? Math.ceil(Number(retryAfter) / 60) : null;
    return {
      ok: false,
      error: 'AnyList rate limit hit (sync_rate_limited). Wait before retrying.',
      retryAfterSeconds: retryAfter || null,
      retryAfterMinutes: minutes,
      hint: 'Batch writes with add-many/remove-many (one sync per command) instead of one command per item.',
    };
  }
  return { ok: false, error: String(err && err.message ? err.message : err) };
}

module.exports = { installSyncCache, describeError };
