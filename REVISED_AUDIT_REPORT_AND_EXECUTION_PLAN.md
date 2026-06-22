# Sidebery v6.1.0 - Codex Follow-up Audit Report & Execution Plan

**Date:** 2026-06-16
**Author:** Codex follow-up audit
**Previous Codex audit:** `REVISED_AUDIT_REPORT_AND_EXECUTION_PLAN.md` dated 2026-06-11
**Progress log reviewed:** `AUDIT_FIX_PROGRESS.md`
**Repo baseline:** `v6` at `0bd72544`
**Verification:** `npm test` passed locally: 9 test files, 100 tests.

This is a follow-up audit of the current code after the A-G workstreams in
`AUDIT_FIX_PROGRESS.md` were completed. It replaces the stale pre-fix report with
current residual findings and a smaller execution plan. It does not modify source
code.

---

## Summary

The original Codex audit items are largely implemented:

- `AsyncQueue.add()`, `deadline()`, async utility conversions, pure utility fixes,
  sync load lifecycle, snapshot serialization, background hardening, foreground
  sidebar fixes, and native-group polish are present in the current source.
- The unit suite has grown from 85 tests to 100 tests and passes.
- The still-missing validation is environmental: `npm run test.e2e.firefox` and
  the manual multi-window Firefox matrix from the previous report have not been
  run in this checkout.

The new audit found several residual issues worth fixing. The highest-risk items
are in IPC retry/dedup identity and snapshot tree preservation for windows without
connected sidebars.

---

## P1 - IPC Retry, Dedup, And Settling

### R1. IPC dedup UIDs can collide after a context reload

**Status:** Confirmed
**Severity:** High
**Files:** `src/services/ipc.ts:520`, `src/services/ipc.ts:637-639`,
`src/services/ipc.ts:950-975`

`request()` assigns `msg.uid` from `_localType`, `_localWinId`, `_localTabId`, and
a module-local `uidCounter`. The receiver keeps processed UIDs for
`MSG_CONFIRM_DEADLINE * 2` (120 seconds). If a sidebar/setup/background context
reloads, `uidCounter` starts from `1` again while the receiver can still have
cached entries for the same type/window/tab tuple.

That makes a new, unrelated request eligible for dedup as if it were a retry of
the old request. Because the dedup cache is keyed only by UID, not by action or
payload, the receiver can return the old cached result or queue the new delivery
behind an unrelated in-flight action.

**Recommended fix:** Add a per-context random/process nonce to generated UIDs
(`crypto.randomUUID()` or existing `Utils.uid()` at module init), and store enough
metadata in `processedMsgs` to assert that duplicate UID, action, destination,
and argument shape match before replaying a cached answer.

**Tests:** Simulate two messages with the same legacy UID but different actions
and assert the second is not answered from the first cached result. Simulate a
same-UID/same-action retry and assert it is still deduped.

