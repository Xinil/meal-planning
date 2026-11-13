#!/usr/bin/env node
/**
 * AnyList grocery-list CLI.
 *
 * Reads ANYLIST_EMAIL / ANYLIST_PASSWORD from the environment.
 * Every command prints JSON to stdout (errors go to stderr, exit 1).
 *
 * USAGE
 *   node groceries.js lists
 *   node groceries.js items <list> [--checked|--unchecked]
 *   node groceries.js add <list> <item name> [--qty Q] [--details D] [--category slug]
 *   node groceries.js add-many <list> (--file f.json | --json '<json>' | --stdin)
 *   node groceries.js check|uncheck <list> <item name>
 *   node groceries.js remove <list> <item name>
 *   node groceries.js remove-many <list> (--file f.json | --json '["a","b"]' | --stdin)
 *   node groceries.js clear-checked <list>
 *
 * <list> accepts a list name (exact, case-insensitive, then substring) or a list id.
 * Omit it (or pass --list <name>) to use ANYLIST_DEFAULT_LIST (default "Shared Grocery List").
 * add-many input is [{ "name": "...", "quantity": "...", "details": "..." }, ...]
 * (also accepts {"items": [...]}) — use it to push a recipe's ingredients in one shot.
 */
const fs = require('fs');
const { rawLists } = require('./anylist-patch'); // must load before AnyList is used
const { installSyncCache, describeError } = require('./anylist-cache');
const { assign: assignCategory } = require('./categorize');
const AnyList = require('anylist');

const EMAIL = process.env.ANYLIST_EMAIL;
const PASSWORD = process.env.ANYLIST_PASSWORD;
const DEFAULT_LIST = process.env.ANYLIST_DEFAULT_LIST || 'Shared Grocery List';
const CACHE_TTL_MS = Number(process.env.ANYLIST_CACHE_TTL_MS || 300000); // 5 min

if (!EMAIL || !PASSWORD) {
  fail('Missing ANYLIST_EMAIL / ANYLIST_PASSWORD in environment');
}

const any = new AnyList({ email: EMAIL, password: PASSWORD });
let syncCache = null;

