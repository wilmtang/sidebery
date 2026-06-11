# Sidebery v6.1.0 — Second Audit Findings & Execution Plan

**Date:** 2026-06-11
**Baseline:** Gemini Antigravity audit report (2026-06-10). This document contains (1) NEW findings not in that report, (2) corrections/re-grades of that report's findings, and (3) an execution plan organized into workstreams that can be handed to separate AI agents.
**Verification status:** every NEW finding below was confirmed by reading the code at the cited lines. All 85 unit tests pass on `v6` (`npm test`).

---

## Part 1 — NEW findings (not in the Gemini report)

### 🔴 High

**N1. `AsyncQueue` deadlocks permanently when the fast-path task rejects**
`src/utils.ts:1196-1204`. In `AsyncQueue.add()`, the first (non-queued) call runs `const result = await fn(...args)` *outside* any try/finally. If `fn` rejects, `_waitingQueue` stays `true` forever and `_processQueue()` never runs → every subsequent `add()` queues a promise that never settles.
Blast radius (call sites):
- `src/services/sync.ts:71` / `src/services/sync.bg.google.ts:24` — `_save` rethrows on network error (`sync.bg.ts:68-71`), so **one failed sync save permanently bricks all sync operations** until the background page restarts.
- `src/services/tabs.fg.handlers.ts:687` — `GLOBAL_QUEUE.add(browser.tabs.move, ...)` is uncaught; `tabs.move` rejects easily (tab closed mid-event) → all subsequent queued tab moves in the sidebar silently hang.
- `src/services/web-req.bg.ts:263,276` — see N6.
**Fix:** wrap the fast path in try/finally (on error: drain queue / reset flag), and add `.catch` at the uncaught call sites.

**N2. `Sync.load()` waiters hang even on the success path**
`src/services/sync.bg.ts:248-342`. Extends Gemini's finding #2 (which only covered the throw path): `_load()`'s early-return branch (`ready && !forced && entries.length`, lines 269-273) returns **without resolving `onLoadHandlers`**. Sequence: load B is queued; load C arrives while `loading === true` and pushes a handler; B's `_load` early-returns → C hangs forever. Also `loading = true` is set in `load()` before `QUEUE.add(_load)`; combined with N1, a stuck queue leaves `loading` true forever and all future `load()` calls accumulate as永-pending handlers.
**Fix:** resolve/reject `onLoadHandlers` in a finally-style block covering *all* exit paths of `_load`, and reset `loading` likewise.

**N3. IPC connection confirmations are keyed by the constants `-1`/`-2` in a shared map**
`src/services/ipc.ts:226,264,296,314` and `851-856`. `msgsWaitingForAnswer.set(conConfirmId, ...)` uses `-1` (to bg) or `-2` (to anything else). If one instance connects to **two destinations concurrently** (bg connecting to several sidebars/group pages at startup), the second `connectTo` overwrites the first's confirmation entry; the first's 5s timeout then fires, deletes the *second's* entry, and marks the wrong connection Closed/retried. Additionally `onPostMsg` (line 855) hardcodes `msgsWaitingForAnswer.delete(-1)` even when the confirmation id was `-2`, so stale `-2` entries persist and later confirmations invoke an old connection's `ok()` (marking a dead connection `Ready`).
**Fix:** key confirmation entries per-connection (e.g. by port name or a unique negative counter), and delete the actual key received.

**N4. `onConnect` never filters by `dstTabId`**
`src/services/ipc.ts:652-653`. Only `dstType` and `dstWinId` are checked. `runtime.onConnect` fires in **all** extension contexts, so when bg connects to the setup/group page of tab A, the setup/group pages in **every other tab** also accept the port and register it as their bg connection (`id = NOID` since `srcType === bg`). Messages sent on that port are then processed by multiple group pages (wrong-tab actions, duplicated handling). Multiple simultaneously-open group pages are a completely normal state.
**Fix:** add `if (portNameData.dstTabId !== undefined && portNameData.dstTabId !== _localTabId) return` (group/setup pages already call `IPC.setTabId`). Same gap exists in `onSendMsg` (`ipc.ts:936-939`), which checks `dstWinId` but not `dstTabId`.

