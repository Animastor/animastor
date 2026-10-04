# Worker physical split — диагностика root layout и SHA `73671b6b` (read-only)

> Тип: **read-only диагностика, изменений не вносилось.** Проверялись
> опубликованный `Animastor/animastor-worker` (`main = 73671b6b…`), VPS bare
> `/home/animastor/repos/animastor-worker.git` и утверждённый Worker whitelist из
> `repository-split-execution-pack.md` (§3.5, §14; команда §4.1.4 в
> `repository-split-next-blockers.md`). **Push / force-push / `filter-repo` /
> смена refs / hook'ов / remotes не выполнялись; backend / web / android /
> GPU Hub не трогались.** Источник split зафиксирован: `64127b9e…`.

## 1. Вопрос и вердикт

Поступило подозрение, что GitHub `main` worker'а содержит «monorepo-структуру»,
а `73671b6b…` — это pre-split (монорепо) коммит.

**Вердикт: PASS — расхождения нет; worker split корректен; исправлять нечего.**

- `73671b6b…` — **не** монорепо-коммит, а **новый SHA, выданный `filter-repo`**.
- Top-level worker = `LICENSE · docker/ · docs/ · packages/` — это **намеренный
  whitelist** (§3.5), подмножество монорепо, а не его корень.
- `packages/animastor-worker/*` **должен остаться** в текущем пути (вариант B);
  корневого `package.json` нет **по дизайну**.

## 2. Доказательства — SHA `73671b6b`

| Проверка | Результат |
|---|---|
| `git --git-dir=monorepo cat-file -t 73671b6b` | **`fatal: Not a valid object name`** → объекта в монорепо нет |
| worker bare: `cat-file -t 73671b6b` | `commit` (только в worker-репо) |
| worker bare: `ls-tree -r 73671b6b` | **58** файлов |
| `commit-map` (worker) | монорепо `bd66bae64c051e4e316b0982c54586a6d5b981f1` («feat(split)!: pre-split decoupling B1/B2/B3/B6/B8/B12 + B7 npm-conversion», **1619** файлов) → **`73671b6b…`** (58 файлов) |
| `ref-map` (worker) | `64127b9e…` → `73671b6b…` (`refs/heads/c21.4-…`) |
| worker bare `refs/heads/main` | `73671b6b4e2986bd33c88c0ef165cb39a67e875d` |
| GitHub `git ls-remote … refs/heads/main` | `73671b6b4e2986bd33c88c0ef165cb39a67e875d` |

Вывод: `73671b6b…` — перезаписанный filter-repo SHA, уникальный для worker-репо;
он не может быть объектом монорепо (SHA контентно-адресуемый, а деревья разные:
58 ≠ 1619 файлов).

## 3. Доказательства — root layout

`git --git-dir=…/animastor-worker.git ls-tree -r --name-only refs/heads/main`
(58 файлов, 4 верхние записи):

```
LICENSE
docker/worker/{Dockerfile,docker-run.md,entrypoint.sh}
docs/architecture/  (16 доков)
packages/animastor-worker/  (38 файлов)
```

Корневой `package.json` отсутствует (`grep -cx 'package.json'` = **0**).

**Whitelist Worker (§4.1.4 → §3.5)** — 19 `--path`: `packages/animastor-worker`,
`docker/worker`, 16 × `docs/architecture/<…>`, `LICENSE`.

**§3.5 execution pack (норматив):**

| Поле | Значение |
|---|---|
| Корневой layout (4) | `LICENSE` · `docker/worker/` (3) · `docs/architecture/` (16) · `packages/animastor-worker/` (38) |
| package identity | корневого `package.json` **нет** → `packages/animastor-worker/package.json` (`@animastor/worker-dev`); вложенные: `worker/package.json` (canonical `2.1.1`), `image/worker/package.json` |
| lock'и | **3**, регенерация **0** |

**Сравнение с уже принятыми split (все сохраняют layout монорепо):**

| Repo | top-level | root `package.json` |
|---|---|---|
| backend | `.dockerignore .env.example .gitignore ARCHITECTURE.md … backend/ docker/ docs/ packages/ proxy/ scripts/ …` | **0** |
| web | `ANDROID_WEB_PARITY.md LICENSE app-web-rebuild.sh docs/ frontends/ packages/ tools/` | **0** |
| android | `ANDROID_WEB_PARITY.md LICENSE apk-build.sh build-apk.sh frontends/` | **0** |
| worker | `LICENSE docker/ docs/ packages/` | **0** |

## 4. Причина «расхождения»

Физический split по регламенту — это `git filter-repo --path …` **без
`--path-rename`**, поэтому структура каталогов монорепо сохраняется 1:1
(`next-blockers.md` §1118: «свежем клоне, `--path-rename` не используется →
корневой layout не меняется»; команда §4.1.4; запрет `--path-rename` — §2,
§4.1.6, D-6, I-8). «Standalone» здесь = отдельный репозиторий с Worker-
подмножеством, а не перекладка `packages/animastor-worker/*` в корень.
Требования «переместить пакет в корень» нет ни в execution pack, ни в GO-guard.

## 5. Что нужно исправить

**Ничего.** Path-rename/mapping не отсутствует. Если владелец намерен получить
иной (плоский) корневой layout — это **отдельное изменение дизайна**:
потребовало бы `--path-rename packages/animastor-worker/=./` (сейчас прямо
запрещён), пересмотра ожиданий (files/commits/root) и повторного split worker —
вне текущего регламента и без авторизации.

## 6. Контроль неизменности (read-only)

| Контроль | Значение |
|---|---|
| monorepo `master` | `64127b9e1dea2ac528a572b51b90a542b70c5ebb` |
| `tmp/parser-audit-backup` | `db5ff61f1079360cc848ff2fc131a12783bd97ad` |
| BEFORE snapshot `MANIFEST.sha256` | **11/11 OK** |
| pre-split backup `$SRC` | `64127b9e…` присутствует |
| backend / web / android | `f83f929c…` / `4c3ea0fb…` / `efa4b293…` |
| GPU Hub | `7c7778c6f313dad19eb403d8509cd297226ec7ea` (byte-identical) |
| force-push | **не выполнялся** |
