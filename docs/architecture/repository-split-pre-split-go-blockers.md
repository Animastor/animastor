# Repository Split — PRE-SPLIT GO-BLOCKERS (P1 · P6 · R-3 · GO/NO-GO)

> **PHYSICAL SPLIT: NOT EXECUTED**
> **git filter-repo: NOT EXECUTED**
> **force-push: NOT EXECUTED · GitHub-репозитории: NOT CREATED ·
> `master` / `Animastor/animastor-gpu-hub` / hooks / npm publish: NOT MODIFIED ·
> R-3: НЕ ВЫБРАН · очистка диска: НЕ ВЫПОЛНЯЛАСЬ**

> **Статус документа: только подготовка и документация.** Все числа ниже получены
> **read-only** (`df`, `du`, `git count-objects`, `git clone` во временный каталог
> `/tmp/opencode/split-measure` — удалён сразу после измерения, `git ls-remote`,
> GitHub API GET, чтение исходников `git_filter_repo.py`). Ничего не создавалось,
> не удалялось, не перезаписывалось.

Связанные документы:
`repository-split-final-gate.md` (авторитетный GO/NO-GO),
`repository-split-execution-pack.md` (per-repo spec, аудит командного листа),
`repository-split-next-blockers.md` §4.1 (исполняемый командный лист),
`repository-split-pre-split-fixes.md` §5 (процедура R-3 = B).

---

## 1. Сводка статусов

| ID | Блокер | Статус | Кто закрывает |
|---|---|---|---|
| **P1** | 4 GitHub-repo + 4 bare + hook + remote `github` | **BLOCKED** — API: 4 × HTTP **404** (`animastor-backend`, `-web`, `-android`, `-worker`); `Animastor/animastor` = 200, `Animastor/animastor-gpu-hub` = 200 | owner |
| **P6** | диск ≥ задокументированного порога | **FAIL** — avail `2 966 122 496 B` < `5 368 709 120 B` (≥5G). **Измеренное** требование split ≈ **431 MB** пик / **1 GiB** минимум → текущий запас = **2.76×** минимума, но **0.55×** задокументированного порога. Перебазировка порога — **решение владельца**; ничего не удалялось | host / owner |
| **R-3** | A (сохранить) / B (заменить) GPU Hub | **UNDECIDED** — обе опции документированы (§4 ниже); `Animastor/animastor-gpu-hub` = 200, `7c7778c`, **не изменён** | owner |
| **I-16** | в новых bare нет remote `github` → hook `git push --mirror github` упадёт | **НАЙДЕН В ЭТОЙ РЕВИЗИИ** — закрывается в P1, до первого push | закрывается в P1 |
| **I-17** | непустой GitHub-repo → non-fast-forward → нужен **запрещённый** force-push | **НАЙДЕН В ЭТОЙ РЕВИЗИИ** — требование «repo пустой» в P1 (§2) | owner при создании |
| **I-18** | push-права SSH-ключа для новых репо | **НАЙДЕН В ЭТОЙ РЕВИЗИИ** — ключ `~/.ssh/github_ed25519` читает org (проверено), push-права на **новые** репо нужно обеспечить созданием их **этим же аккаунтом** | owner при создании |

---

## 2. P1 — точный план создания 4 репозиториев

**Самостоятельно не создаётся.** Ниже — зафиксированные параметры, чтобы план был
воспроизводимым и проверяемым.

### 2.1 Параметры

