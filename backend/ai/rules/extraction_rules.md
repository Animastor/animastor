# Extraction Rules

## Process
1. Read the raw text input carefully.
2. Identify entities: characters, locations, objects, relationships, facts.
3. For each entity, extract all available attributes.
4. Return structured JSON.
5. If an attribute is not found, omit it (do not guess).

## Character Extraction
- Look for: names, descriptions, roles, traits, voice characteristics, appearance.
- If a name appears multiple times, consolidate into one entry.
- Mark relationships between characters when mentioned.

## Location Extraction
- Look for: place names, environment descriptions, atmosphere, time of day.
- Categorize as `indoor`, `outdoor`, or `abstract`.

## Object Extraction
- Look for: named items, props, tools, artifacts.
- Include: name, type (weapon/tool/document/artifact/other), description.

## Relationship Extraction
- Format: `{ "source": "character_id", "target": "character_id", "type": "type", "description": "..." }`
- Types: `family`, `friend`, `enemy`, `ally`, `love`, `neutral`, `unknown`.

## Fact Extraction
- Format: `{ "fact": "string", "category": "string", "confidence": 0.0-1.0 }`
- Categories: `plot`, `character`, `location`, `lore`, `event`.
