# 08. Android → Mobile Web Migration

This section covers migrating the Animastor Android app (`frontend/`, Kotlin) to a
mobile web version (`frontends/mobile/`, domain `https://m.animastor.in/`).

> **Status:** stages 0–7 completed ✅ — `frontends/mobile` builds
> (`tsc --noEmit` + `vite build` + dev-server smoke — OK). Implemented:
> skeleton (shell/theme/i18n/API client/cache), Settings/VBookSettings/
> WorkerSettings/Library (stage 1), WorkflowManager/WorkflowDetails/
> WorkflowTypeList/DeveloperView/AiAssistant (stage 2), File (stage 3),
> Generate (stage 4), Navigate (stage 5), Edit (stage 6), Play (stage 7 —
> multiplex player: scene queue, gapless 2×`<audio>`, video overlay, IU-cycling,
> seek, soft-refresh, lifecycle). Remaining: remove Basic Auth from
> `m.animastor.in` before public launch — see [TODO.md](TODO.md).

---

## ✅ Core project rule

The mobile web version must **closely replicate the Android app** in
design, logic, and user experience. Any deviations must be
**pre-documented and justified** in this section (see
[`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md)) — before they
appear in code.

---

## Section structure

| Document | Contents |
|---|---|
| [`01-MIGRATION-STRATEGY.md`](01-MIGRATION-STRATEGY.md) | Overall strategy for migrating Android UI to Mobile Web |
| [`02-DESIGN-PRESERVATION-PRINCIPLES.md`](02-DESIGN-PRESERVATION-PRINCIPLES.md) | Design and UX preservation principles |
| [`03-MOBILE-WEB-ARCHITECTURE.md`](03-MOBILE-WEB-ARCHITECTURE.md) | Proposed `frontends/mobile/` architecture |
| [`04-MAPPING-TABLES.md`](04-MAPPING-TABLES.md) | Screen→Page, Component→Web Component mapping tables |
| [`05-SCREEN-IMPLEMENTATION-ORDER.md`](05-SCREEN-IMPLEMENTATION-ORDER.md) | Screen migration plan (simple → complex) |
| [`06-RISKS-AND-ALTERNATIVES.md`](06-RISKS-AND-ALTERNATIVES.md) | High technical risk components + alternatives. Player — detailed |
| [`07-MOBILE-WEB-TESTER.md`](07-MOBILE-WEB-TESTER.md) | Android mobile web tester (`tools/mobile-web-tester`) — phone viewport on tablet |

---

## Related documents

- [`docs/01-overview/PROJECT_STRUCTURE.md`](../01-overview/PROJECT_STRUCTURE.md) — `frontends/mobile/` position in project
- [`docs/05-frontend/PLAYER_STATE.md`](../05-frontend/PLAYER_STATE.md) — Android player state (web contract)
- [`docs/03-audit/PLAYER_AUDIT.md`](../03-audit/PLAYER_AUDIT.md) — Android player audit
- [`docs/DONT_DO.md`](../DONT_DO.md) — player anti-patterns (relevant for web migration too)
- [`README.md`](../../README.md) — project services (frontends/mobile)