| Параметр | Значение | Основание / проверка |
|---|---|---|
| Репозитории | `Animastor/animastor-backend` · `Animastor/animastor-web` · `Animastor/animastor-android` · `Animastor/animastor-worker` | §FINAL SPLIT HANDOFF п.3; **GPU Hub отдельно НЕ создавать** — `Animastor/animastor-gpu-hub` уже существует (200) |
| **visibility** | **public** (`private: false`, `visibility: "public"`) | консистентно с `Animastor/animastor` (`private=false`, `visibility=public`) и `Animastor/animastor-gpu-hub` (`private=false`). **Техническое требование:** командные проверки `git ls-remote https://github.com/Animastor/<name>.git` в §4.1.1–§4.1.4 работают **без credentials только для публичных** репо; при private репо эти проверки дадут 401/404 и ложно покажут провал |
| **default branch** | на момент создания — **не задан** (репо без коммитов); фактическое имя задаётся **первым push** | GitHub API: `default_branch=""`, `size=0`, `pushed_at=null` до первого push. После push — проверить `default_branch == $NEWBRANCH`, при расхождении `PATCH /repos/Animastor/<name>` с `{"default_branch":"$NEWBRANCH"}` |
| **NEWBRANCH** | `$NEWBRANCH` из §4.1.0 (**сейчас `main`**) — **единственный** источник имени ветки | §FPSG.5 Этап 1 упоминает `master` (историческая запись), матрица §B9.2 триггеры — `main`; правится **только** переменная `$NEWBRANCH`. В `git init --bare` ветка по умолчанию `master` (`init.defaultBranch` не задан) → **обязательна** строка `git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"` **до** push (уже в §4.1.x) |
| **Пустота до первого push** | **ничего не добавлять**: без README, LICENSE, `.gitignore`, без `git init`, без веток | иначе первый push = non-fast-forward → потребуется `--force`, а **force-push запрещён**. Признаки «пусто»: `size = 0`, `pushed_at = null`, `default_branch = ""`, `contents` пусто/404 |
| **Порядок создания** | 1 `animastor-backend` → 2 `animastor-web` → 3 `animastor-android` → 4 `animastor-worker` | равен очереди split §FINAL SPLIT HANDOFF §4 (backend → web → android → worker → gpu-hub только при R-3=B). GPU Hub в этот список **не входит** |
| **Bare на VPS** | `/home/animastor/repos/animastor-{backend,web,android,worker}.git` — `git init --bare` | в §4.1.x есть guard `test -d "$NEW" \|\| git init --bare`, но bare **обязан быть уже подготовлен** (hook + remote) **до** первого push |
| **expected hook** | `hooks/post-receive`, **0755**, **91 байт**, байт-в-байт как в монорепо и в `animastor-gpu-hub` | см. §2.2 |
| **remote `github`** | `git remote add github git@github.com:Animastor/<name>.git` — **обязателен до первого push** | см. **I-16** §5.1 |

### 2.2 Точный hook (91 байт)

```sh
#!/bin/sh

cd "$GIT_DIR" || exit 1

echo "Mirroring to GitHub..."
git push --mirror github
```

Сверка: `wc -c` = 91; `git -C /home/animastor/repos/animastor.git/hooks/post-receive`
и `…/animastor-gpu-hub.git/hooks/post-receive` — идентичны (сверено read-only).

### 2.3 Порядок действий владельца (P1) и проверки после каждого шага

```sh
# для каждого NAME из {animastor-backend, animastor-web, animastor-android, animastor-worker}
# 0) GitHub: создать ПУСТОЙ public-репозиторий (без README/LICENSE/.gitignore)
curl -s https://api.github.com/repos/Animastor/$NAME | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['size'],d['pushed_at'],d['default_branch'],d['private'],d['visibility'])"
# ожидается: 0 None "" False public

# 1) bare
NEW=/home/animastor/repos/$NAME.git
test -d "$NEW" || git init --bare "$NEW"

# 2) hook (ДО первого push)
install -m 0755 /path/to/post-receive "$NEW/hooks/post-receive"
test -x "$NEW/hooks/post-receive" && test "$(wc -c < "$NEW/hooks/post-receive")" -eq 91

# 3) remote github (ДО первого push) — I-16
git -C "$NEW" remote add github "git@github.com:Animastor/$NAME.git"
test "$(git -C "$NEW" config --get remote.github.url)" = "git@github.com:Animastor/$NAME.git"

# 4) имя ветки
git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"

# после первого push (шаги §4.1.x):
git ls-remote https://github.com/Animastor/$NAME.git "refs/heads/$NEWBRANCH"   # != пусто
git -C "$NEW" for-each-ref --format='%(refname)'                                # только refs/heads/$NEWBRANCH
curl -s https://api.github.com/repos/Animastor/$NAME | python3 -c "import json,sys;print(json.load(sys.stdin)['default_branch'])"  # == $NEWBRANCH
```

### 2.4 Что P1 НЕ делает

Не создаёт `Animastor/animastor-gpu-hub` (уже существует), не трогает `master`,
не делает force-push, не публикует npm, не ставит hub-CI (заблокировано R-3).

---

## 3. P6 — read-only аудит диска

**Ничего не удалялось и не очищалось.**

### 3.1 Измеренные факты (эта сессия)

