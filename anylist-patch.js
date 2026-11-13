/**
 * Runtime patches for the vendored `anylist` package (codetheweb/anylist v0.8.5).
 *
 * Three things 0.8.5 gets wrong for grocery lists:
 *
 * 1. `Item#_encode()` passes a `quantity` property to the `ListItem` protobuf, but
 *    that field does not exist (it was replaced by `quantityPb` / PBItemQuantity,
 *    the string `quantity` is deprecated field 18). protobufjs v5 throws
 *    "ListItem#quantity is not a field", so ANY write that encodes an item fails.
 *    -> we re-implement `_encode` with the real schema.
 *
 * 2. On read, quantities live in `item.quantityPb.rawQuantity`, which the library
 *    never maps back onto `item.quantity`. -> `rawLists()` below reads the decoded
 *    protobuf directly so quantities/details/raw ingredients survive.
 *
 * 3. `List#addItem` / `List#removeItem` send ONE HTTP POST PER ITEM. AnyList
 *    treats heavy API traffic as abusive (they mail account owners about
 *    "excessive downloading" and pause access), so `addItems()` / `removeItems()`
 *    below pack N operations into a single `PBListOperationList` POST - the same
 *    way the official clients batch.
 *
 * This file must be required BEFORE constructing AnyList (it patches the prototype).
 */
const FormData = require('form-data');
const Item = require('anylist/lib/item');
const uuid = require('anylist/lib/uuid');

const WRITE_PATH = 'data/shopping-lists/update';
const STARTER_WRITE_PATH = 'data/starter-lists/update';
const BATCH_DISABLED = process.env.ANYLIST_BATCH_WRITES === '0';

const QUANTITY_RE = /^\s*([\d./\s\u00bc-\u00be]+)\s*(.*)$/;

function splitQuantity(quantity) {
  if (quantity === undefined || quantity === null || quantity === '') return null;
  const raw = String(quantity).trim();
  if (!raw) return null;
  const match = raw.match(QUANTITY_RE);
  if (!match) return { rawQuantity: raw };
  const amount = match[1].trim();
  const unit = match[2].trim();
  return {
    rawQuantity: raw,
    ...(amount ? { amount } : {}),
    ...(unit ? { unit } : {}),
  };
}

function quantityToString(item) {
  if (!item) return undefined;
  if (item.quantityPb && item.quantityPb.rawQuantity) return item.quantityPb.rawQuantity;
  if (item.quantityPb) {
    const { amount, unit } = item.quantityPb;
    const joined = [amount, unit].filter(Boolean).join(' ').trim();
    if (joined) return joined;
  }
  if (item.deprecatedQuantity) return item.deprecatedQuantity;
  return undefined;
}

// --- patch: encode items using the real ListItem schema ----------------------
Item.prototype._encode = function encode() {
  const pb = this._protobuf;
  const listItem = {
    identifier: this._identifier,
    listId: this._listId,
    name: this._name,
    details: this._details || undefined,
    checked: typeof this._checked === 'boolean' ? this._checked : undefined,
    userId: this._userId,
    categoryMatchId: this._categoryMatchId,
    manualSortIndex: typeof this._manualSortIndex === 'number' ? this._manualSortIndex : undefined,
  };

  const quantity = splitQuantity(this._quantity);
  if (quantity) listItem.quantityPb = new pb.PBItemQuantity(quantity);
  if (this._rawIngredient) listItem.rawIngredient = this._rawIngredient;
  if (this._recipeId) listItem.recipeId = this._recipeId;

  return new pb.ListItem(listItem);
};

// --- raw read helpers -------------------------------------------------------

/**
 * Normalized view of every shopping list, built from the decoded user-data blob
 * (so nothing is lost in the library's Item wrapper).
 */
function rawLists(any) {
  const response = any._userData && any._userData.shoppingListsResponse;
  if (!response || !response.newLists) return [];
  return response.newLists.map(list => ({
    id: list.identifier,
    name: list.name,
    items: (list.items || []).map(item => ({
      id: item.identifier,
      name: item.name,
      quantity: quantityToString(item),
      details: item.details || undefined,
      rawIngredient: item.rawIngredient || undefined,
      recipeId: item.recipeId || undefined,
      checked: item.checked === true,
      category: item.category || undefined,
      categoryMatchId: item.categoryMatchId || undefined,
    })),
  }));
}

