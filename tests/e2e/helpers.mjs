// Shared harness for Sidebery Firefox e2e tests.
//
// These helpers spin up geckodriver + a throwaway Firefox profile, install the
// built addon, and provide small utilities for driving Sidebery's native tab
// group UI. Keep anything reusable across more than one e2e file here so the
// individual *.test.mjs files stay focused on assertions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { start as startGeckodriver } from 'geckodriver'
import { Builder, By, until } from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ADDON_DIR = path.join(ROOT_DIR, 'addon')
export const EXTENSION_ID = '{3c078156-979c-498b-8990-85f7987dd929}'
export const TEST_GROUP_TITLE = 'Sidebery E2E Native Group'

export const BLUE = '#37adff'
export const BLUE_RGB = 'rgb(55, 173, 255)'
export const ORANGE = '#ff9f00'
export const ORANGE_RGB = 'rgb(255, 159, 0)'
export const PURPLE = '#af51f5'
export const PURPLE_RGB = 'rgb(175, 81, 245)'
export const RED = '#ff613d'
export const RED_RGB = 'rgb(255, 97, 61)'

export const DEFAULT_TIMEOUT = Number(process.env.SIDEBERY_E2E_TIMEOUT || 90000)
export const POLL_INTERVAL = 250

// Start geckodriver, launch a fresh headless Firefox, and install the built
// addon. Registers cleanup on the provided node:test context so each test file
// tears the browser down even when assertions throw.
export async function startFirefoxSession(t) {
  assert.ok(
    fs.existsSync(path.join(ADDON_DIR, 'manifest.json')),
    'Built addon is missing. Run npm run build before this test, or use npm run test.e2e.firefox.'
  )

  const geckoLogs = []
  const port = await getFreePort()
  const gecko = await startGeckodriver({
    cacheDir:
      process.env.GECKODRIVER_CACHE_DIR ||
      path.join(ROOT_DIR, 'node_modules', '.cache', 'geckodriver'),
    host: '127.0.0.1',
    log: process.env.GECKODRIVER_LOG || 'error',
    port,
    spawnOpts: {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  })
  collectProcessLogs(gecko, geckoLogs)

  let driver
  let profileDir

  t.after(async () => {
    if (driver) await driver.quit().catch(() => {})
    if (!gecko.killed) gecko.kill('SIGTERM')
    if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true })
  })

  await waitForGeckodriver(port, geckoLogs)

  profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sidebery-e2e-firefox-'))
  driver = await launchFirefox(port, profileDir)
  await driver.installAddon(ADDON_DIR, true)

  return { driver, gecko, port }
}

// Navigate to the Sidebery sidebar page and wait until it has rendered at least
// one tab, i.e. it is live and talking to the browser.tabs API.
export async function openSidebar(driver) {
  const sidebarUrl = await getExtensionUrl(driver, '/sidebar/sidebar.html')
  await driver.get(sidebarUrl)
  await driver.wait(until.elementLocated(By.css('#root')), 20000)
  await waitFor(async () => {
    const tabs = await driver.findElements(By.css('.Tab'))
    return tabs.length > 0
  }, 'initial Sidebery tab list')
  return sidebarUrl
}

export async function launchFirefox(port, profileDir) {
  const options = new firefox.Options()
    .addArguments('-profile', profileDir, '-remote-allow-system-access')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('browser.tabs.groups.enabled', true)
    .setPreference('datareporting.policy.dataSubmissionEnabled', false)
    .setPreference('extensions.webextensions.tabhide.enabled', true)
    .setPreference('toolkit.telemetry.reportingpolicy.firstRun', false)

  const firefoxBinary = findFirefoxBinary()
  if (firefoxBinary) options.setBinary(firefoxBinary)
  if (process.env.SIDEBERY_E2E_HEADED !== '1') options.addArguments('-headless')

  const driver = await new Builder()
    .forBrowser('firefox')
    .usingServer(`http://127.0.0.1:${port}`)
    .setFirefoxOptions(options)
    .build()

  await driver.manage().window().setRect({ width: 1200, height: 900 })
  return driver
}

export async function getExtensionUrl(driver, extensionPath) {
  await driver.setContext(firefox.Context.CHROME)
  try {
    return await waitFor(async () => {
      return await driver.executeScript(
        `return WebExtensionPolicy.getByID(arguments[0])?.getURL(arguments[1]) || null`,
        EXTENSION_ID,
        extensionPath
      )
    }, `installed extension URL for ${extensionPath}`)
  } finally {
    await driver.setContext(firefox.Context.CONTENT)
  }
}