| Что | Команда | Значение |
|---|---|---|
| Свободно на `/` | `df -B1 /` | total `105 496 965 120` · used `98 013 741 056` · **avail `2 966 122 496 B`** (≈2.97 GB / 2.76 GiB), 98 %, одна точка монтирования `/` |
| monorepo bare | `du -sb /home/animastor/repos/animastor.git` | **`34 243 705 B`** (38M) |
| — внутренности bare | `git -C $BARE count-objects -v` | `packs: 4`, `size-pack: 22 797 KiB`, loose `count: 1689` / `size: 14 052 KiB` |
| GPU Hub bare | `du -sb …/animastor-gpu-hub.git` | **`273 015 B`** |
| `/home/animastor/backups` | `du -sb` | `2 933 881 591 B` (2.93 GB — существующие зипы; **не удалялось**) |
| split-backup `animastor-pre-split-64127b9e.git` | `test -d` | **отсутствует** (стадия B не выполнялась) |
| `/tmp/split` | `test -d` | **отсутствует** (ничего не фильтровалось) |
| **Фактический свежий клон** | `git clone --no-local --single-branch --branch $BRANCH $BARE` во временный каталог (удалён) | **`.git = 22 588 454 B`**, **worktree = 29 559 927 B**, **итого = 52 148 381 B**; `packs: 1`, `count: 0` (условие sanity ✓), reflog `HEAD` = 1 и ветка = 1 запись, `status` = 0, единственный remote = `origin` |
| Tracked-байты на source | `git ls-tree -r -l $SRC` | `28 304 169 B` |

### 3.2 Оценка места под весь split

Модель (консервативная; клон содержит **полную** историю монорепо, т.к. `--single-branch`
берёт ветку `$BRANCH` целиком):

