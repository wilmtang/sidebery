// End-to-end coverage for Firefox native tab groups in the Sidebery sidebar.
//
// Everything here drives a real (headless) Firefox with the built addon
// installed — see ./helpers.mjs for the geckodriver/selenium harness. The file
// is organized as one shared browser session with three groups of subtests:
//
//   1. Rendering flow — a single, deep scenario that checks the pixel-level
//      "rail" geometry, colors, and the rename/recolor/collapse header actions.
//   2. Lifecycle sanity — fast, independent regression checks for the everyday
//      flows (create, collapse-by-click, add/remove a member, close, multiple
//      groups). These avoid the precise geometry above on purpose.
//   3. Settings smoke check — a lightweight assertion that the setup page still
//      renders (kept here because it shares the same expensive browser session).
//
// Subtests share one Firefox instance for speed; each one starts from a clean
// slate (no groups) and closes the tabs it creates so the others stay isolated.
import test from 'node:test'
import assert from 'node:assert/strict'
import { By, until } from 'selenium-webdriver'
import {
  BLUE,
  BLUE_RGB,
  DEFAULT_TIMEOUT,
  ORANGE,
  ORANGE_RGB,
  PURPLE,
  PURPLE_RGB,
  RED,
  TEST_GROUP_TITLE,
  addTabsToNativeGroup,
  clickNativeGroupHeader,
  closeTabs,
  createBlankTabs,
  createNativeGroup,
  createSimpleNativeGroup,
  getExtensionUrl,
  getNativeGroupSnapshot,
  openNativeGroupMenu,
  openSidebar,
  pickContextMenuOption,
  pickNativeGroupColor,
  railsAreVerticallyUsable,
  railsAreVisuallyConnected,
  railsShareLeftEdge,
  runExtensionAsync,
  startFirefoxSession,
  submitRenameDialog,
  ungroupTabs,
  waitFor,
  waitForGroupSnapshot,
  waitForNativeGroupCount,
} from './helpers.mjs'

const RENAMED_GROUP_TITLE = 'Sidebery E2E Renamed Native Group'

