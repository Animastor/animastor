# MEMORY — ComfyUI GPU instance (animastor worker)

Записка для продолжения работы на GPU-инстансе. Дата последнего обновления: 11 Aug 2026.

## 🟢 СТАТУС 11.08.2026: СИСТЕМА РАБОТАЕТ, ГЕНЕРАЦИЯ ПРОВЕРЕНА

- `bash ~/animastor/start-video.sh` успешно поднимает: ComfyUI v0.27.0 (bb131be) + torch 2.6.0+cu124 + frontend 1.45.20 + kitchen 0.2.16 + worker.
- **ГЕНЕРАЦИЯ LTX 2.3 проверена end-to-end** после фикса cuDNN: минимальный t2v-промпт (UnetLoaderGGUF LTX-2.3-distilled-Q4_K_M + DualClipLoaderGGUF gemma-3-12b + video VAE + KSampler + VAEDecode) отработал за 61.6s, `status_str: success`, 9 кадров PNG в `~/ComfyUI/output/cudnn_test_*.png`, в логе 0 cuDNN-ошибок.
- Исправления в `start-video.sh` (зафиксированы):
  - `PY=/opt/venv/bin/python`, `PIP=/opt/venv/bin/pip` — явный пин окружения (базовый venv инстанса; персистентен PATH-первым в `/etc/environment`).
  - torch **запинен точно**: `torch==2.6.0+cu124 torchvision==0.21.0+cu124 torchaudio==2.6.0+cu124` с cu124-индекса (был плавающий install → риск тихого обновления до 2.7/2.8 и поломки comfy-kitchen).
  - Установка зависимостей **ВСЕХ** custom nodes (`for req in custom_nodes/*/requirements.txt`), а не только GGUF. Без этого не грузились `comfyui-videohelpersuite` (VHS_VideoCombine), `ComfyUI-MelBandRoFormer`, `comfyui-easy-use` — их классов не было в backend, воркфлоу открывались без узлов/линков.
  - Удаление stale `~/ComfyUI/user/comfyui.db` перед стартом — база от v0.28+ блокировала миграцию v0.27 (нет миграций). После чистки: `Database upgraded from None to 0004_drop_tag_type`.
  - **Пурж CUDA-13 стека** после установки custom-node reqs: `pip uninstall -y cuda-toolkit cuda-bindings cuda-pathfinder nvidia-cudnn-cu13 nvidia-cublas nvidia-nccl-cu13 ...`. cu13-пакеты затирают cu12-библиотеки (одинаковый каталог `site-packages/nvidia/*/lib/`) → `CUDNN_STATUS_NOT_INITIALIZED` на любой свёртке torch 2.6.0+cu124. Подробнее см. блок «cuDNN-фикс» ниже.
  - Lock сохраняется с **фильтром от cu13/нес-суффиксных nvidia-пакетов** (не только torch-трио), чтобы ядовитые cu13-строки не вернулись в freeze.
- Проверено после фикса: backend 1325 классов; все классы воркфлоу есть (остались только frontend-плацебо: MarkdownNote/Note/Reroute/GetNode/SetNode/PrimitiveNode и UUID-ноды promoted widgets c `proxyWidgets`); worker подключён к https://animastor.in/gpu; lock `logs/comfy-v0.27.0.lock.txt` пересоздан (176 строк, чистый от cu13).
- Воркфлоу на диске валидны: version 0.4, links-массивы `[id, from_node, from_slot, to_node, to_slot, type]`, дублей ID нет, оборванных ссылок нет.
- Вывод по симптому «воркфлоу без линков»: виноват был НЕ формат файлов (они целые), а (а) отсутствующие классы custom nodes из-за недозависимостей и (б) старый frontend v1.41.x/1.42.x. Сейчас frontend 1.45.20 (>=1.43.7 — починено) + все классы на месте → линки должны отрисовываться.

## Контекст

- Скрипт `worker/start-video.sh` разворачивает ComfyUI на GPU-инстансе (индийская GPU-контора, Ubuntu).
- Инстанс **обнуляет только системную часть**; `~/` (в т.ч. `~/ComfyUI` и `custom_nodes`) **персистентны** и не трогаются.
- Работало примерно до **27 июля 2026**, потом новая сборка ComfyUI перестала запускаться.
- Старый провайдерский ComfyUI работает с qwen-tts/qwen-image, но **слишком стар для LTX 2.3** — поэтому чистый Ubuntu + подбор torch.
- Custom nodes лежат в `~/ComfyUI/custom_nodes` — **не переменная** (персистентны).

## Матрёшка ComfyUI (4 слоя)

```
Animastor (worker.cjs)
  └── ComfyUI backend (Git tag/commit)  ← пиним в скрипте
        └── comfyui-frontend-package (PyPI, ЗАПИНИВАЕТСЯ в requirements.txt тега)
              └── comfy-kitchen (PyPI, ЗАПИНИВАЕТСЯ в requirements.txt тега)
                    └── torch 2.6.0+cu124 (ставится отдельно, cu124-index)
                          └── CUDA 12.4
```

