# Repository Split — Final Verification Report (2026-10-05)

> **STATUS: READ-ONLY FINAL CHECK = PASS (2026-10-05 UTC).**
> Проверка выполнена **без изменений** файлов: новых коммитов/правок в 4 новых
> репозиториях, в `master` монорепо и в GPU Hub — **0**; **единственный** вклад
> в ветку после проверки — **этот** документ в `docs/architecture/` (и его
> редакционные правки).
> **ISC → KEEP** (§1) · активных URL-остатков на старый monorepo: **1** в backend (§2.1)
> · historical `docs/architecture`: backend **9** + worker **1**, не тронуты (§2.2)
> · инварианты split: **PASS** (§3) · тесты: backend **923/2 pre-existing**,
> web **201/201** + typecheck + build, worker **45/45** + protocol,
> android `assembleDebug` **BUILD SUCCESSFUL** (§4).
> Исполняемых BLOCKED-проверок нет; e2e `docker/e2e/dispatch-task.cjs` не запускался
> (требует GPU Hub, в скоуп финальной проверки не входил) — §5.

Документ не является переписыванием исторических аудитов: он фиксирует результат
одной финальной read-only проверки. При расхождении с более ранними записями
статус-документов (`repository-split-final-gate.md`,
`repository-split-post-split-audit.md`) действуют они, а здесь — факты,
перепроверенные командами 2026-10-05.

---

## 0. Скоуп и окружение

| Поле | Значение |
|---|---|
| Скоуп | (1) ISC в `packages/animastor-worker/image/worker/package.json`; (2) остаточные ссылки на `github.com/Animastor/animastor` в 4 новых репо; (3) инварианты split; (4) тесты |
| Режим | **read-only**, без косметики, без новых коммитов (кроме этого документа) |
| Монорепо-worktree | `/home/animastor/animastor`, ветка `c21.4-physically-extract-analysis-from-backend`, **HEAD на момент проверки `d1a6cc66`**, далее — только doc-коммиты с этим документом; `git status --porcelain` = **0 строк** |
| Frozen source | `master` bare `/home/animastor/repos/animastor.git` = **`64127b9e1dea2ac528a572b51b90a542b70c5ebb`** — **не тронут** |
| Клоны-проверяльщики | `/tmp/final/*` (read-only копии HEAD, clean) и `/tmp/verify/*` (рабочие, node_modules; status = 0 строк) |
| filter-repo metadata | `/tmp/split/{backend,web,android,worker}/.git/filter-repo/{ref-map,commit-map}` |
| BEFORE-snapshot | `/home/animastor/backups/before-split-64127b9e-refs/` |
| GPU Hub | worktree `/home/animastor/animastor-gpu-hub` (status = 0), bare `/home/animastor/repos/animastor-gpu-hub.git` — **не тронуты** |
| Дата прогонов тестов | backend/web/android — 2026-10-04 15:18…16:31 UTC; worker — перепрогнан 2026-10-05 01:08 UTC; инварианты и grep — 2026-10-05 |

---

## 1. ISC в `image/worker/package.json` → **KEEP (не менять)**

Файл: `packages/animastor-worker/image/worker/package.json`
(в worker-репозитории — тот же путь; в backend/web/android **отсутствует**).

| Признак | Факт |
|---|---|
| Содержимое | npm-init дефолт: `name:"worker"`, `version:"0.1.0"`, `main:"worker.js"` (**файла не существует**), `test` = заглушка `exit 1`, пустые `author`/`description`, `"license":"ISC"` |
| Происхождение | создан `380a7773` (2026-06-11, **первый коммит монорепо**, Sergey Khabarov) → **first-party**; менялся только cleanup/версии, последний `9f6b5808` (2026-09-07 «Move worker into packages/animastor-worker») |
| Lock-файл | `package-lock.json` несогласован: `version:"1.0.0"` (vs 0.1.0) |
| Ссылки из кода/Dockerfile | **0** — `git grep -n "image/worker" 64127b9e` даёт **только** `docs/architecture/*` (8 файлов), где он описан как legacy: `LINUX_INSTALLER_RECONNAISSANCE.md:72` «**Legacy artefact — do not use**», `PHASE_9D_…:65` «мёртвый», `PHASE_9E_…:209` «dead, documented» |
| Публикация | не публикуется (0 зависимостей, 0 потребителей) |
| Уникальность ISC | единственный `"license":"ISC"` во **всех** `package.json` всех 4 репо (`git grep -l '"license": "ISC"' HEAD -- '**/package.json'` → только этот файл); lock-файлы зависимостей не считаются |
| Лицензия проекта | корневой `LICENSE` = **MIT** — ISC на этот файл не влияет |