**N5. `updateBgTabsTreeData` destroys tree/panel data for ALL windows when one sidebar request fails**
`src/services/tabs.bg.ts:558-622`. `Promise.all(receivingSidebarTrees)` → a single rejection sets `trees = []`, after which the per-window loop **still resets** `lvl/parentId/panelId/customTitle/customColor` on every tab of every window (lines 604-609) with no tree data to restore them. This runs right before snapshot creation → **snapshots silently lose all tree/panel structure**.
**Fix:** use `Promise.allSettled`; for windows whose tree fetch failed, skip the destructive reset entirely.

**N6. Proxy/reopen requests hang indefinitely once the queue is poisoned**
`src/services/web-req.bg.ts:263,276`. `proxyReqHandler` returns `Utils.GLOBAL_QUEUE.add(Tabs.reopenTab, ...)` as the `proxy.onRequest` blocking response. With N1: after one `reopenTab` rejection on the fast path (e.g. `tabs.create` with an invalid `cookieStoreId` after a container was deleted), every later rule-matched navigation returns a never-settling promise → those page loads hang forever. Also `Tabs.reopenTab` (`tabs.bg.ts:804-828`) has no try/catch around `tabs.create`.
**Fix:** harden `reopenTab` (try/catch, only remove original tab after successful create), and `.catch` the queue promise in `proxyReqHandler`, returning `{}` (no proxy) on failure.

### 🟠 Medium

**N7. Favicon saved against the wrong URL on combined update events** — `src/services/tabs.bg.ts:350-354`. `Favicons.saveFavicon(tab.url, change.favIconUrl)` runs **before** `Object.assign(tab, change)`; if a single `onUpdated` event carries both `url` and `favIconUrl`, the icon is associated with the *previous* page's domain.
**Fix:** move the favicon save after `Object.assign` (or use `change.url ?? tab.url`).

**N8. Favicon index race corrupts domain→icon mapping** — `src/services/favicons.bg.ts:108-189`. The save callback awaits `resizeFavicon()` between computing `index = favicons.length` and writing `favicons[index]`. Two concurrent saves (different URLs) can compute the same append index; the second overwrites the first's icon while both domains point at that index. Likely the root cause of long-standing "wrong favicon on a domain" reports.
**Fix:** reserve the index synchronously before the await, or serialize saves through a queue (after N1 is fixed).

**N9. `handledReqId` is a single module-level string** — `src/services/web-req.bg.ts:20,242-245`. Interleaved `main_frame` requests from two tabs overwrite each other's dedup marker, so a redirect of request A is re-processed (double reopen attempt on the same tab).
**Fix:** a small Set/LRU of recent request ids instead of one string.

**N10. `onTabRemoved` leaves a ghost tab on index mismatch** — `src/services/tabs.bg.ts:288`. `if (index === -1 || tab.index !== index) return` — on inconsistency it returns *without* deleting from `byId`/`window.tabs` and without calling `reinitTabs()` (every sibling handler reinits on inconsistency). Stale tab persists in bg state.
**Fix:** call `reinitTabs('onTabRemoved: index mismatch')` instead of plain return.

**N11. IPC `request()` retry can double-execute non-idempotent actions** — `src/services/ipc.ts:615-627`. On missed confirmation (60s), the same message is re-sent. If the first delivery actually executed (confirmation lost/slow), the action runs twice (tab creation, moves, snapshot ops…). At-least-once semantics are nowhere documented.
**Fix:** decide policy: dedup by msg id on the receiving side, or restrict auto-retry to idempotent actions.