function fail(msg, extra) {
  process.stderr.write(JSON.stringify({ ok: false, error: msg, ...(extra ? { detail: extra } : {}) }) + '\n');
  process.exit(1);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// --- tiny arg parser: positional args + --flag value -------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// --- login + cache bootstrap -------------------------------------------------
// The library builds List/Item objects from `any.uid` at construction time, so
// the user id must be injected BEFORE getLists(), otherwise write operations go
// out with userId=undefined and the server rejects them.
async function connect() {
  await any.login(false); // no websocket: one-shot CLI
  syncCache = installSyncCache(any, { ttlMs: CACHE_TTL_MS });
  await any.getRecipes(false); // warms _userData (recipes + list settings + lists); cached when fresh
  const settings = any._userData && any._userData.listSettingsResponse
    ? any._userData.listSettingsResponse.settings
    : null;
  if (!settings || !settings.length || !settings[0].userId) {
    fail('Could not resolve AnyList user id from account data');
  }
  any.uid = settings[0].userId;
  await any.getLists(false); // reuse cached blob, now with uid set
}

// Categories available on this account (system slugs, e.g. "produce"); used when
// auto-assigning a category to a new item.
function availableCategories() {
  const cats = any._userData && any._userData.userCategoriesResponse
    ? any._userData.userCategoriesResponse.categories
    : null;
  if (!cats || !cats.length) return [];
  return cats.map(c => c.systemCategory).filter(Boolean);
}

async function refresh() {
  await any.getLists(true);
  return rawLists(any);
}

// Invalidate the cached sync blob, then read the list back from the server so the
// command reports what actually landed.
async function afterWrite() {
  if (syncCache) syncCache.invalidate();
  return refresh();
}

// --- list resolution ---------------------------------------------------------
function summary(list) {
  const items = list.items;
  return {
    id: list.id,
    name: list.name,
    itemCount: items.length,
    uncheckedCount: items.filter(i => !i.checked).length,
    checkedCount: items.filter(i => i.checked).length,
  };
}

function resolveList(lists, query) {
  // No list given: fall back to the household default (ANYLIST_DEFAULT_LIST).
  if (!query) {
    const fallback = lists.filter(l => l.name.toLowerCase() === DEFAULT_LIST.toLowerCase());
    if (fallback.length === 1) return fallback[0];
    fail(`Missing list name and default "${DEFAULT_LIST}" not found. Available lists: ${lists.map(l => l.name).join(' | ')}`);
  }
  const q = String(query).trim();
  const lower = q.toLowerCase();

  let matches = lists.filter(l => l.id === q);
  if (!matches.length) matches = lists.filter(l => l.name.toLowerCase() === lower);
  if (!matches.length) matches = lists.filter(l => l.name.toLowerCase().includes(lower));

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exact = matches.filter(l => l.name.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    fail(`List name "${q}" is ambiguous`, { candidates: matches.map(summary) });
  }
  fail(`No list matching "${q}"`, { available: lists.map(l => l.name) });
}

function findItem(list, name) {
  const lower = String(name).trim().toLowerCase();
  return list.items.find(i => i.name && i.name.toLowerCase() === lower)
    || list.items.find(i => i.name && i.name.toLowerCase().includes(lower));
}

// The library's List/Item objects are only used for writes; reads come from the
// raw protobuf view (they carry quantityPb, which the library drops).
function writeList(listId) {
  const list = any.getListById(listId);
  if (!list) fail(`List ${listId} not found in library cache`);
  return list;
}

function writeItem(listId, itemId) {
  const list = writeList(listId);
  const item = list.getItemById(itemId);
  if (!item) fail(`Item ${itemId} not found in list cache`);
  return item;
}

// --- item creation / reuse ---------------------------------------------------
// Mirrors the official client: if an item with that name already exists
// (checked off or not), reuse it instead of creating a duplicate.
async function addOne(list, spec, report, categories) {
  const name = String(spec.name || '').trim();
  if (!name) {
    report.push({ name: spec.name, status: 'skipped', reason: 'empty name' });
    return;
  }

  const quantity = spec.quantity === undefined || spec.quantity === null || spec.quantity === ''
    ? undefined
    : String(spec.quantity).trim();
  const details = spec.details === undefined || spec.details === null || spec.details === ''
    ? undefined
    : String(spec.details).trim();
  const requestedCategory = spec.category || spec.categoryMatchId;
  const category = requestedCategory
    ? String(requestedCategory).trim()
    : assignCategory(name, categories);

  const existing = findItem(list, name);
  if (existing) {
    const target = writeItem(list.id, existing.id);
    const changes = [];

    if (existing.checked) {
      target.checked = false;
      changes.push('unchecked');
    }
    if (quantity && existing.quantity !== quantity) {
      target.quantity = quantity;
      changes.push('quantity');
    }
    if (details && existing.details !== details) {
      target.details = details;
      changes.push('details');
    }

    if (changes.length) await target.save();
    report.push({
      name: existing.name,
      status: changes.length ? 'updated' : 'already-present',
      quantity: quantity || existing.quantity,
      category: existing.categoryMatchId || undefined,
      changes: changes.length ? changes : undefined,
    });
    return;
  }

  const draft = any.createItem({ name, quantity, details });
  if (category && category !== 'other') draft.categoryMatchId = category;
  const item = await writeList(list.id).addItem(draft);
  report.push({
    name: item.name,
    status: 'added',
    quantity: quantity,
    details: details,
    category: category || undefined,
  });
}

function readSpecs(flags) {
  let raw;
  if (flags.file) raw = fs.readFileSync(flags.file, 'utf8');
  else if (flags.stdin) raw = fs.readFileSync(0, 'utf8');
  else if (typeof flags.json === 'string') raw = flags.json;
  else fail('add-many needs --file <path>, --json <json> or --stdin');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON input: ${e.message}`);
  }
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(items)) fail('JSON input must be an array of items or {"items": [...]}');
  return items;
}

// --- commands ----------------------------------------------------------------
async function main() {
  const action = process.argv[2] || 'lists';
  const { positional, flags } = parseArgs(process.argv.slice(3));

  await connect();
  let lists = rawLists(any);
  const categories = availableCategories();
  // List can be given positionally (first arg) or as --list, which lets the first
  // positional be the item name instead.
  const listArg = flags.list || positional[0];
  const nameArgs = flags.list ? positional : positional.slice(1);

  switch (action) {
    case 'lists':
      return out({ ok: true, count: lists.length, lists: lists.map(summary) });

    case 'items': {
      const list = resolveList(lists, listArg);
      let items = list.items;
      if (flags.checked) items = items.filter(i => i.checked);
      else if (flags.unchecked) items = items.filter(i => !i.checked);
      return out({
        ok: true,
        list: summary(list),
        count: items.length,
        items,
      });
    }

    case 'add': {
      const list = resolveList(lists, listArg);
      const name = nameArgs.join(' ').trim();
      if (!name) fail('Usage: node groceries.js add <list> <item name> [--qty Q] [--details D] [--category slug]');
      const report = [];
      await addOne(list, { name, quantity: flags.qty, details: flags.details, category: flags.category }, report, categories);
      lists = await afterWrite();
      return out({
        ok: true,
        list: summary(resolveList(lists, list.id)),
        result: report[0],
      });
    }

    case 'add-many': {
      const list = resolveList(lists, listArg);
      const specs = readSpecs(flags);
      const report = [];
      for (const spec of specs) {
        try {
          await addOne(list, spec, report, categories);
        } catch (e) {
          report.push({ name: spec.name, status: 'error', error: e.message });
        }
      }
      lists = await afterWrite();
      return out({
        ok: true,
        list: summary(resolveList(lists, list.id)),
        requested: specs.length,
        summary: report.reduce((acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        }, {}),
        results: report,
      });
    }

    case 'remove': {
      const list = resolveList(lists, listArg);
      const name = nameArgs.join(' ').trim();
      if (!name) fail('Usage: node groceries.js remove <list> <item name>');
      const item = findItem(list, name);
      if (!item) fail(`Item "${name}" not found in list "${list.name}"`);
      await writeList(list.id).removeItem(writeItem(list.id, item.id));
      lists = await afterWrite();
      return out({
        ok: true,
        list: summary(resolveList(lists, list.id)),
        removed: { id: item.id, name: item.name },
      });
    }

    case 'check':
    case 'uncheck': {
      const list = resolveList(lists, listArg);
      const name = nameArgs.join(' ').trim();
      if (!name) fail(`Usage: node groceries.js ${action} <list> <item name>`);
      const item = findItem(list, name);
      if (!item) fail(`Item "${name}" not found in list "${list.name}"`);
      const target = writeItem(list.id, item.id);
      target.checked = action === 'check';
      await target.save();
      lists = await afterWrite();
      return out({
        ok: true,
        list: summary(resolveList(lists, list.id)),
        item: resolveList(lists, list.id).items.find(i => i.id === item.id),
      });
    }

    case 'remove-many': {
      const list = resolveList(lists, listArg);
      const specs = readSpecs(flags);
      const wanted = specs.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean);
      const removed = [];
      const missing = [];
      for (const name of wanted) {
        const item = findItem(list, name);
        if (!item) {
          missing.push(name);
          continue;
        }
        await writeList(list.id).removeItem(writeItem(list.id, item.id));
        removed.push(item.name);
      }
      lists = await afterWrite();
      return out({
        ok: true,
        list: summary(resolveList(lists, list.id)),
        removedCount: removed.length,
        removed,
        missing,
      });
    }

    case 'clear-checked': {
      const list = resolveList(lists, listArg);
      const checked = list.items.filter(i => i.checked);
      const removed = [];
      for (const item of checked) {
        await writeList(list.id).removeItem(writeItem(list.id, item.id));
        removed.push(item.name);
      }
      lists = await afterWrite();
      return out({
        ok: true,
        list: summary(resolveList(lists, list.id)),
        removedCount: removed.length,
        removed,
      });
    }

    default:
      fail(`Unknown command "${action}". Expected: lists | items | add | add-many | check | uncheck | remove | remove-many | clear-checked`);
  }
}

main()
  .catch(err => {
    process.stderr.write(JSON.stringify(describeError(err)) + '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    try { any.teardown(); } catch (e) { /* ignore */ }
  });
