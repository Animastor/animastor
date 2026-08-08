# Default Image Prompt Profile

Default composition order — from general to specific. Used when no model-specific profile is configured for the selected image workflow.

Compose every image.prompt from general to specific:
1. WHO is in frame — each known character as ONE block: character_id + how they are arranged relative to each other (left/right, behind/in front, on what).
2. WHAT is happening in THIS unit — the action, gesture, emotion, or lighting shift.
3. Fine details at the end — textures, materials, small props, focus.

Never split a single character across different parts of the prompt: if a character needs detail, keep ALL their features together inside their block, ordered from the overall silhouette/build to face and hair, then clothes, then small distinguishing details.

Global context (style, epoch, country, location, time, season, lighting, mood) is added by the system BEFORE your prompt — do NOT repeat it here.
