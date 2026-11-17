---
name: anylist
description: "Manage AnyList grocery lists, recipes, and the meal plan."
---

# AnyList

## When to Use

Load this whenever the request touches the user's AnyList account:

- grocery/shopping list items: "what's on my list", "add milk and eggs", "clear the crossed-off items"
- recipes: "what can I make", "does that recipe have ingredients saved", "which recipes are missing ingredients"
- meal planning: "add <meal> to Thursday", "what's for dinner next week", "remove that meal"
- the combined ask: "add <meal> to <day> and put its ingredients on my grocery list"
- buying the list: putting unchecked items into a Kroger-family store cart is the `kroger` skill;
  it consumes `groceries.js items --unchecked` directly, so read the list here and hand it over
  rather than re-typing item names

Unrelated to-dos (home projects, packing lists) also live in AnyList lists, so "add X to my
Home Depot list" is in scope via `groceries.js` with the list named explicitly.

Two one-shot Node CLIs, both printing JSON on stdout (errors: JSON on stderr, exit 1).
They talk to AnyList's reverse-engineered private API via the vendored
`anylist` package (`codetheweb/anylist` v0.8.5).

| Script | Scope |
| --- | --- |
| `groceries.js` | shopping lists: read items, add / check / remove items |
| `meals.js` | meal-planning calendar: history, upcoming, add/delete meals, recipe ingredients |

## This directory is a published git repo

`/opt/data/skills/anylist` is the working copy of **https://github.com/Xinil/meal-planning**
(`origin`, branch `main`; annotated tags carry releases — `v1.0.0` groceries CLI, `v1.1.0` sync
budget + batched writes). Edit files here, then commit and push: the repo is the copy the user
keeps, so an uncommitted change exists on this machine only.

```bash
cd /opt/data/skills/anylist
npm test                      # offline suites must be green before committing
git add SKILL.md groceries.js meals.js anylist-patch.js anylist-cache.js categorize.js \
  test-categorize.js test-sync-budget.js package.json package-lock.json references/
git commit -F - <<'EOF'
feat: ...
EOF
git push origin main
# only when cutting a release:
git tag -a v1.2.0 -m "v1.2.0 — ..." && git push origin v1.2.0
```

- Stage an explicit file list. `node_modules/`, `.cache/`, `.env` and `.anylist_credentials` are
  gitignored; the old reverse-engineering scratch scripts are excluded locally via
  `.git/info/exclude`. Never commit credentials or cache blobs.
- Push auth is an SSH key at `/opt/data/home/.ssh/id_ed25519`, wired through `core.sshCommand` on
  the repo because OpenSSH resolves `~/.ssh/config` from the *passwd* home (`/opt/data`), not
  `$HOME` (`/opt/data/home`). A fresh clone that cannot push needs that `core.sshCommand`
  re-applied — the `github` skill's repo-management reference (§2b) has the full recipe.
- Prove a release by cloning the tag into a scratch directory and running `npm ci && npm test`
  there — a push line is not evidence that the tagged tree builds.

## Setup

Credentials come from the environment:
- `ANYLIST_EMAIL`, `ANYLIST_PASSWORD`

They normally live in `$HERMES_HOME/.env` (e.g. `/opt/data/.env`). The library also keeps
its own encrypted token cache in `~/.anylist_credentials`, and this skill keeps a short-lived
sync cache in `./.cache/` (see Pitfalls → rate limits).

## Running

```bash
cd /opt/data/skills/anylist
node groceries.js lists
```

If `.env` is not already exported in the shell:

```bash
cd /opt/data/skills/anylist && (set -a; [ -f "$HERMES_HOME/.env" ] && . "$HERMES_HOME/.env"; set +a; node groceries.js lists)
```

`<list>` in every command accepts a list **name** or a list **id**. Matching is exact,
then case-insensitive, then substring; an ambiguous query fails with candidate lists
rather than guessing. **Omit `<list>` entirely to use the household default**
(`ANYLIST_DEFAULT_LIST`, falling back to "Shared Grocery List") — that is the list the
user means by "my grocery list". Other lists (Costco, Home Depot, packing lists…) must be
named explicitly.

## Grocery lists — `groceries.js`