**Вывод: оснований менять нет → файл не изменён.** Менять `license` в уже
существующем first-party манифесте без публикации — косметика, запрещённая
условиями проверки; при появлении намерения публиковать пакет лицензия должна
быть приведена к MIT осознанно (см. §6, X-3-смежное).

---

## 2. Остаточные ссылки на `github.com/Animastor/animastor`

**Метод:** `git grep` по **tracked HEAD** каждого репо, case-insensitive, обе формы
(`github.com/Animastor/animastor` + ssh `git@github.com:Animastor/animastor`) с
границей слова `([^a-zA-Z0-9_-]|$)` — чтобы не ловить подстроки в
`…/animastor-backend|web|android|worker`:

```bash
PAT='(github\.com/Animastor/animastor|git@github\.com:Animastor/animastor)([^a-zA-Z0-9_-]|$)'
git grep -n -i -E "$PAT" HEAD -- ':(exclude)docs/architecture'   # active
git grep -l -i -E "$PAT" HEAD -- docs/architecture                # historical
```

### 2.1 Active (вне `docs/architecture`)

| Репо | Остатков | Найдено |
|---|---|---|
| **backend** | **1** | `packages/animastor-ai-connector/README.md:209` — `[Animastor monorepo](https://github.com/Animastor/animastor) — this package is fully self-contained…` |
| web | **0** | — |
| android | **0** | — |
| worker | **0** | — |

- blame остатка: **`a8a296f9`** (2026-09-07, «Move ai-connector into packages»;
  в монорепо тот же коммит — `9fef24ba`, SHA переписан filter-repo) — **pre-split**.
- Уже исправлено ранее коммитами `b89954fa`/`98c4fbd6`: `package.json`
  `repository`/`bugs`/`homepage`, README clone-URL,
  `packages/animastor-installer/src/installer/setup-contract.js:695` (строка —
  `git clone https://github.com/Animastor/animastor-worker.git…`; со старой
  формой URL там **0** совпадений).
- **Фикс в рамках этой проверки НЕ вносился** (скоуп = только проверка; push-путь
  `worktree → bare → GitHub` не использовался). Классификация: **P2, 1 строка**.

**Смежное, НЕ URL (не трогал):** hardcoded `/home/animastor/animastor/…` в
  `scripts/animastor-runtime-audit.sh:415,540,543,544` и
  `docker/e2e/dispatch-task.cjs:11` — задокументированы в
  `repository-split-next-blockers.md` (строки `:779`, `:1611`; актуальные —
  `:826`, `:891`, `:1958`) как **EXPECTED PRE-SPLIT → POST-SPLIT ACTION**;
  это VPS/e2e-пути, а не ссылки на репо.

### 2.2 Historical `docs/architecture` (не переписывать)

| Репо | Файлов |
|---|---|
| backend | **9** |
| worker | **1** (`PHASE_9E_NPM_PUBLIC_RELEASE_AUDIT.md`) |
| web / android | **0** / **0** |

Исторические аудиты — журнал фактов на своих SHA, их переписывание запрещено.

---

## 3. Инварианты split → **PASS**

### 3.1 Репозитории и публикация

| Проверка | Результат |
|---|---|
| `master` монорепо == frozen source | **`64127b9e…`** ✓ · worktree status = **0 строк** ✓ |
| bare == GitHub `refs/heads/main` (ls-remote 2026-10-05) | backend **`98c4fbd6`** ✓ · web **`c7fe52ac`** ✓ · android **`254e2f08`** ✓ · worker **`618f87a6`** ✓ |
| read-only клоны `/tmp/final/*` | status = **0 строк** для всех 4 ✓ |
| Рабочие клоны `/tmp/verify/*` | status = **0 строк**, HEAD == bare ✓ |

### 3.2 Lineage (filter-repo metadata)

