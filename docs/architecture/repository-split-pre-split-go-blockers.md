# Repository Split — PRE-SPLIT GO-BLOCKERS (P1 · P6 · R-3 · GO/NO-GO)

> **BACKEND: PHYSICAL SPLIT EXECUTED / PUBLISHED (2026-10-04)** —
> GO-01…GO-15 перепроверены **перед** запуском (все PASS/READY/CLOSED/N/A, 0 FAIL),
> затем §4.1.0 + §4.1.1 исполнены: `git filter-repo` (35 `--path`) →
> **1045 файлов / 1267 коммитов / leak 0** → первый push **БЕЗ force** →
> post-receive hook → `Animastor/animastor-backend` **`main` = bare = `f83f929c732d8fc490bd150e72294d6b3c6e2f92`**
> (GitHub: ровно 2 refs, лишних нет). Журнал — `repository-split-execution-pack.md` **§11**.
> **web / android / worker: PHYSICAL SPLIT NOT EXECUTED** (3 bare = 0 refs / 0 objects,
> GitHub = 0 refs) · **gpu-hub: НЕ ИСПОЛНЯЕТСЯ (R-3 = A)**
> **git filter-repo для web/android/worker/gpu-hub: NOT EXECUTED**
> **force-push: NOT EXECUTED ни для одного репозитория**
> **`master` / `Animastor/animastor-gpu-hub` / hooks / backup / BEFORE-snapshot /
> `tmp/parser-audit-backup`: NOT MODIFIED** · npm publish: NOT EXECUTED
> **R-3 = A (SELECTED) · R-3 = B: REJECTED** · очистка диска: НЕ ВЫПОЛНЯЛАСЬ ·
> **P6 = CLOSED / PASS (2026-10-04) · P1 = CLOSED (2026-10-04, GO-01…GO-04)**
> **GO-05 = CLOSED (2026-10-04, NEWBRANCH=main — owner-confirmation) ·
> GO-08 = CLOSED (2026-10-04, durable backup `animastor-pre-split-64127b9e.git`) ·
> GO-14 = CLOSED (2026-10-04, BEFORE-snapshot refs `animastor.git` + `animastor-gpu-hub.git`)**

> **Статус документа: подготовка, документация, стадия B и стадия C (backend).**
> Подготовительные числа ниже получены **read-only** (`df`, `du`,
> `git count-objects`, `git clone` во временный каталог
> `/tmp/opencode/split-measure` — удалён сразу после измерения,
> `git ls-remote`, GitHub API GET, чтение исходников `git_filter_repo.py`).
> Ранее эта ревизация добавляла **только** артефакты стадии B в **новые**
> каталоги `backups/` (GO-08, GO-14, §7.1). **Стадия C (2026-10-04)** читала
> этот чеклист как preflight (§6) и писала **только** в **новый**
> bare `animastor-backend.git` + GitHub `Animastor/animastor-backend`;
> монорепо (`master`, refs), GPU Hub, hook'и, backup, snapshot,
> `tmp/parser-audit-backup` и 3 оставшихся bare **не изменялись**.

Связанные документы:
`repository-split-final-gate.md` (авторитетный GO/NO-GO),
`repository-split-execution-pack.md` (per-repo spec, аудит командного листа),
`repository-split-next-blockers.md` §4.1 (исполняемый командный лист),
`repository-split-r3-decision.md` (**решение R-3 = A**; вариант B — REJECTED;
`repository-split-pre-split-fixes.md` §5 — историческая запись B).

---

## 1. Сводка статусов

