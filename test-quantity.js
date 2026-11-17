#!/usr/bin/env node
'use strict';
/**
 * Reading amounts off shopping-list items.
 *
 * An item added from a recipe (meal plan -> grocery list) carries its amount on
 * the linked ingredient, not on the ListItem: `quantityPb` at the top level is
 * null, `ingredients[0].quantityPb.rawQuantity` holds "2 lb", and the app renders
 * "Italian Sausage (2 lb)". Reading only the top level silently turned "2 lb" into
 * "one package" — the bug this test pins down.
 *
 * No network, no credentials: the fixtures are the decoded protobuf shapes.
 */
const assert = require('assert');
const { quantityToString, noteToString } = require('./anylist-patch');

// recipe-linked item: quantity lives on the ingredient
const fromRecipe = {
  name: 'Italian Sausage',
  quantityPb: null,
  deprecatedQuantity: null,
  ingredients: [{
    ingredient: {
      name: 'Italian Sausage',
      quantity: '2 lb',
      rawIngredient: '2 lb Italian Sausage, sweet, hot or a mix, sliced into 1/2 inch pieces',
      note: 'sweet, hot or a mix, sliced into 1/2 inch pieces',
    },
    quantityPb: { amount: '2', unit: 'lb', rawQuantity: '2 lb' },
  }],
};

// hand-entered item: the quantity is on the item itself
const handEntered = { name: 'Milk', quantityPb: { amount: '1', unit: 'gal', rawQuantity: '1 gal' } };

// amount plus unit split across fields, no rawQuantity
const splitFields = { name: 'Parmesan', quantityPb: { amount: '1/2 - 1', unit: 'cup' } };

// nothing anywhere
const bare = { name: 'Bananas', quantityPb: null };

// recipe-linked but the ingredient only carries the plain quantity string
const noQpb = {
  name: 'Chicken Broth',
  quantityPb: null,
  ingredients: [{ ingredient: { name: 'Chicken Broth', quantity: '1 1/2 cups' }, quantityPb: null }],
};

const cases = [
  ['recipe-linked quantity', quantityToString(fromRecipe), '2 lb'],
  ['hand-entered quantity', quantityToString(handEntered), '1 gal'],
  ['amount/unit fields', quantityToString(splitFields), '1/2 - 1 cup'],
  ['no quantity at all', quantityToString(bare), undefined],
  ['ingredient string only', quantityToString(noQpb), '1 1/2 cups'],
  ['prep note', noteToString(fromRecipe), 'sweet, hot or a mix, sliced into 1/2 inch pieces'],
  ['no note', noteToString(bare), undefined],
];

let failed = 0;
for (const [name, got, want] of cases) {
  try {
    assert.strictEqual(got, want);
    console.log(`ok    ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

if (failed) {
  console.error(`\n${failed} quantity check(s) failed`);
  process.exit(1);
}
console.log('\nall quantity checks passed');
