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

Unrelated to-dos (home projects, packing lists) also live in AnyList lists, so "add X to my
Home Depot list" is in scope via `groceries.js` with the list named explicitly.

Two one-shot Node CLIs, both printing JSON on stdout (errors: JSON on stderr, exit 1).
They talk to AnyList's reverse-engineered private API via the vendored
`anylist` package (`codetheweb/anylist` v0.8.5).

| Script | Scope |
| --- | --- |
| `groceries.js` | shopping lists: read items, add / check / remove items |
| `meals.js` | meal-planning calendar: history, upcoming, add/delete meals, recipe ingredients |

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
node groceries.js items                       # default list, every item
node groceries.js items "<list>"              # a specific list (name or id)
node groceries.js items "<list>" --unchecked  # what still needs buying
node groceries.js add "<list>" "Milk" --qty "1 gal" --details "2%" [--category dairy]
node groceries.js add-many --json '[{"name":"Milk","quantity":"1 gal"}]'   # default list
node groceries.js check "<list>" "Milk"       # cross an item off
node groceries.js uncheck "<list>" "Milk"
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

- **Rate limits are real and brutal.** `/data/user-data/get` (full sync) returns
  `429 {"error":"sync_rate_limited","retry_after":<seconds>}` — often ~1 hour — after a burst of
  calls. Mitigations already in place: `anylist-cache.js` reuses a sync blob for
  `ANYLIST_CACHE_TTL_MS` (default 5 min) so read commands cost nothing, writes invalidate it, and
  `add-many`/`remove-many` fold N items into one command. Still: never loop the CLI per item, and
  on 429 report `retryAfterMinutes` to the user instead of retrying in a hot loop.
- **User id injection.** The library never sets `any.uid`, so write operations go out with
  `userId: undefined` and are rejected. Every script resolves
  `_userData.listSettingsResponse.settings[0].userId` and assigns `any.uid` *before* `getLists()`
  (List/Item objects capture the uid at construction).
- **Quantity encode bug in 0.8.5.** `Item#_encode` passes a `quantity` field that no longer exists
  in `ListItem` (it is `quantityPb` / PBItemQuantity now), so *any* item write throws
  `ListItem#quantity is not a field`. `anylist-patch.js` re-implements `_encode` against the real
  schema and reads `quantityPb.rawQuantity` back on read. Both scripts require it before touching
  the library — keep that require order if you edit them, and re-check after any `npm update`.
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
- **Self-check:** `node test-categorize.js` runs the category map against ~33 known cases.

## Files

| File | Purpose |
| --- | --- |
| `groceries.js` | list/item commands |
| `meals.js` | calendar + recipe commands |
| `anylist-patch.js` | protobuf encode/read fixes for the vendored library |
| `anylist-cache.js` | sync-blob disk cache + 429 error shaping |
| `categorize.js` | item-name → category slug rules |
| `test-categorize.js` | offline category regression test (`npm test`) |
| `references/api-internals.md` | schema, endpoints, operation handlers — read this before extending |
