# Sidebery v6.1.0 - Revised Audit Report & Execution Plan

**Date:** 2026-06-11
**Author:** Codex review of `AUDIT_EXECUTION_PLAN.md`
**Baseline reviewed:** `AUDIT_EXECUTION_PLAN.md`
**Repo baseline:** `v6` at `a7d5804c`
**Verification:** `npm test` passed locally: 9 test files, 85 tests.

This report reviews the existing audit/execution plan, spot-checks the cited code paths, and replaces the prior plan with a tighter execution order. It does not modify source code.

---

## Summary

The existing plan is mostly strong and specific. The biggest change in this revision is classification:

- Keep the async queue, sync lifecycle, IPC routing, snapshot/tree-data, and storage-ordering issues as the highest-priority work.
- Split the large "confirmed Gemini batch" into testable workstreams instead of handing it to agents as one bucket.
- Remove or correct stale/overstated items, especially already-caught queue call sites and the favicon append-index race.
- Mark native tab-group ungroup behavior as a product decision before implementation.

---

## P0 - Async Deadlocks And Never-Settling Promises

### A1. `AsyncQueue.add()` can permanently poison the queue

**Status:** Confirmed
**Severity:** High
**File:** `src/utils.ts:1182-1221`

The first, non-queued task sets `_waitingQueue = true`, then awaits `fn(...args)` without `try/finally`. If that first task rejects, `_waitingQueue` remains `true` forever, `_processQueue()` is never called, and later tasks stay pending.

Confirmed affected queues:

- `src/services/sync.ts:71`
- `src/services/sync.bg.ts:23`
- `src/services/sync.bg.google.ts:24`
- `src/services/web-req.bg.ts:263,276`
- `src/services/tabs.fg.move.ts:851,876,924`

**Correction to previous plan:** `src/services/tabs.fg.handlers.ts:687` is already caught in this checkout. Keep the queue fix, but remove that call site from the explicit hardening list.

**Recommended fix:** Wrap the fast path in `try/finally`, make sure queue processing continues after rejection, and preserve rejection to the caller.

**Tests:** First queued action rejects; second action still runs and settles.

### A2. `Sync.load()` waiters can hang on success and failure paths

**Status:** Confirmed
**Severity:** High
**File:** `src/services/sync.bg.ts:248-342`

`onLoadHandlers` are resolved only after the full load path completes. The early return path at `ready && !forced && entries.length` resets `loading` and returns `entries`, but it does not resolve handlers queued while `loading === true`. Throwing before the final handler loop has the same shape.

**Recommended fix:** Put `loading` reset and waiter resolution/rejection into a single `finally`-style lifecycle that covers all exits from `_load()`.

**Tests:** Concurrent `load()` calls for early-return, successful full load, and thrown load. Assert no caller remains pending.

### A3. Async-executor antipatterns can leave callers unsettled

**Status:** Confirmed
**Severity:** Medium
**Files:**

- `src/utils.ts:466-522` (`parseDragEvent`)
- `src/utils.ts:747-769` (`loadBinAsBase64`)
- `src/utils.ts:1004-1022` (`retry`)
- `src/services/ipc.ts:527` (`request`)

Promises constructed with async executors do not automatically reject the outer promise when the executor throws after an `await`. Realistic examples include `browser.tabs.query()` rejection in drag parsing and `response.blob()` failure in binary loading.

**Recommended fix:** Convert to plain `async` functions or use non-async promise executors with explicit reject handling.

---

## P1 - IPC Routing And Reconnect Correctness

### I1. Connection confirmations are keyed by shared constants

**Status:** Confirmed
**Severity:** High
**File:** `src/services/ipc.ts:226,314,850-856`

`connectTo()` uses `-1` or `-2` as the confirmation key for all connections. Concurrent connection attempts from one context can overwrite each other. `onPostMsg()` also hardcodes `msgsWaitingForAnswer.delete(-1)`, leaving stale `-2` waiters.

**Recommended fix:** Generate a unique confirmation id per connection attempt, store it on the connection or closure, and delete the actual id received.

### I2. `dstTabId` is ignored when accepting ports/messages

**Status:** Confirmed
**Severity:** High
**File:** `src/services/ipc.ts:652-653,936-939`

