const AnyList = require('anylist');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const { installSyncCache, describeError } = require('./anylist-cache');
dayjs.extend(utc);

// USAGE: 
//   node meals.js history
//   node meals.js upcoming
//   node meals.js candidates
//   node meals.js add "2026-02-12" "Broccoli Cheddar Risotto"
//   node meals.js ingredients "Broccoli Cheddar Risotto"   (JSON: recipe ingredient list)
//   node meals.js recipes [--missing]                       (cookbook index w/ ingredient counts)

const action = process.argv[2] || 'upcoming';
const EMAIL = process.env.ANYLIST_EMAIL;
const PASSWORD = process.env.ANYLIST_PASSWORD;

if (!EMAIL || !PASSWORD) { console.error("Missing Credentials"); process.exit(1); }
const any = new AnyList({ email: EMAIL, password: PASSWORD });
let syncCache = null;

async function main() {
  await any.login(false); // no websocket: one-shot CLI
  syncCache = installSyncCache(any, { ttlMs: Number(process.env.ANYLIST_CACHE_TTL_MS || 300000) });
  // Load massive metadata blob (needed for IDs and settings); served from the disk
  // cache when fresh so back-to-back commands don't trip the sync rate limit.
  await any.getRecipes(false);

  // --- CRITICAL PATCH: INJECT USER ID ---
  // The library fails to set this automatically, so we find it and inject it.
  let userId = null;
  try {
    const settings = any._userData.listSettingsResponse.settings;
    if (settings && settings.length > 0) userId = settings[0].userId;
  } catch (e) {}

  if (!userId) {
    console.error("❌ Error: Could not auto-detect User ID. Write operations will fail.");
    process.exit(1);
  }
  any.uid = userId; // <--- The Magic Line

  // --- HELPER: Fetch & Format Events ---
  async function getEvents(startDate, endDate) {
    const events = await any.getMealPlanningCalendarEvents(false); // reuse cached blob when fresh
    return events.filter(item => {
      if (!item.date) return false;
      const d = dayjs(item.date);
      return d.isAfter(startDate) && d.isBefore(endDate);
    }).map(item => {
      let name = item.title || "Unknown";
      if (item.recipeId) {
        const r = any.recipes.find(x => x.identifier === item.recipeId);
        if (r) name = r.name;
      }
      return { 
        date: dayjs.utc(item.date).format('YYYY-MM-DD'), 
        display: dayjs.utc(item.date).format('ddd, MMM D'),
        meal: name 
      };
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // --- COMMAND: HISTORY ---
  if (action === 'history') {
    const start = dayjs().subtract(60, 'day').startOf('day');
    const end = dayjs().endOf('day');
    const history = await getEvents(start, end);
    console.log(JSON.stringify(history, null, 2));
  }

  // --- COMMAND: CANDIDATES ---
  else if (action === 'candidates') {
    // Return high-rated recipes (4+ stars) or unrated ones
    const candidates = any.recipes
      .filter(r => (r.rating === undefined || r.rating >= 4)) 
      .map(r => ({ name: r.name, rating: r.rating || "Unrated" }));
    
    // Shuffle and pick 30 random options
    const shuffled = candidates.sort(() => 0.5 - Math.random()).slice(0, 30);
    console.log(JSON.stringify(shuffled, null, 2));
  }

  // --- COMMAND: UPCOMING ---
  else if (action === 'upcoming') {
    const daysIdx = process.argv.indexOf('--days');
    const days = daysIdx > -1 && process.argv[daysIdx + 1] ? Number(process.argv[daysIdx + 1]) : 10;
    const start = dayjs().subtract(1, 'day');
    const end = dayjs().add(Number.isFinite(days) ? days : 10, 'day');
    const plans = await getEvents(start, end);
    console.log(JSON.stringify(plans, null, 2));
  }

  // --- COMMAND: INGREDIENTS (recipe -> grocery items) ---
  else if (action === 'ingredients') {
    const query = process.argv.slice(3).join(' ').trim().toLowerCase();
    if (!query) {
      console.error('Usage: node meals.js ingredients "<recipe name>"');
      process.exit(1);
    }

    const recipe = any.recipes.find(r => r.name.toLowerCase() === query)
      || any.recipes.find(r => r.name.toLowerCase().includes(query));
    if (!recipe) {
      const near = any.recipes.filter(r => r.name.toLowerCase().includes(query.split(' ')[0])).slice(0, 10).map(r => r.name);
      console.error(JSON.stringify({ ok: false, error: `No recipe matching "${query}"`, suggestions: near }));
      process.exit(1);
    }

    // Read the raw decoded recipe: the library's Ingredient wrapper drops `isHeading`,
    // and section headings ("For the sauce") must not become grocery items.
    const rawRecipes = any._userData.recipeDataResponse.recipes || [];
    const raw = rawRecipes.find(r => r.identifier === recipe.identifier);
    const rawIngredients = raw && raw.ingredients ? raw.ingredients : [];

    const items = rawIngredients
      .filter(i => !i.isHeading && (i.name || i.rawIngredient))
      .map(i => ({
        name: i.name || i.rawIngredient,
        quantity: (i.quantity || i.rawIngredient || '').trim() || undefined,
        details: i.note ? i.note.trim() || undefined : undefined,
        raw: i.rawIngredient,
      }));

    // --skip-pantry drops staples you almost certainly already have, so a recipe
    // push doesn't litter the list with salt/pepper/oil.
    const PANTRY = /^(salt|kosher salt|sea salt|pepper|black pepper|white pepper|water|ice|olive oil|vegetable oil|canola oil|cooking spray|flour|all-purpose flour|sugar|granulated sugar|butter|unsalted butter|salted butter)$/i;
    const filtered = process.argv.includes('--skip-pantry')
      ? items.filter(i => !PANTRY.test(String(i.name).trim()))
      : items;

    console.log(JSON.stringify({
      ok: true,
      recipe: recipe.name,
      recipeId: recipe.identifier,
      servings: recipe.servings || undefined,
      count: filtered.length,
      skippedPantry: items.length - filtered.length,
      items: filtered,
    }, null, 2));
  }

  // --- COMMAND: RECIPES (cookbook index) ---
  else if (action === 'recipes') {
    const missingOnly = process.argv.includes('--missing');
    const list = any.recipes
      .map(r => ({
        name: r.name,
        rating: r.rating || null,
        servings: r.servings || null,
        ingredientCount: (r.ingredients || []).length,
      }))
      .filter(r => (missingOnly ? r.ingredientCount === 0 : true))
      .sort((a, b) => a.name.localeCompare(b.name));
    console.log(JSON.stringify({ ok: true, count: list.length, recipes: list }, null, 2));
  }

  // --- COMMAND: DELETE (remove a meal from the plan) ---
  else if (action === 'delete') {
    const dateStr = process.argv[3];
    const searchName = process.argv.slice(4).join(" ").trim();
    if (!dateStr) {
      console.error('Usage: node meals.js delete <YYYY-MM-DD> [meal name]');
      process.exit(1);
    }

    const events = await any.getMealPlanningCalendarEvents();
    const sameDay = events.filter(e => e.date && dayjs.utc(e.date).format('YYYY-MM-DD') === dateStr);
    const matches = searchName
      ? sameDay.filter(e => {
        const name = e.recipeId
          ? (any.recipes.find(r => r.identifier === e.recipeId) || {}).name || ''
          : e.title || '';
        return name.toLowerCase().includes(searchName.toLowerCase());
      })
      : sameDay;

    if (!matches.length) {
      console.error(JSON.stringify({ ok: false, error: `No matching meal on ${dateStr}` }));
      process.exit(1);
    }

    const deleted = [];
    for (const event of matches) {
      const name = event.recipeId
        ? (any.recipes.find(r => r.identifier === event.recipeId) || {}).name || event.title
        : event.title;
      await event.delete();
      deleted.push({ name, id: event.identifier });
    }

    if (syncCache) syncCache.invalidate();
    console.log(JSON.stringify({ ok: true, date: dateStr, deletedCount: deleted.length, deleted }, null, 2));
  }

  // --- COMMAND: ADD ---
  else if (action === 'add') {
    const dateStr = process.argv[3];
    const searchName = process.argv.slice(4).join(" ");

    if (!dateStr || !searchName) {
      console.error("Usage: node meals.js add <YYYY-MM-DD> <Recipe Name>");
      process.exit(1);
    }

    const targetDate = dayjs(dateStr).startOf('day').toDate();
    const recipe = any.recipes.find(r => r.name.toLowerCase().includes(searchName.toLowerCase()));

    if (recipe) {
      console.log(`Found recipe: "${recipe.name}"`);
      // Create Event using Native Library (Patched)
      const event = await any.createEvent({
        date: targetDate,
        recipeId: recipe.identifier,
        allDay: true
      });
      await event.save();
      console.log(`✅ Successfully added "${recipe.name}" to ${dateStr}`);
    } else {
      console.log(`Recipe not found. Adding text item: "${searchName}"`);
      const event = await any.createEvent({
        date: targetDate,
        title: searchName,
        allDay: true
      });
      await event.save();
      console.log(`✅ Successfully added text note to ${dateStr}`);
    }

    if (syncCache) syncCache.invalidate(); // next read should see the new event
  }

  any.teardown();
}

main().catch(err => { console.error(JSON.stringify(describeError(err))); any.teardown(); });