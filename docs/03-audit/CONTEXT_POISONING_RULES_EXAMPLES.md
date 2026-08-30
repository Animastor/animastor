# Context Poisoning: Concrete IDs from Rules/Demo Book Examples

Date: 2026-08-09
Status: **Option 1 applied** (examples anonymized); **Option 3 applied**
(hybrid: deterministic detection + LLM rebuild); Option 2 — optional.

## Symptom

При генерации книги `royallib_com_1786206633026` (русскоязычная книга) в
`video.action` появился выдуманный id **`zhenshchina_v_budochke`** — такого
персонажа НЕТ в `characters.json` книги (там только mikhail_berlioz,
ivan_ponyrev, prozrachnyy). При этом сам id — это «женщина в будочке»,
персонаж-эпизод из **«Мастера и Маргариты»** Булгакова — той самой книги,
которую генерировали.

Последствия:
- Видео-промпт ссылается на id без паспорта (`character_id: tokens` в секции
  characters отсутствует) → ломается маппинг движения на персонажа.
- Строка спикера «женщина в будочке speaking with lip movement» — сырой
  русский алиас, который ни во что не резолвится.
- В других прогонах агент «придумывал» ей паспорт и голос — потому что тот же
  id фигурирует в примерах шага извлечения персонажей.

## Poisoning Mechanism

The agent copies examples from its context rather than following a closed ID list.
All examples in rules and demo data were hardcoded with IDs from *The Master and Margarita*
— **the very book the user is generating**. When the agent encounters
"kiosk saleswoman" in text, it recalls the "correct" ID from the example and
inserts it, even if it's absent from the Scene Context.

Three independent injection vectors:

| Vector | Where | What the agent sees |
|---|---|---|
| Vector | Where | What the agent sees |
|---|---|---|
| Rules (`ai/rules/*.md`) | Injected into all pipeline steps | `mikhail_berlioz`, `ivan_ponyrev`, `zhenshchina_v_budochke`, "Patriarch's Ponds", "Berlioz", "Bezdomny", "MASSOLIT", "Give me Narzan" |
| Demo book `ai/examples/*.json` | `%EXAMPLES%` in visuals (`buildImageExemplars`) | scene with `berlioz, bezdomny` and ready-made image.prompt/video.action |
| Demo book `ai/examples/*.json` | `refineDraft` (bootstrap) + `formatExamplesForPrompt` | entire catalog, including "Patriarch's Ponds" chapter |
| Default prompts `ai/workflows/video-ltx-*.json` | fallback text of positivePrompt node | M&M storyboard (overwritten at assembly, but it's a landmine) |
| Inline examples in `ai-service.js` (refineDraft) | system prompt | "Berlioz and Bezdomny sat on a bench…", "berlioz:" |

The instability ("sometimes a passport, sometimes just an ID") is explained by the fact that
the ID appears in three independent steps — whichever step the agent hits first,
that's where the poisoning leaks through.

## Solutions

### Option 1 — Anonymize Examples (APPLIED)

Concrete IDs from *The Master and Margarita* replaced with a neutral fictional
demo book **"Evening in the City"** (M. Demin): `anna_smirnova`, `boris_volkov`,
`dmitry_orekhov`, location `city_park`. The same fictional pair is used in
rule examples.

| Было (M&M) | Стало (нейтрально) |
|---|---|
| `mikhail_berlioz` / `ivan_ponyrev` | `anna_smirnova` / `boris_volkov` |
| `zhenshchina_v_budochke` (женщина в будочке) | `kiosk_saleswoman` (женщина у киоска) |
| `patriarch_ponds` | `city_park` |
| «Берлиоз» / «Бездомный» / «Воланд» | Анна / Борис / Дмитрий |
| «МАССОЛИТ» | «глава журнала» |
| «Дайте нарзану» | «Дайте воды» |
| «прозрачный гражданин» | «незнакомец в светлом плаще» |

Затронутые файлы: `ai/rules/{characters,visuals,units,scenes,locations,
video_action_polish,video_action_reconciliation,passport_reconciliation,
storyboard_polish}.md`, `ai/examples/*.json` (9 файлов),
`ai/workflows/video-ltx-{1p,2p,3p,4p}.json` (дефолтные промпты),
`src/services/agent/pipeline-steps.js` (инжектируемый пример алиасов),
`src/services/ai-service.js` (инлайн-примеры refineDraft).

**Ограничение:** любой конкретный id в примерах потенциально может протечь —
даже нейтральный `kiosk_saleswoman`. Вариант 1 устраняет *известное*
заражение (совпадение демо-книги с генерируемой), но не закрывает механизм
полностью.

### Option 2 — Explicit Warning in Rules (optional)

Add to the beginning of rules: "The examples below are FORMAT only. Their IDs do NOT belong
to your book. Use ONLY IDs from Scene Context / character list."
Minimal changes, but the model may ignore it.

### Option 3 — Hybrid Programmatic Guard (APPLIED)

Two-layer defense — detection is deterministic, recovery is LLM-based
(reverse transliteration doesn't work: the project is multilingual):

1. **Детект (`src/utils/snake-guard.js`, общий с аудит-скриптом).**
   snake_case-токен (`[A-Za-z]` + ≥1 подчёркивание, без possessive `'s`) —
   это выдуманный id, если его нет среди known ids (characters + locations)
   и нет в whitelist'е технических/визуальных слов (`close_up`, `park_bench`,
   `street_lamp`, …). Варианты реальных id (префиксы) не считаются фэнтези.
2. **LLM-ремонт (`stepRepairFantasyIds`, финальный visual-шаг в обеих ветках
   pipeline-runner).** Если в `image.prompt` / `video.action` найден фэнтези-id
   — юнит (с исходным текстом и списком известных id) уходит агенту, который
   пересобирает промпт, восстанавливая естественное обозначение из текста
   книги (языко-зависимо, не транслитом). Результат снова сканируется:
   нечистый ответ отбрасывается, остаётся оригинал.
3. **Барьер на записи (`book/lazy-book/create.js`):** `scene.participants`
   фильтруется по known ids — фэнтези-id, переживший LLM-шаги, в книгу не
   попадает (известные id и естественные обозначения сохраняются).
4. **Спикер:** фэнтези-id в `audio.speaker` тоже попадает в скан/ремонт
   (пересобирается в естественное обозначение); голос не выдумывается
   (`stepGenerateVoices` — только персонажи с описанной внешностью), а для
   неизвестного спикера аудио-конвейер молча использует голос рассказчика.

Превентивная подсказка в `%CONTEXT%` visuals (перечислять эпизодических
участников агенту заранее) **рассматривалась и отклонена**: она дублировала
правило visuals.md («unnamed person → describe as extra, do NOT invent id»),
добавляла токены в каждый visual-вызов ради редкого кейса и не покрывала сам
вектор (фэнтези-id всё равно отбрасывались молча). Гарантию даёт финальный
ремонт-шаг — он детерминированно ловит всё, что проскочило.

Цена: ремонт срабатывает только на флагнутые юниты (редкость) — один маленький
LLM-вызов на окно. Тесты: `tests/snake-guard.test.js`.

## Методология аудита (фикс «he»/«the»)

Ложное срабатывание «he» внутри «t**he** alley» — классическая ошибка
подстрочного поиска. Аудит-скрипт `backend/scripts/audit-video-actions.js`
использует **word-boundary** регулярки (`\bhe\b`, `\bthe two men\b`), поэтому
«the alley» никогда не триггерит «he», а «heat» — «she». См. скрипт.

## Статус

- [x] Вариант 1: примеры обезличены (рулсы + ai/examples + workflow-дефолты + инлайн-строки)
- [ ] Вариант 2: предупреждение в рулсах
- [x] Вариант 3: гибрид — snake-guard детект + `stepRepairFantasyIds` (финальный visual-шаг, обе ветки) + барьер participants/mentions/id в create.js (превенция в %CONTEXT% отклонена — см. выше)
- [x] Химеры: `findCanonicalId` (Tier 1–3) + канонизация в ремонтном шаге / create.js / аудите
- [x] Скрипт аудита: `backend/scripts/audit-video-actions.js` (теперь использует общий `snake-guard`)

## Химеры: канонизация к реестру (слой 2 гибрида)

Политика двух классов:

1. **Эпизодический персонаж с полной упаковкой — не дефект.** Если система
   упаковала «женщину в будочке» в полноценную сущность (id, роль, паспорт,
   голос) — это допустимо и не лечится.
2. **Химера — дефект и лечится обязательно.** Snake-id, который *похож* на
   существующего персонажа, но не совпадает с ним побайтово: полу-русский /
   полу-английский (`mikhail_berлиоз`), неправильная транслитерация
   (`ivan_ponerov` vs `ivan_ponyrev`, `y`/`iy`), хвостовой подчёркивание
   (`mihail_bulgakov_`), опечатка в 1–2 буквы, шумовой суффикс
   (`anna_smirnova_extra`). Для системы это другой ключ — за ним нет паспорта.

Защита (`findCanonicalId` в `src/utils/snake-guard.js`) — три ступени
убывающей уверенности, исправление ВСЕГДА берёт существующий id из
`characters.json`, новый вариант не генерируется:

1. **Tier 1** — равенство после нормализации (транслитерация кириллицы через
   `CYR_LATIN_MAP`, lowercase, стрип мусора): `mikhail_berлиоз` →
   `mikhail_berlioz`, `mihail_bulgakov_` → `mihail_bulgakov`.
2. **Tier 2** — уникальный ближайший по Левенштейну в консервативном пороге
   (≤3, ≤15% длины, длина ≥8): `mihail_bulgakoviy` → `mihail_bulgakov`,
   `ivan_ponerov` → `ivan_ponyrev`. Два равнодалёких кандидата → НЕ уверенно
   → уходит в LLM-ремонт.
3. **Tier 3** — известный id + шумовой суффикс: `anna_smirnova_extra` →
   `anna_smirnova`.

Где применяется канонизация (все через один `snake-guard`):

| Точка | Что делает |
|---|---|
| `stepRepairFantasyIds` | канонизация ДО LLM-флага: химеры чинятся детерминированно без вызова; в LLM уходят только токены без уверенного соответствия |
| `create.js` participants | химера-участник → канонический id (`onReplace`), истинная фантазия → drop (`onDrop`) |
| `create.js` mentions | цель алиаса канонизируется или дропается — битый алиас в книгу не пишется |
| `create.js` char/location id | mixed-script id нормализуется к чистому латинскому (`patriarshie_pруды` → `patriarshie_prudy`) |
| `audit-video-actions.js` | CHIMERA-проверка + mixed-script id + mentions-таргеты |

## Гибрид: почему не транслитерация

Обратная транслитерация (`zhenshchina_v_budochke` → «женщина в будочке»)
работает только для кириллицы и «правильного» транслита. Проект мультиязычный
(ru/en/de/zh/ar/…), поэтому восстановление исходного обозначения делегировано
LLM: детект говорит «это фэнтези-id», а агент по тексту юнита возвращает
естественное обозначение на языке книги («the kiosk saleswoman»). Детерминизм —
только в решении «ремонтировать или нет», смысл восстанавливается контекстно.

## Known Limitations of Option 3

- **Partial fix is not rolled back but completed with deterministic fallback:**
  если агент-ремонт починил одно поле юнита, но оставил фэнтези-id в другом
  (или вернул грязный черновик), `mergeRepairResults` сохраняет черновик LLM и
  программно взрывает оставшийся invented-токен в обычные слова
  (`kiosk_saleswoman` → "kiosk saleswoman") через `desnakeifyText` — фэнтези-id
  в книгу не попадает никогда. Реверт к оригиналу остаётся только как крайняя
  мера (если даже fallback не смог очистить поле). Счётчик `fallbackFixed`
  виден в логе шага. Пример из боя: LLM не смог убрать `kiosk_saleswoman` из
  `video.action` трёх юнитов — старый код ревертил (фэнтези-id оставался в
  книге, аудит FAIL), новый код отдаёт "kiosk saleswoman".
- **Fallback — это слова, а не перевод:** для латинских id деснейкификация даёт
  осмысленные слова ("kiosk saleswoman"); для транслитерированных id
  ("zhenshchina_v_budochke") — сырой транслит, который пользователь явно
  отверг. Поэтому fallback работает ТОЛЬКО как последний рубеж после LLM:
  первично агент восстанавливает естественное обозначение по тексту юнита.
- **Усечённые варианты реальных id** (`mikhail_berlio` при реальном
  `mikhail_berlioz`) считаются вариантами персонажа, а не фэнтези — они
  сознательно пропускаются и ремонтом не чинятся (консервативная защита от
  ложных срабатываний).
- **Усечённые варианты реальных id** (`mikhail_berlio` при реальном
  `mikhail_berlioz`) считаются вариантами персонажа, а не фэнтези — они
  сознательно пропускаются и ремонтом не чинятся (консервативная защита от
  ложных срабатываний).
- **Out-of-format промпты** (> `IMAGE_PROMPT_MAX_CHARS`, legacy/пользовательские)
  не сканируются и не ремонтируются — политика «не трогать то, что модель
  не видела целиком».
- **Fuzzy-слияние (Tier 2) в реестровых путях отключено** (`fuzzy: false` в
  create.js): два реальных разных персонажа с похожими id
  (`sergey_ivanov` / `sergey_ivanova`) могут быть разными людьми — в записи в
  реестр выравниваются только нормализованные-равные (Tier 1) и суффиксные
  (Tier 3) варианты; опечатки уходят в ремонт промптов. В промптах (ремонтный
  шаг) fuzzy остаётся — там ошибка влияет только на текст кадра.
- **Миграция уже сгенерированных книг:** старые главы могут ссылаться на
  mixed-script location id, которого нет в канонизированной карте — новые
  окна пишут канонические id; остатки ловит аудит-скрипт.

## Known Remnants (not injected — intentionally untouched)

- `backend/src/scripts/test-scene-split.cjs` — дев-скрипт с M&M-фикстурами; не
  вызывается из package.json/тестов (ручной инструмент).
- Комментарии в `src/image/iu-processor.js`, `src/image/character-utils.js`,
  `src/audio/segments.js` — упоминают «Берлиоз»/«нарзан» как иллюстрацию; в
  промпты не попадают.
- `GENERIC_WORDS` в `src/image/helpers.js` / `src/utils/character-identity.js`
  содержит `zhenshchina` — это гард-список (исключение общих слов из алиасов),
  его трогать нельзя.
