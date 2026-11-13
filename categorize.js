/**
 * Best-effort grocery category assignment for new AnyList items.
 *
 * AnyList stores an item's category as `categoryMatchId`, which for the built-in
 * categories is the system slug (e.g. "produce", "dairy"). The official apps
 * categorize locally from a bundled dictionary; this is a compact equivalent so
 * recipe ingredients don't all pile up in "Other" when pushed to a list.
 *
 * Rules are checked in order — put specific phrases before generic ones.
 * `assign(name, availableSlugs)` returns a slug that exists on the account, or
 * "other" when nothing matches.
 */

const RULES = [
  // --- overrides that must beat the generic produce/meat/dairy/bakery patterns --
  ['cooking-and-baking', /\b(chocolate chips?|butterscotch chips?|white chocolate chips?|red pepper flakes?|crushed red pepper|chili flakes?|cayenne)\b/],
  ['condiments-oils-and-salad-dressings', /(?<!bell )(?<!red )(?<!green )(?<!yellow )(?<!orange )(?<!jalape(?:n|ñ)o )(?<!serrano )(?<!poblano )(?<!banana )(?<!chili )(?<!chipotle )(?<!anaheim )(?<!habanero )(?<!sweet )(?<!roasted )(?<!stuffed )(?<!creamed )\b(black pepper|white pepper|ground pepper|peppercorns?|pepper)\b/],
  ['soups-and-canned-goods', /\b((chicken|beef|vegetable|veggie|bone|fish|turkey|mushroom)\s+(stock|broth)|bouillon|stock)\b/],
  ['soups-and-canned-goods', /\b((diced|crushed|stewed|whole peeled|fire[- ]roasted|sun[- ]dried)\s+tomatoes?|tomato (sauce|paste|puree)|marinara|pasta sauce|pizza sauce)\b/],
  ['soups-and-canned-goods', /\bcoconut milk\b/],
  ['beverages', /\b(juice|orange juice|apple juice|cranberry juice|lemonade)\b/],
  ['snacks-cookies-and-candy', /\b(tortilla chips|potato chips|chips|pretzels|crackers)\b/],

  // --- frozen (before produce/meat: "frozen peas", "frozen shrimp") ----------
  ['frozen-foods', /\b(frozen|ice cream|ice pops?|popsicles?|frozen pizza|waffles|tater tots)\b/],

  // --- produce ---------------------------------------------------------------
  ['produce', /\b(apple|apples|avocado|avocados|banana|bananas|berries|blackberr(y|ies)|blueberr(y|ies)|raspberr(y|ies)|strawberr(y|ies)|cranberr(y|ies)|cherr(y|ies)|lemon|lemons|lime|limes|orange|oranges|grapefruit|peach|peaches|pear|pears|plum|plums|mango|mangoes|pineapple|melon|watermelon|cantaloupe|kiwi|grapes?|pomegranate|fig|figs|dates?|raisins?)\b/],
  ['produce', /\b(onions?|red onion|shallots?|garlic( cloves?)?|scallions?|green onions?|leeks?|chives?|potato(es)?|sweet potato(es)?|yams?|carrots?|celery|celeriac|cucumbers?|pickling cucumber|tomato(es)?|cherry tomatoes?|roma tomatoes?|peppers?|bell peppers?|jalape(n|ñ)o|serrano|poblano|anaheim|habanero|chili peppers?|mushrooms?|cremini|portobello|shiitake|spinach|kale|lettuce|romaine|arugula|chard|collard|bok choy|cabbage|red cabbage|napa cabbage|broccoli|cauliflower|brussels sprouts?|asparagus|zucchini|squash|butternut|acorn squash|spaghetti squash|pumpkin|eggplant|beets?|radish(es)?|turnip|parsnip|fennel|artichoke|okra|green beans?|string beans?|snap peas?|snow peas?|peas|edamame|corn|corn on the cob|ginger|turmeric root|horseradish|fresh herbs?|basil|cilantro|parsley|dill|mint|rosemary|thyme|sage|tarragon|oregano|lemongrass|sprouts?|bean sprouts?|watercress|endive|radicchio|water chestnuts?|bamboo shoots?)\b/],

  // --- meat / seafood --------------------------------------------------------
  ['seafood', /\b(salmon|tuna|halibut|cod|tilapia|trout|mahi|snapper|catfish|bass|sardines?|anchov(y|ies)|shrimp|prawns?|scallops?|crab|lobster|clams?|mussels?|oysters?|squid|calamari|octopus|fish (fillets?|sauce|stock)|seafood)\b/],
  ['meat', /\b(chicken|chicken breasts?|chicken thighs?|ground (beef|turkey|chicken|pork|lamb)|beef|steak|sirloin|ribeye|brisket|chuck roast|pork|pork chops?|tenderloin|bacon|pancetta|sausage|sausages|chorizo|italian sausage|bratwurst|hot dogs?|ham|prosciutto|salami|pepperoni|turkey|lamb|veal|duck|meatballs?|ribs|roast)\b/],

  // --- dairy / deli ----------------------------------------------------------
  ['dairy', /\b(milk|whole milk|skim milk|2% milk|buttermilk|cream|heavy cream|heavy whipping cream|half and half|sour cream|cream cheese|yogurt|greek yogurt|butter|unsalted butter|salted butter|margarine|eggs?|egg whites?|egg yolks?|cheese|cheddar|mozzarella|parmesan|parmigiano|pecorino|gruyere|swiss|provolone|monterey jack|pepper jack|feta|goat cheese|blue cheese|brie|ricotta|cottage cheese|mascarpone|queso|cream fraiche|crème fraîche|kefir|whipped cream|condensed milk|evaporated milk)\b/],
  ['deli', /\b(deli|sliced (turkey|ham|roast beef)|rotisserie chicken|prepared salad|coleslaw|hummus|olives|pickles)\b/],

  // --- bakery ----------------------------------------------------------------
  ['bakery', /\b(bread|baguette|rolls?|dinner rolls?|buns?|hamburger buns?|hot dog buns?|tortillas?|pita|naan|bagels?|english muffins?|croissants?|pastr(y|ies)|donuts?|cake|cookies|muffins?|pie crust|pie shell|sourdough|brioche|focaccia|ciabatta)\b/],

  // --- grains, pasta & sides -------------------------------------------------
  ['grains-pasta-and-side-dishes', /\b(rice|white rice|brown rice|jasmine rice|basmati|arborio|risotto rice|quinoa|farro|barley|couscous|bulgur|oats?|rolled oats|pasta|spaghetti|penne|rigatoni|fusilli|linguine|fettuccine|macaroni|rotini|orzo|noodles?|ramen|udon|soba|lasagna|tortellini|ravioli|gnocchi|polenta|cornmeal|grits|potatoes boxed|stuffing|breadcrumbs|panko|crackers?|croutons|taco shells?|wonton wrappers?|egg roll wrappers?|phyllo|filo)\b/],

  // --- soups & canned goods --------------------------------------------------
  ['soups-and-canned-goods', /\b(canned|can of|broth|stock|bouillon|soup|tomato sauce|pasta sauce|marinara|pizza sauce|salsa|diced tomatoes|crushed tomatoes|tomato paste|sun-dried tomatoes|beans?|black beans?|kidney beans?|pinto beans?|cannellini|chickpeas|garbanzo|lentils?|split peas|coconut milk|canned tuna|canned salmon|tuna (can|packet)|applesauce|pumpkin puree|pumpkin pie filling|jam|jelly|preserves|peanut butter|almond butter|nutella|tahini|honey|maple syrup)\b/],

  // --- condiments & dressings ------------------------------------------------
  ['condiments-oils-and-salad-dressings', /\b(oil|olive oil|vegetable oil|canola oil|sesame oil|coconut oil|avocado oil|cooking spray|vinegar|balsamic|rice vinegar|apple cider vinegar|white vinegar|red wine vinegar|dressing|mayo|mayonnaise|ketchup|mustard|dijon|yellow mustard|horseradish sauce|hot sauce|sriracha|soy sauce|tamari|fish sauce|worcestershire|bbq sauce|barbecue sauce|teriyaki|ranch|relish|salt|pepper|kosher salt|sea salt|black pepper|peppercorns)\b/],

  // --- cooking & baking (spices, leaveners, flours, sugars) ------------------
  ['cooking-and-baking', /\b(flour|all-purpose flour|bread flour|almond flour|cornstarch|corn starch|baking (soda|powder)|yeast|sugar|granulated sugar|brown sugar|powdered sugar|confectioners|vanilla|vanilla extract|cocoa|cocoa powder|chocolate chips?|baking chocolate|shortening|gelatin|food coloring|spices?|paprika|smoked paprika|cumin|chili powder|coriander|cinnamon|nutmeg|cloves|allspice|cardamom|curry powder|garam masala|cayenne|crushed red pepper|red pepper flakes|turmeric|saffron|bay leaves?|dried (oregano|basil|thyme|parsley|dill|rosemary|sage|cilantro|ginger|onion|chives)|onion powder|garlic powder|italian seasoning|taco seasoning|ranch seasoning|seasoning|extract|almonds|walnuts|pecans|cashews|pistachios|nuts|peanuts|seeds|sesame seeds|chia seeds|flax|flaxseed|sunflower seeds|pumpkin seeds|shredded coconut|desiccated coconut)\b/],

  // --- breakfast & cereal ----------------------------------------------------
  ['breakfast-and-cereal', /\b(cereal|oatmeal packets?|granola|granola bars?|pancake mix|waffle mix|syrup|instant breakfast)\b/],

  // --- snacks ----------------------------------------------------------------
  ['snacks-cookies-and-candy', /\b(chips|tortilla chips|potato chips|pretzels|popcorn|candy|chocolate bar|gum|cookies|graham crackers?|fruit snacks|granola bites|trail mix|rice cakes|crackers)\b/],

  // --- beverages / alcohol ---------------------------------------------------
  ['wine-beer-spirits', /\b(wine|red wine|white wine|rose|champagne|prosecco|beer|ipa|lager|ale|stout|vodka|gin|rum|tequila|whiskey|whisky|bourbon|scotch|brandy|cognac|liqueur|vermouth|sake|hard seltzer)\b/],
  ['beverages', /\b(water|sparkling water|soda|cola|seltzer|juice|orange juice|lemonade|iced tea|tea|coffee|coffee beans?|ground coffee|espresso|k-cups?|energy drink|sports drink|gatorade|coconut water|milk alternative|almond milk|oat milk|soy milk|cashew milk)\b/],

  // --- household / personal / pet / baby -------------------------------------
  ['household-and-cleaning', /\b(paper towels?|toilet paper|napkins|dish soap|dishwasher|sponges?|laundry detergent|detergent|bleach|cleaner|cleaning|trash bags?|garbage bags?|foil|aluminum foil|plastic wrap|parchment paper|ziploc|storage bags?|light bulbs?|batteries|tissues)\b/],
  ['health-and-personal-care', /\b(shampoo|conditioner|soap|body wash|toothpaste|toothbrush|deodorant|lotion|sunscreen|razors?|shaving|vitamins?|ibuprofen|tylenol|aspirin|band-?aids?|first aid|floss|mouthwash|feminine|diapers?|wipes)\b/],
  ['pet-supplies', /\b(dog food|cat food|dog treats?|cat treats?|litter|cat litter|pet food|kibble|dog|cat)\b/],
  ['baby', /\b(baby food|formula|diapers|baby wipes|pacifier|bottle liner)\b/],
];

const VALID = new Set([
  'baby', 'bakery', 'beverages', 'breakfast-and-cereal', 'condiments-oils-and-salad-dressings',
  'cooking-and-baking', 'dairy', 'deli', 'frozen-foods', 'grains-pasta-and-side-dishes',
  'health-and-personal-care', 'household-and-cleaning', 'meat', 'pet-supplies', 'produce',
  'seafood', 'snacks-cookies-and-candy', 'soups-and-canned-goods', 'wine-beer-spirits', 'other',
]);

/**
 * @param {string} name item name
 * @param {string[]} [available] slugs that exist on the account (from userCategoriesResponse)
 * @returns {string} category slug
 */
function assign(name, available) {
  const text = String(name || '').toLowerCase();
  if (!text) return 'other';
  const allowed = available && available.length ? new Set(available) : VALID;
  for (const [slug, re] of RULES) {
    if (re.test(text) && allowed.has(slug)) return slug;
  }
  return 'other';
}

module.exports = { assign, RULES };
