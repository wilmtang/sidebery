# Settings Audit

This audit covers Sidebery settings and setup configuration controls exposed in `src/page.setup/components/*.vue`, including settings sections, keybinding options, import/export popups, container config, and panel config.

## Description Coverage

Shared field components now look up setting notes automatically:

1. Explicit `note` props still win.
2. If a field has `dbg="someSetting"`, Sidebery tries `settings.notes.someSetting`.
3. If there is no setting-id note, Sidebery tries `<label>_note`.

The current setup-page inventory finds 276 visible controls and 0 controls without an explicit or automatic note. This includes the dense Tabs and Mouse sections, where most of the previously arcane behavior lived, plus container proxy settings, panel config, and backup/import categories.

## Broken Setting Fix

`skipEmptyPanels` was present in defaults/types but was not read anywhere. It is now treated as a deprecated legacy alias for `hideEmptyPanels`:

- Old stored configs with `skipEmptyPanels: true` and no explicit `hideEmptyPanels` become `hideEmptyPanels: true`.
- If a config already has `hideEmptyPanels`, that explicit value wins.
- New saved settings no longer carry `skipEmptyPanels`.

## Hidden Preferences

Some settings are intentionally hidden tuning knobs rather than normal setup-page controls. They remain in defaults because code reads them and older user configs may already use them:

- `updTooltipDelay`
- `selLen`
- `dndOutsideThresholdTimeout`
- `searchInputTimeout`
- `newTabCtxReopen` (exposed from tabs panel config, not the main settings section)
- `tabWarmupOnHover`
- `forceDiscard`
- `tabUpdDelay`
- `forceUpdTooltip`
- `pinnedForcedDiscard`
- `scrollThroughTabsPreselDelay`

The remaining unit fields are represented through numeric controls rather than standalone toggles:

- `discardFoldedDelayUnit`
- `snapIntervalUnit`
- `snapLimitUnit`

## Verification

Use these checks after changing settings UI:

```bash
npm test
npm run lint
npm run build
npm run test.e2e.firefox
```

The Firefox E2E test opens the real extension setup page and asserts that an automatically discovered note renders as user-facing text instead of leaking a translation key.
