# Repository Split — R-3 DECISION: **A (SELECTED)** · **B (REJECTED)**

> **PHYSICAL SPLIT: NOT EXECUTED**
> **git filter-repo: NOT EXECUTED · force-push: NOT EXECUTED**
> **`Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git` /
> hooks / GitHub: NOT MODIFIED · npm publish: NOT EXECUTED ·
> новых GitHub-репозиториев: NOT CREATED**

> **Статус документа: решение зафиксировано, действие — только
> документационное.** Ничего из перечисленного ниже **не выполнялось**;
> все проверки в §4 и §5 — **read-only** (перечень §7).

---

## 1. Решение

| Поле | Значение |
|---|---|
| ID решения | **R-3** |
| **Выбран** | **Вариант A** — сохранить существующий `Animastor/animastor-gpu-hub` без изменений |
| **Отклонён** | **Вариант B** — замена истории monorepo → **REJECTED / NOT SELECTED** |
| Статус | **DECIDED (owner)** — прежнее «OWNER DECISION / UNDECIDED» в остальных документах снято этой ревизией |
| Область | split-план, `repository-split-execution-pack.md`, `repository-split-final-gate.md`, `repository-split-next-blockers.md`, `repository-split-pre-split-fixes.md` §5, `repository-split-pre-split-go-blockers.md` |

### 1.1 Нормативные правила (после этой ревизии — обязательны)

1. Существующий **`Animastor/animastor-gpu-hub` сохраняется без изменений**
   (GitHub-repo, VPS-bare `/home/animastor/repos/animastor-gpu-hub.git`,
   `hooks/post-receive`, remote `github`, ветка `master`).
2. **`git filter-repo` для GPU Hub НЕ выполняется** — ни в монорепо-клоне
   (prep-plan §8.5 / next-blockers §4.1.5), ни в существующем bare.
3. **Новый GPU Hub репозиторий не создаётся** (ни bare, ни GitHub-repo).
   `Animastor/animastor-gpu-hub` существует и остаётся единственным.
4. **Существующий GPU Hub не force-push, не overwrite, не delete** —
   ни с VPS, ни из клона, ни через `push --mirror` / `git push --mirror github`.
5. **Его текущая standalone history канонична**: `master` bare =
   `refs/remotes/github/master` = **`7c7778c`** (43 коммита,
   2026-06-11 … 2026-09-06) = HEAD GitHub. Эта история **не выводится из
   оборота** и **не перезаписывается**; никакой альтернативный «split-слепок»
   ей не противопоставляется.

---

## 2. Что это меняет в плане split

| Место | Было (A/B) | Стало (A = SELECTED) |
|---|---|---|
| Очередь физического split | 1 backend → 2 web → 3 android → 4 worker → **5 gpu-hub (при B)** → smoke → freeze | **1 backend → 2 web → 3 android → 4 worker → smoke → freeze. Шаг 5 исключён из очереди** |
| Исполняемых `--path` | 116 (90 из 4 репо + 26 gpu-hub) | **90** (backend 35 + web 31 + android 5 + worker 19) |
| Стадия B (backup) | «при R-3=B — mirror-backup GPU Hub» | **не выполняется**: существующий GPU Hub не пишется → backup не нужен; зеркальная копия монорепо (`$BK`) остаётся обязательной |
| Стадия C (destructive) | «при R-3=B — force-push в существующий GPU Hub bare» | **исключена полностью**; force-push в GPU Hub = запрещённое действие |
| GO-чеклист `G-G` / `GO-07` (R-3) | UNDECIDED | **READY = A** |
| GO-чеклист `G-I` / `GO-09` (backup/freeze GPU Hub) | требовал mirror + заморозку hook | **NOT APPLICABLE** (пункт исключён из GO-условий) |
| P1 (создание репо) | 4 + «для gpu-hub — по варианту» | **только 4**; GPU Hub отдельно не создавать |
| Rollback-строка «R-3=B: GPU Hub после force-push» | существовала | **удалена как неприменимая** (перезаписи нет → откат не нужен) |
| hub CI (B9/D10) | блокирован до решения A/B | разблокирован: авторить **в существующем репо** его собственные `ci.yml` / `ghcr-release.yml` (не пересоздавая) |
| §8.5 / §4.1.5 / §5.5 / §3.6 | исполняемые при B | **REJECTED / NOT SELECTED** — снабжены явными отказами (§3) |