/**
 * Shape an Item instance (library object used for writes) for JSON output.
 */
function itemSummary(item) {
  return {
    id: item.identifier,
    name: item.name,
    quantity: item.quantity || undefined,
    details: item.details || undefined,
    checked: item.checked === true,
    categoryMatchId: item.categoryMatchId,
  };
}

// --- batched writes ---------------------------------------------------------
// One HTTP POST carries N PBListOperation entries. Set ANYLIST_BATCH_WRITES=0 to
// fall back to the library's one-request-per-item behaviour.

function buildOperationList(list, handlerId, items) {
  const protobuf = list.protobuf;
  const ops = new protobuf.PBListOperationList();

  ops.setOperations(items.map(item => {
    const op = new protobuf.PBListOperation();
    op.setMetadata({
      operationId: uuid(),
      handlerId,
      userId: list.uid,
    });
    op.setListId(list.identifier);
    op.setListItemId(item.identifier);
    op.setListItem(item._encode());
    return op;
  }));

  return ops;
}

async function postOperations(list, ops, isFavorite) {
  const form = new FormData();
  form.append('operations', ops.toBuffer());
  await list.client.post(isFavorite ? STARTER_WRITE_PATH : WRITE_PATH, { body: form });
}

/**
 * Add many items to a list with a single request.
 * @param {object} list library List instance
 * @param {object[]} items Item instances (already encoded-cleared)
 * @return {Promise<object[]>} the same items
 */
async function addItems(list, items, { isFavorite = false } = {}) {
  if (!items.length) return [];
  for (const item of items) item.listId = list.identifier;

  if (BATCH_DISABLED) {
    for (const item of items) await list.addItem(item, isFavorite);
    return items;
  }

  await postOperations(list, buildOperationList(list, 'add-shopping-list-item', items), isFavorite);
  list.items.push(...items);
  return items;
}

/**
 * Remove many items from a list with a single request.
 */
async function removeItems(list, items, { isFavorite = false } = {}) {
  if (!items.length) return [];

  if (BATCH_DISABLED) {
    for (const item of items) await list.removeItem(item, isFavorite);
    return items;
  }

  await postOperations(list, buildOperationList(list, 'remove-shopping-list-item', items), isFavorite);
  const ids = new Set(items.map(i => i.identifier));
  list.items = list.items.filter(i => !ids.has(i.identifier));
  return items;
}

// --- batched field updates ---------------------------------------------------
// Item#save() posts one PBListOperation per changed field, per item. Updates to
// already-present items (uncheck, new quantity, new note) are the common case when
// a recipe is pushed twice, so they are packed into one POST too.
const UPDATE_HANDLERS = {
  name: 'set-list-item-name',
  quantity: 'set-list-item-quantity',
  details: 'set-list-item-details',
  checked: 'set-list-item-checked',
  categoryMatchId: 'set-list-item-category-match-id',
  manualSortIndex: 'set-list-item-sort-order',
};

/**
 * Save field changes for several items in one request.
 * @param {object} list library List instance
 * @param {object[]} updates [{ item, fields: [{ field, value }] }]
 */
async function saveItems(list, updates, { isFavorite = false } = {}) {
  const ops = [];
  const protobuf = list.protobuf;

  for (const update of updates) {
    for (const change of update.fields) {
      const handlerId = UPDATE_HANDLERS[change.field];
      if (!handlerId) throw new Error(`No update handler for field "${change.field}"`);

      const op = new protobuf.PBListOperation();
      op.setMetadata({ operationId: uuid(), handlerId, userId: list.uid });
      op.setListId(list.identifier);
      op.setListItemId(update.item.identifier);
      op.setUpdatedValue(typeof change.value === 'boolean' ? (change.value ? 'y' : 'n') : String(change.value));
      ops.push(op);
    }
  }

  if (!ops.length) return 0;

  if (BATCH_DISABLED) {
    for (const update of updates) {
      const item = update.item;
      for (const change of update.fields) item[change.field] = change.value;
      await item.save(isFavorite);
    }
    return updates.length;
  }

  const protobufOps = new protobuf.PBListOperationList();
  protobufOps.setOperations(ops);
  await postOperations(list, protobufOps, isFavorite);
  return ops.length;
}

module.exports = {
  rawLists,
  itemSummary,
  splitQuantity,
  quantityToString,
  addItems,
  removeItems,
  saveItems,
  buildOperationList,
};