| Компонент | На 1 репо | ×4 репо | ×5 (при R-3 = B) |
|---|---|---|---|
| рабочий клон (факт. измерение) | 52 148 381 | 208 593 524 | 260 741 905 |
| новый bare (≤ размера `.git` клона) | 22 588 454 | 90 353 816 | 112 942 270 |
| transient во время `filter-repo` (старые + новые объекты **до** `git gc --prune=now`, выполняется cleanup'ом filter-repo) — **на одном репо за раз** | 22 588 454 | 22 588 454 | 22 588 454 |
| backup монорепо (`git clone --mirror $BARE $BK`) | — | 34 243 705 | 34 243 705 |
| backup GPU Hub (только R-3 = B) | — | — | 273 015 |
| **ПИК** | | **355 779 499 B (≈356 MB)** | **430 789 349 B (≈431 MB)** |
| + страховка на повтор/незавершённый клон (2 × 52 148 381) | | 460 076 261 | 535 086 111 |

### 3.3 Минимальный безопасный запас

| Порог | Значение | Обоснование |
|---|---|---|
| **Измеренный пик** | `430 789 349 B` (5 репо) | §3.2 |
| **Измеренный пик + страховка** | `535 086 111 B` | оставлено 2 незавершённых клона |
| **Минимальный безопасный запас (рекомендация)** | **`1 073 741 824 B` (1 GiB)** | ≈2× пика со страховкой; покрывает пик + headroom на `/tmp`-мусор |
| **Задокументированный порог (§P6, final-gate)** | `5 368 709 120 B` (**≥5G**), рекомендуется ≥8G | консервативная оценка, сделанная до измерений («73M `.git` × 5» — фактический `.git` клона **22.6 MB**, а не 73M) |

### 3.4 Статус P6 и что решает владелец

- **P6 = FAIL** относительно задокументированного порога **≥5G**: `2 966 122 496 < 5 368 709 120`.
- **P6 = PASS** относительно измеренного минимума **1 GiB**: `2 966 122 496 ≈ 2.76 ×` минимума.
- **Ничего не удалялось.** Кандидаты очистки (только по распоряжению владельца, как и раньше):
  `pip cache purge` ≈4.4G → ≈7.3G; `npm cache clean --force` ≈0.8G; `/tmp`-мусор ≈1.4G.
  Каталог `backups/` (2.93 GB) — **не трогать** (это и есть страховочный архив).
- **Решение за владельцем (одно из):** (а) освободить ≥5G и оставить порог как есть;
  (б) явно **перебазировать** порог на `1 073 741 824 B`, зафиксировав в
  final-gate §1/§4 измерения §3.1–§3.3. До такого решения **P6 считается FAIL**.

---

## 4. R-3 — сравнение вариантов A и B (GPU Hub)

**Решение не принимается здесь.** Детали: `repository-split-pre-split-fixes.md` §5,
`repository-split-next-blockers.md` §R-3.

| Критерий | **A — сохранить существующий GPU Hub** | **B — backup/freeze и заменить историей monorepo** |
|---|---|---|
| Что физически делается | ничего не перезаписывается; код из monorepo переносится в существующий bare (merge `--allow-unrelated-histories` или один коммит поверх `7c7778c`) | `git clone --mirror` → `backups/animastor-gpu-hub-pre-split.git` → заморозить `hooks/post-receive` → `filter-repo` по whitelist §8.5 → **force-push** в существующий bare → верификация → возврат hook → mirror в GitHub |
| Выполняется ли `filter-repo` для gpu-hub | **НЕТ** (§8.5 не применяется) | **ДА** |
| Очередь §4.1 | шаг 5 **пропускается** → исполняется **90** `--path` (вместо 116) | шаг 5 выполняется **последним**, исполняется **116** |
| Существующая история (43 коммита, 2026-06-11…2026-09-06) | **сохраняется** | **затирается**; обратимо **только** из mirror-backup |
| Ссылки на старые SHA (`7c7778c`, `b95870f`, GHCR-workflow) | остаются валидными | перестают резолвиться |
| npm / GHCR преемственность | да (`@animastor/gpu-hub@0.1.1` уже опубликован, consumers не трогаются) | да (пакет не переиздаётся этим действием) |
| CI workflows | bare **уже имеет** `.github/workflows/{ci,ghcr-release}.yml` — нужно только сверить с матрицей B9 | workflows нужно авторить заново в hub-repo |
| Что требуется до старта | **ничего** (R-3 = A — это отказ от действий) | mirror-backup + заморозка hook + **письменное** подтверждение владельца (п.10 №4) |
| Основной риск | аккуратный merge/бэкпорт: **7 пунктов** переноса (§R-3: `resolveArtifactDir`, `/worker-source`, 0.1.0→0.1.1, B5-тройка, Dockerfile, `tests/run-all.cjs`, `.github/workflows`) | необратимая утрата 43 коммитов без backup; активный mirror-hook может вытолкнуть частичную историю в GitHub, если заморозить поздно |
| Что блокирует | авторинг hub-CI (D10) — до выбора A/B hub workflows не авторятся | авторинг hub-CI, **весь шаг 5 очереди**, `filter-repo` gpu-hub |
| Статус | **не выбран** | **не выбран** |

`Animastor/animastor-gpu-hub`: HTTP 200, `private=false`, `default_branch=master`,
`size=105`, `pushed 2026-09-06T18:07:10Z`, HEAD `7c7778c`; bare
`/home/animastor/repos/animastor-gpu-hub.git` — `refs/heads/master` **и**
`refs/remotes/github/master` = `7c7778c` (синхронизированы) — **не изменены**.

---

## 5. Технические блокеры, закрываемые ДО первого `git filter-repo`

### 5.1 Найдены в этой ревизии (закрываются документацией/P1)

| # | Блокер | Почему это блокер | Где закрыт |
|---|---|---|---|
| **I-16** | В новых bare **нет remote `github`** — ни один документ не содержит `git remote add github` (проверено grep'ом по `docs/`) | `post-receive` выполняет `git push --mirror github` → падение «no such remote» на **первом push**; зеркало GitHub не появится, а `git ls-remote https://…` вернёт пустоту → оператор ложно сочтёт push провальным. Не блокирует сам `filter-repo`, но ломает шаг «первый push» | §2.1 / §2.3 (P1); добавлено в чеклист §6 |
| **I-17** | Репозиторий на GitHub **не пустой** (README/LICENSE/`.gitignore`) | первый push = non-fast-forward → единственный выход — `--force`, а **force-push запрещён** | §2.1 «Пустота до первого push»; чеклист §6 |
| **I-18** | Push-права SSH-ключа на **новые** репо не гарантированы | `post-receive` ходит по `git@github.com:` ключом `~/.ssh/github_ed25519` (читает org — проверено: `HEAD = 64127b9e`). Если репозитории создаст **другой** GitHub-аккаунт без прав для этого ключа — mirror будет отклонён | §2.1 (visibility/создание тем же аккаунтом), §2.3 п.3 |

### 5.2 Проверено и **не** является блокером

| Кандидат | Проверка | Вывод |
|---|---|---|
| `git reset --hard` + reflog → abort sanity-check | фактический клон `$BARE`: 1 запись → после `reset --hard $SRC` **2 записи** (`WOULD ABORT`) → после `git reflog expire --expire=now --all` **0 записей** | **был блокер**, закрыт в §4.1.0 (I-1) |
| `packs > 1` / `count >= 100` → «expected freshly packed repo» | фактический `clone --no-local`: `packs: 1`, `count: 0` | **не блокер** |
| `P4` — пустой untracked-каталог `workflow.json` (`drwxr-xr-x root root`) | `git clone` не копирует untracked/пустые каталоги; в клоне `git ls-files -o` пуст | **не блокирует `filter-repo`**; остаётся гигиеной чекаута (для `rmdir` нужен `sudo`, владелец каталога — root) |
| `tmp/parser-audit-backup` (`db5ff61f`) есть в `$BARE` | `clone --single-branch --branch $BRANCH` (проверено на фактическом клоне) переносит **только** эту ветку; новый bare получает только `refs/heads/$NEWBRANCH` | **не создаёт лишнюю ref**; удаление ветки остаётся отдельным решением владельца (деструктивно, не требуется для split) |
| `refs/remotes/github/*` в `$BARE` | fetch-рефспек клона = `+refs/heads/*:refs/remotes/origin/*` → `refs/remotes/*` источника не переносятся | **не блокер** |
| `master` != `$NEWBRANCH` | `git init --bare` → HEAD `refs/heads/master`; `symbolic-ref` до push уже в §4.1.x | закрыто (I-11) |
| версия / ancestry / чистота | `git-filter-repo 2.47.0`; `merge-base --is-ancestor $SRC $BRANCH` = **YES**; `status` клона = 0; только remote `origin` | **готово** |

---

## 6. Финальный GO/NO-GO checklist

**Все пункты обязательны. Один FAIL = не запускать первый `git filter-repo`.**
Проверяются **в порядке таблицы**, команды — read-only.

| # | Пункт | Команда проверки | Ожидание | Статус |
|---|---|---|---|---|
| **GO-01** | **P1** — 4 репозитория существуют и пусты | `curl -s https://api.github.com/repos/Animastor/<name>` | 4 × 200; `size=0`, `pushed_at=null`, `default_branch=""`, `private=false` | **BLOCKED** (4 × 404) |
| **GO-02** | **P1** — 4 bare подготовлены | `test -d /home/animastor/repos/<name>.git` | существует **до** push | **BLOCKED** |
| **GO-03** | **hooks** — `post-receive` в каждом bare | `test -x "$NEW/hooks/post-receive" && test "$(wc -c < "$NEW/hooks/post-receive")" -eq 91` | 0755, 91 байт, содержимое §2.2 | **BLOCKED** (требует GO-02) |
| **GO-04** | **hooks** — remote `github` настроен (**I-16**) | `git -C "$NEW" config --get remote.github.url` | `git@github.com:Animastor/<name>.git` | **BLOCKED** (требует GO-02) |
| **GO-05** | **NEWBRANCH** зафиксирован и согласован | `echo "$NEWBRANCH"`; `grep NEWBRANCH docs/architecture/repository-split-next-blockers.md` | одна переменная, значение подтверждено владельцем; `git -C "$NEW" symbolic-ref HEAD` == `refs/heads/$NEWBRANCH` | значение есть (`main`), **подтверждение владельца не выполнено** |
| **GO-06** | **P6** — диск | `df -B1 /` | `avail` ≥ задокументированного порога `5 368 709 120` (или ≥ `1 073 741 824` после явной перебазировки порога владельцем) | **FAIL** — `2 966 122 496 B`; измеренный минимум покрыт (**2.76×**), порог ≥5G — нет |
| **GO-07** | **R-3** — вариант зафиксирован | решение владельца | записано `A` или `B` | **UNDECIDED** |
| **GO-08** | **backup** монорепо | `test -d "$BK" && git -C "$BK" rev-parse 64127b9e…^{commit}"` | exit 0; `$BK` = `backups/animastor-pre-split-64127b9e.git` | **не выполнялся** (стадия B) |
| **GO-09** | **backup/freeze GPU Hub** (только при R-3 = B) | mirror в `backups/animastor-gpu-hub-pre-split.git` + `hooks/post-receive` переименован | оба подтверждены владельцем | **не выполнялся** (требует GO-07) |
| **GO-10** | **frozen SHA** | `git -C "$BARE" rev-parse 64127b9e…^{commit}"` == `$SRC`; `git -C "$BARE" rev-parse refs/heads/master` == `$SRC` | exit 0 | **READY** (P2 CLOSED) |
| **GO-11** | **clean tree** монорепо | `git status --porcelain` | 0 строк | **READY** |
| **GO-12** | **git-filter-repo 2.47.0** | `python3 -c "import importlib.metadata as m; assert m.version('git-filter-repo')=='2.47.0'"` | exit 0 | **READY** |
| **GO-13** | **empty split directories** | `test ! -e /tmp/split/{backend,web,android,worker,gpu-hub}` | exit 0 (каталог `/tmp/split` может существовать, но быть **пустым**) | **READY** (`/tmp/split` отсутствует) |
| **GO-14** | **monorepo refs unchanged** — фиксация ДО старта | `BEFORE=$(git -C "$BARE" for-each-ref --format='%(objectname) %(refname)' \| sort)` | значение сохранено; **после каждого репо** сверяется `AFTER` (§4.1.0) | выполняется на стадии B |
| **GO-15** | ancestry / whitelist / SSH | `merge-base --is-ancestor $SRC $BRANCH`; `git ls-tree -r --name-only $SRC \| wc -l`; `git ls-remote git@github.com:Animastor/animastor.git HEAD` | YES; 1635; `64127b9e…` | **READY** (все три проверены) |

**Текущее состояние: GO-01…GO-04 = BLOCKED · GO-06 = FAIL · GO-07 = UNDECIDED ·
GO-08/GO-09 = не выполнялись → итоговый вердикт `NO-GO`.**

**GO** наступает только после: закрытия P1 (GO-01…GO-04, GO-05),
закрытия P6 (GO-06) и фиксации R-3 (GO-07), выполнения стадии B
(GO-08, при B — GO-09) и GO-14.

---

## 7. Verification log (read-only, эта сессия)

| Проверка | Результат |
|---|---|
| `df -B1 /` | avail `2 966 122 496 B`, 98 % |
| `du -sb` bare / backups | `34 243 705` / `273 015` / `2 933 881 591` |
| `git count-objects -v` в `$BARE` | `packs 4`, `size-pack 22 797 KiB`, loose 1689 / 14 052 KiB |
| GitHub API GET ×6 | `animastor` 200 (public, master) · `gpu-hub` 200 (public, master, `7c7778c`) · **backend/web/android/worker = 404** |
| `git ls-remote https://github.com/Animastor/animastor.git` | `64127b9e…` (public, без credentials) |
| `git ls-remote git@github.com:Animastor/animastor.git HEAD` | `64127b9e…` → SSH-ключ `~/.ssh/github_ed25519` авторизован в org |
| свежий клон `$BARE` (временный, удалён) | `.git 22 588 454` · worktree `29 559 927` · `packs 1 / count 0` · reflog 1+1 · status 0 · remote `origin` |
| `reset --hard $SRC` в этом клоне | reflog **2+2** → «expected at most one entry» срабатывает |
| `git reflog expire --expire=now --all` | reflog **0** → sanity проходит |
| `merge-base --is-ancestor $SRC $BRANCH` | **YES** |
| `python3 -c "… version('git-filter-repo')"` | **2.47.0** |
| hook'и монорепо и gpu-hub | идентичны, 91 байт, `0755`, `git push --mirror github`; в обоих bare есть remote `github` |
| `git remote add github` в `docs/` | **не найдено** → **I-16** |
| `workflow.json` | пустой каталог `root:root`, untracked |
| `/tmp/split`, `$BK` | отсутствуют |
| временный клон | удалён; диск восстановлен |

---

## 8. NOT EXECUTED

**PHYSICAL SPLIT: NOT EXECUTED · git filter-repo: NOT EXECUTED ·
force-push: NOT EXECUTED · GitHub-репозитории: NOT CREATED ·
`master`: NOT MODIFIED · `Animastor/animastor-gpu-hub` / bare
`animastor-gpu-hub.git`: NOT MODIFIED · hooks: NOT MODIFIED ·
npm publish: NOT EXECUTED · R-3: НЕ ВЫБРАН · очистка диска: НЕ ВЫПОЛНЯЛАСЬ.**

Изменены только `docs/architecture/*.md` — одним docs-only commit'ом.