test('Firefox native tab groups', { timeout: DEFAULT_TIMEOUT }, async t => {
  const { driver } = await startFirefoxSession(t)
  await openSidebar(driver)

  // --- 1. Rendering flow -----------------------------------------------------
  // One end-to-end scenario over a single group: it builds a parent + nested
  // child + two siblings, then walks expand -> rename -> recolor -> collapse,
  // asserting the visual "rails" and header styling at each step. Kept as one
  // atomic subtest because every step depends on the state the previous left.
  await t.test(
    'group rail rendering survives expand, rename, recolor, and collapse',
    async () => {
      await waitForNativeGroupCount(driver, 0, 'clean slate before rendering flow')
      const nativeGroup = await createNativeGroup(driver, TEST_GROUP_TITLE)

      try {
        // Expanded: the three grouped tabs plus the nested (ungrouped) child
        // each draw a rail, and together they form one connected blue rail.
        const expanded = await waitFor(async () => {
          const snapshot = await getNativeGroupSnapshot(driver, TEST_GROUP_TITLE)
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

        // Rename via the context menu's "Edit title" -> in-app dialog. This must
        // rename the group only, never drop the first tab into custom-title edit
        // mode (a past regression).
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

        // Recolor via the menu's color picker: the whole group (header + rails)
        // turns purple, not just per-tab custom colors.
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

        // Collapse (and recolor to orange) via the browser API: the header keeps
        // a single orange pill on the active member, with a different fill
        // strength than the expanded header used.
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
      } finally {
        await closeTabs(driver, nativeGroup.tabIds)
        await waitForNativeGroupCount(driver, 0, 'cleanup after rendering flow')
      }
    }
  )

  // --- 2. Lifecycle sanity ---------------------------------------------------
  await t.test('a new group renders a header with title, count, and a rail per member tab', async () => {
    await waitForNativeGroupCount(driver, 0, 'clean slate before create')
    const title = 'Sidebery Sanity Create'
    const group = await createSimpleNativeGroup(driver, { title, color: 'blue', count: 3 })

    try {
      const snapshot = await waitForGroupSnapshot(
        driver,
        title,
        s => s.group?.collapsed === 'false' && s.rails.length === 3,
        'created native group renders'
      )

      assert.match(snapshot.group.text, /Sidebery Sanity Create/)
      assert.equal(snapshot.group.color, BLUE)
      assert.equal(snapshot.group.count, '3')
      assert.equal(snapshot.rails.length, 3)
      assert.ok(
        snapshot.rails.every(rail => rail.color === BLUE_RGB),
        `Expected every rail to use ${BLUE_RGB}: ${JSON.stringify(snapshot.rails)}`
      )
    } finally {
      await closeTabs(driver, group.tabIds)
      await waitForNativeGroupCount(driver, 0, 'cleanup after create')
    }
  })

  await t.test('clicking the header collapses then expands the group', async () => {
    await waitForNativeGroupCount(driver, 0, 'clean slate before collapse')
    const title = 'Sidebery Sanity Collapse'
    const group = await createSimpleNativeGroup(driver, { title, color: 'blue', count: 3 })

    try {
      await waitForGroupSnapshot(
        driver,
        title,
        s => s.group?.collapsed === 'false' && s.rails.length === 3,
        'group starts expanded'
      )

      await clickNativeGroupHeader(driver, title)
      const collapsed = await waitForGroupSnapshot(
        driver,
        title,
        s => s.group?.collapsed === 'true',
        'header click collapses group'
      )
      assert.equal(collapsed.group.collapsed, 'true')

      await clickNativeGroupHeader(driver, title)
      const expanded = await waitForGroupSnapshot(
        driver,
        title,
        s => s.group?.collapsed === 'false' && s.rails.length === 3,
        'header click expands group again'
      )
      assert.equal(expanded.group.collapsed, 'false')
      assert.equal(expanded.rails.length, 3)
    } finally {
      await closeTabs(driver, group.tabIds)
      await waitForNativeGroupCount(driver, 0, 'cleanup after collapse')
    }
  })

  await t.test('adding a tab to a group grows its member count and rails', async () => {
    await waitForNativeGroupCount(driver, 0, 'clean slate before add')
    const title = 'Sidebery Sanity Add'
    const group = await createSimpleNativeGroup(driver, { title, color: 'blue', count: 2 })
    let extraIds = []

    try {
      await waitForGroupSnapshot(
        driver,
        title,
        s => s.group?.collapsed === 'false' && s.rails.length === 2,
        'group starts with two members'
      )

      extraIds = await createBlankTabs(driver, 1, 'sanity-add')
      await addTabsToNativeGroup(driver, group.groupId, extraIds)

      // Both the live rail count (driven by recalcVisibleTabs) and the header's
      // count text must track membership changes made via the browser API.
      const grown = await waitForGroupSnapshot(
        driver,
        title,
        s =>
          s.rails.length === 3 &&
          s.tabs.filter(tab => tab.hasRail).length === 3 &&
          s.group?.count === '3',
        'group grows to three members'
      )
      assert.equal(grown.rails.length, 3)
      assert.equal(grown.tabs.filter(tab => tab.hasRail).length, 3)
      assert.equal(grown.group.count, '3')
    } finally {
      await closeTabs(driver, [...group.tabIds, ...extraIds])
      await waitForNativeGroupCount(driver, 0, 'cleanup after add')
    }
  })

  await t.test('ungrouping a tab shrinks the group member count and rails', async () => {
    await waitForNativeGroupCount(driver, 0, 'clean slate before remove')
    const title = 'Sidebery Sanity Remove'
    const group = await createSimpleNativeGroup(driver, { title, color: 'blue', count: 3 })

    try {
      await waitForGroupSnapshot(
        driver,
        title,
        s => s.group?.collapsed === 'false' && s.rails.length === 3,
        'group starts with three members'
      )

      await ungroupTabs(driver, [group.tabIds[2]])

      const shrunk = await waitForGroupSnapshot(
        driver,
        title,
        s =>
          s.rails.length === 2 &&
          s.tabs.filter(tab => tab.hasRail).length === 2 &&
          s.group?.count === '2',
        'group shrinks to two members'
      )
      assert.equal(shrunk.rails.length, 2)
      assert.equal(shrunk.tabs.filter(tab => tab.hasRail).length, 2)
      assert.equal(shrunk.group.count, '2')
    } finally {
      // The ungrouped tab is still open, so close every tab we created.
      await closeTabs(driver, group.tabIds)
      await waitForNativeGroupCount(driver, 0, 'cleanup after remove')
    }
  })

  await t.test('closing every member tab removes the group header', async () => {
    await waitForNativeGroupCount(driver, 0, 'clean slate before close')
    const title = 'Sidebery Sanity Close'
    const group = await createSimpleNativeGroup(driver, { title, color: 'blue', count: 2 })

    await waitForGroupSnapshot(
      driver,
      title,
      s => !!s.group && s.rails.length === 2,
      'group header is present before closing'
    )

    await closeTabs(driver, group.tabIds)

    const gone = await waitForGroupSnapshot(
      driver,
      title,
      s => !s.group && s.groupCount === 0,
      'group header disappears after closing all members'
    )
    // executeScript serializes a missing group as null, so assert falsy.
    assert.ok(!gone.group, `Expected the group header to be gone: ${JSON.stringify(gone.group)}`)
    assert.equal(gone.groupCount, 0)
  })

  await t.test('two groups render side by side with independent colors', async () => {
    await waitForNativeGroupCount(driver, 0, 'clean slate before multi-group')
    const blueTitle = 'Sidebery Sanity Multi Blue'
    const redTitle = 'Sidebery Sanity Multi Red'
    const blueGroup = await createSimpleNativeGroup(driver, {
      title: blueTitle,
      color: 'blue',
      count: 2,
    })
    const redGroup = await createSimpleNativeGroup(driver, {
      title: redTitle,
      color: 'red',
      count: 2,
    })

    try {
      await waitForNativeGroupCount(driver, 2, 'both groups rendered')

      const blueSnap = await waitForGroupSnapshot(
        driver,
        blueTitle,
        s => s.group?.color === BLUE,
        'blue group keeps its color'
      )
      const redSnap = await waitForGroupSnapshot(
        driver,
        redTitle,
        s => s.group?.color === RED,
        'red group keeps its color'
      )

      assert.equal(blueSnap.group.color, BLUE)
      assert.equal(redSnap.group.color, RED)
      assert.notEqual(
        blueSnap.group.color,
        redSnap.group.color,
        'Two native groups should render with their own distinct colors'
      )
    } finally {
      await closeTabs(driver, [...blueGroup.tabIds, ...redGroup.tabIds])
      await waitForNativeGroupCount(driver, 0, 'cleanup after multi-group')
    }
  })

  // --- 3. Settings smoke check ----------------------------------------------
  // Not native-group specific, but it reuses this session: confirm the setup
  // page renders and shows the migrated "native scrollbars" setting label
  // (rather than a raw, untranslated i18n key). Runs last because it navigates
  // away from the sidebar page.
  await t.test('setup page renders the native scrollbars setting label', async () => {
    const setupUrl = await getExtensionUrl(driver, '/page.setup/setup.html')
    await driver.get(setupUrl)
    await driver.wait(until.elementLocated(By.css('.Settings')), 20000)
    const setupText = await driver.findElement(By.css('body')).getText()

    assert.match(setupText, /Uses Firefox's native scrollbars inside Sidebery panels/)
    assert.doesNotMatch(setupText, /settings\\.notes\\.nativeScrollbars/)
  })
})
