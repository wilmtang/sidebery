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
const BLUE = '#37adff'
const BLUE_RGB = 'rgb(55, 173, 255)'
const ORANGE = '#ff9f00'
const ORANGE_RGB = 'rgb(255, 159, 0)'
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
      if (snapshot.group?.collapsed === 'false' && snapshot.rails.length === 3) return snapshot
    }, 'expanded native group rails')

    assert.equal(expanded.group.color, BLUE)
    assert.equal(expanded.rails.length, 3)
    assert.deepEqual(
      expanded.rails.map(rail => ({
        start: rail.start,
        middle: rail.middle,
        end: rail.end,
      })),
      [
        { start: true, middle: false, end: false },
        { start: false, middle: true, end: false },
        { start: false, middle: false, end: true },
      ]
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
      const snapshot = await getNativeGroupSnapshot(driver)
      if (
        snapshot.group?.collapsed === 'true' &&
        snapshot.group.color === ORANGE &&
        snapshot.rails.length === 1
      ) {
        return snapshot
      }
    }, 'collapsed native group color state')

    assert.equal(collapsed.group.titleColor, ORANGE_RGB)
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
      const tabs = []
      for (let i = 1; i <= 3; i++) {
        tabs.push(
          await browser.tabs.create({ url: `about:blank#sidebery-e2e-${i}`, active: false })
        )
      }

      const groupId = await browser.tabs.group({ tabIds: tabs.map(tab => tab.id) })
      await browser.tabGroups.update(groupId, { title, color: 'blue' })
      await browser.tabs.update(tabs[1].id, { active: true })

      return {
        groupId,
        tabIds: tabs.map(tab => tab.id),
      }
    },
    TEST_GROUP_TITLE
  )

  assert.ok(
    Number.isFinite(result.groupId),
    `Cannot create native tab group: ${JSON.stringify(result)}`
  )
  assert.equal(result.tabIds.length, 3)
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

async function getNativeGroupSnapshot(driver) {
  return await driver.executeScript(
    `
      const group = [...document.querySelectorAll('.NativeTabGroup')]
        .find(el => el.textContent.includes(arguments[0]));

      const railEls = [...document.querySelectorAll('.Tab .native-group-thread')];

      return {
        group: group && {
          collapsed: group.dataset.collapsed,
          color: getComputedStyle(group).getPropertyValue('--native-group-color').trim(),
          text: group.textContent,
          titleColor: getComputedStyle(group.querySelector('.title')).color,
        },
        rails: railEls.map(el => {
          const rect = el.getBoundingClientRect();
          return {
            collapsed: el.dataset.collapsed === 'true',
            color: getComputedStyle(el).backgroundColor,
            end: el.dataset.end === 'true',
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
          text: el.textContent,
        })),
      };
    `,
    TEST_GROUP_TITLE
  )
}

function railsAreVerticallyUsable(rails) {
  return rails.every(rail => rail.width >= 3 && rail.height >= 20)
}

function railsShareLeftEdge(rails) {
  const leftEdges = rails.map(rail => rail.left)
  return Math.max(...leftEdges) - Math.min(...leftEdges) <= 0.5
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