## Ключевые факты (проверено)

| Тэг ComfyUI | commit | frontend | comfy-kitchen |
|---|---|---|---|
| v0.27.0 | `bb131be9e83d2f773c90f1d6f1e4b248a498c8c5` (30.06.2026) | `==1.45.20` | `==0.2.16` |
| v0.28.0 | `700821e1364eaab0e8f21c538a2131719fec57bf` (15.07.2026) | `==1.45.21` | `==0.2.20` |

- `comfyui-frontend-package` и `comfy-kitchen` **пинятся самим тегом** в `requirements.txt` (НЕ плавающие).
- `torch` в requirements.txt не пинится → скрипт ставит 2.6.0+cu124 с https://download.pytorch.org/whl/cu124.
- Гипотеза ChatGPT про «общий плавающий frontend» **опровергнута** — frontend запиниван per-tag, разница между v0.27/v0.28 всего 1.45.20→1.45.21, поэтому симптом одинаковый.

## Известные ошибки

- Оригинальная поломка (свежая сборка не стартует): `comfy_kitchen → torch 2.6.0 → infer_schema() → list[int] unsupported`. Это `torch.library.infer_schema` не умеет `list[int]`/`list[Tensor]` в type hints; триггерит comfy-kitchen (quant_ops.py). Требует lock зависимостей.
- Старый симптом (воркфлоу без линков) — РАЗОБРАН, см. статус выше: отсутствующие классы custom nodes (недозависимости) + frontend v1.41.x/1.42.x. Формат файлов целый.
- Из трекера ComfyUI_frontend: frontend **v1.41.x** сломал subgraph'ы/promoted widgets («No link found for link ID», «disconnected»), починено в **v1.43.7+**, документированный стабильный workaround — **v1.39.x**. Мы сидим на 1.45.20 (починено) — v1.39.x НЕ нужен.
- v0.27.0 не содержит alembic-миграций БД; stale `user/comfyui.db` от v0.28+ даёт ошибку `Can't locate revision '0006_add_loader_path'` (некритично, но шумит в логе). Лечится удалением DB перед стартом (сделано в start-video.sh).

## cuDNN-фикс (11.08.2026) — CUDNN_STATUS_NOT_INITIALIZED

- **Симптом**: генерация падала с `Exception during processing: CUDNN_STATUS_NOT_INITIALIZED` на свёртках (`nodes_lt.py:456`, LTXVVideoVAE encode). Даже `conv2d`/`conv3d` в чистом python падали при `torch.backends.cudnn` включённом; при `enabled=False` работали (медленно).
- **Причина**: в venv оказались одновременно cu12- и cu13-наборы NVIDIA-библиотек. `nvidia-cudnn-cu12==9.1.0.70` (нужен torch 2.6.0+cu124) и `nvidia-cudnn-cu13==9.20.0.48` кладут `.so` в **один и тот же каталог** `site-packages/nvidia/cudnn/lib/`. Установившийся позже cu13 перезаписал файлы → `torch.backends.cudnn.version()` показывал **92000** (9.20, собран под CUDA 13) вместо 90100 → при инициализации поверх CUDA 12.4 → `CUDNN_STATUS_NOT_INITIALIZED`.
- **Кто принёс cu13**: цепочка `cuda-bindings → cuda-toolkit[all]` (+ нес-суффиксные `nvidia-cublas/cusolver/nccl/nvtx/cufft/curand/cufile/cusparse/nvjitlink` 13.x) — установились транзитивно при первой установке reqs custom nodes (08:58, при установке deps VHS/MelBand/easy-use), попали в lock, и lock их потом воспроизводил при каждом буте. Точный инициатор не найден (после фикса `pip check` чист, ничего не требует cu13; dry-run не тянет).
- **Фикс**: `pip uninstall -y cuda-toolkit cuda-bindings cuda-pathfinder nvidia-cudnn-cu13 nvidia-cublas nvidia-nccl-cu13 nvidia-nvshmem-cu13 nvidia-cusparselt-cu13 nvidia-cusolver nvidia-cuda-runtime nvidia-cuda-nvrtc nvidia-cuda-cupti nvidia-nvtx nvidia-cufft nvidia-curand nvidia-cufile nvidia-cusparse nvidia-nvjitlink` + переустановка `nvidia-cudnn-cu12==9.1.0.70` (все cu12-библиотеки переустановлены заново). После: `torch.backends.cudnn.version()` = 90100, conv2d/conv3d OK, генерация успешна.
- **Защита в скрипте**: пурж cu13 после цикла custom-node reqs + фильтр cu13 из freeze при сохранении lock.

## Текущее состояние скрипта worker/start-video.sh

