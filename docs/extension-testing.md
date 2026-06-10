# Automated Firefox Extension Testing

Sidebery now has a repeatable Firefox extension smoke test for native tab groups:

```bash
npm run test.e2e.firefox
```

The script builds `addon/`, starts an isolated Firefox profile through Selenium and Geckodriver, installs the built extension as a temporary add-on, opens Sidebery's sidebar page, and drives real WebExtension APIs from that extension page.

## What It Covers

The current test creates three real Firefox tabs, groups them with `browser.tabs.group`, and updates the native group with `browser.tabGroups.update`.

It verifies:

- Sidebery renders a native tab group header in the tabs panel.
- The expanded group's three colored rails render on all member tabs, including after the first tab.
- The rails share the same left edge, catching the broken rail offset regression.
- Collapsing the Firefox group leaves the active member tab visible.
- Changing the collapsed Firefox group color updates Sidebery's collapsed header text and remaining rail color.

## Requirements

- Firefox 140 or newer.
- Node.js 20 or newer.
- Network access on the first run, unless Geckodriver is already cached or `GECKODRIVER_PATH` points to a local binary.

The test uses a temporary Firefox profile under the OS temp directory and removes it after the run. It does not touch the user's normal Firefox profile, and the Sidebery add-on install is temporary.

## Useful Environment Variables

```bash
# Use a specific Firefox-compatible browser.
FIREFOX_BIN="/Applications/Firefox Nightly.app/Contents/MacOS/firefox" npm run test.e2e.firefox

# Watch the browser while the test runs. Headless is the default.
SIDEBERY_E2E_HEADED=1 npm run test.e2e.firefox

# Reuse or move the Geckodriver download cache.
GECKODRIVER_CACHE_DIR="$PWD/node_modules/.cache/geckodriver" npm run test.e2e.firefox

# Point at an already-installed Geckodriver binary.
GECKODRIVER_PATH="/path/to/geckodriver" npm run test.e2e.firefox

# Increase browser startup/debug output.
GECKODRIVER_LOG=info npm run test.e2e.firefox
```

## Why Selenium

Firefox WebExtension sidebars live in browser chrome, and most browser automation tools cannot install and exercise a Firefox extension's privileged APIs directly. Selenium with Geckodriver can:

- Start Firefox with a clean automation profile.
- Install an unpacked WebExtension directory as a temporary add-on.
- Resolve the generated `moz-extension://...` URL from Firefox itself.
- Execute `browser.tabs` and `browser.tabGroups` calls in the extension page.

Firefox 151 and newer require `-remote-allow-system-access` before Selenium can briefly enter chrome context. The test only uses that isolated automation profile to resolve Sidebery's generated extension URL.

## Known Limits

This is a real Firefox/WebExtension test, but it opens `sidebar/sidebar.html` as a normal tab so Selenium can inspect the DOM. It does not assert Firefox's visible sidebar chrome, userChrome sizing, or toolbar/sidebar frame integration. Keep one manual check in the actual Firefox sidebar for changes that depend on the browser frame around Sidebery.

## Extending The Test

Add new checks in `tests/e2e/firefox-native-groups.test.mjs`. Prefer using extension APIs through `runExtensionAsync` for setup, then assert rendered DOM with `getNativeGroupSnapshot` or a similarly small snapshot helper.

Good next candidates:

- Native group rename and ungroup context menu behavior.
- Sidebery tree nesting inside a native group.
- Search and folded-tree visibility while a native group is expanded and collapsed.
