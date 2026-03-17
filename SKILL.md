# AnyList Meal Manager

A comprehensive agent for managing the user's weekly meal plan. It can read history, suggest high-rated recipes, and write directly to the calendar.

## Tools

### Get Recent History
Retrieves meals eaten in the last 14 days.
- **Command**: `node meals.js history`
- **Description**: Use this FIRST to see what the user recently ate, to avoid suggesting repeats.

### Get Recipe Suggestions
Fetches a list of highly-rated recipes from the user's cookbook.
- **Command**: `node meals.js candidates`
- **Description**: Returns 30 random high-quality recipes. Use this to generate options for the meal plan.

### Get Upcoming Plan
Checks the calendar for the next 10 days.
- **Command**: `node meals.js upcoming`
- **Description**: Use this to see what is already planned or to confirm a successful add.

### Add Meal to Plan
Adds a specific recipe or text item to a specific date on the meal plan.
- **Command**: `node meals.js add "{{date}}" "{{meal_name}}"`
- **Arguments**:
  - `date`: Format YYYY-MM-DD (e.g., "2026-02-12")
  - `meal_name`: The name of the recipe (fuzzy matched) or text to add.
- **Description**: Use this to finalize the plan.