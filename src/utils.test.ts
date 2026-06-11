import { describe, expect, test } from 'vitest'
import * as Utils from './utils'
import { PLACEHOLDER_URL } from 'src/defaults'

describe('Utils.AsyncQueue', () => {
  test('runs sequential tasks in order', async () => {
    const queue = new Utils.AsyncQueue()
    const order: number[] = []
    const mk = (n: number) => async () => {
      await Promise.resolve()
      order.push(n)
      return n
    }
    const results = await Promise.all([queue.add(mk(1)), queue.add(mk(2)), queue.add(mk(3))])
    expect(results).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
  })

  test('does not deadlock when the first (fast-path) task rejects', async () => {
    const queue = new Utils.AsyncQueue()
    const failing = async () => {
      throw new Error('boom')
    }
    const ok = async () => 'ok'

    // First task rejects on the fast path; its rejection must propagate.
    await expect(queue.add(failing)).rejects.toThrow('boom')

    // Queue must still be usable afterwards.
    await expect(queue.add(ok)).resolves.toBe('ok')
  })

  test('a rejected queued task does not block later tasks', async () => {
    const queue = new Utils.AsyncQueue()
    const slowOk = async () => {
      await Utils.sleep(5)
      return 'first'
    }
    const failing = async () => {
      throw new Error('mid')
    }
    const lastOk = async () => 'last'

    const p1 = queue.add(slowOk)
    const p2 = queue.add(failing)
    const p3 = queue.add(lastOk)

    await expect(p1).resolves.toBe('first')
    await expect(p2).rejects.toThrow('mid')
    await expect(p3).resolves.toBe('last')
  })

  test('preserves rejection to the caller while keeping the queue alive', async () => {
    const queue = new Utils.AsyncQueue()
    const results: string[] = []
    await queue
      .add(async () => {
        throw new Error('x')
      })
      .catch(() => results.push('caught'))
    await queue.add(async () => {
      results.push('after')
    })
    expect(results).toEqual(['caught', 'after'])
  })
})

