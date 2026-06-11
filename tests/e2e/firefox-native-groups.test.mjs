import test from 'node:test'
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

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ADDON_DIR = path.join(ROOT_DIR, 'addon')
const EXTENSION_ID = '{3c078156-979c-498b-8990-85f7987dd929}'
const TEST_GROUP_TITLE = 'Sidebery E2E Native Group'
const RENAMED_GROUP_TITLE = 'Sidebery E2E Renamed Native Group'
const BLUE = '#37adff'
const BLUE_RGB = 'rgb(55, 173, 255)'
const ORANGE = '#ff9f00'
const ORANGE_RGB = 'rgb(255, 159, 0)'
const PURPLE = '#af51f5'
const PURPLE_RGB = 'rgb(175, 81, 245)'
const DEFAULT_TIMEOUT = Number(process.env.SIDEBERY_E2E_TIMEOUT || 90000)
const POLL_INTERVAL = 250

test(
  'Firefox native tab groups render Sidebery headers, rails, and collapsed color state',
  { timeout: DEFAULT_TIMEOUT },
  async t => {
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

    const sidebarUrl = await getExtensionUrl(driver, '/sidebar/sidebar.html')
    await driver.get(sidebarUrl)
    await driver.wait(until.elementLocated(By.css('#root')), 20000)
    await waitFor(async () => {
      const tabs = await driver.findElements(By.css('.Tab'))
      return tabs.length > 0
    }, 'initial Sidebery tab list')

    const nativeGroup = await createNativeGroup(driver)

    const expanded = await waitFor(async () => {
      const snapshot = await getNativeGroupSnapshot(driver)
      const childTab = snapshot.tabs.find(tab => tab.id === String(nativeGroup.childId))
      if (
        snapshot.group?.collapsed === 'false' &&
        snapshot.rails.length === 4 &&
        childTab?.hasRail
      ) {
        return snapshot
      }
    }, 'expanded native group rails')

    assert.equal(expanded.group.color, BLUE)
    assert.equal(expanded.rails.length, 4)
    assert.deepEqual(
      expanded.rails.map(rail => ({
        start: rail.start,
        middle: rail.middle,
        end: rail.end,
      })),
      [
        { start: true, middle: false, end: false },
        { start: false, middle: true, end: false },
        { start: false, middle: true, end: false },
        { start: false, middle: false, end: true },
      ]
    )
    assert.notEqual(
      expanded.group.titleColor,
      BLUE_RGB,
      'Expanded group headers should keep normal text color instead of reading like collapsed pills'
    )
    assert.ok(
      expanded.rails.every(rail => rail.color === BLUE_RGB),
      `Expected all expanded rails to use ${BLUE_RGB}: ${JSON.stringify(expanded.rails)}`
    )
    assert.ok(
      railsAreVerticallyUsable(expanded.rails),
      `Expected every rail to have a visible size: ${JSON.stringify(expanded.rails)}`
    )
    assert.ok(
      railsShareLeftEdge(expanded.rails),
      `Expected rail left edges to stay aligned after the first tab: ${JSON.stringify(expanded.rails)}`
    )
    assert.ok(
      railsAreVisuallyConnected(expanded.rails),
      `Expected expanded rails to draw as one connected group rail: ${JSON.stringify(expanded.rails)}`
    )

    await openNativeGroupMenu(driver)
    await pickContextMenuOption(driver, 'Edit title')
    await submitRenameDialog(driver, RENAMED_GROUP_TITLE)

    const renamed = await waitFor(async () => {
      const snapshot = await getNativeGroupSnapshot(driver, RENAMED_GROUP_TITLE)
      if (
        snapshot.group?.collapsed === 'false' &&
        snapshot.group.text.includes(RENAMED_GROUP_TITLE) &&
        snapshot.rails.length === 4
      ) {
        return snapshot
      }
    }, 'native group edit-title update')

    assert.equal(
      renamed.editingTabs.length,
      0,
      `Native group Edit title should not put the first tab into title-edit mode: ${JSON.stringify(renamed.editingTabs)}`
    )
    assert.equal(
      renamed.customTitleInputCount,
      0,
      'Native group Edit title should not render a tab custom-title input'
    )

    await openNativeGroupMenu(driver, RENAMED_GROUP_TITLE)
    await pickNativeGroupColor(driver, 'Purple')

    const recolored = await waitFor(async () => {
      const snapshot = await getNativeGroupSnapshot(driver, RENAMED_GROUP_TITLE)
      if (
        snapshot.group?.collapsed === 'false' &&
        snapshot.group.color === PURPLE &&
        snapshot.rails.length === 4 &&
        snapshot.rails.every(rail => rail.color === PURPLE_RGB)
      ) {
        return snapshot
      }
    }, 'native group color picker update')

    assert.notEqual(
      recolored.group.color,
      BLUE,
      'Native group color picker should update the group header color, not only tab custom colors'
    )
    assert.ok(
      railsAreVisuallyConnected(recolored.rails),
      `Expected recolored rails to remain connected: ${JSON.stringify(recolored.rails)}`
    )

    const collapsedUpdate = await runExtensionAsync(
      driver,
      async groupId => {
        await browser.tabGroups.update(groupId, { collapsed: true, color: 'orange' })
        return true
      },
      nativeGroup.groupId
    )
    assert.equal(collapsedUpdate, true)

    const collapsed = await waitFor(async () => {
      const snapshot = await getNativeGroupSnapshot(driver, RENAMED_GROUP_TITLE)
      if (
        snapshot.group?.collapsed === 'true' &&
        snapshot.group.color === ORANGE &&
        snapshot.rails.length === 1
      ) {
        return snapshot
      }
    }, 'collapsed native group color state')

    assert.equal(collapsed.group.titleColor, ORANGE_RGB)
    assert.notEqual(
      collapsed.group.colorLayerOpacity,
      expanded.group.colorLayerOpacity,
      'Collapsed and expanded group headers should use different color fill strength'
    )
    assert.equal(collapsed.rails[0].color, ORANGE_RGB)
    assert.deepEqual(
      {
        collapsed: collapsed.rails[0].collapsed,
        start: collapsed.rails[0].start,
        end: collapsed.rails[0].end,
      },
      { collapsed: true, start: true, end: true }
    )
    assert.equal(
      collapsed.tabs.filter(tab => tab.hasRail).length,
      1,
      `Expected only the active member tab to keep a rail while collapsed: ${JSON.stringify(collapsed.tabs)}`
    )

    const setupUrl = await getExtensionUrl(driver, '/page.setup/setup.html')
    await driver.get(setupUrl)
    await driver.wait(until.elementLocated(By.css('.Settings')), 20000)
    const setupText = await driver.findElement(By.css('body')).getText()

    assert.match(setupText, /Uses Firefox's native scrollbars inside Sidebery panels/)
    assert.doesNotMatch(setupText, /settings\\.notes\\.nativeScrollbars/)
  }
)

async function launchFirefox(port, profileDir) {
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

async function getExtensionUrl(driver, extensionPath) {
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

async function createNativeGroup(driver) {
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
    TEST_GROUP_TITLE
  )

  assert.ok(
    Number.isFinite(result.groupId),
    `Cannot create native tab group: ${JSON.stringify(result)}`
  )
  assert.equal(result.tabIds.length, 4)
  return result
}

async function runExtensionAsync(driver, fn, ...args) {
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

async function getNativeGroupSnapshot(driver, title = TEST_GROUP_TITLE) {
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
          text: group.textContent,
          titleColor: getComputedStyle(group.querySelector('.title')).color,
        },
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

function railsAreVerticallyUsable(rails) {
  return rails.every(rail => rail.width >= 3 && rail.height >= 20)
}

function railsShareLeftEdge(rails) {
  const leftEdges = rails.map(rail => rail.left)
  return Math.max(...leftEdges) - Math.min(...leftEdges) <= 0.5
}

function railsAreVisuallyConnected(rails) {
  return rails
    .slice()
    .sort((a, b) => a.top - b.top)
    .every((rail, index, sortedRails) => {
      const nextRail = sortedRails[index + 1]
      return !nextRail || rail.bottom >= nextRail.top - 2.5
    })
}

async function openNativeGroupMenu(driver, title = TEST_GROUP_TITLE) {
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

async function pickNativeGroupColor(driver, label) {
  await pickContextMenuOption(driver, label)
}

async function submitRenameDialog(driver, value) {
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

async function pickContextMenuOption(driver, label) {
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

async function waitFor(fn, label, timeout = 20000) {
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

async function waitForGeckodriver(port, logs) {
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

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

function collectProcessLogs(child, logs) {
  child.stdout?.on('data', data => pushLogLines(logs, data))
  child.stderr?.on('data', data => pushLogLines(logs, data))
}

function pushLogLines(logs, data) {
  logs.push(...String(data).trim().split(/\r?\n/).filter(Boolean))
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

function findFirefoxBinary() {
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
