const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { compactRecognitionFrames } = require('../../src/automation/diagnostic-storage')

test('识别图去重后每个用途仍可独立校验原图、OCR、XML和时间，目录搬移后仍有效', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-storage-'))
  const directory = path.join(root, '关键识别')
  await fs.mkdir(directory)
  const original = {}
  try {
    for (const [stem, bytes] of [['before', 'same PNG'], ['confirm', 'same PNG'], ['after', 'changed PNG']]) {
      const frame = Buffer.from(bytes)
      original[stem] = { frame_file: `${stem}.png`, frame_sha256: createHash('sha256').update(frame).digest('hex'),
        purpose: stem, recognition: { results: [{ text: stem }] }, hierarchy: `<hierarchy>${stem}</hierarchy>`, frame_captured_at: stem }
      await fs.writeFile(path.join(directory, `${stem}.png`), frame)
      await fs.writeFile(path.join(directory, `${stem}.json`), JSON.stringify(original[stem]))
    }
    const result = await compactRecognitionFrames(directory)
    assert.equal(result.removed_files, 1)
    assert.equal(result.saved_bytes, Buffer.byteLength('same PNG'))
    const moved = path.join(root, '搬移后')
    await fs.rename(directory, moved)
    for (const stem of Object.keys(original)) {
      const data = JSON.parse(await fs.readFile(path.join(moved, `${stem}.json`)))
      assert.deepEqual({ ...data, frame_file: original[stem].frame_file }, original[stem])
      assert.equal(createHash('sha256').update(await fs.readFile(path.join(moved, data.frame_file))).digest('hex'), data.frame_sha256)
    }
    assert.equal((await compactRecognitionFrames(moved)).removed_files, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('图像损坏或引用丢失时停止去重并保留全部原文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-storage-invalid-'))
  try {
    for (const stem of ['a', 'b']) {
      await fs.writeFile(path.join(root, `${stem}.png`), 'same PNG')
      await fs.writeFile(path.join(root, `${stem}.json`), JSON.stringify({ frame_file: `${stem}.png`, frame_sha256: createHash('sha256').update('same PNG').digest('hex') }))
    }
    await fs.writeFile(path.join(root, 'c.json'), JSON.stringify({ frame_file: 'missing.png', frame_sha256: 'invalid' }))
    await assert.rejects(compactRecognitionFrames(root))
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.json', 'a.png', 'b.json', 'b.png', 'c.json'])
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'b.json'))).frame_file, 'b.png')
    await fs.writeFile(path.join(root, 'missing.png'), 'damaged PNG')
    await assert.rejects(compactRecognitionFrames(root), /原图校验失败/)
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'b.json'))).frame_file, 'b.png')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('更新引用中途失败时不删除原图，已更新和未更新的证据都能读取', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-storage-interrupt-'))
  const hash = createHash('sha256').update('same PNG').digest('hex')
  try {
    for (const stem of ['a', 'b', 'c']) {
      await fs.writeFile(path.join(root, `${stem}.png`), 'same PNG')
      await fs.writeFile(path.join(root, `${stem}.json`), JSON.stringify({ frame_file: `${stem}.png`, frame_sha256: hash }))
    }
    const rename = fs.rename
    const mocked = t.mock.method(fs, 'rename', async (from, to) => {
      if (to === path.join(root, 'c.json')) throw new Error('模拟磁盘写入失败')
      return rename(from, to)
    })
    await assert.rejects(compactRecognitionFrames(root), /模拟磁盘写入失败/)
    mocked.mock.restore()
    assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.png')).length, 3)
    for (const stem of ['a', 'b', 'c']) {
      const detail = JSON.parse(await fs.readFile(path.join(root, `${stem}.json`)))
      assert.equal(createHash('sha256').update(await fs.readFile(path.join(root, detail.frame_file))).digest('hex'), hash)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