```bash
node groceries.js lists                       # all lists: id, name, item/checked counts
node groceries.js items [--fresh]             # default list, every item
node groceries.js items "<list>"              # a specific list (name or id)
node groceries.js items "<list>" --unchecked  # what still needs buying
node groceries.js add "<list>" "Milk" --qty "1 gal" --details "2%" [--category dairy]
node groceries.js add-many --json '[{"name":"Milk","quantity":"1 gal"}]'   # default list
node groceries.js check "<list>" "Milk"       # cross an item off
node groceries.js uncheck "<list>" "Milk"
node groceries.js check-many "<list>" (--file f.json | --json '["a","b"]' | --stdin)   # one write
node groceries.js uncheck-many "<list>" (same input)
node groceries.js remove "<list>" "Milk"
node groceries.js remove-many "<list>" --json '["Milk","Eggs"]'
node groceries.js clear-checked "<list>"      # delete every crossed-off item
```

`add-many` / `remove-many` also accept `--file items.json` or `--stdin`, and a bare array or
`{"items": [...]}`. **Batch, don't loop** — each invocation costs one login and at most one
sync; 12 separate `add` calls is how you hit the rate limit.

### Add semantics (mirrors the official app)

- Item name already on the list (case-insensitive)? Reuse it — no duplicates.
- Reused item is crossed off? Uncheck it and report `"changes": ["unchecked"]`.
- `--qty` / `--details` given and different? Update them and report `"changes"`.
- Otherwise create a new item.
- New names are auto-categorized from a keyword map before upload, so items land in the
  right aisle instead of "Other". Override with `--category <slug>`; valid slugs:
  `produce`, `meat`, `seafood`, `dairy`, `deli`, `bakery`, `frozen-foods`,
  `grains-pasta-and-side-dishes`, `soups-and-canned-goods`,
  `condiments-oils-and-salad-dressings`, `cooking-and-baking`, `breakfast-and-cereal`,
  `snacks-cookies-and-candy`, `beverages`, `wine-beer-spirits`, `household-and-cleaning`,
  `health-and-personal-care`, `pet-supplies`, `baby`, `other`.
- Every write is read back from the server before the command reports, so the JSON you get is
  what AnyList actually stored.

## Meal plan — `meals.js`

```bash
node meals.js history                      # last 60 days
node meals.js upcoming [--days 20]         # planned meals (default window: -1..+10 days)
node meals.js candidates                   # 30 high-rated recipes to choose from
node meals.js add "2026-11-25" "Butternut Squash Risotto"
node meals.js add "2026-11-25" "Marley Spoon"        # not a recipe -> all-day text note
node meals.js delete "2026-11-25" ["Risotto"]        # remove meal(s) from that date
node meals.js recipes [--missing]          # cookbook index w/ ingredient counts
node meals.js ingredients "<recipe>" [--skip-pantry]
```

`ingredients` returns the recipe's structured ingredient list as JSON:

```json
{"ok": true, "recipe": "...", "servings": "5 cups", "count": 13,
 "items": [{"name": "Garlic Cloves", "quantity": "4", "details": "rough chop", "raw": "4 Garlic Cloves, rough chop"}]}
```

Section headings inside a recipe are filtered out. `--skip-pantry` drops staples
(salt, pepper, oils, flour, sugar, water, butter) so a push doesn't litter the list.

## Workflow: plan a week of dinners

The ask is "plan next week", usually with some nights already spoken for (a meal-kit service
covers 3 of them, the user names one meal, a night stays empty). Do not fill nights nobody asked
for.

1. **Anchor the dates.** `date "+%Y-%m-%d %A"` for today, then plan the *next* week's calendar
   week (Mon–Sun). Pass bare `YYYY-MM-DD` strings to `meals.js`; it stores UTC midnight and
   formats with `dayjs.utc`, so hand-converting a PT evening to a date is what shifts a day.
2. **Read once, both views, in one shell call** — `history` then `upcoming` in the same
   invocation share the sync cache (one sync). `recipes` / `candidates` cost a sync each, so run
   them in the same call too, redirecting to files you then query with `node -e`.
3. **Build the exclusion list** from `history` (60 days): skip anything cooked in the last ~3
   weeks, and skip the *genre*, not just the exact title — the user pushes back on "too much pizza
   lately", so a week with pizza already in it should not get another flatbread/pizza, and pasta
   twice in a week reads as lazy. Leave the meal-kit entries (`Marley Spoon`, takeout notes) alone;
   they are the nights being covered.