| ID | Блокер | Статус | Кто закрывает |
|---|---|---|---|
| **P1** | 4 GitHub-repo + 4 bare + hook + remote `github` | **CLOSED (2026-10-04, вторая ревизия)** — **GitHub**: API **4 × HTTP 200**, `size=0`, **0 refs** (`git ls-remote` ssh rc=0), `default_branch=main`, `private=false`, созданы 2026-10-03T23:53–23:55Z. **VPS**: созданы **4 bare** `/home/animastor/repos/animastor-{backend,web,android,worker}.git` — 0 refs / 0 objects, `HEAD = refs/heads/main`, hook `post-receive` **0755 / 91 байт / byte-identical** шаблону (sha256 `6a63cb14…`), remote `github` настроен → **GO-01…GO-04 = READY/CLOSED**. **Push не выполнялся до стадии C** → **2026-10-04: backend push ВЫПОЛНЕН (без force)**, web/android/worker остаются 0 refs / 0 objects, GitHub 0 refs | закрыто (подготовительная стадия) + backend — стадия C |
| **P6** | диск ≥ задокументированного порога | **CLOSED / PASS (2026-10-04)** — `df -B1 /` → avail **`6 839 934 976 B`** ≥ `5 368 709 120 B` (≥5G) → **1.27×** порога и **6.4×** измеренного минимума (**431 MB** пик / **1 GiB** минимум). **Очистка не выполнялась и не требуется** (перебазировка порога не понадобилась). Историческое pre-cleanup: `2 966 122 496 B` (2026-10-03, **FAIL**) — только audit trail | **нет** |
| **R-3** | A (сохранить) / B (заменить) GPU Hub | **CLOSED — A (SELECTED), B = REJECTED** (`repository-split-r3-decision.md`); `Animastor/animastor-gpu-hub` = 200, `7c7778c`, **не изменён и не будет меняться** | закрыто |
| **GO-05** | `NEWBRANCH` подтверждён владельцем | **CLOSED (2026-10-04)** — **`NEWBRANCH=main`**. Owner-confirmation: письменное указание владельца в задаче этого этапа («NEWBRANCH=main», «зафиксировать в docs явное owner-confirmation») зафиксировано здесь; фактическая сверка выполнена read-only: GitHub API `default_branch=main` у **4/4** репо, `git symbolic-ref HEAD = refs/heads/main` у **4/4** новых bare | закрыто |
| **GO-08** | durable backup монорепо (стадия B) | **CLOSED (2026-10-04)** — `git clone --mirror --no-local /home/animastor/repos/animastor.git /home/animastor/backups/animastor-pre-split-64127b9e.git` = **22 431 724 B**, содержит `$SRC` (1653 коммитов / 1635 файлов), `fsck` чисто, refs **6/6 на момент создания** (`master` и `tmp/parser-audit-backup` == `$BARE` и после; docs-ветка в backup — снимок момента создания), **restore-дрилл пройден** (fetch в чистый bare + checkout worktree: `master = 64127b9e`, 1635 файлов, status 0). `$BARE` не писался | закрыто (стадия B) |
| **GO-14** | BEFORE-snapshot refs до split | **CLOSED (2026-10-04)** — read-only snapshot `/home/animastor/backups/before-split-64127b9e-refs/` (только `animastor.git` и `animastor-gpu-hub.git`): refs, HEAD, config, count-objects, hook sha256 + `MANIFEST.sha256` (проверен), режим 0444/0555. `gpu-hub master/HEAD = 7c7778c6…` зафиксирован; **новый GPU Hub не создавался, filter-repo/push не выполнялись** | закрыто (стадия B) |
| **I-16** | в новых bare нет remote `github` → hook `git push --mirror github` упадёт | **НАЙДЕН В ЭТОЙ РЕВИЗИИ** — закрывается в P1, до первого push | закрывается в P1 |
| **STAGE-C** | физический split backend (стадия C, шаг 1/4) | **CLOSED / PUBLISHED (2026-10-04)** — GO-01…GO-15 перепроверены перед запуском (0 FAIL), §4.1.0 + §4.1.1 исполнены: `filter-repo` 35 `--path` → **1045 / 1267 / leak 0 / fsck / clean / корень `Recovery01`** → первый push **без force** → hook → GitHub = bare = **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`**; монорепо/GPU Hub/backup/snapshot **BEFORE == AFTER**. Журнал: `execution-pack` §11 | закрыто (стадия C, backend) |
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
| **default branch** | на момент создания — **не задан** (репо без коммитов); фактическое имя задаётся **первым push** | **Факт 2026-10-04:** GitHub API возвращает `default_branch="main"` (предпочтение аккаунта), `size=0`, **0 refs** (`git ls-remote` пусто), `pushed_at=2026-10-03T23:5x:xxZ` (= created_at — API заполняет его уже при создании; **`pushed_at=null` не наблюдается**, поэтому критерий пустоты — `size=0` **и** 0 refs). После первого push — проверить `default_branch == $NEWBRANCH`, при расхождении `PATCH /repos/Animastor/<name>` с `{"default_branch":"$NEWBRANCH"}` |
| **NEWBRANCH** | `$NEWBRANCH` из §4.1.0 (**сейчас `main`**) — **единственный** источник имени ветки | §FPSG.5 Этап 1 упоминает `master` (историческая запись), матрица §B9.2 триггеры — `main`; правится **только** переменная `$NEWBRANCH`. В `git init --bare` ветка по умолчанию `master` (`init.defaultBranch` не задан) → **обязательна** строка `git -C "$NEW" symbolic-ref HEAD "refs/heads/$NEWBRANCH"` **до** push (уже в §4.1.x) |
| **Пустота до первого push** | **ничего не добавлять**: без README, LICENSE, `.gitignore`, без `git init`, без веток | иначе первый push = non-fast-forward → потребуется `--force`, а **force-push запрещён**. Признаки «пусто» (актуальные, 2026-10-04): **`size = 0` и `git ls-remote` возвращает 0 refs**, `contents` пусто/404. *(`pushed_at = null` / `default_branch = ""` — исторические признаки, фактически не выполняются: API отдаёт `pushed_at = created_at`, `default_branch = main`)* |
| **Порядок создания** | 1 `animastor-backend` → 2 `animastor-web` → 3 `animastor-android` → 4 `animastor-worker` | равен очереди split §FINAL SPLIT HANDOFF §4 (**backend → web → android → worker**; слот `gpu-hub` **удалён — R-3 = A**). GPU Hub в этот список **не входит** |
| **Bare на VPS** | `/home/animastor/repos/animastor-{backend,web,android,worker}.git` — `git init --bare` | в §4.1.x есть guard `test -d "$NEW" \|\| git init --bare`, но bare **обязан быть уже подготовлен** (hook + remote) **до** первого push. **Статус 2026-10-04 (вторая ревизия): СОЗДАНЫ** — `/home/animastor/repos/` = `animastor.git`, `animastor-gpu-hub.git` **+ 4 новых bare** (0 refs / 0 objects, `HEAD=refs/heads/main`, hook + remote `github`) → **GO-02/GO-03/GO-04 = CLOSED**; **push не выполнялся** |
| **expected hook** | `hooks/post-receive`, **0755**, **91 байт**, байт-в-байт как в монорепо и в `animastor-gpu-hub` | см. §2.2. **Факт 2026-10-04:** во всех 4 новых bare mode **0755**, 91 байт, `cmp` с шаблоном — **байт-в-байт идентичны**; mode самого шаблона — **775** (отличие только в group-write бите; содержимое идентично) |
| **remote `github`** | `git remote add github git@github.com:Animastor/<name>.git` — **обязателен до первого push** | см. **I-16** §5.1 |

### 2.2 Точный hook (91 байт)

```sh
#!/bin/sh