The destination window is checked, but destination tab is not. Runtime ports/messages can be accepted by setup/group pages in other tabs when `dstType` matches.

**Recommended fix:** Add `dstTabId` filtering in both `onConnect()` and `onSendMsg()` when the local tab id is known.

### I3. Old port disconnects can reject new-port requests

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/ipc.ts:963-981`

`resolveUnfinishedCommunications()` matches waiters by `port.name`. Port names are deterministic for a source/destination pair, so an old disconnect can match waiters created for a newer connection.

**Recommended fix:** Track port identity or a per-connection generation, not only `port.name`.

### I4. Request retry semantics can double-execute actions

**Status:** Confirmed design risk
**Severity:** Medium
**File:** `src/services/ipc.ts:615-627`

On a confirmation timeout, `request()` resends the same action. If the first delivery executed but the confirmation/result was delayed or lost, non-idempotent actions can run twice.

**Recommended fix:** Either add receiver-side dedupe by message id with a TTL, or restrict automatic resend to explicitly idempotent actions.

---

## P1 - Snapshot, Tree, And Persistence Integrity

### S1. One failed sidebar tree fetch can erase tree/panel data for all windows

**Status:** Confirmed
**Severity:** High
**File:** `src/services/tabs.bg.ts:558-622`

`updateBgTabsTreeData()` uses `Promise.all()`. One rejection sets `trees = []`, but the function still loops over every window and resets `lvl`, `parentId`, `panelId`, `customTitle`, and `customColor`.

**Recommended fix:** Use `Promise.allSettled()`. For windows whose tree fetch failed, skip destructive reset entirely.

### S2. Snapshot create/add/remove are un-serialized read-modify-write paths

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/snapshots.bg.ts:37-151,160-168,520-541`

Concurrent snapshot operations can read the same stored list, mutate independently, and overwrite each other.

**Recommended fix:** Serialize snapshot mutations with an `AsyncQueue` after A1 is fixed, or use a dedicated promise chain.

### S3. `storage.bg.set()` delayed/immediate ordering can write stale values

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/storage.bg.ts:81-91`

Sequence:

1. `set({ k: v1 }, 500)` buffers `v1`.
2. `set({ k: v2 })` writes `v2` immediately.
3. The delayed flush later writes stale `v1`.

**Recommended fix:** On immediate `_set`, remove overlapping keys from `storageBuf`, or flush buffered state in order before the immediate write.

### S4. Storage listeners are notified before persistence succeeds

**Status:** Confirmed
**Severity:** Low/Medium
**File:** `src/services/storage.bg.ts:54-79`

Foreground contexts can apply state that then fails to persist.

**Recommended fix:** Prefer persisting first, then notifying. If existing UX depends on optimistic notification, document it and add failure rollback/logging.

---

## P2 - Background Services And Browser State

### B1. Proxy reopen path needs failure isolation

**Status:** Confirmed
**Severity:** High when combined with A1
**Files:**

- `src/services/web-req.bg.ts:263,276`
- `src/services/tabs.bg.ts:804-828`

`proxyReqHandler()` returns the queue promise as a blocking response. If `Tabs.reopenTab()` rejects, the queue can be poisoned today, and the blocking request can fail poorly.

**Recommended fix:** Harden `reopenTab()` and catch queue failures in `proxyReqHandler()`, returning `{}` or no proxy decision on failure.

### B2. `handledReqId` is a single global string

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/web-req.bg.ts:20,242-245`

Interleaved `main_frame` requests can overwrite the dedupe marker.

**Recommended fix:** Use a bounded `Set`/LRU keyed by request id.

### B3. `ipCheckCtx` is a single global value

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/web-req.bg.ts:26,50-74,226-231`

Concurrent IP checks for different containers can route through the wrong proxy context.

**Recommended fix:** Tie context to a request token or serialize IP checks.

### B4. `onTabRemoved()` leaves ghost tabs on index mismatch

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/tabs.bg.ts:276-307`

On `index === -1 || tab.index !== index`, the function returns without deleting the tab or reinitializing.

**Recommended fix:** Call `reinitTabs('onTabRemoved: index mismatch')`.