// Build the layered topology used by the detailed rail-rendering test: a parent
// tab with a nested (ungrouped) child, plus two siblings, all grouped together
// except the child.
export async function createNativeGroup(driver, title = TEST_GROUP_TITLE) {
  const result = await runExtensionAsync(
    driver,
    async title => {
      const parent = await browser.tabs.create({
        url: 'about:blank#sidebery-e2e-parent',
        active: false,
      })
      const child = await browser.tabs.create({
        url: 'about:blank#sidebery-e2e-child',
        active: false,
        openerTabId: parent.id,
      })
      const siblings = []
      for (let i = 1; i <= 2; i++) {
        siblings.push(
          await browser.tabs.create({
            url: `about:blank#sidebery-e2e-sibling-${i}`,
            active: false,
          })
        )
      }
      const groupedTabIds = [parent.id, ...siblings.map(tab => tab.id)]

      const groupId = await browser.tabs.group({ tabIds: groupedTabIds })
      const noneGroupId = browser.tabGroups?.TAB_GROUP_ID_NONE ?? -1
      const childAfterGrouping = await browser.tabs.get(child.id)
      if (childAfterGrouping.groupId !== noneGroupId) {
        await browser.tabs.ungroup(child.id)
        await browser.tabs.update(child.id, { openerTabId: parent.id })
      }

      await browser.tabGroups.update(groupId, { title, color: 'blue' })
      await browser.tabs.update(siblings[0].id, { active: true })

      return {
        childId: child.id,
        groupId,
        tabIds: [...groupedTabIds, child.id],
      }
    },
    title
  )

  assert.ok(
    Number.isFinite(result.groupId),
    `Cannot create native tab group: ${JSON.stringify(result)}`
  )
  assert.equal(result.tabIds.length, 4)
  return result
}

// Create a flat native group of `count` blank tabs with the given title/color.
// Simpler than createNativeGroup() and meant for sanity checks where the exact
// tree shape does not matter. Returns { groupId, tabIds }.
export async function createSimpleNativeGroup(
  driver,
  { title, color = 'blue', count = 3 } = {}
) {
  assert.ok(title, 'createSimpleNativeGroup requires a unique title')

  const result = await runExtensionAsync(
    driver,
    async (title, color, count) => {
      const marker = encodeURIComponent(title)
      const tabs = []
      for (let i = 0; i < count; i++) {
        tabs.push(
          await browser.tabs.create({
            url: `about:blank#sidebery-e2e-${marker}-${i}`,
            active: false,
          })
        )
      }
      const tabIds = tabs.map(tab => tab.id)
      const groupId = await browser.tabs.group({ tabIds })
      await browser.tabGroups.update(groupId, { title, color })
      // Activate the first member so the group renders in a stable expanded
      // state regardless of which tab was focused before.
      await browser.tabs.update(tabIds[0], { active: true })

      return { groupId, tabIds }
    },
    title,
    color,
    count
  )

  assert.ok(
    Number.isFinite(result.groupId),
    `Cannot create native tab group "${title}": ${JSON.stringify(result)}`
  )
  assert.equal(result.tabIds.length, count)
  return result
}

// Group the given tabs into an existing native group via the browser API.
export async function addTabsToNativeGroup(driver, groupId, tabIds) {
  return await runExtensionAsync(
    driver,
    async (groupId, tabIds) => {
      await browser.tabs.group({ groupId, tabIds })
      return true
    },
    groupId,
    tabIds
  )
}

// Create `count` blank tabs (not grouped) and return their ids.
export async function createBlankTabs(driver, count = 1, marker = 'extra') {
  return await runExtensionAsync(
    driver,
    async (count, marker) => {
      const ids = []
      for (let i = 0; i < count; i++) {
        const tab = await browser.tabs.create({
          url: `about:blank#sidebery-e2e-${marker}-${i}`,
          active: false,
        })
        ids.push(tab.id)
      }
      return ids
    },
    count,
    marker
  )
}

// Remove a tab from its native group, leaving it open and ungrouped.
export async function ungroupTabs(driver, tabIds) {
  return await runExtensionAsync(
    driver,
    async tabIds => {
      await browser.tabs.ungroup(tabIds)
      return true
    },
    tabIds
  )
}

// Close the given tabs. Safe to call with the ids returned by the create*
// helpers for per-subtest cleanup.
export async function closeTabs(driver, tabIds) {
  if (!tabIds || !tabIds.length) return
  await runExtensionAsync(
    driver,
    async ids => {
      await browser.tabs.remove(ids)
      return true
    },
    tabIds
  )
}