cd "$GIT_DIR" || exit 1

echo "Mirroring to GitHub..."
git push --mirror github
```

Сверка: `wc -c` = 91; `git -C /home/animastor/repos/animastor.git/hooks/post-receive`
и `…/animastor-gpu-hub.git/hooks/post-receive` — идентичны (сверено read-only);
`sha256 = 6a63cb14a1f76ca1a87de81cc54a1a46361ee11c224741fe3ea234d421a3130c`.
**2026-10-04:** этот же файл скопирован **без изменений** в 4 новых bare
(`install -m 0755`), `cmp` → идентичны; **hooks монорепо и GPU Hub не изменялись**
(BEFORE == AFTER по `post-receive`).

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
не делает force-push, не публикует npm; hub-CI авторится **в существующем**
`Animastor/animastor-gpu-hub` (R-3 = A — `repository-split-r3-decision.md`),
а не в новом репо.

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
| split-backup `animastor-pre-split-64127b9e.git` | `test -d` | **отсутствовал** на момент этого аудита (стадия B не выполнялась) → **создан 2026-10-04** (GO-08 = CLOSED, см. §7.1) |
| `/tmp/split` | `test -d` | **отсутствует** (ничего не фильтровалось) |
| **Фактический свежий клон** | `git clone --no-local --single-branch --branch $BRANCH $BARE` во временный каталог (удалён) | **`.git = 22 588 454 B`**, **worktree = 29 559 927 B**, **итого = 52 148 381 B**; `packs: 1`, `count: 0` (условие sanity ✓), reflog `HEAD` = 1 и ветка = 1 запись, `status` = 0, единственный remote = `origin` |
| Tracked-байты на source | `git ls-tree -r -l $SRC` | `28 304 169 B` |

### 3.2 Оценка места под весь split

Модель (консервативная; клон содержит **полную** историю монорепо, т.к. `--single-branch`
берёт ветку `$BRANCH` целиком):

| Компонент | На 1 репо | ×4 репо | ~~×5 (R-3 = B)~~ — **не применяется (A)** |
|---|---|---|---|
| рабочий клон (факт. измерение) | 52 148 381 | 208 593 524 | 260 741 905 |
| новый bare (≤ размера `.git` клона) | 22 588 454 | 90 353 816 | 112 942 270 |
| transient во время `filter-repo` (старые + новые объекты **до** `git gc --prune=now`, выполняется cleanup'ом filter-repo) — **на одном репо за раз** | 22 588 454 | 22 588 454 | 22 588 454 |
| backup монорепо (`git clone --mirror $BARE $BK`) | — | 34 243 705 | 34 243 705 |
| ~~backup GPU Hub~~ | — | — | **0 — не нужен** (R-3 = A: существующий bare не пишется) |
| **ПИК** | | **355 779 499 B (≈356 MB)** | **430 789 349 B (≈431 MB)** |
| + страховка на повтор/незавершённый клон (2 × 52 148 381) | | 460 076 261 | 535 086 111 |

### 3.3 Минимальный безопасный запас

| Порог | Значение | Обоснование |
|---|---|---|
| **Измеренный пик** | `430 789 349 B` (замер на плане **5** репо; при R-3 = A фильтруется **4** → потребность не больше) | §3.2 |
| **Измеренный пик + страховка** | `535 086 111 B` | оставлено 2 незавершённых клона |
| **Минимальный безопасный запас (рекомендация)** | **`1 073 741 824 B` (1 GiB)** | ≈2× пика со страховкой; покрывает пик + headroom на `/tmp`-мусор |
| **Задокументированный порог (§P6, final-gate)** | `5 368 709 120 B` (**≥5G**), рекомендуется ≥8G | консервативная оценка, сделанная до измерений («73M `.git` × 5» — фактический `.git` клона **22.6 MB**, а не 73M) |

### 3.4 Статус P6 и что решает владелец

**Актуальный статус (2026-10-04): P6 = CLOSED / PASS — порог ≥5G выполнен
без очистки.**

- **P6 = PASS** относительно задокументированного порога **≥5G**:
  `6 839 934 976 ≥ 5 368 709 120` (`df -B1 /`, перепроверка 2026-10-04;
  `df -h /` → 6.4G; владелец фиксировал 6.5G) → **1.27×** порога,
  **6.4×** измеренного минимума.
- **P6 = PASS** относительно измеренного минимума **1 GiB**: `6 839 934 976 ≈ 6.4 ×`
  минимума.
- **Ничего не удалялось и удалять не требуется.** Кандидаты очистки из §3.1–§3.2
  (`pip cache purge` ≈4.4G, `npm cache clean --force` ≈0.8G, `/tmp`-мусор ≈1.4G)
  **отзываются как не нужные**; выполнять — только по отдельному распоряжению
  владельца. Каталог `backups/` (2.93 GB) — **не трогать** (страховочный архив).
- ~~**Решение за владельцем:** (а) освободить ≥5G / (б) перебазировать порог~~ —
  **больше не требуется**: вариант (а) фактически достигнут (6.4G ≥ 5G) без
  вмешательства. Перебазировка порога на `1 073 741 824 B` **не понадобилась**.
- **Историческое состояние** (сохранено для audit trail): preflight 2026-10-03 —
  `2 966 122 496 < 5 368 709 120` = **FAIL** (0.55× порога, 2.76× минимума).

---

## 4. R-3 — сравнение вариантов A и B (GPU Hub)

**Решение: A = SELECTED, B = REJECTED** — нормативный документ
`repository-split-r3-decision.md`. Таблица ниже сохранена как **история
сравнения**; колонка B — **REJECTED / NOT SELECTED**.
Дополнительно: `repository-split-pre-split-fixes.md` §5,
`repository-split-next-blockers.md` §R-3.

| Критерий | **A — сохранить существующий GPU Hub ✅ SELECTED** | **B — backup/freeze и заменить историей monorepo ⛔ REJECTED** |
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
| Статус | **✅ SELECTED (решение зафиксировано)** | **⛔ REJECTED / NOT SELECTED — НЕ ИСПОЛНЯТЬ** |

`Animastor/animastor-gpu-hub`: HTTP 200, `private=false`, `default_branch=master`,
`size=105`, `pushed 2026-09-06T18:07:10Z`, HEAD `7c7778c`; bare
`/home/animastor/repos/animastor-gpu-hub.git` — `refs/heads/master` **и**
`refs/remotes/github/master` = `7c7778c` (синхронизированы) — **не изменены**.

---

## 5. Технические блокеры, закрываемые ДО первого `git filter-repo`

### 5.1 Найдены в этой ревизии (закрываются документацией/P1)

| # | Блокер | Почему это блокер | Где закрыт |
|---|---|---|---|
| **I-16** | ~~В новых bare **нет remote `github`**~~ → **ЗАКРЫТ (2026-10-04)**: `remote.github.url = git@github.com:Animastor/<name>.git` настроен во **всех 4** bare **до** push | `post-receive` выполняет `git push --mirror github`; раньше — падение «no such remote» на первом push. **Теперь remote есть**, но сам push **не выполнялся** → зеркалирование проверится только при первом push | **закрыто** (§2.1 / §6 = **GO-04 = READY**) |
| **I-17** | Репозиторий на GitHub **не пустой** (README/LICENSE/`.gitignore`) | первый push = non-fast-forward → единственный выход — `--force`, а **force-push запрещён** | **условие выполнено (2026-10-04):** 4 × `size=0` / 0 refs, новые bare 0 refs / 0 objects; **повторить проверку непосредственно перед первым push** |
| **I-18** | Push-права SSH-ключа на **новые** репо не гарантированы | `post-receive` ходит по `git@github.com:` ключом `~/.ssh/github_ed25519` (читает org — проверено: `HEAD = 64127b9e`, `ls-remote` новых репо rc=0). Если репозитории создаст **другой** GitHub-аккаунт без прав для этого ключа — mirror будет отклонён | read-права **подтверждены**; **push-права проверяются при первом push** (никаких push в этом задании не выполнялось) |

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
| **GO-01** | **P1** — 4 репозитория существуют и пусты | `curl -s https://api.github.com/repos/Animastor/<name>`; `git ls-remote git@github.com:Animastor/<name>.git` | 4 × 200; **`size=0` и 0 refs**; `private=false` (`pushed_at`/`default_branch` — см. §2.1, фактически `pushed_at=created_at`, `default_branch=main`) | **READY (2026-10-04)** — 4 × **200**, `size=0`, **0 refs**, `private=false`, `default_branch=main`, созданы 2026-10-03 |
| **GO-02** | **P1** — 4 bare подготовлены | `test -d /home/animastor/repos/<name>.git` | существует **до** push | **CLOSED (2026-10-04)** — 4 bare созданы: **0 refs / 0 objects**, пустые; `HEAD=refs/heads/main` |
| **GO-03** | **hooks** — `post-receive` в каждом bare | `test -x "$NEW/hooks/post-receive" && test "$(wc -c < "$NEW/hooks/post-receive")" -eq 91` | 0755, 91 байт, содержимое §2.2 | **CLOSED (2026-10-04)** — 4 × mode **0755**, **91 байт**, `cmp` с hook'ом монорепо (шаблон §2.2) → байт-в-байт идентичны (sha256 `6a63cb14…`); hook'и существующих bare **не трогались** (BEFORE == AFTER) |
| **GO-04** | **hooks** — remote `github` настроен (**I-16**) | `git -C "$NEW" config --get remote.github.url` | `git@github.com:Animastor/<name>.git` | **READY (2026-10-04)** — 4 × `remote.github.url` = `git@github.com:Animastor/<name>.git`; **push не выполнялся**, зеркалирование проверится при первом push (hook только на receive) |
| **GO-05** | **NEWBRANCH** зафиксирован и согласован | `echo "$NEWBRANCH"`; `grep NEWBRANCH docs/architecture/repository-split-next-blockers.md` | одна переменная, значение подтверждено владельцем; `git -C "$NEW" symbolic-ref HEAD` == `refs/heads/$NEWBRANCH` | **CLOSED (2026-10-04)** — **`NEWBRANCH=main`** подтверждён владельцем **письменно** (задача владельца этого этапа); сверка: GitHub `default_branch=main` ×4, `symbolic-ref HEAD = refs/heads/main` ×4, `$NEWBRANCH` — одна переменная (`next-blockers` §4.1.0). Owner-confirmation зафиксирован в §7 |
| **GO-06** | **P6** — диск | `df -B1 /` | `avail` ≥ задокументированного порога `5 368 709 120` | **CLOSED / PASS (2026-10-04)** — `6 839 934 976 B` ≥ `5 368 709 120` (**1.27×** порога, **6.4×** минимума); очистка не выполнялась и не требуется; историческое `2 966 122 496 B` (2026-10-03) = FAIL → только audit trail. **Аудит (та же ревизия):** `6 737 682 432 B` = **1.25×** — значение колеблется, источник истины — команда `df -B1 /` перед запуском |
| **GO-07** | **R-3** — вариант зафиксирован | решение владельца | записано `A` или `B` | **READY = A (SELECTED)**; B = REJECTED |
| **GO-08** | **backup** монорепо | `test -d "$BK" && git -C "$BK" rev-parse 64127b9e…^{commit}"` | exit 0; `$BK` = `backups/animastor-pre-split-64127b9e.git` | **CLOSED (2026-10-04)** — `$BK` создан (`git clone --mirror --no-local`, 22 431 724 B, независимая копия — 0 общих inode'ов с `$BARE`); `rev-parse $SRC` = `$SRC`; `fsck` чисто; refs 6/6 на момент создания, `master`/`tmp/parser-audit-backup` == `$BARE` (docs-ветка — снимок момента создания); restore-дрилл OK (см. §7) |
| **GO-09** | ~~backup/freeze GPU Hub~~ | — | — | **NOT APPLICABLE (R-3 = A)** — существующий GPU Hub не пишется, откат не нужен; пункт исключён из GO-условий |
| **GO-10** | **frozen SHA** | `git -C "$BARE" rev-parse 64127b9e…^{commit}"` == `$SRC`; `git -C "$BARE" rev-parse refs/heads/master` == `$SRC` | exit 0 | **READY** (P2 CLOSED) |
| **GO-11** | **clean tree** монорепо | `git status --porcelain` | 0 строк | **READY** |
| **GO-12** | **git-filter-repo 2.47.0** | `python3 -c "import importlib.metadata as m; assert m.version('git-filter-repo')=='2.47.0'"` | exit 0 | **READY** |
| **GO-13** | **empty split directories** | `test ! -e /tmp/split/{backend,web,android,worker,gpu-hub}` | exit 0 (каталог `/tmp/split` может существовать, но быть **пустым**) | **PASS на preflight 2026-10-04** (`/tmp/split` отсутствовал) → **после стадии C** `/tmp/split/backend` существует (рабочий клон извлечения); `web`/`android`/`worker`/`gpu-hub` отсутствуют |
| **GO-14** | **monorepo refs unchanged** — фиксация ДО старта | `BEFORE=$(git -C "$BARE" for-each-ref --format='%(objectname) %(refname)' \| sort)` | значение сохранено; **после каждого репо** сверяется `AFTER` (§4.1.0) | **CLOSED (2026-10-04)** — BEFORE сохранён **на диск** для обоих bare: `/home/animastor/backups/before-split-64127b9e-refs/{animastor,animastor-gpu-hub}.git.refs.txt` (+HEAD, config, count-objects, hook sha256, `MANIFEST.sha256`, режим только-чтение); `diff` с живыми refs = пусто на момент снятия. **После каждого репо** — та же команда (§4.1.0) |
| **GO-15** | ancestry / whitelist / SSH | `merge-base --is-ancestor $SRC $BRANCH`; `git ls-tree -r --name-only $SRC \| wc -l`; `git ls-remote git@github.com:Animastor/animastor.git HEAD` | YES; 1635; `64127b9e…` | **READY** (все три проверены) |

#### Распределение пунктов по категориям (перепроверка 2026-10-04)

| Категория | Пункты |
|---|---|
| **CLOSED** (закрыто фактически, подтверждено read-only) | **GO-01** — 4 GitHub-repo 200 / `size=0` / 0 refs · **GO-02** — 4 bare созданы (0 refs, 0 objects) · **GO-03** — 4 hook'а 0755/91 байт/byte-identical · **GO-05** — `NEWBRANCH=main`, owner-confirmation (2026-10-04) · **GO-06 (P6)** — 6 839 934 976 B ≥ 5G · **GO-07** (R-3 = A) · **GO-08** — durable backup `animastor-pre-split-64127b9e.git` (2026-10-04) · **GO-09** (N/A при A) · **GO-10** (frozen SHA / `master` == source) · **GO-11** (clean tree) · **GO-12** (`git-filter-repo` 2.47.0) · **GO-13** (`/tmp/split` отсутствует) · **GO-14** — BEFORE-snapshot refs двух bare (2026-10-04) · **GO-15** (ancestry / 1635 / SSH) |
| **READY** (проверено, исполнения не требует) | **GO-04** — remote `github` настроен в 4 bare |
| **BLOCKED** (нужен владелец/внешнее) | **P3** npm E401 (post-split publish, не в GO-таблице) · **авторизация стадии C для web/android/worker** |
| **NOT YET EXECUTED** (сознательно не выполнялось) | **физический split web / android / worker** · **`git filter-repo` для web/android/worker/gpu-hub** · **force-push (вообще)** · push в оставшиеся 3 bare/GitHub · **P4-гигиена** · удаление `tmp/parser-audit-backup` · авторинг workflows · `npm publish` |

**Итоговый вердикт: BACKEND = SPLIT / PUBLISHED (2026-10-04); web/android/worker
— авторизация стадии C НЕ выдана (NO-GO для них).** Сняты: **P1 = CLOSED**
(GO-01…GO-04), **P6 (GO-06 = CLOSED/PASS)**, **R-3 (GO-07 = READY A)**,
**GO-05 = CLOSED (`NEWBRANCH=main`)**, **стадия B = ВЫПОЛНЕНА (GO-08 + GO-14)**,
и **стадия C для backend = ВЫПОЛНЕНА** (preflight GO-01…GO-15 перепроверен фактами
**перед** запуском — 0 FAIL; затем §4.1.0 + §4.1.1 → `filter-repo` 35 `--path` →
1045/1267/leak 0/fsck/clean/root `Recovery01`/`--follow` 5/5 → первый push **без
force** → hook → GitHub/bare parity `f83f929c…`; монорепо/GPU Hub/backup/snapshot
**BEFORE == AFTER** — журнал `repository-split-execution-pack.md` **§11**).
**Осталось:** **отдельная авторизация физического split'а** для web/android/worker
(шаги 2–4), плюс вне-таблица P3 (npm E401), P4-гигиена, P5-интерпретация и решение
по `tmp/parser-audit-backup`.
**FINAL PRE-SPLIT AUDIT (2026-10-04, эта ревизия) = PASS** — все **GO-01…GO-15**
перепроверены **фактами** (API/`ls-remote`/`for-each-ref`/`df`/`fsck`/метаданные,
не документацией); dry-run execution-plan: §3.1 **8/8**, корни коммитов **4/4**,
leak **0×4**, coverage **1615/1635** (20 не покрыто = только gpu-hub), overlaps
**52 = намеренные дубли**, `bash -n` листа **6/6**; в командный лист добавлены
guard'ы (пустой bare, `origin == $NEW`, `check_bare_snapshot`) — подробности
`repository-split-execution-pack.md` §9. **Технических BLOCKER'ов не найдено.**
**PHYSICAL SPLIT (backend) / `git filter-repo` (backend) / первый push без force
= EXECUTED (2026-10-04)** — журнал `repository-split-execution-pack.md` **§11**;
**для web / android / worker и для gpu-hub эти операции остаются NOT EXECUTED
до отдельной авторизации владельцем; force-push не выполнялся нигде.**

---

## 7. Verification log

§7 — журнал **read-only** проверок подготовительной сессии; **§7.1** — журнал
этапа GO-05 / GO-08 / GO-14 (2026-10-04): read-only сверки + **стадия B**
(создание backup и BEFORE-snapshot — писали **только** в новые каталоги
`backups/`).

| Проверка | Результат |
|---|---|
| `df -B1 /` (2026-10-03, исторически) | avail `2 966 122 496 B`, 98 % |
| **`df -B1 /` (2026-10-04, эта ревизия)** | total `105 496 965 120`, used `94 139 928 576`, **avail `6 839 934 976 B` ≈6.4 GiB** (`df -h /` → 6.4G) → **P6 PASS**; очистка не выполнялась |
| **GitHub API GET ×4 (2026-10-04)** | `animastor-backend/-web/-android/-worker` = **200**, `private=false`, **`size=0`**, `default_branch=main`, `pushed_at=2026-10-03T23:5x:xxZ` → **GO-01 READY** |
| **`git ls-remote git@github.com:Animastor/<name>.git` ×4 (2026-10-04)** | exit 0, **0 refs** (SSH-ключ авторизован; пустые репо) |
| `ls /home/animastor/repos` (до подготовки, 2026-10-04) | только `animastor.git`, `animastor-gpu-hub.git` → 4 bare отсутствовали (GO-02…GO-04 = BLOCKED) |
| **`git init --bare` ×4 + hook + remote (2026-10-04, эта ревизия)** | созданы `animastor-{backend,web,android,worker}.git`: `refs=0`, `objects=0`, `HEAD=refs/heads/main`, `hooks/post-receive` = **0755 / 91 байт / `cmp` → идентичны шаблону** (sha256 `6a63cb14…`), `remote.github.url = git@github.com:Animastor/<name>.git` → **GO-02 = GO-03 = GO-04 = READY/CLOSED**; **push не выполнялся** |
| **`git -C <new> ls-remote github`** | **0 refs** ×4 — зеркало не тронуто |
| **GitHub API + `ls-remote` после подготовки (2026-10-04)** | 4 × **200**, `size=0`, **0 refs**, `default_branch=main`, `pushed_at` не изменился (`2026-10-03T23:5x:xxZ`) → **GO-01 = READY** |
| **BEFORE/AFTER старых bare (2026-10-04)** | `animastor.git` и `animastor-gpu-hub.git`: `refs`, `for-each-ref`, `HEAD`, `config --local --list`, `count-objects -v`, `hooks/post-receive` (+mode/size) — **14/14 файлов IDENTICAL**; `animastor.master = 64127b9e…`, **`animastor-gpu-hub.master = 7c7778c6…`** — не изменены |
| **`git branch -a`, `git show-ref` (`tmp/parser-audit-backup`)** | `db5ff61f` существует локально, в `origin` и в bare → **не удалена** |
| **`workflow.json`, `frontends/android/docker-compose.yml:41`** | каталог существует; строка mount осталась → **P4 NOT YET EXECUTED** |
| **`.github/` (tree + GitHub API)** | `git ls-tree 64127b9e` → 0 файлов; `Animastor/animastor/contents/.github/workflows` → **404** → **P5 фактически подтверждён** |
| **`npm whoami`** | **E401** → P3 открыт (post-split) |
| **`git rev-parse master` / `origin/master`** | `64127b9e…` == source → **P2/CLOSED, GO-10 READY** |
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
| `/tmp/split`, `$BK` | отсутствовали **до** этой ревизии; **`$BK` создан 2026-10-04** — см. §7.1; `/tmp/split` по-прежнему отсутствует |
| временный клон | удалён; диск восстановлен |

### 7.1 Этап GO-05 / GO-08 / GO-14 (2026-10-04, эта ревизия)

**GO-05 — owner-confirmation (явная фиксация):**

| Поле | Значение |
|---|---|
| **`NEWBRANCH`** | **`main`** |
| **Owner-confirmation** | письменное указание владельца в задаче этого этапа: «NEWBRANCH=main … зафиксировать в docs явное owner-confirmation: NEWBRANCH=main» (2026-10-04) — зафиксировано этим документом; **никакого выдуманного/устного подтверждения не создавалось** |
| Сверка №1 (GitHub) | API GET ×4 → `default_branch = main` у `animastor-backend`, `-web`, `-android`, `-worker` |
| Сверка №2 (VPS) | `git -C /home/animastor/repos/animastor-<name>.git symbolic-ref HEAD` = **`refs/heads/main`** ×4 |
| Сверка №3 (единственная переменная) | `NEWBRANCH` объявлен **один раз** — `repository-split-next-blockers.md` §4.1.0 |

**GO-08 — durable backup (стадия B):**

| Проверка | Результат |
|---|---|
| guard `test ! -e $BK` до создания | `$BK` **отсутствовал** → создан, ничего не перезаписывалось |
| команда | `git clone --mirror --no-local /home/animastor/repos/animastor.git /home/animastor/backups/animastor-pre-split-64127b9e.git` |
| почему `--no-local` | обычный локальный `clone --mirror` **хардлинкует** pack'и (проверено: один inode у источника и клона) — это **не** независимая копия; `--no-local` даёт отдельный pack (**0 общих inode'ов**), т.е. ровно то, чего требует план («отдельная mirror-копия … не hardlink») |
| размер / содержимое | **22 431 724 B**; `rev-parse $SRC` = `64127b9e…` · `refs/heads/master = $SRC` · **1653** коммита · **1635** tracked-файлов |
| `git -C $BK fsck --no-progress` | чисто, 0 ошибок |
| refs `$BK` vs `$BARE` | **IDENTICAL (6/6) на момент создания** (`master=64127b9e`, `c21.4…=0194684e`, `tmp/parser-audit-backup=db5ff61f` + `refs/remotes/github/*`); **аудит 2026-10-04**: `master` и `tmp/parser-audit-backup` по-прежнему дословно совпадают, docs-ветка в `$BARE` продвинулась только docs-only коммитами (`0194684e` → `40f09946` → …) → **ожидаемо, не блокирует** |
| objects | `packs: 1`, `count: 0`, `in-pack: 23075`, `size-pack: 21842 KiB` |
| **restore-дрилл №1** | `git init --bare /tmp/…/drill.git` → `git -C drill fetch $BK '+refs/*:refs/*'` → refs IDENTICAL, `fsck` чисто, `master=64127b9e` |
| **restore-дрилл №2** | `git clone --no-local --single-branch --branch master $BK /tmp/…/wt` → `HEAD=64127b9e`, **status 0**, **1635** файлов → backup пригоден для восстановления |
| временные каталоги дрилла | удалены после проверки |
| `$BARE` после backup | `master=64127b9e`, refs 6, `count: 1743 / packs: 4 / size-pack: 22797` — **не изменился** |
| GPU Hub | **не создавался, не клонировался, не писался** (R-3 = A) |