### B5. Favicon save can associate icon with previous URL

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/tabs.bg.ts:350-354`

If `change.url` and `change.favIconUrl` arrive together, `Favicons.saveFavicon(tab.url, ...)` runs before `Object.assign(tab, change)`.

**Recommended fix:** Use `change.url ?? tab.url`, or save after assigning URL state.

### B6. Favicon concurrency claim needs demotion

**Status:** Overstated in previous plan
**Severity:** Low/Needs repro
**File:** `src/services/favicons.bg.ts:147-165`

The prior report says two concurrent saves can compute the same append index before `await resizeFavicon()`. In this checkout, append index is chosen after the await, so that exact race is not confirmed. There may still be stale hash/domain and max-capacity replacement races.

**Recommended fix:** Do not treat this as a root-cause claim without a repro. If touching favicon save anyway, serializing saves is still reasonable.

### B7. Other confirmed background hardening

**Status:** Confirmed
**Severity:** Low/Medium

- `openCachedWindow()` crashes on empty cache: `src/services/tabs.bg.ts:147-163`
- proxy badge debounce is shared across tabs: `src/services/tabs.bg.ts:412-418`
- `lockedWindowsTabs` is not cleaned in `onWindowRemoved()`: `src/services/windows.bg.ts:250-264`
- focused window flags can remain stale: `src/services/windows.bg.ts:266-287`
- `Windows.createWithTabs()` can remove the initial blank tab even if all created tabs failed: `src/services/windows.bg.ts:127-197`
- `containers.bg.load()` does not handle `contextualIdentities.query()` failure gracefully: `src/services/containers.bg.ts:21-24`
- container creation sentinel is one string, not a set: `src/services/containers.bg.ts:104-115`
- snapshot export object URLs are not revoked and download promises are not caught: `src/services/snapshots.bg.ts:184-211`
- `background.ts` update listener reloads only when `newVersion <= currentVersion`; confirm maintainer intent before changing: `src/bg/background.ts:119-123`

---

## P2 - Foreground And Sidebar Correctness

### F1. Unsafe context-menu selector construction

**Status:** Confirmed
**Severity:** Medium
**File:** `src/sidebar/components/popup.context-menu.vue:232-235`

The selector interpolates `opt.tooltip ?? opt.label` directly into a CSS selector. Quotes and special selector characters can break lookup.

**Recommended fix:** Use `CSS.escape()`.

### F2. Native drag event uses `clientX` as Y coordinate

**Status:** Confirmed
**Severity:** Low/Medium
**File:** `src/services/drag-and-drop.fg.ts:517-520`

`y: e.clientX` should be `y: e.clientY`.

### F3. Selection range assumes tab indexes are valid

**Status:** Confirmed
**Severity:** Low/Medium
**File:** `src/services/selection.fg.ts:229-253`

`Tabs.list[maxIndex]` and `Tabs.list[i]` are unguarded.

**Recommended fix:** Guard missing tabs and reset/reinit selection state on stale indexes.

### F4. Group page update can skip non-tab updates

**Status:** Confirmed
**Severity:** Low
**File:** `src/page.group/group.ts:161-197`

`if (!newTabEl) return` prevents title/window updates too. The splice loop also mutates while incrementing and can leave stale elements.

**Recommended fix:** Move the `newTabEl` guard inside the `upd.tabs` handling and replace the splice loop with a safe removal pattern.

### F5. Other confirmed foreground hardening

**Status:** Confirmed
**Severity:** Low/Medium

- `containers.fg.saveContainer()` ignores the `delay` value in `setTimeout`: `src/services/containers.fg.ts:71`
- `tabs.fg.move.ts` has uncaught `browser.tabs.update(...openerTabId...)` calls: `src/services/tabs.fg.move.ts:206-208,251-252`
- `srcPanelId` in tab move is overwritten by the last moved tab; use a set and recalc all affected panels: `src/services/tabs.fg.move.ts:230-233`
- `bufTabActivatedEventIndex` should be reset when deferred events are cleared/replayed: `src/services/tabs.fg.handlers.ts:105-106`, `src/services/tabs.fg.handlers.ts:1651-1665`
- `BkmNode.rmChildByIndex()` should reject `index >= length`, not only `index > length`: `src/services/bookmarks.fg.ts:254-263`

---

## P2 - Pure Utility Correctness

**Status:** Confirmed
**Severity:** Low/Medium
**File:** `src/utils.ts`

Fix with table-driven unit tests:

- `deadline()` does not clear the timeout after promise settlement: `src/utils.ts:120-124`
- `toRGBA()` uses red percentage for green/blue percentage channels: `src/utils.ts:291,297`
- `HEXA_RE` uses `[0-f]`, accepting invalid characters and partial parse behavior: `src/utils.ts:269-270`
- `decodeUrlPunycode()` only handles URLs that start with `xn--`, not per-label punycode: `src/utils.ts:962-967`
- `isRegExp(null)` / `isRegExp(undefined)` throws: `src/utils.ts:993-995`
- `withoutEmptyFolders()` assumes parents precede children: `src/utils.ts:1268-1291`
- `colorFromString()` ignores the last character of odd-length strings: `src/utils.ts:250-265`

False positives/overstated items to avoid:

- `sameStart()` length check is not a behavior bug.
- `getSnapInterval()` not supporting `sec` is not a bug because options are `min`, `hr`, `day`.
- `pendingProxyAuthRequests` is cleared on handler refresh; not a permanent leak.
- `incHistory` is bounded by container count; stale cleanup is optional.
- `reloadingTabs` is local to the bulk reload interval; low impact.

---

## Product Decision - Native Tab Groups

### N1. Ungrouping a native group includes the Sidebery group page

**Status:** Product decision required
**File:** `src/services/tabs.fg.native-groups.ts:347-354`

`ungroupNativeGroup()` includes the Sidebery group page tab. That may intentionally preserve a legacy Sidebery group, or it may be unwanted clutter.

Decide before implementing:

- Close the Sidebery group page when ungrouping native tabs.
- Preserve it and document that ungroup converts to a Sidebery group.
- Offer both actions separately.

### N2. Native group page creation and title sync hardening

**Status:** Confirmed
**Severity:** Medium
**Files:** `src/services/tabs.fg.native-groups.ts`, `src/sidebar/components/panel.tabs.vue`

Fix after N1 decision:

- Clean up `newTabPosition` if group page creation fails.
- Guard `groupPage.id` before grouping/moving.
- Observe/log the `setTimeout(...createSideberyGroupPage...)` promise.
- Preserve the IPPC hash suffix when syncing group page title.
- Replace `window.prompt()` with the project popup/input UI.
- Use a native-group rename i18n key instead of `editBookmarkTitle`.
- Optimize native-group rails/header computation from repeated scans to one linear pass.
- De-dupe `g:${groupId}` keys if visual groups become non-contiguous.

---

## Revised Execution Plan

General rules for every workstream:

1. One workstream per branch/PR.
2. Keep diffs narrow and follow existing style.
3. Add tests where feasible.
4. Run `npm test`, `npm run lint`, and `npm run build` before declaring the workstream complete.
5. Do not fix items explicitly marked false positive or product-decision-only.

### WS-A - Async Core First

**Scope:** `src/utils.ts`, real queue call sites.

1. Fix `AsyncQueue.add()` exception safety.
2. Fix `deadline()`.
3. Convert `retry`, `parseDragEvent`, and `loadBinAsBase64` away from async executors.
4. Catch real uncaught queue call sites, especially `web-req.bg.ts` and `tabs.fg.move.ts`.
5. Catch/log `Sync.save()` in `settings.bg.ts`.

**Acceptance:** Unit tests for rejected first queue task, queue recovery, and async error settling.

### WS-B - Sync Lifecycle

**Scope:** `src/services/sync.bg.ts`, `src/services/sync.ts`, `src/services/sync.bg.google.ts`.
**Depends on:** WS-A.

1. Make `load()` / `_load()` resolve or reject waiters on every path.
2. Reset `loading` reliably.
3. Make `IPC.sidebars()` usage safe for notifications.
4. Update local `entries` in `removeByType()`.
5. Audit all sync queue callers for rejection handling.

**Acceptance:** Unit tests for concurrent load success, early-return, and throw paths.

### WS-C - IPC Isolation

**Scope:** `src/services/ipc.ts`.

1. Unique confirmation ids per connection attempt.
2. Delete the actual confirmation id received.
3. Add `dstTabId` checks in port and runtime-message handling.
4. Use port identity/generation in unfinished communication cleanup.
5. Decide and implement request retry/dedupe policy.
6. Fix `getPortErrorMessage()` to check `remotePort`.
7. Accept falsy args in `runActionFor()` with `msg.arg !== undefined`.

**Acceptance:** Manual Firefox matrix: 3+ windows, multiple group/setup pages, background reload, reconnect, and targeted messages only reaching intended context.

### WS-D - Persistence And Background State

**Scope:** `storage.bg.ts`, `snapshots.bg.ts`, `tabs.bg.ts`, `windows.bg.ts`, `web-req.bg.ts`, `containers.bg.ts`, `settings.bg.ts`, `background.ts`.
**Depends on:** WS-A for serialization primitives.

1. Fix storage delayed/immediate ordering.
2. Decide storage notification ordering and add tests/logging.
3. Serialize snapshot mutations.
4. Fix `updateBgTabsTreeData()` with `Promise.allSettled()`.
5. Harden `reopenTab()` and proxy blocking responses.
6. Replace `handledReqId` with bounded recent-id tracking.
7. Remove `ipCheckCtx` global race.
8. Reinit on tab-remove index mismatch.
9. Fix cached-window empty cache, proxy badge debounce, window lock cleanup, focused flags, and all-failed window creation.
10. Catch containers-disabled load failure.
11. Replace single container `creating` marker with a set.
12. Revoke snapshot export object URLs and catch downloads.
13. Confirm update-reload intent before changing `onUpdateAvailable`.

**Acceptance:** Storage ordering unit test, snapshot concurrency test where feasible, and manual snapshot/restore exercise.

### WS-E - Pure Utils

**Scope:** `src/utils.ts`.

Fix `toRGBA`, punycode, hex regex, `isRegExp`, `withoutEmptyFolders`, and optionally `colorFromString`.

**Acceptance:** Table-driven unit tests for each utility.

### WS-F - Foreground Sidebar Fixes

**Scope:** `src/services/*.fg.ts`, `src/sidebar/components/popup.context-menu.vue`, `src/page.group/group.ts`.

1. Use `CSS.escape()` in context menu selectors.
2. Fix native drag `clientY`.
3. Add selection guards.
4. Fix group page update guard and splice loop.
5. Fix `containers.fg.saveContainer()` delay.
6. Catch opener-tab update calls.
7. Track all source panels during tab move.
8. Reset deferred activation buffer when deferred events are cleared/replayed.
9. Fix bookmark `rmChildByIndex()` boundary.

**Acceptance:** Unit tests where existing mocks allow it, plus manual sidebar smoke test for drag/drop, context menu keyboard nav, and cross-panel moves.

### WS-G - Native Groups

**Scope:** `tabs.fg.native-groups.ts`, `panel.tabs.vue`, native group components/tests.

1. Resolve Sidebery group-page ungroup policy.
2. Fix group-page creation cleanup and id guards.
3. Preserve IPPC hash suffix on title sync.
4. Replace `window.prompt()` with app UI.
5. Add correct i18n key.
6. Optimize rails/header computation.
7. De-dupe group header keys.

**Acceptance:** Extend existing native-group unit tests and Firefox e2e for rename, ungroup, collapse, and group page channel survival.

---

## Suggested Sequencing

```text
WS-A (async core)
  -> WS-B (sync)
  -> WS-D (persistence/background)

WS-C (IPC) runs alone with review time.

WS-E (pure utils) can run anytime.
WS-F (foreground) can run after WS-A or in parallel if queue call sites are coordinated.
WS-G (native groups) waits for product decision on ungroup behavior.
```

---

## Final Verification Gate

After all workstreams merge:

1. `npm test`
2. `npm run lint`
3. `npm run build`
4. `npm run test.e2e.firefox`
5. Manual scenario:
   - 3 windows
   - 200+ tabs
   - multiple setup/group pages
   - containers with proxy and reopen rules
   - snapshot create/restore
   - sync save while network is offline, then online recovery
   - background reload/reconnect during pending IPC requests