export async function runExtensionAsync(driver, fn, ...args) {
  const serializedFn = `(${fn.toString()})(...args)`
  const result = await driver.executeAsyncScript(
    `
      const args = Array.from(arguments).slice(0, -1);
      const done = arguments[arguments.length - 1];
      (async () => {
        return await ${serializedFn};
      })().then(
        value => done({ value }),
        err => done({ error: String(err?.stack || err) })
      );
    `,
    ...args
  )

  if (result?.error) throw new Error(result.error)
  return result?.value
}

export async function getNativeGroupSnapshot(driver, title = TEST_GROUP_TITLE) {
  return await driver.executeScript(
    `
      const group = [...document.querySelectorAll('.NativeTabGroup')]
        .find(el => el.textContent.includes(arguments[0]));

      const railEls = [...document.querySelectorAll('.Tab .native-group-thread')];

      return {
        group: group && {
          collapsed: group.dataset.collapsed,
          colorLayerOpacity: getComputedStyle(group.querySelector('.color-layer')).opacity,
          color: getComputedStyle(group).getPropertyValue('--native-group-color').trim(),
          count: group.querySelector('.count') ? group.querySelector('.count').textContent.trim() : null,
          text: group.textContent,
          titleColor: getComputedStyle(group.querySelector('.title')).color,
        },
        groupCount: document.querySelectorAll('.NativeTabGroup').length,
        customTitleInputCount: document.querySelectorAll('.Tab .custom-title-input').length,
        editingTabs: [...document.querySelectorAll('.Tab[data-edit="true"]')].map(el => ({
          id: el.id.replace(/^tab/, ''),
          text: el.textContent,
        })),
        rails: railEls.map(el => {
          const rect = el.getBoundingClientRect();
          return {
            collapsed: el.dataset.collapsed === 'true',
            color: getComputedStyle(el).backgroundColor,
            end: el.dataset.end === 'true',
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            middle: el.dataset.middle === 'true',
            start: el.dataset.start === 'true',
            top: rect.top,
            width: rect.width,
          };
        }),
        tabs: [...document.querySelectorAll('.Tab')].map(el => ({
          hasRail: !!el.querySelector('.native-group-thread'),
          id: el.id.replace(/^tab/, ''),
          lvl: el.dataset.lvl,
          text: el.textContent,
        })),
      };
    `,
    title
  )
}

// Poll getNativeGroupSnapshot until `predicate(snapshot)` is truthy, then return
// that snapshot. Convenience wrapper around waitFor for the common case.
export async function waitForGroupSnapshot(driver, title, predicate, label, timeout = 20000) {
  return await waitFor(
    async () => {
      const snapshot = await getNativeGroupSnapshot(driver, title)
      if (predicate(snapshot)) return snapshot
    },
    label,
    timeout
  )
}

// Count how many native group headers are currently rendered in the sidebar.
export async function countNativeGroups(driver) {
  return await driver.executeScript(
    `return document.querySelectorAll('.NativeTabGroup').length`
  )
}

// Wait until exactly `expected` native group headers are rendered. Used to keep
// sanity subtests isolated from each other's leftover state.
export async function waitForNativeGroupCount(driver, expected, label) {
  return await waitFor(
    async () => {
      const count = await countNativeGroups(driver)
      if (count === expected) return { count }
    },
    label || `native group count = ${expected}`
  )
}

export function railsAreVerticallyUsable(rails) {
  return rails.every(rail => rail.width >= 3 && rail.height >= 20)
}

export function railsShareLeftEdge(rails) {
  const leftEdges = rails.map(rail => rail.left)
  return Math.max(...leftEdges) - Math.min(...leftEdges) <= 0.5
}

export function railsAreVisuallyConnected(rails) {
  return rails
    .slice()
    .sort((a, b) => a.top - b.top)
    .every((rail, index, sortedRails) => {
      const nextRail = sortedRails[index + 1]
      return !nextRail || rail.bottom >= nextRail.top - 2.5
    })
}

// Left-click the native group header (mousedown + mouseup on the same target),
// which is how Sidebery toggles a native group's collapsed state.
export async function clickNativeGroupHeader(driver, title = TEST_GROUP_TITLE) {
  await driver.executeScript(
    `
      const group = [...document.querySelectorAll('.NativeTabGroup')]
        .find(el => el.textContent.includes(arguments[0]));
      if (!group) throw new Error('Native group header not found: ' + arguments[0]);

      const rect = group.getBoundingClientRect();
      const init = {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: rect.left + 12,
        clientY: rect.top + rect.height / 2,
        view: window,
      };
      group.dispatchEvent(new MouseEvent('mousedown', init));
      group.dispatchEvent(new MouseEvent('mouseup', init));
    `,
    title
  )
}