| Репо | `ref-map` (`$SRC → split-tip`) | split-tip → HEAD | «старые» SHA — предки `$SRC` | dropped | violations |
|---|---|---|---|---|---|
| backend | `64127b9e… → f83f929c732d8fc490bd150e72294d6b3c6e2f92` | **YES** | **1267/1267** | 386 | **0** |
| web | `64127b9e… → 4c3ea0fb2a1adb552ba1c9acd98abc41befdab3b` | **YES** | **275/275** | 1378 | **0** |
| android | `64127b9e… → efa4b2937bc1954900c0e5aa9501667f42d6a70d` | **YES** | **107/107** | 1546 | **0** |
| worker | `64127b9e… → 73671b6b4e2986bd33c88c0ef165cb39a67e875d` | **YES** | **24/24** | 1629 | **0** |

- Метод lineage: множество предков `$SRC` = `git rev-list 64127b9e` (1653 SHA),
  сверялось с колонкой `old` записей `commit-map` с ненулевой колонкой `new`.
- **`$SRC` в `commit-map` каждого репо → `0000…` (dropped)** — **ожидаемо**:
  `$SRC` менял только gpu-hub-пути вне whitelist каждого репо → после фильтрации
  коммит пустой (`--empty=drop`), вклад в дерево = 0. Это **не** потеря истории
  (см. `repository-split-execution-pack.md` §11.5/§14.4).
  Важно: **frozen `64127b9e` сам по себе не является предком HEAD новых репо** —
  lineage проверяется через `ref-map` + «старые» SHA, как выше.

### 3.3 GPU Hub и refs монорепо vs snapshot

| Проверка | Результат |
|---|---|
| bare GPU Hub `refs/heads/master` == `HEAD` | **`7c7778c6f313dad19eb403d8509cd297226ec7ea`** ✓ |
| SHA-only diff vs BEFORE-snapshot | **IDENTICAL** ✓ (расхождение только в колонке типа объекта `commit`) |
| GitHub (ssh `git@github.com:Animastor/animastor-gpu-hub.git`, 2026-10-05) | **`7c7778c6…`** ✓ == bare == `refs/remotes/github/master` |
| worktree GPU Hub | status = **0 строк**, HEAD `7c7778c` ✓ |
| refs монорепо vs snapshot | `master` = **`64127b9e`** идентичны; ветка `c21.4` сдвинулась `40f09946 → HEAD` **только doc-коммитами внутри `docs/architecture/`** (в т.ч. этот документ) — `git diff --name-only 40f09946 HEAD \| grep -vc '^docs/architecture/'` = **0** ✓ |
| force-push | **доказательств нет**: в bare нет `logs/` (reflog отсутствует), все push'и шли обычными (без `--force`) по командным листам execution-pack |
| npm publish | не выполнялся |

---

## 4. Тесты

| Репо | Команда | rc | Результат |
|---|---|---|---|
| backend | `npm test` (`/tmp/verify/backend/backend`) | **2** | **923 passing / 24 pending / 2 failing** — обе **pre-existing** (см. ниже) |
| web | `typecheck` (`frontends/app`) | **0** | `tsc --noEmit` чисто |
| web | `vitest` | **0** | **201/201** (15 файлов), 6.16s |
| web | `vite build` | **0** | ✓ 62 modules, `dist/` собран |
| worker | `npm test` (`packages/animastor-worker`) | **0** | **45/45** (2 skip: «standalone checkout without monorepo») |
| worker | `npm run check:protocol` | **0** | «worker bundle copy is in sync with @animastor/contracts» |
| android | `gradle help` | **0** | Gradle **8.12** |
| android | `gradle :app:assembleDebug` | **0** | **BUILD SUCCESSFUL**, APK `app/build/outputs/apk/debug/app-debug.apk` = **12 677 548 B** (2026-10-04 15:18) |

### 4.1 Две backend failing — pre-existing, сознательно НЕ чинились

1. `installer package boundary guards (@animastor/installer)` →
   `IB-G15: package.json pins (main, bin, private)` —
   `backend/tests/architecture/installer-package-boundary.test.js:243`:
   `AssertionError: package stays private (no publish yet): expected undefined to equal true`
2. `Phase 5 final audit: full runtime/** boundary` →
   `T9: no dynamic/template/concat require or import() can reach orchestration from runtime/**` —
   `Error: ENOENT: no such file or directory, open '/tmp/verify/backend/backend/src/runtime/index.js'`

Обе падали до этой проверки; решение владельца — не чинить в рамках split-блоки.