**GO-14 — BEFORE-snapshot refs (стадия B):**

| Проверка | Результат |
|---|---|
| Каталог | `/home/animastor/backups/before-split-64127b9e-refs/` (создан; режим **0555**, файлы **0444** — только чтение) |
| `animastor.git` | `refs.txt` = **6** строк (`master=64127b9e…`, docs-ветка `c21.4…` (= `40f09946…` после переснятия, см. `SNAPSHOT.txt`), `tmp/parser-audit-backup=db5ff61f…` + `refs/remotes/github/*`); `HEAD.txt` = `refs/heads/master`; `config-local.txt`, `count-objects.txt`, `hooks-post-receive.sha256` (sha256 `6a63cb14…`, mode 775, 91 байт) |
| `animastor-gpu-hub.git` | `refs.txt` = **2** строки (**`master = 7c7778c6f313dad19eb403d8509cd297226ec7ea`**, `refs/remotes/github/master` = тот же); `HEAD.txt` = `refs/heads/master`; hook sha256 `6a63cb14…` |
| Целостность | `MANIFEST.sha256` → `sha256sum -c` = **11/11 OK** |
| Сверка на момент снятия/переснятия | `diff` snapshot ↔ живые refs обоих bare = **пусто**; `HEAD` == snapshot. **Переснят 2026-10-04 после docs-push** (сдвинулась только docs-ветка `0194684e` → `40f09946`, ожидаемо; старое состояние сохранено в `SNAPSHOT.txt` → `pre_refresh:`); `master`/`tmp/parser-audit-backup`/GPU Hub не менялись |
| `SNAPSHOT.txt` | frozen `64127b9e…`, tip docs-ветки (на момент пересечения `40f09946…`, 13 doc-коммитов) + `pre_refresh`-запись (`0194684e…`, 12), `master=64127b9e`, gpu-hub `master/HEAD=7c7778c6`, worktree porcelain = 0, backup size |
| Сверка после каждого репо (стадия C) | `check_bare_snapshot` в `next-blockers` §4.1.0 — неизменяемые refs **дословно**, docs-ветка только **fast-forward** (жёсткое равенство всех 6 refs давало бы ложный FAIL после каждого docs-коммита); команды продублированы в `SNAPSHOT.txt` |
| GPU Hub | snapshot **read-only**; новый GPU Hub **не создавался**, `filter-repo`/push **не выполнялись** |

