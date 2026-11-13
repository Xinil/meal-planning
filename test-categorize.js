// Offline sanity test for the category rules: node test-categorize.js
const { assign } = require('./categorize');

const cases = [
  ['Pepper', 'condiments-oils-and-salad-dressings'],
  ['Black Pepper', 'condiments-oils-and-salad-dressings'],
  ['Bell Pepper', 'produce'],
  ['Red Pepper', 'produce'],
  ['Red Pepper Flakes', 'cooking-and-baking'],
  ['Chicken Stock', 'soups-and-canned-goods'],
  ['Vegetable Broth', 'soups-and-canned-goods'],
  ['Chicken Breast', 'meat'],
  ['Ground Beef', 'meat'],
  ['Frozen Peas', 'frozen-foods'],
  ['Frozen Shrimp', 'frozen-foods'],
  ['Garlic Cloves', 'produce'],
  ['Yellow Onion', 'produce'],
  ['Heavy Cream', 'dairy'],
  ['Sour Cream', 'dairy'],
  ['Parmesan', 'dairy'],
  ['Arborio Rice', 'grains-pasta-and-side-dishes'],
  ['Spaghetti', 'grains-pasta-and-side-dishes'],
  ['Diced Tomatoes', 'soups-and-canned-goods'],
  ['Coconut Milk', 'soups-and-canned-goods'],
  ['Olive Oil', 'condiments-oils-and-salad-dressings'],
  ['Nutmeg', 'cooking-and-baking'],
  ['All-Purpose Flour', 'cooking-and-baking'],
  ['Brown Sugar', 'cooking-and-baking'],
  ['Sourdough Bread', 'bakery'],
  ['White Wine', 'wine-beer-spirits'],
  ['Orange Juice', 'beverages'],
  ['Paper Towels', 'household-and-cleaning'],
  ['Dog Food', 'pet-supplies'],
  ['Tortilla Chips', 'snacks-cookies-and-candy'],
  ['Salmon Fillet', 'seafood'],
  ['Cat Litter', 'pet-supplies'],
  ['Mystery Item', 'other'],
];

let failures = 0;
for (const [name, expected] of cases) {
  const actual = assign(name);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(28)} -> ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exitCode = failures ? 1 : 0;
