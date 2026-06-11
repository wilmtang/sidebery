# Audit Fix Execution — Progress Log

Resumable log for executing AUDIT_EXECUTION_PLAN.md (rev. 2). Branch: `v6`.
Update this after each workstream. If resumed: read this file, run `npm test` to confirm baseline, continue from the first unchecked item.

## Status legend
- [ ] not started  / [~] in progress  / [x] done & tested

## Workstreams
- [x] WS-A — Async foundations (utils.ts AsyncQueue/deadline/retry/parseDragEvent/loadBinAsBase64 + call-site catches)
- [x] WS-E — Pure utils (toRGBA, punycode, HEXA_RE, isRegExp, withoutEmptyFolders, colorFromString)
- [x] WS-B — Sync lifecycle (sync.bg.ts/sync.ts/sync.fg.ts/sync.bg.google.ts)
- [x] WS-C — IPC layer (ipc.ts)
- [x] WS-D — Background services hardening
- [x] WS-F — Foreground sidebar fixes
- [x] WS-G — Native tab groups polish

### WS-A done (utils.ts + call sites)
- AsyncQueue.add: try/finally so rejection settles caller & keeps queue alive (utils.ts:1196).
- deadline(): clearTimeout on settle.
- parseDragEvent / retry: converted from async-executor to plain async; tabs.query wrapped in try/catch.
- loadBinAsBase64: single settle() guard, clears timer, handles blob+reader errors.
- .catch added: tabs.fg.move.ts:851,876; web-req.bg.ts proxyReqHandler returns {type:'direct'} on reopen failure; settings.bg.ts:30 + settings.fg.ts:35 Sync.save catch.
- Tests: 4 new AsyncQueue tests in utils.test.ts.

### WS-D done (bg services)
- N5 tabs.bg updateBgTabsTreeData: Promise.allSettled; skip destructive reset for windows whose fetch rejected (preserve tree data; no cross-window blast radius).
- N6 tabs.bg reopenTab: create replacement first, only remove original on success; never throws.
- N7 tabs.bg onTabUpdated: saveFavicon(change.url ?? tab.url).
- N10 tabs.bg onTabRemoved: reinitTabs on index mismatch (was silent return -> ghost tab).
- tabs.bg openCachedWindow: guard empty items. proxy badge: per-tab Map of timers (was shared single timer).
- N9 web-req handledReqId -> bounded Set (markReqHandled, LIMIT 100).
- N18 web-req: checkIpInfo serialized via dedicated IP_CHECK_QUEUE (ipCheckCtx no longer clobbered).
- N13+L11 storage.bg: _set persists BEFORE notifying fg; immediate set() drops overlapping buffered keys; buffered flush captured+caught.
- windows.bg: lockedWindowsTabs cleaned in onWindowRemoved; onWindowFocused clears stale focused on other windows (no -1 guarantee); L4 createWithTabs keeps initial tab if nothing created.
- containers.bg: contextualIdentities.query catch (containers-disabled no longer hangs load); creating string -> Set<string>.
- snapshots.bg: create/add/remove serialized via SNAP_QUEUE; exportSnapshot downloadAndRevoke() revokes object URL on complete/interrupted + catches download rejection.
- background.ts onUpdateAvailable: NOT changed (flagged confirm-maintainer-intent in plan).
- Typecheck clean + 97/97.

### WS-C done (ipc.ts + types/ipc.ts)  ⚠ riskiest — NEEDS manual Firefox matrix test
- N3: confirmation waiter moved OFF the shared msgsWaitingForAnswer map ONTO the connection object (conConfirmTimeout/conConfirmResolve). onPostMsg resolves it via the connection captured in the localPort postListener closure (passed as 3rd arg). -1/-2 sentinels still sent by receiver unchanged (wire-compatible); -99 liveness probe still ignored. removeConnection clears pending confirm timer.
- N4: onConnect + onSendMsg now reject ports/messages whose dstTabId !== _localTabId. Safe: only setup pages set dstTabId AND _localTabId (group pages use IPPC/BroadcastChannel, not port IPC).
- N12: msgsWaitingForAnswer + runningAsyncActions match by PORT IDENTITY (stored Port object) instead of port.name (names identical across reconnects).
- N11: added Message.uid (stable across retries). Receiver dedups in onPostMsg via processedMsgs map (in-flight + done states, pendingAnswers for duplicates that arrive mid-run, TTL = 2*MSG_CONFIRM_DEADLINE). finalizeProcessedMsg() in both sync+async result branches.
- getPortErrorMessage: 2nd branch remotePort (was localPort twice).
- L1: runActionFor uses msg.arg !== undefined (was truthy check, dropped 0/''/false).
- Tests: port-layer not unit-testable without full port mock; typecheck clean + 97/97. Acceptance = manual Firefox matrix (multi-window, multiple setup/group pages, bg reload/reconnect).

### WS-B done (sync.*.ts)
- N2: sync.bg.ts _load wrapped in try/catch; resolveLoadHandlers/rejectLoadHandlers helpers resolve waiters on EVERY exit (early-return, success, throw); loading reset on all paths.
- N20: sync.bg.ts:294 + sync.bg.google.ts:454 IPC.sidebars('notify') -> sendToSidebars (fire-and-forget, no Promise.all rejection).
- L5: removeByType filters local entries by type.
- sync.fg.ts _load: removed inconsistent catch-block handler rejection; all waiters+primary resolve with entries (empty on error) consistently.
- Tests: deferred to manual/e2e (sync internals are IPC/Google/Firefox-coupled; AsyncQueue primitive covered in WS-A). Typecheck + 97/97 pass.

