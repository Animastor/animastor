# СИСТЕМА: GPU-инстанс Animastor (video worker) — описание

Дата фиксации: 11 Aug 2026. Состояние: **РАБОЧАЯ** (генерация LTX 2.3 проверена end-to-end).

## 1. Что это

Инстанс на GPU-конторе (E2E Networks, индийская) с NVIDIA **L40S 46GB**, драйвер 550.127.08, CUDA 12.4.
Роль: **video worker** для платформы Animastor — поднимает ComfyUI + Node.js worker, который забирает задачи с `https://animastor.in/gpu`.

**Поведение инстанса**: обнуляется только системная часть (`/opt/venv`, `/usr/local`, системный python).
Всё в `~/` (в т.ч. `~/ComfyUI`, `custom_nodes`, модели, скрипты) **персистентно** и переживает перезагрузки.

## 2. Стек (что установлено)

| Компонент | Версия | Как ставится | Где лежит |
|---|---|---|---|
| Python | 3.10.12 | образ инстанса | `/opt/venv/bin/python` (базовый venv) |
| Node.js | 18+ | `start-worker.sh` (nodesource) | `node -v` |
| ComfyUI | **v0.27.0** (`bb131be9...`) | `start-video.sh` (git clone/tag) | `~/ComfyUI` |
| comfyui-frontend-package | **1.45.20** | из requirements.txt тега | `/opt/venv/.../site-packages` |
| comfy-kitchen | **0.2.16** | из requirements.txt тега | `/opt/venv/.../site-packages` |
| PyTorch | **2.6.0+cu124** | `start-video.sh` (cu124-index) | `/opt/venv/.../site-packages` |
| CUDA runtime | 12.4 (torch bundles) | часть torch | `/opt/venv/.../site-packages/nvidia/*-cu12` |
| cuDNN | **9.1.0.70** (cu12) | часть torch | `/opt/venv/.../site-packages/nvidia/cudnn` |
| worker (video) | node-fetch@3, worker.cjs | `start-worker.sh video` | `~/animastor/worker` |
| mc / git | latest | `start-video.sh` (apt) | системные |

## 3. Матрёшка зависимостей

```
Animastor (worker.cjs → https://animastor.in/gpu)
  └── ComfyUI backend v0.27.0 (git tag bb131be9)
        └── comfyui-frontend-package 1.45.20 (пинится тегом)
              └── comfy-kitchen 0.2.16 (пинится тегом)
                    └── torch 2.6.0+cu124 (пинится отдельно, cu124-index)
                          └── CUDA 12.4
```

## 4. Custom nodes (все в `~/ComfyUI/custom_nodes`)

| Папка | Что даёт | Источник |
|---|---|---|
| `ComfyUI-GGUF` | GGUF-загрузка моделей (UnetLoaderGGUF, ClipLoaderGGUF, DualClipLoaderGGUF) | plain dir (no .git) |
| `gguf` | библиотека gguf для GGUF-нод | plain dir |
| `comfyui-kjnodes` | Kijai-ноды (VAELoaderKJ и др.), **пропатчен** — исправлен вызов AudioVAE | plain dir |
| `comfyui-videohelpersuite` | VHS_VideoCombine, пакетное видео | plain dir |
| `comfyui-easy-use` | easy-ноды (kSampler и др.) | plain dir |
| `ComfyUI-MelBandRoFormer` | аудио-мелодии (MelBandRoFormer) | plain dir |
| `ComfyUI-PromptRelay` | промпт-реле | git `kijai/ComfyUI-PromptRelay` @ ca5d4e3 |
| `ComfyUI-Manager` | менеджер нод | git `ltdrdata/ComfyUI-Manager` @ bbafbb12 |
| `rgthree-comfy` | rgthree-ноды (KSampler Config и др.) | git `rgthree/rgthree-comfy` @ 683836c |

ВАЖНО: 6 из них (GGUF, gguf, kjnodes, videohelpersuite, easy-use, MelBandRoFormer) — **обычные папки без .git**, их нельзя пере-клонировать одной командой. Они включены в бэкап-архив.

## 5. Модели (в `~/ComfyUI/models`, НЕ входят в бэкап — ~33GB, переживают ребут)

| Категория | Файл | Размер |
|---|---|---|
| unet | `LTX-2.3-distilled-Q4_K_M.gguf` | 17 GB |
| text_encoders | `gemma-3-12b-it-qat-UD-Q4_K_XL.gguf` | 7.0 GB |
| text_encoders | `ltx-2.3_text_projection_bf16.safetensors` | 2.2 GB |
| loras | `ltx-2-19b-ic-lora-detailer.safetensors` | 2.5 GB |
| vae | `ltx-2.3-22b-dev_video_vae.safetensors` | 1.4 GB |
| vae | `ltx-2.3-22b-dev_audio_vae.safetensors` | 348 MB |
| vae | `taeltx2_3.safetensors` | 23 MB |
| latent_upscale_models | `ltx-2.3-spatial-upscaler-x2-1.0.safetensors` | 950 MB |