4. **Pick** from `candidates` (rating 4–5) cross-checked against the `recipes` index for variety
   against the exclusion list, and for leftovers value on a weekend night. Nod to the season when
   it is obvious (chili, soup, braises in November).
5. **Write one date at a time**, sleeping 45–60s between writes (see Pitfalls → consecutive
   writes). Confirm each add is a real recipe link, not a text note.
6. **Swap = delete then add**, not edit: `meals.js delete "<date>" "<old>"`, wait, then `add`.
7. **Verify and report.** `meals.js upcoming --days 10` must show the new meals. Reply with a
   day/meal table, the rating of each pick, and the recent meals it was chosen *against*, plus 2–4
   named swap options — the user edits the picks rather than re-briefing from scratch.
   Push ingredients only when asked; the default is calendar-only.

## Workflow: meal on the calendar + ingredients on the grocery list

The user phrase is usually "add <meal> to <day> and put the ingredients on my list".

```bash
cd /opt/data/skills/anylist
node meals.js add "2026-11-25" "Butternut Squash Risotto"
node meals.js ingredients "Butternut Squash Risotto" --skip-pantry \
  | node groceries.js add-many --stdin        # --stdin with no list = household default
```

Notes for this flow:
- The meal and the list are independent: `add` only touches the calendar, `add-many` only the list.
- Piping is intentional — `ingredients` already emits `{"items": [...]}`, which `add-many` consumes
  with no translation step. If you want to inspect first, run `ingredients` alone, then re-run the
  pipe (cheap: the sync blob is cached).
- Confirm both halves to the user: the date/meal from `add`, then the `summary` block from
  `add-many` (`added` / `updated` / `already-present` counts).
- Duplicate protection means re-running the pipe after a partial failure is safe.

## Pitfalls & best practices

- **Rate limits are real and brutal.** `/data/user-data/get` is a *full* download of the
  account (lists, recipes, calendar) and AnyList polices it hard: exceeding it returns
  `429 {"error":"sync_rate_limited","retry_after":<seconds>}` (an hour is typical) and the vendor
  also emails the account owner about "excessive downloading" and pauses API access. One observed
  trigger: roughly 40 syncs in 25 minutes. Every command here is budgeted:

  | Command | Syncs | Writes |
  | --- | --- | --- |
  | `lists` / `items` within the 15 min cache window | 0 | 0 |
  | the same after the cache expires | 1 | 0 |
  | `add-many` of N ingredients (cache warm) | 1 (verification) | 1 for all N |
  | `add-many` of N ingredients (cache cold) | 2 | 1 for all N |
  | `check` / `uncheck` | 1-2 | 1 |
| `check-many` / `uncheck-many` of N items | 1-2 | 1 for all N |

  Knobs (env, all optional): `ANYLIST_CACHE_TTL_MS` (default 900000 = 15 min),
  `ANYLIST_MAX_SYNCS_PER_HOUR` (default 10), `ANYLIST_MIN_SYNC_INTERVAL_MS` (default 45000).
  Over budget, reads fall back to the cached blob and say so (`api.stale`, `api.dataAgeSeconds`);
  if there is no blob to fall back on you get a clean `retryAfterMinutes` instead of a 429.
  Every command reports its own `api` block — read it before claiming data is fresh.
  Never loop the CLI per item. Use `--fresh` on a read only when the user needs live data now.
- **User id injection.** The library never sets `any.uid`, so write operations go out with
  `userId: undefined` and are rejected. Every script resolves
  `_userData.listSettingsResponse.settings[0].userId` and assigns `any.uid` *before* `getLists()`
  (List/Item objects capture the uid at construction).
- **Quantity encode bug in 0.8.5.** `Item#_encode` passes a `quantity` field that no longer exists
  in `ListItem` (it is `quantityPb` / PBItemQuantity now), so *any* item write throws
  `ListItem#quantity is not a field`. `anylist-patch.js` re-implements `_encode` against the real
  schema and reads `quantityPb.rawQuantity` back on read. Both scripts require it before touching
  the library — keep that require order if you edit them, and re-check after any `npm update`.
- **Recipe-linked items keep their amount on the ingredient, not the item.** An item pushed from
  a recipe (meal plan → list) has `ListItem.quantityPb = null` while
  `ingredients[0].quantityPb.rawQuantity` holds `"2 lb"` — the app still renders
  "Italian Sausage (2 lb)", so reading only the item-level field makes a 2 lb ingredient look
  like a bare name. `quantityToString()` in `anylist-patch.js` falls back to the linked ingredient,
  and `rawLists()` also exposes `note` (the prep text, e.g. "sliced into 1/2 inch pieces") and
  `rawIngredient`. Regression test: `test-quantity.js` (`npm test`).
