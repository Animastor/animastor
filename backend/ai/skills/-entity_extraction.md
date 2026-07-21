# Entity Extraction

## Overview
Extract structured data from natural language text. The goal is to identify all meaningful entities and their relationships.

## Extraction Pipeline
1. **Tokenize** the text into sentences and clauses.
2. **Identify named entities**: proper names, places, objects.
3. **Classify** each entity by type.
4. **Extract attributes** for each entity from surrounding context.
5. **Link** entities through relationships.
6. **Output** as structured JSON.

## Entity Types

### Characters
- Trigger words: who, someone, person, man, woman, child, name patterns.
- Attributes: name, role, gender (if stated), age (if stated), description, traits, voice.

### Locations
- Trigger words: where, place, room, forest, city, building, house.
- Attributes: name, type (indoor/outdoor/abstract), description, mood, time_of_day.

### Objects
- Trigger words: what, thing, item, tool, weapon, document.
- Attributes: name, type, description.

### Relationships
- Between two characters or a character and an object.
- Types: family, friend, enemy, ally, love, neutral, ownership.

### Facts
- Standalone assertions about the world, plot, or characters.
- Categorized as: plot, character, location, lore, event.

## Quality Guidelines
- Only extract what is explicitly stated or clearly implied.
- Do not invent attributes.
- When in doubt, mark confidence as < 1.0.
- Preserve the original text wording for names when possible.