---

## 3. R-3 = B — **REJECTED / NOT SELECTED** (где помечено)

Сценарий B **сохранён только как историческая запись** о рассмотренном
варианте. Он **не исполняем** и снабжён отказом во всех местах, где его
можно было бы прочитать как инструкцию:

| Документ | Где | Пометка после этой ревизии |
|---|---|---|
| `repository-split-pre-split-fixes.md` | §5 «Вариант B» | заголовок §5 → решение A; «Решение НЕ принимается» → **принято: A**; вариант B → **REJECTED** |
| `repository-split-next-blockers.md` | §4.1.5 (командный лист шага 5) | заголовок → **REJECTED / DO NOT EXECUTE** + отказ в первых строках блока |
| `repository-split-next-blockers.md` | §5.5 (extraction map gpu-hub) | то же |
| `repository-split-next-blockers.md` | §4 «Exact split order», §FPSG.5, §FPSG.8, §FINAL SPLIT HANDOFF §4, §10 | шаг 5 исключён/заменён |
| `repository-split-execution-pack.md` | §2 (стадии B/C), §3.1, §3.6, §5.1, §5.2, §6 (`G-I`) | исключены / N/A |
| `repository-split-preparation-plan.md` | §8.5 (whitelist gpu-hub) | добавлена строка-отказ: **REJECTED при R-3=A** |
| `repository-split-pre-split-go-blockers.md` | §4 (сравнение A/B), §6 (`GO-07`, `GO-09`) | A = выбран, B = REJECTED, `GO-09` = N/A |

### 3.1 Постоянные запреты (бессрочно, без нового письменного решения)

- `git filter-repo` по gpu-hub (prep-plan §8.5 / §4.1.5) — **не исполнять**;
- `git push --force` / `git push --mirror` / любой иной **overwrite** в
  `/home/animastor/repos/animastor-gpu-hub.git` или в
  `https://github.com/Animastor/animastor-gpu-hub` — **запрещено**;
- `git push --delete`, принудительный `reset`, переименование/пересоздание
  репозитория — **запрещено**;
- создание **нового** `Animastor/animastor-gpu-hub` — **запрещено**
  (репозиторий существует);
- изменение `hooks/post-receive` существующего GPU Hub bare — **запрещено**.

Любое переоткрытие возможно **только** новым письменным решением владельца,
которое явно аннулирует этот документ.

---

## 4. Проверка: 4 репозитория не получают копии GPU Hub (read-only)

Цель: убедиться, что после split **backend / web / android / worker** содержат
**не копию** компонента, а (где whitelisted) **ссылки и общие артефакты**.

### 4.1 Код компонента (`packages/animastor-gpu-hub/`) — отсутствует во всех 4

| Репо | Кол-во `--path` в §4.1.x | `packages/animastor-gpu-hub` | Leak-греп запрещает |
|---|---|---|---|
| backend (§4.1.1) | 36 токенов − 1 комментарий (`# НЕТ --path workflow.json`) = **35** | **нет** | да — `packages/animastor-(worker\|gpu-hub\|web-)` |
| web (§4.1.2) | **31** | **нет** | да — `packages/animastor-(ai-\|…\|gpu-hub\|…\|worker)` |
| android (§4.1.3) | 6 − 1 комментарий (`# НЕТ --path local.properties`) = **5** | **нет** (android вообще исключает `docs/`, `docker/`, `scripts/`, всё `packages/`) | да |
| worker (§4.1.4) | **19** | **нет** | да — «все пакеты кроме `animastor-worker`» |
| **Итого** | **35 + 31 + 5 + 19 = 90** | **0 вхождений** | — |

Сверено grep'ом по блокам §4.1.1–§4.1.4 командного листа: паттерн
`gpu` не встречается **ни в одном** исполняемом `--path` этих четырёх блоков.

