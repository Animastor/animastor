# Third-Party Notices

Animastor uses open-source software and AI models from third parties. This document lists the major components and their licenses. The MIT license of this project does not extend to these components.

## Runtime Dependencies

### Backend (Node.js)

| Package | License | Link |
|---------|---------|------|
| Express | MIT | https://expressjs.com/ |
| ioredis | MIT | https://github.com/redis/ioredis |
| pg (node-postgres) | MIT | https://github.com/brianc/node-postgres |
| sharp | Apache-2.0 | https://github.com/lovell/sharp |
| multer | MIT | https://github.com/expressjs/multer |
| helmet | MIT | https://github.com/helmetjs/helmet |
| cors | MIT | https://github.com/expressjs/cors |
| adm-zip | MIT | https://github.com/cthackers/adm-zip |
| express-rate-limit | MIT | https://github.com/expressjs/express-rate-limit |
| music-metadata | MIT | https://github.com/Borewit/music-metadata |
| prom-client | Apache-2.0 | https://github.com/siimon/prom-client |
| tinyld | MIT | https://github.com/kubn2/tinyld |

### Frontend (Preact + Vite)

| Package | License | Link |
|---------|---------|------|
| Preact | MIT | https://preactjs.com/ |
| @preact/signals | MIT | https://github.com/preactjs/signals |
| preact-router | MIT | https://github.com/preactjs/preact-router |
| Vite | MIT | https://vitejs.dev/ |

### GPU Hub

| Package | License | Link |
|---------|---------|------|
| Express | MIT | https://expressjs.com/ |
| ioredis | MIT | https://github.com/redis/ioredis |
| cors | MIT | https://github.com/expressjs/cors |

## Infrastructure

| Component | License | Link |
|-----------|---------|------|
| PostgreSQL 16 | PostgreSQL License | https://www.postgresql.org/about/licence/ |
| Redis 7 | RSALv2 / SSPLv1 | https://redis.io/legal/ |
| Nginx | BSD-2-Clause | https://nginx.org/LICENSE |
| Docker Compose | Apache-2.0 | https://github.com/docker/compose |

## AI Models and Engines

AI models used by Animastor for text-to-speech, image generation, and video generation may have their own licenses. These are not bundled with Animastor and are accessed via APIs or installed separately on GPU workers.

| Component | Typical License | Notes |
|-----------|----------------|-------|
| ComfyUI | GPL-3.0 | Node-based diffusion model UI — runs on GPU workers |
| Stable Diffusion models | CreativeML Open RAIL-M | Image generation — varies by model version |
| LTX Video | Apache-2.0 | Video generation models |
| TTS models | Varies | Text-to-speech engines — check individual model licenses |

## Android

| Component | License | Link |
|-----------|---------|------|
| Kotlin | Apache-2.0 | https://kotlinlang.org/ |
| Android SDK | Apache-2.0 | https://developer.android.com/license |

## Development Tools

| Package | License | Link |
|---------|---------|------|
| Mocha | MIT | https://mochajs.org/ |
| Chai | MIT | https://www.chaijs.com/ |
| nyc (Istanbul) | ISC | https://github.com/istanbuljs/nyc |
| TypeScript | Apache-2.0 | https://www.typescriptlang.org/ |
| Vitest | MIT | https://vitest.dev/ |

---

If you believe any license information is incorrect or missing, please open an issue.
