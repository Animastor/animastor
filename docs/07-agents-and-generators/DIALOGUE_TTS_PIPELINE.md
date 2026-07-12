# Dialogue TTS Pipeline — TODO

## Цель

Автоматическая генерация многоголосой озвучки диалогов через TTS.  
Сейчас все сцены (`narration` и `dialogue`) озвучиваются одним голосом диктора (`voice: 'narrator'`).  
Нужно: диалоговые сцены получают скриптовый `full_text` вида `"speaker: реплика"` и маршрутятся в dialogue TTS workflow (многоголосый Qwen3).

## Архитектура

```
AI pipeline → units[{ type: 'dialogue', speaker, text }]
                           ↓
                    create.js
                  /           \
     narration scene          dialogue scene
      voice='narrator'         voice='dialogue'
      full_text=sceneText      full_text=buildScript(units)
                                           ↓
                              buildSegments() → парсит "speaker: текст"
                                           ↓
                              tts-qwen-dialogue workflow
                              (RoleBank + AdvancedDialogue Engine)
```

## Изменения

### 1. `SYSTEM_PROMPTS.units` (`agent-prompts.js`)
Добавить поле `speaker` в формат dialogue-юнитов.

**Текущий формат:**
```
{ "text": "...", "type": "dialogue" }
```

**Новый формат:**
```
{ "text": "...", "type": "dialogue", "speaker": "berlioz" }
```

Промпт: добавить описание поля `speaker` и правило — для dialogue-юнита обязательно указывать character_id говорящего.

### 2. `stepCreateUnits()` (`pipeline-steps.js`)
AI уже возвращает `result.units` с полями. Нужно убедиться, что поле `speaker` не теряется при сохранении.  
Текущий код сохраняет `{ text, type }` — добавить `speaker` в destructuring.

### 3. `create.js` (`backend/src/book/lazy-book/create.js`)
При создании сцены:
- Если `isDialogue` (обнаружен dialogue-юнит) → собрать `audio.full_text` как скрипт:
  ```js
  const scriptLines = cleanUnits
    .filter(u => u.type === 'dialogue' && u.speaker)
    .map(u => `${u.speaker}: ${u.text}`);
  scene.audio = {
    voice: 'dialogue',
    full_text: scriptLines.join('\n')
  };
  ```
- Если НЕ dialogue → текущее поведение: `voice: 'narrator'`, `full_text: sceneText`

### 4. `buildSegments()` (`backend/src/audio/segments.js`)
**Не менять.** Уже работает с форматом `"speaker: текст"` через `splitDialogueIntoChunks()`.

## TODO List

- [ ] 1. Создать TODO doc (этот файл)
- [ ] 2. Добавить `speaker` в `SYSTEM_PROMPTS.units` в `agent-prompts.js`
- [ ] 3. Обновить `stepCreateUnits()` — сохранять `speaker` из AI
- [ ] 4. Обновить `create.js` — сборка скрипта для dialogue-сцен
- [ ] 5. Проверить `buildSegments()` — тест на формате `speaker: текст`
- [ ] 6. Прогнать тесты (473 шт.)
- [ ] 7. Code review

## Тестирование

После изменений:
1. Импортировать `.txt` с диалогами (например, отрывок «Мастера и Маргариты»)
2. Проверить `voices.json` — есть голоса персонажей
3. Проверить chapter JSON — dialogue-сцена имеет `audio.voice: 'dialogue'` и `audio.full_text` в формате `"berlioz: текст"`
4. Проверить что `buildSegments()` корректно парсит скрипт