1. `PY=/opt/venv/bin/python`, `PIP=/opt/venv/bin/pip` (явный пин окружения).
2. `apt install -y mc git`
3. Пин ComfyUI: `COMFY_VER="v0.27.0"` — клон с `--branch`, или fetch тега + `checkout -f FETCH_HEAD`.
4. Верификация: `git describe --tags --exact-match` + `rev-parse HEAD` → в лог `ComfyUI version:` / `ComfyUI commit:`.
5. Зависимости: если есть `logs/comfy-${COMFY_VER}.lock.txt` — `pip install -r <lock>`, иначе `-r requirements.txt`.
6. Удаление stale `user/comfyui.db` (+.lock/.bkp) — иначе ошибка миграции БД.
7. Зависимости ВСЕХ custom nodes: цикл `for req in custom_nodes/*/requirements.txt`.
8. **Пурж CUDA-13 стека** (`pip uninstall -y cuda-toolkit cuda-bindings ... nvidia-*-cu13 ...`) — защита cu12-библиотек torch.
9. torch: uninstall + install **точных** `torch==2.6.0+cu124 torchvision==0.21.0+cu124 torchaudio==2.6.0+cu124` `--index-url .../whl/cu124`.
10. Старт `nohup "$PY" main.py --listen 127.0.0.1 --port 8188 > output.log 2>&1 &`
11. Health-check `/system_stats` (60×5s). Если OK — сохраняет `pip freeze` (кроме torch-трио **и cu13/nvidia-нес-суффиксных**) в `logs/comfy-${COMFY_VER}.lock.txt` (lock только с рабочей сборки). Если НЕ OK — tail output.log и exit 1.
12. Запуск `bash ~/animastor/start-worker.sh video`.

## Диагностика на инстансе (выполнить!)

```bash
# что реально стоит сейчас
pip show comfyui-frontend-package | grep -E 'Name|Version'

# какой frontend был 27 июля — bootstrap.log копится (append)
grep -iE 'frontend|front-end|ComfyUI version' ~/animastor/logs/bootstrap.log | tail -30

# сколько классов знает backend
curl -s http://127.0.0.1:8188/object_info | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"

# какие классы ждёт workflow (заменить путь)
python3 -c "
import json
d=json.load(open('WORKFLOW.json'))
print(sorted(set(n.get('type') or n.get('class_type') for n in d.get('nodes',[]))))
"

# формат links в воркфлоу (массив vs объекты)
python3 -c "import json; d=json.load(open('WORKFLOW.json')); print(type(d.get('links',[])).__name__); print(json.dumps(d.get('links',[])[:2]))"
```

Браузер: F12 → Console при загрузке воркфлоу — искать `No link found for link ID`.

## Версии, которые НЕ пиним (для справки)

- v0.29.0 = 29.07.2026 (уже ПОСЛЕ проверенной даты), v0.29.2 = 31.07, v0.30.0 = 03.08, v0.31.0 = 08.08.

## Открытые вопросы

1. ~~Какой frontend стоял на инстансе 27 июля 2026?~~ — см. вывод выше: симптом не в формате файлов.
2. ~~Это frontend-формат или отсутствующие классы custom nodes?~~ — РЕШЕНО: отсутствующие классы custom nodes (недозависимости cv2/imageio-ffmpeg/rotary_embedding_torch) + старый frontend v1.41.x/1.42.x. Формат файлов целый.
3. ~~Нужен ли пин `--front-end-version v1.39.x`?~~ — НЕ НУЖЕН: работающая сборка v0.27.0 тянет frontend 1.45.20 (>=1.43.7, починено). v1.39.x не трогаем.
4. Lock `comfy-v0.27.0.lock.txt` — пересоздан и лежит в `logs/` (176 строк, чистый от cu13). В репо закоммитить при желании.
5. ~~Генерация падает: CUDNN_STATUS_NOT_INITIALIZED~~ — РЕШЕНО (cu13-стек затирал cu12-библиотеки), генерация проверена.

## TODO

- [x] Выполнить диагностику (см. блок команд выше).
- [x] Определить виновника: отсутствующие классы custom nodes (недозависимости), не формат файлов.
- [x] Добавить установку зависимостей ВСЕХ custom nodes в start-video.sh (цикл по requirements.txt).
- [x] Запинить torch точно 2.6.0+cu124 в start-video.sh.
- [x] Починить stale comfyui.db (удалять перед стартом).
- [x] Пересоздать lock после рабочего бута.
- [x] Починить cuDNN (пурж cu13-стека + фильтр lock) — генерация проверена end-to-end.
- [ ] Проверить в браузере (F12 → Console): открыть воркфлоу LTX2.3_KJ_i2V_WORK_GGUF.json — не должно быть `No link found for link ID`.
- [ ] (Опционально) закоммитить `logs/comfy-v0.27.0.lock.txt` в репо.
- [ ] (Опционально) выяснить точный пакет, тянущий cu13 (`cuda-bindings` был транзитивным); защита уже есть в скрипте.