## 6. Ключевые файлы и скрипты

| Файл | Назначение |
|---|---|
| `~/animastor/start-video.sh` | **Главный скрипт установки/запуска** ComfyUI (см. раздел 7) |
| `~/animastor/start-worker.sh` | Запуск worker.cjs (image/audio/video) |
| `~/animastor/worker/worker.cjs` | Код video-воркера (забирает задачи с animastor.in/gpu) |
| `~/animastor/bootstrap-video.sh` | Автозапуск при старте (вызывает start-video.sh) |
| `~/animastor/bootstrap-light.sh` | Автозапуск (image worker) |
| `~/animastor/fix-nodes-*.sh` | Доп. установка зависимостей нод |
| `~/animastor/mc.sh` | Автоустановка mc |
| `~/animastor/MEMORY.md` | Записка о диагностике/фиксах |
| `~/animastor/logs/comfy-v0.27.0.lock.txt` | Lock зависимостей (воспроизводимая установка) |
| `~/ComfyUI/output.log` | Лог запуска ComfyUI |
| `~/animastor/logs/worker-video.log` | Лог воркера |
| `~/ComfyUI/user/default/workflows/` | 14 воркфлоу (LTX 2.3) |
| `~/ComfyUI/input/` | Входные изображения (для I2V) |

## 7. `start-video.sh` — порядок действий (актуальный, 11.08.2026)

1. `PY=/opt/venv/bin/python`, `PIP=/opt/venv/bin/pip` — явный пин окружения.
2. `apt install -y mc git`.
3. Пин ComfyUI: `COMFY_VER="v0.27.0"` — clone `--branch` или `fetch tag` + `checkout -f FETCH_HEAD`.
4. Верификация тега/коммита в лог.
5. Deps: `pip install -r logs/comfy-v0.27.0.lock.txt` (если есть) или `requirements.txt`.
6. Удаление stale `~/ComfyUI/user/comfyui.db` (+.lock/.bkp) — иначе ошибка миграции БД.
7. Зависимости ВСЕХ custom nodes: цикл `for req in custom_nodes/*/requirements.txt`.
8. **Пурж CUDA-13 стека** (`pip uninstall -y cuda-toolkit cuda-bindings ... nvidia-*-cu13 ...`) — защита cu12-библиотек.
9. torch: `pip install torch==2.6.0+cu124 torchvision==0.21.0+cu124 torchaudio==2.6.0+cu124` (cu124-index).
10. Старт: `nohup "$PY" main.py --listen 127.0.0.1 --port 8188 > output.log 2>&1 &`
11. Health-check `/system_stats` (60×5s). Если OK — сохранить lock (`pip freeze` без torch-трио и без cu13). Если нет — tail output.log, exit 1.
12. Запуск `bash ~/animastor/start-worker.sh video`.

## 8. Известные подводные камни (кратко; детали в MEMORY.md)

- **cuDNN**: `nvidia-cudnn-cu13` (тянется транзитивно cuda-bindings/cuda-toolkit) затирает cu12-библиотеки в `site-packages/nvidia/cudnn/lib/` → `CUDNN_STATUS_NOT_INITIALIZED` на любой свёртке. Защита: пурж cu13 в скрипте + фильтр lock.
- **AudioVAE**: kjnodes `VAELoaderKJ` вызывал `AudioVAE(sd, metadata)`, а в v0.27.0 сигнатура только `metadata` → пропатчен в `custom_nodes/comfyui-kjnodes/nodes/nodes.py` (используется общий путь `VAE(sd=sd, ..., metadata=metadata)`).
- **comfy_kitchen/infer_schema**: свежая сборка (v0.28+) не стартует с torch 2.6.0 (`list[int] unsupported`) — поэтому пинится v0.27.0 + lock.
- **stale comfyui.db** от v0.28+ даёт ошибку миграции — удаляется перед стартом.
- **Frontend**: версии v1.41.x ломали отрисовку линков; мы на 1.45.20 (>=1.43.7, починено).

## 9. Как проверить здоровье системы

```bash
curl -s http://127.0.0.1:8188/system_stats | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['system']['cuda'][0])"
curl -s http://127.0.0.1:8188/object_info | python3 -c "import json,sys; print('classes:', len(json.load(sys.stdin)))"
pgrep -af 'main.py --listen'
pgrep -af 'node worker.cjs'
/opt/venv/bin/python -c "import torch; print('cudnn', torch.backends.cudnn.version(), 'cuda', torch.version.cuda)"   # ждём 90100 / 12.4
tail -f ~/ComfyUI/output.log
```