export async function openNativeGroupMenu(driver, title = TEST_GROUP_TITLE) {
  await driver.executeScript(
    `
      const group = [...document.querySelectorAll('.NativeTabGroup')]
        .find(el => el.textContent.includes(arguments[0]));
      if (!group) throw new Error('Native group header not found');

      const rect = group.getBoundingClientRect();
      const init = {
        bubbles: true,
        button: 2,
        buttons: 2,
        cancelable: true,
        clientX: rect.left + 12,
        clientY: rect.top + rect.height / 2,
        view: window,
      };
      group.dispatchEvent(new MouseEvent('mousedown', init));
      group.dispatchEvent(new MouseEvent('mouseup', init));
    `,
    title
  )

  await waitFor(async () => {
    return await driver.executeScript(
      `return document.querySelector('.CtxMenu[data-active="true"] .icon-opt[title="Purple"]') !== null`
    )
  }, 'native group color picker menu')
}

export async function pickNativeGroupColor(driver, label) {
  await pickContextMenuOption(driver, label)
}

export async function submitRenameDialog(driver, value) {
  // Native group rename now uses Sidebery's in-app dialog popup (with a text
  // input) instead of window.prompt. Wait for it, fill the input, click Save.
  await waitFor(async () => {
    return await driver.executeScript(
      `return document.querySelector('.Dialog .popup .TextInput input') !== null`
    )
  }, 'native group rename dialog')

  await driver.executeScript(
    `
      const input = document.querySelector('.Dialog .popup .TextInput input');
      if (!input) throw new Error('Rename dialog input not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, arguments[0]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const save = [...document.querySelectorAll('.Dialog .popup .ctrls .btn')]
        .find(el => el.textContent.trim() === arguments[1]);
      if (!save) throw new Error('Rename dialog Save button not found');
      const rect = save.getBoundingClientRect();
      const init = {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        view: window,
      };
      save.dispatchEvent(new MouseEvent('mousedown', init));
      save.dispatchEvent(new MouseEvent('mouseup', init));
      save.dispatchEvent(new MouseEvent('click', init));
    `,
    value,
    'Save'
  )

  // The dialog should disappear once the rename is submitted.
  await waitFor(async () => {
    return await driver.executeScript(
      `return document.querySelector('.Dialog .popup') === null`
    )
  }, 'native group rename dialog dismissal')
}

export async function pickContextMenuOption(driver, label) {
  await driver.executeScript(
    `
      const option = [...document.querySelectorAll('.CtxMenu[data-active="true"] .opt, .CtxMenu[data-active="true"] .icon-opt')]
        .find(el => el.title === arguments[0]);
      if (!option) throw new Error('Context menu option not found: ' + arguments[0]);

      const rect = option.getBoundingClientRect();
      const init = {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        view: window,
      };
      option.dispatchEvent(new MouseEvent('mousedown', init));
      option.dispatchEvent(new MouseEvent('mouseup', init));
    `,
    label
  )
}

export async function waitFor(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  let lastErr

  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (err) {
      lastErr = err
    }

    await sleep(POLL_INTERVAL)
  }

  if (lastErr) throw lastErr
  throw new Error(`Timed out waiting for ${label}`)
}

export async function waitForGeckodriver(port, logs) {
  return await waitFor(
    async () => {
      await new Promise((resolve, reject) => {
        const req = http.get(
          { hostname: '127.0.0.1', path: '/status', port, timeout: 1000 },
          res => {
            res.resume()
            res.on('end', resolve)
          }
        )
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('timeout')))
      })
      return true
    },
    `Geckodriver on port ${port}. Recent logs: ${logs.slice(-20).join('\n')}`
  )
}

export async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

export function collectProcessLogs(child, logs) {
  child.stdout?.on('data', data => pushLogLines(logs, data))
  child.stderr?.on('data', data => pushLogLines(logs, data))
}

function pushLogLines(logs, data) {
  logs.push(...String(data).trim().split(/\r?\n/).filter(Boolean))
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

export function findFirefoxBinary() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Firefox.app/Contents/MacOS/firefox',
          '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
          '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
            'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
          ]
        : ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox']

  return candidates.find(candidate => fs.existsSync(candidate))
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