**Перепроверка непосредственно перед этой ревизией (read-only):** frozen SHA
в `$BARE` = `64127b9e…` · `master` = `origin/master` = `64127b9e…` ·
`git status --porcelain` = 0 строк · 4 новых bare = 0 refs / 0 objects /
`HEAD=refs/heads/main` / hook 0755+91 байт / `remote.github.url` настроен ·
GitHub 4 репо = `size=0` и **0 refs** (`ls-remote`) · hook'и монорепо и GPU Hub
sha256 `6a63cb14…` (не менялись, mtime 2026-08-22 / 2026-09-06) · GPU Hub
`HEAD`/`master` = `7c7778c6…` (bare и GitHub) · `tmp/parser-audit-backup`
`db5ff61f` существует · `/tmp/split` отсутствует · `git filter-repo` не
запускался.

---

### 7.2 Стадия C — backend (2026-10-04, эта ревизия)

Preflight этого чеклиста (§6) перепроверен фактами **непосредственно перед
запуском** — все GO-01…GO-15 PASS/READY/CLOSED/N/A, **0 FAIL**. Затем
исполнены `repository-split-next-blockers.md` §4.1.0 + §4.1.1.

| Проверка | Результат |
|---|---|
| `df -B1 /` перед запуском | avail **6 703 718 400 B** ≥ 5 368 709 120 → GO-06 PASS |
| свежий клон + `reset --hard $SRC` + `update-ref` + `reflog expire` | HEAD = `64127b9e…`, reflog **0 entries**, дерево чистое, 1 remote `origin` |
| `git filter-repo` (35 `--path`, без `--path-rename`/`--force`/`workflow.json`) | **RC=0** |
| AFTER: fsck / файлы / leak / clean / корень / коммиты | **чисто / 1045 / 0 / 0 строк / `Recovery01…` / 1267** → все PASS |
| `git log --follow` ×5 | **5/5 логируются** |
| отсутствие чужих компонентов | `frontends/`, `tools/`, `packages/animastor-{worker,gpu-hub,web-*}`, root `package.json`, `workflow.json` и пр. → **0** |
| bare `$NEW` до push | **0 refs / 0 objects**, `HEAD=refs/heads/main`, hook 0755/91 (`6a63cb14…`), `remote.github.url` настроен → GO-02/03/04 подтверждены **непосредственно перед push** |
| guard `origin == $NEW` + guard пустого bare | **PASS** |
| push | `git push -u origin HEAD:refs/heads/main` **без `--force`**, RC=0 |
| post-receive | `Mirroring to GitHub...` → `* [new branch] main -> main` |
| bare после push | `refs/heads/main = f83f929c…` (+ его же remote-tracking `refs/remotes/github/main`), `fsck` чисто |
| GitHub parity | `ls-remote` = **ровно 2 refs**: `HEAD` = `refs/heads/main` = **`f83f929c732d8fc490bd150e72294d6b3c6e2f92`** = bare; `default_branch=main`, `private=false`, `pushed_at=2026-10-04T08:29:14Z` |
| monorepo `BEFORE == AFTER` | **6 refs IDENTICAL**, `master=64127b9e…`, `tmp/parser-audit-backup=db5ff61f…` → GO-10/GO-14 PASS |
| GPU Hub | refs/HEAD/config/count-objects/hook == snapshot → **не изменён** |
| backup + snapshot | `$BK` **22 431 724 B** не тронут; `MANIFEST.sha256` **11/11 OK**; `tmp/parser-audit-backup` не удалена |
| clone из GitHub (финальный) | clean tree, **1045** файлов, leak **0**, **1267** коммитов, корень `6d12eed3…` «Recovery01…», fsck чисто, lineage от `$SRC` подтверждён |