describe('Utils.toRGBA()', () => {
  test('percentage channels convert independently', () => {
    // Regression: green/blue percent channels previously reused the red value.
    expect(Utils.toRGBA('rgba(100%, 50%, 0%, 0.5)')).toEqual([255, 128, 0, 0.5])
    expect(Utils.toRGBA('rgb(0%, 100%, 50%)')).toEqual([0, 255, 128, 1])
  })
  test('numeric channels', () => {
    expect(Utils.toRGBA('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1])
    expect(Utils.toRGBA('rgba(10, 20, 30, 0.25)')).toEqual([10, 20, 30, 0.25])
  })
  test('valid hex', () => {
    expect(Utils.toRGBA('#fff')).toEqual([255, 255, 255, 1])
    expect(Utils.toRGBA('#010203')).toEqual([1, 2, 3, 1])
  })
  test('rejects malformed hex (no partial parse)', () => {
    // Regression: `[0-f]` accepted garbage like `#1G2H3I` and parsed it partially.
    expect(Utils.toRGBA('#1G2H3I')).toBe(undefined)
    expect(Utils.toRGBA('#zzz')).toBe(undefined)
  })
})

describe('Utils.isRegExp()', () => {
  test('true for RegExp', () => {
    expect(Utils.isRegExp(/abc/)).toBe(true)
  })
  test('false (no throw) for null/undefined/string', () => {
    expect(Utils.isRegExp(null)).toBe(false)
    expect(Utils.isRegExp(undefined)).toBe(false)
    expect(Utils.isRegExp('abc')).toBe(false)
    expect(Utils.isRegExp({ test: () => true })).toBe(false)
  })
})

describe('Utils.withoutEmptyFolders()', () => {
  test('keeps ancestor folders even when children precede parents', () => {
    // child-first ordering used to misclassify the parent folder as empty
    const items = [
      { id: 3, url: 'https://example.com', parentId: 2 },
      { id: 2, parentId: 1 },
      { id: 1, parentId: -1 },
      { id: 4, parentId: 1 }, // empty folder -> dropped
    ]
    const result = Utils.withoutEmptyFolders(items).map(i => i.id)
    expect(result).toEqual([3, 2, 1])
  })
})

describe('Utils.colorFromString()', () => {
  test('deterministic and includes trailing char of odd-length strings', () => {
    const a = Utils.colorFromString('abcde')
    const b = Utils.colorFromString('abcde')
    expect(a).toBe(b)
    // changing only the trailing (previously ignored) char changes the color
    expect(Utils.colorFromString('abcde')).not.toBe(Utils.colorFromString('abcdf'))
  })
})

describe('Utils.createGroupUrl()', () => {
  test('just name', () => {
    const url = Utils.createGroupUrl('name')
    const urlObj = new URL(url)
    expect(Utils.isGroupUrl(url)).toBe(true)
    expect(urlObj.hash).toBe('#name')
  })
  test('name and pin', () => {
    const url = Utils.createGroupUrl('name', 'https://example.com', 'firefox-default')
    const urlObj = new URL(url)
    expect(Utils.isGroupUrl(url)).toBe(true)
    expect(urlObj.hash).toBe('#name')
    expect(urlObj.searchParams.get('pin')).toBe('firefox-default::https://example.com')
  })
})

describe('Utils.createPlaceholderUrl(), Utils.parsePlaceholderUrl()', () => {
  test('encode decode', () => {
    const srcUrl = encodeURI('file:///path/to some/filе.pdf')
    const srcTitle = 'Abc🔙йĀ𐀀文'
    const placeholderUrl = Utils.createPlaceholderUrl({ url: srcUrl, title: srcTitle })
    const info = Utils.parsePlaceholderUrl(placeholderUrl)
    expect(info.url).toBe(srcUrl)
    expect(info.title).toBe(srcTitle)
  })
  test('decode legacy', () => {
    const srcUrl = 'file:///home/m/sidebery-snapshot-2026.02.08-13.46.05.json'
    const srcTitle = '123'
    const placeholderUrl =
      PLACEHOLDER_URL + '#' + encodeURIComponent(JSON.stringify([srcUrl, srcTitle]))
    const info = Utils.parsePlaceholderUrl(placeholderUrl)
    expect(info.url).toBe(srcUrl)
    expect(info.title).toBe(srcTitle)
  })
  test('decode legacy without title', () => {
    const srcUrl = 'file:///path/to/file.pdf'
    const placeholderUrl = PLACEHOLDER_URL + '#' + srcUrl
    const info = Utils.parsePlaceholderUrl(placeholderUrl)
    expect(info.url).toBe(srcUrl)
  })
  test('parse placeholder url with broadcast channel', () => {
    const srcUrl = 'file:///some/path/to/file.txt'
    const srcTitle = 'File'
    const placeholderUrl = Utils.createPlaceholderUrl({ url: srcUrl, title: srcTitle })
    const urlWithChId = placeholderUrl + '~!123456789abc!ch!~'
    const info = Utils.parsePlaceholderUrl(urlWithChId)
    expect(info.url).toBe(srcUrl)
    expect(info.title).toBe(srcTitle)
  })
  test('parse placeholder url with hash msg', () => {
    const srcUrl = 'file:///some/path/to/file.txt'
    const srcTitle = 'File'
    const placeholderUrl = Utils.createPlaceholderUrl({ url: srcUrl, title: srcTitle })
    const urlWithHashMsg = placeholderUrl + '~!+.0.123456789abc!b!p!~'
    const info = Utils.parsePlaceholderUrl(urlWithHashMsg)
    expect(info.url).toBe(srcUrl)
    expect(info.title).toBe(srcTitle)
  })
})

describe('Utils.restoreUrl()', () => {
  test('group page url', () => {
    const sUrl =
      'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#New%20Tab'
    const rUrl = Utils.restoreUrl(sUrl)
    expect(rUrl).toBe(sUrl)
  })
  test('group page url with empty title', () => {
    const sUrl = 'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#'
    const rUrl = Utils.restoreUrl(sUrl)
    expect(rUrl).toBe(sUrl)
  })
  test('group page url (+chId)', () => {
    const sUrl =
      'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#New%20Tab~!PpBA2ocRL1ry!ch!~'
    const eUrl =
      'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#New%20Tab'
    const rUrl = Utils.restoreUrl(sUrl)
    expect(rUrl).toBe(eUrl)
  })
  test('group page url (+chId) with empty title', () => {
    const sUrl =
      'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#~!PpBA2ocRL1ry!ch!~'
    const eUrl = 'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#'
    const rUrl = Utils.restoreUrl(sUrl)
    expect(rUrl).toBe(eUrl)
  })
  test('group page url (+hash msg)', () => {
    const sUrl =
      'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#123~!+.0.syPdgQdGolHy!p!b!~'
    const eUrl = 'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#123'
    const rUrl = Utils.restoreUrl(sUrl)
    expect(rUrl).toBe(eUrl)
  })
  test('placeholder page url (+chId)', () => {
    const origUrl = 'file:///abc/cba/123.json'
    const sUrl = Utils.createPlaceholderUrl({ url: origUrl }) + '~!PpBA2ocRL1ry!ch!~'
    const rUrl = Utils.restoreUrl(sUrl)
    expect(rUrl).toBe(origUrl)
  })
})

describe('Utils.parseTextForItems()', () => {
  test('empty string', () => {
    const items = Utils.parseTextForItems('')
    expect(items.length).toBe(0)
  })
  test('url, markdown, html, text', () => {
    const input = `
pre https://example.com
[hey](https://example.com) post
pre <a href="https://example.com">123</a> post
some:text`
    const items = Utils.parseTextForItems(input)
    expect(items[0].url).toBe('https://example.com')
    expect(items[0].title).toBe('')
    expect(items[1].url).toBe('https://example.com')
    expect(items[1].title).toBe('hey')
    expect(items[2].url).toBe('https://example.com')
    expect(items[2].title).toBe('123')
    expect(items[3].url).toBe(undefined)
    expect(items[3].title).toBe('some:text')
    expect(items.length).toBe(4)
  })
  test('api-limited url, markdown, html', () => {
    const input = `
file:///some/path/to/File%20Name.json
[1 2 3](blob:https://example.com/550e8400)
<a href="about:config">one two</a>
[hey](not link)`
    const items = Utils.parseTextForItems(input)
    expect(Utils.isPlaceholderUrl(items[0].url ?? '')).toBe(true)
    expect(items[0].title).toBe('File Name.json')
    expect(Utils.isPlaceholderUrl(items[1].url ?? '')).toBe(true)
    expect(items[1].title).toBe('1 2 3')
    expect(Utils.isPlaceholderUrl(items[2].url ?? '')).toBe(true)
    expect(items[2].title).toBe('one two')
    expect(items[3].url).toBe(undefined)
    expect(items[3].title).toBe('[hey](not link)')
    expect(items.length).toBe(4)
  })
})