### 4.2 Что из «gpu-hub» попадает в 4 репо — **по whitelist, не копия компонента**

| Артефакт | Куда попадает | Почему это не копия GPU Hub |
|---|---|---|
| `docs/architecture/GPU_HUB_CONTRACT.md`, `PHASE_10*`, `JOB_PROTOCOL_V2.md` | **только backend** (через `--path docs` — весь каталог) и **только `JOB_PROTOCOL_V2.md`** у worker | протокольные/аудиторские документы, не код; whitelist §8 намеренно дублирует их (final-gate §2: `PHASE_10*` → backend+gpu-hub, `JOB_PROTOCOL_V2.md` → backend+worker+gpu-hub) |
| `docker/compose/overlay-gpu-hub-standalone.yml` | **backend** (через `--path docker`) | это **pinned-image overlay**, а не код: `image: ${GPU_HUB_IMAGE:?…}`, `build: !reset null` — т.е. backend **ссылается** на внешний образ, а не собирает hub |
| `scripts/check-artifacts.sh` | **backend** (через `--path scripts`) | общий проверочный скрипт артефактов; hub-копия — в §8.5 (отклонена) |
| `gpu-hub-rebuild.sh` | **не попадает никуда** (запрещён в backend/web, исключён из §8.5) | — |
| `packages/animastor-gpu-hub/**` | **не попадает никуда** из 4 репо | остаётся **только** в замороженном монорепо `$BARE` как исторический источник |

**Вывод:** разделение чистое — 4 репозитория получают **ноль** экземпляров
пакета hub; backend держит **overlay + digest-pin**, т.е. именно **ссылку**
на существующий `Animastor/animastor-gpu-hub`, как и требует R-3 = A.

---

## 5. Ссылки и metadata: GPU Hub = внешний уже опубликованный standalone component

Все проверки — **read-only** (GitHub API GET, `npm view`, чтение файлов).

| Аспект | Факт | Совместимость с R-3 = A |
|---|---|---|
| GitHub-repo | `Animastor/animastor-gpu-hub`: 200, public, `default_branch=master`, created 2026-09-06T16:19:30Z, pushed 2026-09-06T18:07:10Z, 0 forks, **0 releases, 0 tags** | **не трогаем**; releases/tags не нужны — hub сам артефакты не публикует |
| Canonical history | bare `master` = `refs/remotes/github/master` = **`7c7778c`** (43 коммита, линейная) | **канонична**; не перезаписывается |
| Собственный CI | `.github/workflows/{ci.yml, ghcr-release.yml}` **в существующем репо** | при A авторятся/обновляются **в этом же репо**, не создаются заново |
| GHCR image | `ghcr.io/animastor/animastor-gpu-hub` — публикуется `ghcr-release.yml` (`workflow_dispatch`, immutable tag, **никогда `:latest`**, pin по digest) | **без изменений**; namespace не зависит от R-3 |
| Потребление hub в backend | `.env.example:53` → `GPU_HUB_IMAGE=ghcr.io/animastor/animastor-gpu-hub@sha256:eb9a9807…`; overlay `build: !reset null` | **ссылка на внешний образ по digest** → это и есть «ссылка вместо копии» (X-2 рабочий путь) |
| npm package | `@animastor/gpu-hub` **0.1.1** (`dist-tags.latest=0.1.1`); `repository.url = git+https://github.com/Animastor/animastor.git` | **без изменений** при A (X-3: «при A — без изменений»); перепривязка `repository.url` = отдельный **post-split** шаг владельца и требует `npm publish` (P3/E401) — **не blocker split** |
| Release-asset chain (B5) | `artifacts.lock.json` → `source_repository` ∈ {`animastor-worker`, `animastor-backend`}, `release_tag` ∈ {`worker-bundle-v2.1.1`, `hub-artifacts-v1`}, `sha256_asset: null` (пиннинг — при первом post-split release) | URL строится как `<base>/<source_repository>/releases/download/…` (`g5-artifact-integrity.sh`, `RELEASE_BASE=https://github.com/Animastor`) → **резолвится по ИМЕНИ репо**, а имена `animastor-backend` / `animastor-worker` **сохраняются** при split → цепочка **не зависит от R-3** и при A работает как задумано |
| Monorepo releases | `Animastor/animastor`: **0 releases** | цепочка целиком **post-split**, ничего переносить не нужно |