### R2. `IPC.request()` still uses an async Promise executor

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/ipc.ts:582-691`

The previous audit called out async executors. Most utility cases were fixed, but
`IPC.request()` still returns `new Promise(async (ok, err) => { ... })`. The
awaited connection-confirmation paths are mostly wrapped, but synchronous throws
from `connectTo()` or port access inside the executor can still reject the
executor's implicit promise while leaving the outer promise unsettled.

**Recommended fix:** Convert `request()` to a plain `async` function that awaits a
small helper for connection readiness, then returns a non-async promise only for
the final response timeout. Alternatively keep the promise executor synchronous
and move all awaited work outside it.

**Tests:** Mock `connectTo()` / `browser.runtime.connect()` to throw
synchronously and assert the caller receives a rejection, not a hung promise.

### R3. Async action tracking still uses a port-name-derived key

**Status:** Confirmed design risk
**Severity:** Medium
**Files:** `src/services/ipc.ts:1002-1016`, `src/services/ipc.ts:1070-1086`

`runningAsyncActions` now stores the actual `Port` as the map value and disconnect
cleanup checks by port identity, which fixes part of the old finding. The map key,
however, is still `msgId + port.name`, and result delivery only checks whether the
key exists.

If a context reloads and reconnects with the same deterministic port name while
the old action is still running, message ids can start from `1` again. A key
collision can let the old action delete the new action's tracking entry or let a
result be delivered after the tracked port has changed.

**Recommended fix:** Key async actions by a unique per-delivery token, preferably
the new collision-resistant `msg.uid`, or store a unique record and verify
`runningAsyncActions.get(asyncActionId) === port` before deleting/sending. Avoid a
single key that can represent two live actions.

**Tests:** Two same-name mock ports with the same message id should not interfere
with each other's final responses.

---

## P1 - Snapshot, Tree, And Persistence Integrity

### R4. Missing sidebar connections still flatten background tree data

**Status:** Confirmed
**Severity:** High
**File:** `src/services/tabs.bg.ts:577-587`, `src/services/tabs.bg.ts:602-625`

The previous `Promise.allSettled()` fix prevents one rejected sidebar tree fetch
from resetting all windows. But a window with no connected sidebar still pushes
`Promise.resolve([])`. That fulfilled empty tree is then treated as authoritative:
the code resets every tab in that window to `lvl = 0`, `parentId = NOID`,
`panelId = NOID`, and clears custom title/color.

This can still corrupt snapshot/tree persistence for any normal window whose
sidebar is not connected when `updateBgTabsTreeData()` runs.

**Recommended fix:** Treat "no connected sidebar" the same as a rejected fetch:
skip the destructive reset for that window and preserve existing background tab
metadata. If an explicit flatten operation is needed, make it a separate call.

**Tests:** Build two background windows, connect only one sidebar, call
`updateBgTabsTreeData()`, and assert the disconnected window keeps its existing
`parentId`, `panelId`, `customTitle`, and `customColor`.

### R5. Foreground delayed storage can overwrite newer immediate values

**Status:** Confirmed
**Severity:** Medium
**File:** `src/services/storage.fg.ts:13-23`

The background storage path now drops overlapping buffered keys before an
immediate write. The foreground storage proxy still has the old shape:

1. `Store.set({ k: v1 }, 500)` buffers `v1`.
2. `Store.set({ k: v2 })` sends `v2` to the background immediately.
3. The delayed foreground timer later sends stale `v1`.

The timer also calls `_set(storageBuf)` without a `.catch()`, so IPC failures can
become unhandled rejections.

**Recommended fix:** Mirror the background fix in `storage.fg.ts`: for immediate
writes, delete overlapping keys from `storageBuf`; in delayed flushes, capture the
buffer into a local object, clear it, and catch/log `_set()` failures.

**Tests:** Foreground delayed/immediate same-key ordering test with a mocked
`IPC.bg`.

### R6. Storage notifications use request-style IPC without observing failures

**Status:** Confirmed
**Severity:** Low/Medium
**Files:** `src/services/storage.bg.ts:58-79`, `src/services/ipc.bg.ts:13-27`

`storage.bg._set()` persists first, then calls `IPC.sidebar()`,
`IPC.setupPage()`, and `IPC.panelConfigPopup()` as fire-and-forget notifications.
Those helpers return request promises with 60-second confirmation timeouts. If a
page closes or the connection is stale, the promise can reject without a handler.
`ipc.bg.sendToLastFocusedSidebar()` has the same request-as-notification pattern.

**Recommended fix:** Use the `sendTo*` helpers for true notifications, or attach
`.catch()` logging where an answer is still desired.

**Tests:** Mock a rejected IPC request from `storageChanged` and assert no
unhandled rejection is produced.

---

## P2 - Foreground State Correctness

### R7. `History.setAllLoadedState()` writes the wrong variable

**Status:** Confirmed
**Severity:** Medium
**Files:** `src/services/history.fg.ts:37-38`,
`src/services/search.fg.history.ts:12-13`, `src/services/search.fg.history.ts:81-83`

`setAllLoadedState` currently assigns `ready = r` instead of `allLoaded = r`.
History search calls `History.setAllLoadedState(false)` before loading filtered
results, but the real `allLoaded` flag is left unchanged. If full history had
previously been exhausted, search navigation can think all filtered history is
already loaded and skip `History.loadMore()`.

**Recommended fix:** Change the setter to `allLoaded = r` and add a focused unit
test around history search/load-more state.

### R8. `Utils.pending()` has the same async-executor shape for throwing checks

**Status:** Confirmed
**Severity:** Low/Medium
**File:** `src/utils.ts:1039-1061`

`pending()` catches `conf.action()` rejections, but `conf.check(result)` runs
inside an async Promise executor. If `check` throws synchronously, the outer
promise can remain unsettled.

**Recommended fix:** Convert `pending()` to a plain `async` loop, like `retry()`.

**Tests:** `check()` throws and the returned promise rejects.

---

## P2 - Background Request/Proxy State

### R9. `ipCheckCtx` can remain stale after failed or non-intercepted checks

**Status:** Plausible/confirmed by code path
**Severity:** Low/Medium
**File:** `src/services/web-req.bg.ts:61-128`, `src/services/web-req.bg.ts:243-249`

IP checks are now serialized, which fixes the original cross-container clobber.
But `ipCheckCtx` is cleared only inside `proxyReqHandler()` when a matching
background XHR is intercepted and a proxy exists. If the fetch fails before the
handler consumes the marker, if interception does not happen, or if the proxy
config is removed mid-check, the marker can survive past the check.

**Recommended fix:** Clear `ipCheckCtx` in a `finally` block when it still matches
the check's container after the fetch attempt completes. Keep the existing handler
clear for the normal consumed path.

### R10. Auto-reopen suppression is a single global container marker

**Status:** Confirmed design risk
**Severity:** Low/Medium
**Files:** `src/services/web-req.bg.ts:40-58`,
`src/services/tabs.fg.create.ts:538-559`,
`src/sidebar/components/bar.new-tab.vue:365-383`

`disableAutoReopening()` stores one `disableReopeningForContainer` string. Two
overlapping "reopen/open in container" operations for different containers can
overwrite or clear each other's suppression window. That can allow reopen rules to
fire during an intentional container move.

**Recommended fix:** Replace the single string with a map/set keyed by container,
with per-container timers or reference counts.

---

## P3 - Lower-risk Hardening

### R11. Favicon saves still have residual concurrency races

**Status:** Confirmed residual risk
**Severity:** Low
**File:** `src/services/favicons.bg.ts:117-181`

The old append-index claim was correctly demoted, but saves are still not
serialized. `hashes.indexOf(hash)`, `domainInfo`, and random replacement decisions
can go stale across the `await resizeFavicon()` gap. The usual result is duplicate
icon slots or wasted capacity; at the max-count limit, concurrent random
replacement can still leave one domain pointing at another saved icon.

**Recommended fix:** If favicon persistence is touched again, serialize the
mutation section with an `AsyncQueue` or recompute hash/domain/replacement state
after resizing.

### R12. Some fire-and-forget browser/API calls still lack rejection handling

**Status:** Confirmed
**Severity:** Low
**Examples:**

- `src/services/tabs.bg.ts:560-567` calls `Store.set()` from a timer without
  catching persistence failure.
- `src/services/tabs.bg.ts:399` calls `browser.tabs.reload(tab.id)` without
  catching missing-tab errors.
- Several UI activation paths call `browser.tabs.update(...)` without catching;
  these are mostly user-action best-effort calls.

**Recommended fix:** Add `.catch()` logging to background persistence/tabs calls
where failure can leave cached state stale. UI-only activation calls can be
batched into a smaller opportunistic cleanup.

---

## Revised Execution Plan

### WS-H - IPC Identity And Settling

**Scope:** `src/services/ipc.ts`, `src/types/ipc.ts`, IPC tests/mocks.

1. Make `Message.uid` collision-resistant across context reloads.
2. Include action/destination metadata in processed-message dedup validation.
3. Replace `runningAsyncActions` keying with a per-delivery identity.
4. Convert `request()` away from an async promise executor.
5. Add regression tests for retry dedup, reload UID collision, and sync throw
   settling.

**Acceptance:** Unit tests for IPC retry/dedup behavior plus the manual Firefox
matrix from the original WS-C.

### WS-I - Persistence Follow-up

**Scope:** `tabs.bg.ts`, `storage.fg.ts`, `storage.bg.ts`, `ipc.bg.ts`,
`history.fg.ts`, `search.fg.history.ts`, `utils.ts`.

1. Preserve background tab tree data when no sidebar is connected.
2. Mirror delayed/immediate storage ordering fixes in foreground storage.
3. Convert storage notifications to send-style IPC or catch request failures.
4. Fix `History.setAllLoadedState()`.
5. Convert `Utils.pending()` to a plain async function.

**Acceptance:** Unit tests for tree preservation, foreground storage ordering,
history all-loaded reset, and `pending()` throw behavior.

### WS-J - Request/Proxy And Low-risk Hardening

**Scope:** `web-req.bg.ts`, `favicons.bg.ts`, selected background timers.

1. Clear stale `ipCheckCtx` on all IP-check exits.
2. Replace single auto-reopen suppression marker with per-container state.
3. Serialize or recompute favicon mutation state after resize.
4. Add catches to background fire-and-forget persistence/browser calls.

**Acceptance:** Focused unit tests where mocks exist, plus manual container proxy
checks with two containers and overlapping reopen operations.

---

## Final Verification Gate

After WS-H through WS-J:

1. `npm test`
2. `npm run lint`
3. `npm run build`
4. `npm run test.e2e.firefox`
5. Manual Firefox scenario:
   - 3 windows
   - 200+ tabs
   - at least one window without an open/connected sidebar
   - multiple setup/group pages
   - containers with proxy and reopen rules
   - overlapping "reopen in container" operations
   - snapshot create/restore
   - sync save while offline, then online recovery
   - background/sidebar reload during pending IPC requests