**N12. Reconnect can reject in-flight messages of the NEW port** — `src/services/ipc.ts:963-981`. `resolveUnfinishedCommunications(port)` matches waiters by `port.name`, but port names are deterministic per (src,dst) pair — identical across reconnects. When an old port's `onDisconnect` fires after a new port (same name) is already live, pending requests sent on the new port get spuriously rejected.
**Fix:** match by port identity (store the Port object or a per-connection generation counter), not name.

**N13. `storage.bg.set` delayed/immediate ordering loses newer values** — `src/services/storage.bg.ts:81-91`. `set({k: v1}, 500)` buffers; a later `set({k: v2})` (no delay) writes immediately; then the timer flushes stale `v1` over `v2`. (This replaces Gemini's same-key claim, which was just normal debounce behavior — see corrections.) Affected keys: anything written both ways, e.g. `sidebar` (`sidebar.fg.ts:899` with delay; other paths without).
**Fix:** on immediate `_set`, merge/clear overlapping keys from `storageBuf`.

**N14. `ungroupNativeGroup` orphans the Sidebery group-page tab** — `src/services/tabs.fg.native-groups.ts:347-354`. Ungroup includes the group-page tab (`includeSideberyPage = true`) and leaves it open as a loose tab. Product decision needed: close it, or intentionally convert to a legacy Sidebery group (then keep the tree intact and document it).

**N15. `createSideberyGroupPage` failure paths** — `src/services/tabs.fg.native-groups.ts:243-265`. (a) `Tabs.setNewTabPosition(...)` is called *before* `browser.tabs.create`; if create throws, the stale newTabPosition entry is never cleaned. (b) `groupPage.id` is used unguarded for `tabs.group`/`tabs.move`. (c) The 120 ms `setTimeout` in `onNativeGroupCreated` (line 142) is fire-and-forget — rejections unobserved.

**N16. Native-group rename/title-sync issues** — `src/services/tabs.fg.native-groups.ts:282-332`.
(a) `syncSideberyGroupPageTitle` rewrites the whole hash via `PAGE_HASH_RE` replace → drops the IPPC suffix (`~!<chId>!ch!~`) from the group page URL; verify the page's message channel still works after a rename (needs an e2e test).
(b) `renameNativeGroup` uses `window.prompt()` in the sidebar context — modal prompts are unreliable/blocked in Firefox sidebar documents; replace with Sidebery's input popup.
(c) Wrong i18n key: `'editBookmarkTitle'` for a tab-group rename.

**N17. O(n²) recompute in native-group rails rendering** — `src/sidebar/components/panel.tabs.vue:86-157`. For every tab, `getNativeGroupThread` does `visibleTabs.slice(0,i).some(...)` + `slice(i+1).some(...)`, and `getVisualNativeGroupId` walks ancestors per call. Recomputed on every `nativeGroupsVersion` bump / visibleTabIds change. With 500-1000 tabs this is millions of ops per render pass — a perf regression vs Sidebery's standards. Same family: `hasLaterVisibleDescendant` per ancestor per tab.
**Fix:** one linear pass computing first/last membership per group id; cache visual group id per tab within the pass.

**N18. `ipCheckCtx` clobber race** — `src/services/web-req.bg.ts:26,52,74,226-231`. Module-level single value; two concurrent IP checks for different containers route one check through the wrong container's proxy.

**N19. Async-executor antipattern hangs callers on error** — `src/utils.ts:466-522` (`parseDragEvent`: `browser.tabs.query` rejecting → the drop handler awaits forever; query of a closed `lastFocusedId` window is realistic), `src/utils.ts:1004-1022` (`retry`), `src/services/ipc.ts:527` (`request`: a synchronous throw from `connectTo` — e.g. invalidated extension context — leaves the promise unsettled).
**Fix:** remove `async` executors; use plain promise chains or try/catch-and-reject inside.

**N20. `IPC.sidebars()` rejects wholesale and is often unawaited** — `src/services/ipc.ts:358-367` uses `Promise.all` over per-sidebar `request`s; one disconnected sidebar rejects the whole thing. Callers like `sync.bg.ts:294` (`IPC.sidebars('notify', ...)`) neither await nor catch → unhandled rejections.
**Fix:** `allSettled` inside `sidebars()`, or `sendToSidebars` for fire-and-forget notifications.

### 🟡 Low (new)

- **L1.** `runActionFor`: `if (msg.arg)` skips falsy-but-valid args (`0`, `''`, `false`) → action called with no args. `src/services/ipc.ts:830-837`.
- **L2.** `selectTabsRange`: `Tabs.list[maxIndex]` / `Tabs.list[i]` unguarded (`.isParent`/`.reactive` throw on undefined under stale indexes). `src/services/selection.fg.ts:229-253`. (Overlaps a Gemini low; the second loop is also affected.)
- **L3.** `tabs.fg.move.ts:206-252` — four unawaited, uncaught `browser.tabs.update(openerTabId)` calls.
- **L4.** `Windows.createWithTabs`: if *all* tab creations fail, the initial `about:blank` tab is still removed → Firefox closes the new window; also `window.tabs` empty → silent `return true`. `src/services/windows.bg.ts:94,193-197`.
- **L5.** `Sync.removeByType` never updates the local `entries` array → stale UI until reload. `src/services/sync.bg.ts:183-203`.
- **L6.** Possible duplicate Vue keys `g:${groupId}` in `visibleItems` if a visual group's tabs become non-contiguous within a panel (tree-descendant "visual" membership makes this reachable after odd moves). `src/sidebar/components/panel.tabs.vue:97-98`.
- **L7.** `onGroupUpdMsg` drops the entire update if `newTabEl` is missing (early return before title/window handling). `src/page.group/group.ts:162`.
- **L8.** `HEXA_RE` `[0-f]` accepts garbage like `#1G2H3I` and *partially parses* it (`parseInt('1G',16) === 1`) → returns `[1,2,3,1]` instead of undefined. `src/utils.ts:269-270`. (Sharper version of Gemini's regex note.)
- **L9.** `isRegExp(null/undefined)` throws (`(value).test` access); currently safe at its only call sites (web-req rule values) but a footgun. `src/utils.ts:993-995`.
- **L10.** `withoutEmptyFolders` assumes parents precede children in the array; child-first input misclassifies folders as empty. `src/utils.ts:1268-1291`.
- **L11.** `_set` notifies fg instances *before* `browser.storage.local.set` resolves — fg can apply state that then fails to persist. `src/services/storage.bg.ts:54-79`.
- **L12.** `loadBinAsBase64`: `response.blob()` outside try/catch → unhandled rejection; timer already fired path double-resolves (harmless) but blob error is not. `src/utils.ts:747-769`.

---

## Part 2 — Corrections to the Gemini report

Hand this list to agents so they **don't burn time "fixing" non-bugs**:

| Gemini finding | Verdict | Detail |
|---|---|---|
| `sameStart` wrong length check (utils.ts:242) | ❌ **False positive** | `slice(0, limit)` clamps; both branches produce identical results for every input. No behavior change possible. Do not fix. |
| `getIndexToReplace` deletes domains sharing the index (favicons.bg.ts:89) | ❌ **False positive** | Intentional: the favicon at that index is being replaced, so domains referencing it must be unmapped or they'd show the wrong icon. Do not "fix". (The real favicon bug is N8.) |
| `incHistory` grows unboundedly (web-req.bg.ts:25) | ⚠️ **Overstated** | Keyed by container id — bounded by container count. Stale values, not a leak. Optional cleanup only. |
| `pendingProxyAuthRequests` stranded forever (web-req.bg.ts:24) | ⚠️ **Overstated** | It's a Set and is `.clear()`ed at the top of every `updateReqHandlers()` (line 121). Not permanent. |
| `reopenTab` deletes original tab when create fails (tabs.bg.ts:819) | ⚠️ **Wrong mechanism, real problem** | If `tabs.create` rejects, the `await` throws and `tabs.remove` is **never reached** — the original tab survives. The actual damage is the uncaught rejection poisoning `GLOBAL_QUEUE` (N1/N6). Fix per N6. |
| `getSnapInterval` doesn't handle `'sec'` (snapshots.bg.ts:263) | ❌ **False positive** | `SETTINGS_OPTIONS.snapIntervalUnit = ['min','hr','day']` (`src/defaults/settings.ts:347`); `'sec'` cannot occur. Defensive fallback optional, not a bug. |
| storage.bg delayed set "same key overwritten" (storage.bg.ts:84) | ❌ **By design** (last-write-wins is what a debounce buffer does) — but see N13 for the *real* ordering bug in the same code. |
| `reloadingTabs` accumulation (tabs.fg.ts:1054) | ⚠️ **Overstated** | Local array, alive only while the bulk-reload interval runs; cleared with it. Cosmetic at most (progress closes slightly early). |
| `initialTabId` undefined (windows.bg.ts:97) | ⚠️ **Already handled** | The `tabs.remove(initialTabId)` is inside try/catch (lines 193-197). Cosmetic guard only. |
| `rmChildByIndex` off-by-one (bookmarks.fg.ts:259) | ✅ Real but **harmless** | `splice(length,1)` is a no-op returning `undefined`; only the warning is skipped. Trivial fix. |
| `isRegExp` false positives (utils.ts:993) | ✅ Real shape, **low impact** | Only used on `RegExp \| string` rule values where strings have no `.test`. See L9 (null crash) for the sharper issue. |
| `onUpdateAvailable` `<=` (background.ts:119) | ✅ Real-looking, **confirm intent first** | Merely having the listener defers auto-update; reloading only for same/older versions looks inverted, but may be a deliberate "don't restart users mid-session on upgrades" choice. Ask the maintainer / check git blame before changing. |
| All other Gemini items spot-checked (toRGBA, decodeUrlPunycode, sync `_load` error path, openCachedWindow empty cache, containers query unhandled (throws when `privacy.userContext` is disabled), `creating` flag race, shared proxy-badge timeout, `bufTabActivatedEventIndex`, `srcPanelId` overwrite, `lockedWindowsTabs` leak (no cleanup in `onWindowRemoved`), `createObjectURL` leak, snapshot read-modify-write race, containers.fg missing `delay` arg, group.ts splice loop, context-menu `querySelector` injection (use `CSS.escape`), dnd `clientX`-as-y, `getPortErrorMessage` dup, stale `focused` flag) | ✅ **Confirmed as reported** | Proceed with fixes. |

---

## Part 3 — Execution plan (workstreams for AI agents)

General rules for every agent:
1. **One workstream = one branch/PR.** Branch off `v6`. Keep diffs minimal; match existing code style (no new deps).
2. **Every behavioral fix ships with a test** where the code is testable (utils, sync logic, storage buffering are all unit-testable; there is an existing vitest setup — see `src/services/settings.test.ts`, `src/services/tabs.fg.native-groups.test.ts` — and an e2e harness `tests/e2e/firefox-native-groups.test.mjs`).
3. Run `npm test` and `npx tsc --noEmit` (types must stay clean) before declaring done.
4. **Do not fix items marked False positive in Part 2.**
5. When a fix changes cross-context behavior (IPC, storage), state the assumption in the PR description so a reviewer can challenge it.

### WS-A — Async foundations (do FIRST; small, unblocks others)
Scope: `src/utils.ts` + uncaught call sites.
1. N1: make `AsyncQueue.add` exception-safe (try/finally; drain queue on error). Unit-test: first task rejects → second task still runs.
2. N19: de-async-ify executors in `retry`, `parseDragEvent`, `loadBinAsBase64` (L12); ensure all paths settle.
3. Gemini-confirmed: `deadline()` — clear timer on settle.
4. Call-site hardening: `.catch` on `GLOBAL_QUEUE.add` at `tabs.fg.handlers.ts:687`, `tabs.fg.ts:864` (already has), `web-req.bg.ts:263,276` (N6 part), `settings.bg.ts:30` (`Sync.save(...).catch(Logs.err)`).
Acceptance: new unit tests for AsyncQueue rejection + retry/parseDragEvent error paths.

### WS-B — Pure utils correctness (independent; easiest)
Scope: `src/utils.ts` only — all unit-testable.
1. toRGBA percentage channels (`gn`/`bn` at lines 291/297) — Gemini #1.
2. `decodeUrlPunycode` rewrite: per-label `xn--` check (decode only labels that start with `xn--`, leave others) — Gemini #4.
3. L8: tighten `HEXA_RE` to `[0-9a-fA-F]`.
4. `colorFromString` odd-length last char (include it or document).
5. L9 `isRegExp`: `value instanceof RegExp` (keep cross-realm caveat in mind; instanceof is fine here).
6. L10 `withoutEmptyFolders`: two-pass (build `itemsById` first).
Acceptance: table-driven unit tests for each (e.g. `rgba(50%, 25%, 10%, 50%)`, `xn--80ak6aa92e.com`, `сайт.xn--p1ai`, `#1G2H3I`).

### WS-C — Sync service lifecycle
Scope: `src/services/sync.bg.ts`, `sync.ts`, `sync.bg.google.ts`. Depends on WS-A (queue fix).
1. N2 + Gemini #2: restructure `load()/_load()` so `onLoadHandlers` are resolved/rejected on **every** exit path; reset `loading` in finally.
2. N20: `IPC.sidebars` → allSettled or use `sendToSidebars` for notify.
3. L5: `removeByType` updates local `entries`.
4. Audit every `QUEUE.add` caller for rejection handling.
Acceptance: unit tests simulating concurrent `load()` calls (success, early-return, and throw paths) — assert no pending promise is left unsettled.

### WS-D — IPC layer (highest risk; isolate; review carefully)
Scope: `src/services/ipc.ts`.
1. N3: per-connection confirmation keying; remove hardcoded `delete(-1)`.
2. N4: `dstTabId` checks in `onConnect` and `onSendMsg`.
3. N12: identity-based (not name-based) unfinished-communication cleanup.
4. N11: decide & implement retry policy (recommend: receiving-side dedup by msg id, short TTL).
5. Gemini-confirmed: `getPortErrorMessage` second branch → `remotePort`.
6. L1: `msg.arg !== undefined` in `runActionFor`.
Acceptance: manual matrix test — multi-window startup (3+ windows, sidebars open), multiple group pages open simultaneously, kill/restore bg page, verify each sidebar/group page only handles its own messages. This WS most needs a human-in-the-loop smoke test in Firefox.

### WS-E — Background tab/window/services hardening
Scope: `src/services/tabs.bg.ts`, `windows.bg.ts`, `snapshots.bg.ts`, `containers.bg.ts`, `favicons.bg.ts`, `web-req.bg.ts`, `storage.bg.ts`, `settings.bg.ts`, `background.ts`.
1. N5: `updateBgTabsTreeData` → allSettled, skip destructive reset on missing tree.
2. N6: harden `reopenTab`; `.catch` queue promises in `proxyReqHandler` returning `{}`.
3. N7: favicon save after `Object.assign` in `onTabUpdated`.
4. N8: reserve favicon index before `await resizeFavicon`.
5. N9: `handledReqId` → bounded Set.
6. N10: reinit on `onTabRemoved` mismatch.
7. N13: clear overlapping buffered keys on immediate `_set`.
8. N18: pass ctx per-request instead of module-level `ipCheckCtx` (or accept and document the race).
9. Gemini-confirmed batch: `openCachedWindow` empty-cache guard; per-tab proxy-badge timeouts (Map keyed by tabId); `lockedWindowsTabs` cleanup in `onWindowRemoved`; `onWindowFocused` unset previous `focused`; `containers.load` catch around `contextualIdentities.query` (degrade gracefully when containers are disabled); `creating` flag → Set of names; snapshot create/add serialization (single promise chain or AsyncQueue after WS-A); `URL.revokeObjectURL` after `downloads.download` completes (use `downloads.onChanged`) + `.catch` on download (invalid user-template filename chars!); uncaught `tabs.reload`/`windows.update`/`Store.set` sites; L4 `createWithTabs` ordering.
Acceptance: unit tests where feasible (storage buffer ordering is easily testable); rest via existing e2e + manual snapshot/restore exercise.

### WS-F — Foreground sidebar fixes
Scope: `src/services/*.fg.ts`, `src/sidebar/components/popup.context-menu.vue`, `src/page.group/group.ts`.
1. Gemini-confirmed batch: `containers.fg.ts:71` missing `delay` arg; `drag-and-drop.fg.ts:519` `e.clientX` → `e.clientY`; `popup.context-menu.vue:234` wrap with `CSS.escape()` (both query sites); `group.ts:193-197` splice loop → `tabs.splice(i).forEach(t => t.el?.remove())`; `bookmarks.fg.ts:259` `>=`; `tabs.fg.move.ts:232` `srcPanelId` → `Set<ID>` and recalc each; `bufTabActivatedEventIndex` — reset to `-1` wherever `deferredEventHandling` is cleared/replayed.
2. L2 selection guards; L3 catch the four `tabs.update` calls; L7 group.ts early-return placement.
Acceptance: `npm test` + manual sidebar smoke (drag-drop native item, context menu keyboard nav over options containing quotes, bulk move across panels).

### WS-G — Native tab groups (v6 feature polish)
Scope: `src/services/tabs.fg.native-groups.ts`, `panel.tabs.vue`, `native-tab-group.vue`, `menu.fg.options.tabs.ts`. There are existing unit tests (`tabs.fg.native-groups.test.ts`) and e2e (`tests/e2e/firefox-native-groups.test.mjs`) to extend.
1. N14: decide ungroup policy for the Sidebery group-page tab (recommend: close it when ungrouping; offer "convert to Sidebery group" as separate menu item).
2. N15: fix create failure paths (position cleanup, id guards, observed setTimeout promise).
3. N16: (a) preserve IPPC hash suffix on title sync — replace only the `prefix` group; add e2e: rename group → group page channel still functional; (b) replace `window.prompt` with the editing popup used elsewhere; (c) proper i18n key.
4. N17: linear-pass computation of group threads/guides; measure with 500+ tabs before/after.
5. L6: de-dupe group header keys (suffix with occurrence index).
Acceptance: extend both test files; e2e for rename/ungroup/collapse with a Sidebery group page present.

### Suggested sequencing

```
WS-A (utils async)  ──┬──> WS-C (sync)
WS-B (utils pure)     ├──> WS-E (bg services)
                      └──> WS-F (fg fixes)      WS-D (IPC) — independent but riskiest; schedule with review time
WS-G (native groups) — independent; product decisions needed for N14 first
```

WS-A+WS-B are ~1 day combined and unblock everything. WS-D should not be batched with anything else — its regressions are the hardest to notice.

### Verification gate (after all workstreams merge)
1. `npm test` + `npx tsc --noEmit` + `npm run build.*` clean.
2. e2e suite incl. extended native-group tests.
3. Manual scenario script: 3 windows / 200+ tabs / 2 group pages / containers with reopen rules + proxy / create+restore snapshot / sync save with network offline (verify sync recovers when back online — this exercises N1+N2).