- **Wrapper classes expose only a curated subset of fields.** `quantityPb` (above) and
  `PBIngredient.isHeading` are both dropped by the library's wrappers. When a value is missing
  from `list.items`/`any.recipes`, read the decoded protobuf instead
  (`any._userData.shoppingListsResponse.newLists`, `any._userData.recipeDataResponse.recipes`) —
  never assume the field does not exist server-side. See `references/api-internals.md`.
- **`categorize.js` rules are first-match-wins, top to bottom.** A generic pattern placed above a
  specific one silently steals the match: "Coconut Milk"→dairy, "Orange Juice"→produce,
  "Diced Tomatoes"→produce, "Tortilla Chips"→bakery. Put high-specificity overrides in the
  override block at the top of `RULES`, and add a case to `test-categorize.js` for every new rule
  (`node test-categorize.js` must stay green).
- **Dates are UTC.** Calendar events are stored at UTC midnight (`00:00:00.000Z`); all formatting
  and comparison must use `dayjs.utc`, otherwise PST shifts a date to the previous day.
- **List creation is not supported** by the library (no create/rename/reorder). If the user asks
  for a list that doesn't exist, create it in the app and retry.
- **Recategorizing an existing item is unreliable** — the `set-list-item-category-match-id`
  operation appears to clear the category rather than set it. Auto-categorize at add time
  (default) or leave as is; don't promise the user a category change on an existing item.
- **Guest / portion sizing** (meal choice, not groceries): filter recipes by `servings`
  (e.g. `"4-6"`, `"8"`) as well as rating when cooking for a crowd.
- **Text notes vs recipes:** meal kit services, takeout, and one-off notes go through
  `meals.js add` as all-day text entries; no cookbook entry needed.
- **A wrong recipe name fails silently into a text note.** `meals.js add` prints
  `Found recipe: "<name>"` only when it links a cookbook entry; otherwise it creates an all-day
  text entry and still reports success. Recipe titles are matched byte-for-byte and many contain
  typographic apostrophes (`Jeffrey’s Blue Ribbon Chili` uses U+2019, not `'`), so copy the exact
  string out of `meals.js recipes` instead of retyping it, and treat a missing `Found recipe:`
  line as a failure to fix (delete the note, re-add with the indexed spelling).
- **Consecutive writes trip the min-sync-interval budget.** Every `add` / `delete` is a write, and
  a write cannot fall back to the cache the way a read can: back-to-back commands seconds apart
  return `{"ok":false,"error":"sync budget spent: ...","retryAfterSeconds":N}`. Sleep ~45–60s
  between writes, and on that error wait out the reported `retryAfterSeconds` (plus a few seconds)
  and re-run the *same* command — the retry succeeds, and re-running a duplicate `add`/`delete`
  that partially landed is harmless. Prefer one batched shell command for all the session's reads
  over one call per read; each separate call buys another sync.
- **Crossing off a shopped list: use `check-many`, never a loop of `check`.** One write for
  all N items; 26 separate `check` calls spend 26 writes and trip the min-interval budget.
  Pass the item names exactly as AnyList stores them (recipe noise and typographic characters
  included) — read them from `items --unchecked` and feed the JSON back rather than retyping.
- **Self-check:** `npm test` runs the category map (~33 cases) and the sync cache/budget tests
  (cache hits, min interval, hourly cap, stale fallback) — no network or credentials needed.

## Files

| File | Purpose |
| --- | --- |
| `groceries.js` | list/item commands |
| `meals.js` | calendar + recipe commands |
| `anylist-patch.js` | protobuf encode/read fixes for the vendored library |
| `anylist-cache.js` | sync-blob disk cache + 429 error shaping |
| `categorize.js` | item-name → category slug rules |
| `test-categorize.js` | offline category regression test (`npm test`)
| `test-quantity.js` | offline regression test for item/ingredient quantity reads (`npm test`) |
| `test-sync-budget.js` | offline regression test for the sync cache/budget (`npm test`) |
| `references/api-internals.md` | schema, endpoints, operation handlers — read this before extending |
