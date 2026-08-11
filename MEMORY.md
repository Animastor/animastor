# MEMORY — ComfyUI GPU instance (animastor worker)

Записка для продолжения работы на GPU-инстансе. Дата последнего обновления: 11 Aug 2026.

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
- Текущий симптом (v0.27.0/v0.28.0 стартуют): **старые воркфлоу открываются БЕЗ линков**, узлы без связей, «граф руками не соединяется».
- Из трекера ComfyUI_frontend: frontend **v1.41.x** сломал subgraph'ы/promoted widgets («No link found for link ID», «disconnected»), починено в **v1.43.7+**, документированный стабильный workaround — **v1.39.x**. Воркфлоу, испорченные v1.41.x, могут не восстановиться автоматически.

## Текущее состояние скрипта worker/start-video.sh

1. `apt install -y mc git`
2. Пин ComfyUI: `COMFY_VER="v0.27.0"` — клон с `--branch`, или fetch тега + `checkout -f FETCH_HEAD`.
3. Верификация: `git describe --tags --exact-match` + `rev-parse HEAD` → в лог `ComfyUI version:` / `ComfyUI commit:`.
4. Зависимости: если есть `logs/comfy-${COMFY_VER}.lock.txt` — `pip install -r <lock>`, иначе `-r requirements.txt`.
5. GGUF deps.
6. torch: uninstall + install torch/torchvision/torchaudio `--index-url .../whl/cu124`.
7. Старт `nohup python main.py --listen 127.0.0.1 --port 8188 > output.log 2>&1 &`
8. Health-check `/system_stats` (60×5s). Если OK — сохраняет `pip freeze` (кроме torch-трио) в `logs/comfy-${COMFY_VER}.lock.txt` (lock только с рабочей сборки). Если НЕ OK — tail output.log и exit 1.
9. Запуск `bash ~/animastor/start-worker.sh video`.

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

1. Какой frontend стоял на инстансе 27 июля 2026? (см. grep bootstrap.log)
2. Это frontend-формат (массив/объекты links) или отсутствующие классы custom nodes?
3. Нужен ли пин `--front-end-version Comfy-Org/ComfyUI_frontend@v1.39.x` при запуске (backend v0.27.0 остаётся, тянет LTX 2.3; frontend не жёстко привязан)?
4. Lock `comfy-v0.27.0.lock.txt` после первого успешного бута — закоммитить в репо.

## TODO

- [ ] Выполнить диагностику (см. блок команд выше).
- [ ] Определить виновника: frontend-формат vs custom nodes.
- [ ] При необходимости добавить `--front-end-version` в строку запуска main.py в start-video.sh.
- [ ] После рабочего бута: закоммитить `logs/comfy-v0.27.0.lock.txt`.