**Итог §5:** при R-3 = A никаких release-asset/GHCR/npm допущений **не
ломается** — все внешние контракты резолвятся либо по имени репо
(сохраняется), либо по digest пакета (не зависит от git-истории).

---

## 6. Индекс правок этой ревизии (только `docs/architecture/*.md`)

| Файл | Что изменено |
|---|---|
| **(новый)** `repository-split-r3-decision.md` | этот документ |
| `repository-split-execution-pack.md` | §2 стадии B/C (удалены gpu-hub-ветки), §2 запреты и порядок репо, §3.1 + §3.6 → N/A/REJECTED, §5.1 + §5.2 (gpu-hub-строки), §6 `G-G`/`G-I`, §7 (E20) |
| `repository-split-final-gate.md` | §1 R-3 → **DECIDED = A**, §1 сводка blocker'ов, §4 R-3 → CLOSED, §6 статус и список blocker'ов |
| `repository-split-next-blockers.md` | §0, §B9.2/D10, §FPSG.3, §FPSG.5, §FPSG.8, §4.1.5 → REJECTED, §5.5 → REJECTED, §4 порядок, §7.1/§7.3, §FINAL SPLIT HANDOFF §2/§4/§10, запрет force-push → бессрочный |
| `repository-split-pre-split-fixes.md` | §5 заголовок + решение (A selected / B rejected), §7 NO-GO №2/№5/№10, §8 пп. 6–8 |
| `repository-split-pre-split-go-blockers.md` | §1, §4 (A/B → selected/rejected), §6 `GO-07`/`GO-09`, бейджи |
| `repository-split-preparation-plan.md` | §8.5 — строка-отказ **REJECTED при R-3=A** |
| `repository-split-final-readiness.md` | заметка в шапке: R-3 решён = A; строки ниже — исторический статус на 2026-10-01 |

---

## 7. Verification log (read-only, эта сессия)

| Проверка | Результат |
|---|---|
| `--path` блоков §4.1.1–§4.1.4 (grep `gpu`) | **0** вхождений в 4 репо; сумма исполняемых `--path` = **90** |
| leak-грепы backend/web/android/worker (§3.2–§3.5) | `packages/animastor-gpu-hub` **запрещён** во всех четырёх |
| `curl api.github.com/repos/Animastor/animastor-gpu-hub` | 200, public, master, 0 releases, 0 tags, workflows = `ci.yml`, `ghcr-release.yml` |
| `curl api.github.com/repos/Animastor/animastor/releases` | **0** |
| `npm view @animastor/gpu-hub` | `0.1.1`, `repository.url = git+https://github.com/Animastor/animastor.git` |
| bare / GitHub GPU Hub | `master` = `github/master` = `7c7778c` — **не изменены** |
| `artifacts.lock.json` + `g5-artifact-integrity.sh` | `source_repository` = `animastor-worker` / `animastor-backend`, `RELEASE_BASE=https://github.com/Animastor` |
| `docker/compose/overlay-gpu-hub-standalone.yml`, `.env.example:53` | `image: ${GPU_HUB_IMAGE:?…}`, `build: !reset null`, digest-pin → **ссылка**, не копия |
| `git filter-repo`, force-push, GitHub-mutations | **не выполнялись** |

---

## 8. NOT EXECUTED

**PHYSICAL SPLIT: NOT EXECUTED · git filter-repo: NOT EXECUTED ·
force-push: NOT EXECUTED · новых GitHub-репозиториев: NOT CREATED ·
`Animastor/animastor-gpu-hub` / bare `animastor-gpu-hub.git` / hooks:
NOT MODIFIED · `master`: NOT MODIFIED · npm publish: NOT EXECUTED ·
R-3 = B: REJECTED (не исполнялся).**

Изменены только `docs/architecture/*.md` — одним docs-only commit'ом.