### 4.2 Замечания по окружению (не влияют на результат)

- android: `gradlew` в clone — заглушка `./gradle-8.12/bin/gradle`, а каталог
  `gradle-8.12` **untracked** и не клонируется → использован системный Gradle 8.12
  (`/home/animastor/animastor/frontends/android/gradle-8.12/bin/gradle`).
- Первый проход `assembleDebug` rc=1 «SDK location not found» → создан
  **gitignored** `frontends/android/local.properties` (паттерн `.gitignore:16`),
  после чего BUILD SUCCESSFUL; git status клона остался **чистым**.
- Скан по working tree (`rg`) даёт больше совпадений, чем git grep: это подстроки
  `animastor` внутри `Animastor/animastor-<other-repo>` — **false positive**;
  источник истины — git grep с границей слова (§2).

---

## 5. Не выполнялось / ограничения

| Пункт | Статус |
|---|---|
| e2e `docker/e2e/dispatch-task.cjs` | **не запускался** — требует живой GPU Hub; в скоуп финальной проверки не входил (проверка локальная, без секретов/GPU/внешних сервисов) |
| Секреты / внешние сервисы | не требовались; BLOCKED-проверок **нет** |
| Логи тестов | `/tmp/final-{backend-test,web-typecheck,web-vitest,web-build,worker-test,worker-protocol,gradle-help,gradle-assemble}.log` — **эфемерные** (`/tmp`), в репозиторий не архивируются |
| Фикс §2.1 (README ai-connector) | **не внесён** — вне скоупа read-only проверки |
| Остальные post-split actions | см. §6 и `repository-split-next-blockers.md` |

---

## 6. Рекомендации после проверки (не закрыты этим документом)

| ID | Что | Класс |
|---|---|---|
| V-1 | 1-строчный фикс `packages/animastor-ai-connector/README.md:209` → `https://github.com/Animastor/animastor-backend` (отдельным коммитом backend-репо) | **P2** |
| X-3 | Обновить `repository.url`/`bugs`/`homepage` в `package.json` **перед первым npm publish** | blocker publish'а |
| PR2 | hardcoded `/home/animastor/animastor/…` в `scripts/animastor-runtime-audit.sh`, `docker/e2e/dispatch-task.cjs` → сделать путь переменным | POST-SPLIT ACTION (`repository-split-next-blockers.md:826`, `:891`, `:1958`) |
| ISC-смежное | при решении публиковать worker-пакет — привести `image/worker/package.json` к MIT и починить несогласованный lock (`1.0.0` vs `0.1.0`) | только при publish |

---

## 7. Команды-источники (для воспроизводимости)

```bash
# §3.1 публикация
git --git-dir=/home/animastor/repos/animastor-<r>.git rev-parse refs/heads/main
git ls-remote https://github.com/Animastor/animastor-<r>.git refs/heads/main
git -C /tmp/final/<r> status --porcelain | wc -l

# §3.2 lineage
git rev-list 64127b9e > /tmp/ancestors-src.txt
grep -E '^64127b9e' /tmp/split/<r>/.git/filter-repo/ref-map
awk 'NR>1 && $2 !~ /^0{40}$/{print $1}' /tmp/split/<r>/.git/filter-repo/commit-map \
  | grep -vwFf /tmp/ancestors-src.txt | wc -l        # violations = 0
git --git-dir=… merge-base --is-ancestor <split-tip> <bare-HEAD>

# §3.3 GPU Hub
git ls-remote git@github.com:Animastor/animastor-gpu-hub.git refs/heads/master
git --git-dir=/home/animastor/repos/animastor-gpu-hub.git show-ref
diff <(sort snapshot.refs) <(sort current.refs)      # только колонка типа объекта

# §2 остатки (см. метод в §2)
PAT='(github\.com/Animastor/animastor|git@github\.com:Animastor/animastor)([^a-zA-Z0-9_-]|$)'
git grep -n -i -E "$PAT" HEAD -- ':(exclude)docs/architecture'

# §4 тесты
cd /tmp/verify/backend/backend && npm test            # rc=2 (2 pre-existing)
cd /tmp/verify/web/frontends/app && npm run typecheck && npm test && npm run build
cd /tmp/verify/worker/packages/animastor-worker && npm test && npm run check:protocol
gradle -p frontends/android :app:assembleDebug        # Gradle 8.12, rc=0
```
