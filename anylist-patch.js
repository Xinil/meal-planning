/**
 * Runtime patches for the vendored `anylist` package (codetheweb/anylist v0.8.5).
 *
 * Two bugs in 0.8.5 matter for grocery lists:
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
 * This file must be required BEFORE constructing AnyList (it patches the prototype).
 */
const Item = require('anylist/lib/item');

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

module.exports = { rawLists, itemSummary, splitQuantity, quantityToString };