**СТАТУС BACKEND = SPLIT / PUBLISHED.** Подробный журнал —
`repository-split-execution-pack.md` **§11**.

---

## 8. NOT EXECUTED

**PHYSICAL SPLIT (backend): EXECUTED (2026-10-04) ·
git filter-repo (backend): EXECUTED · первый push без force: EXECUTED ·
push в новые bare/GitHub (только backend): EXECUTED.**
**PHYSICAL SPLIT (web / android / worker): NOT EXECUTED ·
git filter-repo (web / android / worker / gpu-hub): NOT EXECUTED ·
force-push: NOT EXECUTED ни для одного репозитория.**
**GitHub-репозитории этим документом: NOT CREATED
(4 пустых репо созданы владельцем 2026-10-03 вне этих документов;
4 VPS bare подготовлены 2026-10-04) ·
`master`: NOT MODIFIED · `Animastor/animastor-gpu-hub` / bare
`animastor-gpu-hub.git`: NOT MODIFIED · hooks: NOT MODIFIED ·
npm publish: NOT EXECUTED · **R-3 = A (SELECTED) / B = REJECTED** ·
очистка диска: НЕ ВЫПОЛНЯЛАСЬ.**

**Стадия B ВЫПОЛНЕНА (2026-10-04)** — только в новые каталоги `backups/`:
mirror-backup `$BK = backups/animastor-pre-split-64127b9e.git` (GO-08) и
BEFORE-snapshot `backups/before-split-64127b9e-refs/` (GO-14).
`$BARE`, существующий GPU Hub (bare + GitHub), hook'и **не изменялись**;
`tmp/parser-audit-backup` **не удалялась**; P4-cleanup **не выполнялся**.

**Стадия C ВЫПОЛНЕНА (2026-10-04) ТОЛЬКО ДЛЯ BACKEND** — писала **только** в
новый bare `animastor-backend.git` и в `Animastor/animastor-backend`;
монорепо, GPU Hub, hook'и, backup, snapshot и 3 оставшихся bare —
**не изменялись** (§7.2, `execution-pack` §11).

Изменены только `docs/architecture/*.md` — одним docs-only commit'ом.
