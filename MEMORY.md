# MEMORY — ComfyUI GPU Instance (Animastor Worker)

Work notes for continuing on the GPU instance. Last updated: 11 Aug 2026.

## Context

- Script `worker/start-video.sh` deploys ComfyUI on the GPU instance (Indian GPU provider, Ubuntu).
- The instance **resets only the system partition**; `~/` (including `~/ComfyUI` and `custom_nodes`) **is persistent** and untouched.
- Worked until approximately **27 July 2026**, then a new ComfyUI build stopped starting.
- The provider's stock ComfyUI works with qwen-tts/qwen-image, but is **too old for LTX 2.3** — hence a clean Ubuntu install + torch version selection.
- Custom nodes live in `~/ComfyUI/custom_nodes` — **not variable** (persistent).

## ComfyUI Nesting (4 Layers)

```
Animastor (worker.cjs)
  └── ComfyUI backend (Git tag/commit)  ← pinned in the script
        └── comfyui-frontend-package (PyPI, PINNED in the tag's requirements.txt)
              └── comfy-kitchen (PyPI, PINNED in the tag's requirements.txt)
                    └── torch 2.6.0+cu124 (installed separately, cu124-index)
                          └── CUDA 12.4
```

## Key Facts (Verified)

| ComfyUI Tag | Commit | Frontend | Comfy-kitchen |
|---|---|---|---|
| v0.27.0 | `bb131be9e83d2f773c90f1d6f1e4b248a498c8c5` (30 Jun 2026) | `==1.45.20` | `==0.2.16` |
| v0.28.0 | `700821e1364eaab0e8f21c538a2131719fec57bf` (15 Jul 2026) | `==1.45.21` | `==0.2.20` |

- `comfyui-frontend-package` and `comfy-kitchen` **are pinned by the tag itself** in `requirements.txt` (NOT floating).
- `torch` is not pinned in requirements.txt → the script installs 2.6.0+cu124 from https://download.pytorch.org/whl/cu124.
- ChatGPT's hypothesis about "a shared floating frontend" **has been debunked** — frontend is pinned per-tag; the difference between v0.27 and v0.28 is only 1.45.20→1.45.21, so the symptom is identical.

## Known Errors

- Original failure (new build fails to start): `comfy_kitchen → torch 2.6.0 → infer_schema() → list[int] unsupported`. This is `torch.library.infer_schema` not supporting `list[int]`/`list[Tensor]` in type hints; triggered by comfy-kitchen (quant_ops.py). Requires dependency locking.
- Current symptom (v0.27.0/v0.28.0 start successfully): **old workflows open WITHOUT links** — nodes are disconnected, "graph cannot be connected manually".
- From the ComfyUI_frontend tracker: frontend **v1.41.x** broke subgraphs/promoted widgets ("No link found for link ID", "disconnected"), fixed in **v1.43.7+**, the documented stable workaround is **v1.39.x**. Workflows corrupted by v1.41.x may not recover automatically.

## Current State of worker/start-video.sh

1. `apt install -y mc git`
2. Pin ComfyUI: `COMFY_VER="v0.27.0"` — clone with `--branch`, or fetch tag + `checkout -f FETCH_HEAD`.
3. Verification: `git describe --tags --exact-match` + `rev-parse HEAD` → logs `ComfyUI version:` / `ComfyUI commit:`.
4. Dependencies: if `logs/comfy-${COMFY_VER}.lock.txt` exists — `pip install -r <lock>`, otherwise `-r requirements.txt`.
5. GGUF deps.
6. torch: uninstall + install torch/torchvision/torchaudio `--index-url .../whl/cu124`.
7. Start `nohup python main.py --listen 127.0.0.1 --port 8188 > output.log 2>&1 &`
8. Health-check `/system_stats` (60×5s). If OK — saves `pip freeze` (excluding torch trio) to `logs/comfy-${COMFY_VER}.lock.txt` (lock only from a working build). If NOT OK — tail output.log and exit 1.
9. Launch `bash ~/animastor/start-worker.sh video`.

## Diagnostics on Instance (Run These!)

```bash
# what is actually installed right now
pip show comfyui-frontend-package | grep -E 'Name|Version'

# what frontend was installed on 27 July — bootstrap.log accumulates (append)
grep -iE 'frontend|front-end|ComfyUI version' ~/animastor/logs/bootstrap.log | tail -30

# how many classes does the backend know
curl -s http://127.0.0.1:8188/object_info | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"

# which classes does the workflow expect (replace path)
python3 -c "
import json
d=json.load(open('WORKFLOW.json'))
print(sorted(set(n.get('type') or n.get('class_type') for n in d.get('nodes',[]))))
"

# links format in workflow (array vs objects)
python3 -c "import json; d=json.load(open('WORKFLOW.json')); print(type(d.get('links',[])).__name__); print(json.dumps(d.get('links',[])[:2]))"
```

Browser: F12 → Console when loading a workflow — look for `No link found for link ID`.

## Versions NOT Pinned (Reference Only)

- v0.29.0 = 29 Jul 2026 (AFTER the verified date), v0.29.2 = 31 Jul, v0.30.0 = 03 Aug, v0.31.0 = 08 Aug.

## Open Questions

1. Which frontend was installed on the instance on 27 July 2026? (see grep bootstrap.log above)
2. Is this a frontend format issue (array/objects links) or missing custom node classes?
3. Is a `--front-end-version Comfy-Org/ComfyUI_frontend@v1.39.x` pin needed at main.py launch time (backend v0.27.0 remains, pulls LTX 2.3; frontend is not tightly coupled)?
4. After a successful boot: commit `logs/comfy-v0.27.0.lock.txt` to the repo.

## TODO

- [ ] Run diagnostics (see command block above).
- [ ] Determine the root cause: frontend format vs custom nodes.
- [ ] If necessary, add `--front-end-version` to the main.py launch line in start-video.sh.
- [ ] After a working boot: commit `logs/comfy-v0.27.0.lock.txt`.
