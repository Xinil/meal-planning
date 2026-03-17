const AnyList = require('anylist');
const dayjs = require('dayjs');

// USAGE: 
//   node meals.js history
//   node meals.js upcoming
//   node meals.js candidates
//   node meals.js add "2026-02-12" "Broccoli Cheddar Risotto"

const action = process.argv[2] || 'upcoming';
const EMAIL = process.env.ANYLIST_EMAIL;
const PASSWORD = process.env.ANYLIST_PASSWORD;

if (!EMAIL || !PASSWORD) { console.error("Missing Credentials"); process.exit(1); }
const any = new AnyList({ email: EMAIL, password: PASSWORD });

async function main() {
  await any.login();
  // Load massive metadata blob (needed for IDs and settings)
  await any.getRecipes();

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
    const events = await any.getMealPlanningCalendarEvents();
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
        date: dayjs(item.date).format('YYYY-MM-DD'), 
        display: dayjs(item.date).format('ddd, MMM D'),
        meal: name 
      };
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  // --- COMMAND: HISTORY ---
  if (action === 'history') {
    const start = dayjs().subtract(14, 'day').startOf('day');
    const end = dayjs().endOf('day');
    console.log(`History (${start.format('MMM D')} - Today):`);
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
    const start = dayjs().subtract(1, 'day');
    const end = dayjs().add(10, 'day');
    const plans = await getEvents(start, end);
    console.log(JSON.stringify(plans, null, 2));
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
  }

  any.teardown();
}

main().catch(err => { console.error(err); any.teardown(); });