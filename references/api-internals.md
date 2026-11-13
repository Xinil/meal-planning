# AnyList API internals

Depth for extending the skill. The `anylist` npm package is a thin wrapper over
AnyList's private API: every read and write is a protobuf message sent as a
multipart POST. When the wrapper lacks a field or operation, go to the schema.

## Sources of truth

| What | Where |
| --- | --- |
| Protobuf schema (all messages/fields) | `node_modules/anylist/lib/definitions.json` |
| Client + write operations | `node_modules/anylist/lib/{index,list,item,recipe,recipe-collection,meal-planning-calendar-event}.js` |
| Local fixes that must survive `npm install` | `anylist-patch.js` (never edit `node_modules` directly) |

Dump the schema instead of reading the 140 KB file by hand:

```bash
python3 - <<'EOF'
import json
d = json.load(open('node_modules/anylist/lib/definitions.json'))
for m in d['messages']:
    if m['name'] in ('ListItem', 'PBIngredient', 'ShoppingList'):
        print(m['name'], [(f['rule'], f['type'], f['name'], f['id']) for f in m['fields']])
EOF
```

## Endpoints

| Endpoint | Payload | Used for |
| --- | --- | --- |
| `auth/token`, `auth/token/refresh` | form | login; library caches tokens AES-encrypted in `~/.anylist_credentials` |
| `data/user-data/get` | — | full sync: lists, recipes, calendar, settings. **Rate limited** |
| `data/shopping-lists/update` | `PBListOperationList` | add / patch / remove list items |
| `data/starter-lists/update` | `PBListOperationList` | favorites + recent-items starter lists (`isFavorite=true`) |
| `data/meal-planning-calendar/update` | `PBCalendarOperationList` | calendar events |
| `data/user-recipe-data/update` | `PBRecipeOperationList` | recipes / collections |

A websocket (`wss://www.anylist.com/data/add-user-listener`, pushes
`refresh-shopping-lists`) exists but one-shot CLIs should call `login(false)` and skip it.

## Messages worth knowing

- `ListItem`: `identifier` 1, `listId` 3, `name` 4, `details` 5, `checked` 6, `recipeId` 7,
  `rawIngredient` 8, `category` 11 (slug), `userId` 12, `categoryMatchId` 13, `storeIds` 16,
  `manualSortIndex` 17, `deprecatedQuantity` 18 (string, ignored by clients),
  `quantityPb` 21 (`PBItemQuantity{amount, unit, rawQuantity}`), `packageSizePb` 24,
  `ingredients` 27.
- `PBItemQuantity`: `amount`, `unit`, `rawQuantity`. Display the item by
  `rawQuantity`, fall back to `amount unit`. There is no plain `quantity` field any more —
  sending one makes protobufjs throw.
- `PBIngredient`: `rawIngredient`, `name`, `quantity`, `note`, `isHeading` 7. The library's
  `Ingredient` wrapper drops `isHeading`, so read recipe ingredients from
  `any._userData.recipeDataResponse.recipes[].ingredients` to filter section headings.
- `PBCalendarEvent`: `identifier`, `calendarId`, `date` (`YYYY-MM-DD` string, stored as UTC
  midnight), `title`, `details`, `recipeId`, `labelId`, `recipeScaleFactor`.
- `ShoppingList`: `identifier`, `name`, `items[]`, `sharedUsers`.
- `PBUserDataResponse` branches used here: `shoppingListsResponse.newLists`,
  `listSettingsResponse.settings[0].userId`, `userCategoriesResponse.categories[]`
  (`identifier` + `systemCategory` slug), `recipeDataResponse.{recipes, recipeDataId}`,
  `mealPlanningCalendarResponse.{calendarId, events, labels}`.

`categorizedItemsResponse` (the server's name→category dictionary) is `null` on accounts that
have migrated to list categories — do not build categorization on it; that is why `categorize.js`
exists.

## Item categories

`categoryMatchId` stores the **system slug** (`produce`, `dairy`, …), not the category UUID.
Assigning it while creating an item persists correctly. Assigning it as an update to an existing
item through handler `set-list-item-category-match-id` instead *clears* the field, so categorize
only at add time.

## How writes are built

`Item#save()` emits one `PBListOperation` per changed field, each with
`handlerId` from `OP_MAPPING` (`set-list-item-name`, `...-quantity`, `...-details`, `...-checked`,
`...-category-match-id`, `set-list-item-sort-order`) and the value in `updatedValue` (booleans
encoded `y` / `n`). `List#addItem` / `removeItem` use `add-shopping-list-item` /
`remove-shopping-list-item`. Calendar events use `new-event`, `set-event-details`, `delete-event`.

To expose a new mutable item field, extend `OP_MAPPING` and the encode in the patch module — a
new operation name alone will not be applied server-side.

## Request economics

`data/user-data/get` is a full account download, and the vendor treats heavy use as abuse
(accounts get an "excessive downloading" email plus a temporary pause). Two rules keep the
client cheap:

- **Reads** come from `anylist-cache.js`: 15 min TTL, one blob per account on disk, a
  rolling-hour cap (`ANYLIST_MAX_SYNCS_PER_HOUR`, default 10) and a minimum gap between
  opportunistic syncs (`ANYLIST_MIN_SYNC_INTERVAL_MS`, default 45 s). Forced syncs (write
  verification, `--fresh`) bypass the gap but still count against the cap.
- **Writes** are batched: `addItems()` / `removeItems()` / `saveItems()` in
  `anylist-patch.js` pack N `PBListOperation`s into one POST, so adding a 13-ingredient
  recipe costs one write, not thirteen. The library's own `List#addItem` / `Item#save`
  remain the per-item fallback (`ANYLIST_BATCH_WRITES=0`).

## Verification pattern

Write, invalidate the sync cache, force a fresh read, then assert the field came back:

```js
await list.addItem(item);
syncCache.invalidate();
await any.getLists(true);           // forced sync, repopulates cache
```

This catches silent accepts — operations that return 200 but result in a cleared or unchanged
field.