### WS-G done (native tab groups)
- N14 ungroupNativeGroup: dissolve group's member tabs, then CLOSE the orphaned Sidebery group page (was left as a loose tab rendering an empty group). Policy = exclude/close the page (recorded decision below). Did NOT build a "convert to legacy Sidebery group" menu item — that's a separate feature (tree reconstruction), out of audit scope.
- N15 createSideberyGroupPage: (a) browser.tabs.create wrapped in .catch that deletes the reserved Tabs.newTabsPosition[index] so a failed create can't mis-place the next tab; (b) `if (!groupPage?.id) return` guards group/move; tabs.group/move now have their own .catch; (c) onNativeGroupCreated's 120ms setTimeout now observes the promise (.catch logs).
- N16(a) syncSideberyGroupPageTitle: rewrite only the title (prefix) slice of the hash, preserving the IPPC channel suffix `~!<chId>!ch!~` + `:id:` (blind PAGE_HASH_RE replace dropped them → dead message channel after rename). Verified with the real regex across plain/channel/pin+special-chars/:id: URLs.
- N16(b) renameNativeGroup: window.prompt (unreliable/blocked in FF sidebar docs) → Popups.ask() dialog with a text input. Extended the dialog system: added DialogInput type + `input?` on Dialog/DialogConfig, rendered a TextInput in popup.dialog.vue (focus+selectAll on mount, Enter submits default btn, Esc cancels), threaded through Popups.ask.
- N16(c): i18n key 'editBookmarkTitle' → new 'dialog.native_group_rename.title' + '.placeholder' (dict.common.ts).
- N17 panel.tabs.vue: O(n²) group-rail/tree-guide recompute → single linear precompute pass (visualGroupId per tab cached; per-group first/last visible index; per-ancestor last-visible-descendant index). Dropped hasLaterVisibleDescendant/isDescendantOf (now derived from maps). Group thread start/end now O(1) lookups instead of slice().some() scans.
- L6 panel.tabs.vue: group header Vue key `g:${id}` → `g:${id}:${occ}` (per-render occurrence counter) so a non-contiguous visual group can't emit duplicate keys.
- Tests: tabs.fg.native-groups.test.ts — updated edit-title test to mock Popups.ask (was window.prompt); +rename-cancel test; +2 ungroupNativeGroup tests (with/without group page). 100/100 pass. Typecheck + eslint clean + build OK.
- e2e: firefox-native-groups.test.mjs rename driver updated — the old `setSidebarPrompt` (overrode window.prompt) is replaced by `submitRenameDialog` which fills the new dialog's TextInput and clicks Save. Required because N16(b) removed window.prompt (the old override would no longer fire → test would hang). `node --check` passes; full run needs Firefox/geckodriver (not on PATH here). A dedicated "rename keeps the group-page IPPC channel alive" e2e is still TODO.

### WS-F done (fg sidebar)
- containers.fg saveContainer: delayed branch now passes `delay` to setTimeout (was firing immediately) + captures cts before clear + IPC.bg catch.
- drag-and-drop.fg: `y: e.clientX` -> `e.clientY` (autoscroll Y coord bug).
- popup.context-menu.vue scrollToOption: `CSS.escape(opt.tooltip ?? opt.label ?? '')` in `[title=...]` selector (quotes/specials in user labels can't break selector).
- bookmarks.fg rmChildByIndex: `index >= this.children.length` (was `>`, allowed out-of-bounds splice no-op miss).
- group.ts onGroupUpdMsg (L7): removed top-level `if (!newTabEl) return` (title/parent/window updates were skipped when DOM el missing); tab-DOM block gated by `upd.tabs !== undefined && newTabEl`; splice-while-iterating removal replaced with `splice(i)` + remove loop.
- tabs.fg.move srcPanelId -> `srcPanelIds: Set<ID>` (multi-source-panel moves now recalc all source panels); L3 openerTabId updates compute opener + `.catch`.
- selection.fg (L2): `lastTab?.isParent` guard; `if (!target) continue` in global-range loop.
- tabs.fg.handlers: `bufBatchActivatedEventIndex` number -> `bufferedActivationHandler` reference; dedupes by handler identity; cleared in releaseReopenedTabsBuffer.
- Typecheck clean + 97/97.

### WS-E done (utils.ts)
- toRGBA: gn/bn percent channels (was reusing rn).
- HEXA_RE: [0-9a-fA-F] (was [0-f]).
- isRegExp: instanceof RegExp (no throw on null).
- decodeUrlPunycode: per-label xn-- decode (includes() guard).
- withoutEmptyFolders: two-pass (index first, then mark ancestors); cycle-safe.
- colorFromString: includes trailing char of odd-length strings (even-length output unchanged).
- Tests: toRGBA, isRegExp, withoutEmptyFolders, colorFromString. Full suite 97/97.

## Verification
- Baseline at start: `npm test` = 85/85 pass (9 files).
- FINAL (all WS A–G done): `npm test` = 100/100 pass (9 files; +15 new tests across WS-A/E/G); `npm run lint` (eslint + vue-tsc) clean; `npm run build` OK.
- Still TODO (env-dependent, not run here): `npm run test.e2e.firefox` incl. extended native-group e2e (rename keeps group-page IPPC channel alive, ungroup closes group page, collapse), and the manual multi-window/200-tab/2-group-page/offline-sync/bg-reload scenario script. WS-C (IPC) especially needs the manual Firefox matrix — its regressions are the hardest to notice.

## Notes / decisions
- N14 ungroup: defaulting to EXCLUDE the Sidebery group page from native ungroup (close/keep separately), per recommended option.
- Working directly on branch `v6` (not default branch v5).

## Detailed per-item progress
(filled in as work proceeds)
