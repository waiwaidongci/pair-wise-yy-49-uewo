// Store 层端到端验证：模拟浏览器 localStorage，跑通
// 旧草稿升级 → 建批次 → 断网补录 → 对端在线修改 → 回网合并/冲突/重试 → 失效重算 → 导出登记
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require('esbuild') as typeof import('esbuild')

const memory = new Map<string, string>()
const storePlugin = {
  name: 'store-shims',
  setup(b: any) {
    b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: 'env-shim', namespace: 'shim' }))
    b.onResolve({ filter: /^svelte\/store$/ }, () => ({ path: 'svelte-store-shim', namespace: 'shim' }))
    b.onLoad({ filter: /^env-shim$/, namespace: 'shim' }, () => ({
      contents: `export const browser = true; export const dev = false;`,
      loader: 'js',
    }))
    b.onLoad({ filter: /^svelte-store-shim$/, namespace: 'shim' }, () => ({
      contents: `
        function writable(initial) {
          let value = initial
          const subs = new Set()
          return {
            subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn) },
            set(v) { value = v; subs.forEach((fn) => fn(v)) },
            update(fn) { this.set(fn(value)) },
          }
        }
        function derived(store, fn) {
          const inner = writable(fn(get_store_value(store)))
          store.subscribe((v) => inner.set(fn(v)))
          return inner
        }
        function get_store_value(store) {
          let value
          store.subscribe((v) => { value = v })()
          return value
        }
        export { writable, derived as readable };
        export const get = get_store_value;
      `,
      loader: 'js',
    }))
  },
}

const localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
}
;(globalThis as any).localStorage = localStorage

async function loadStore() {
  const result = await build({
    entryPoints: ['src/lib/stores.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [storePlugin],
  })
  const file = resolve(`./.tmp-store-under-test-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('A. 旧草稿（无批次号）兼容升级')
memory.clear()
localStorage.setItem(
  'curriculum-map-draft-v1',
  JSON.stringify({
    nodes: [{ id: 'OBJ-01', label: 'x', type: '目标', x: 1, y: 1 }],
    mappings: [
      { id: 'M-01', source: 'OBJ-01', target: 'GR-01', relation: '支撑', weight: 0.9 },
      { id: 'M-NEW', source: 'GR-06', target: 'C-205', relation: '支撑', weight: 0.66 },
    ],
    reviewItems: [
      { id: 'REV-201', courseId: 'C-308', requirementId: 'GR-03', evidence: '旧证据旧证据旧证据旧证据', submitter: 's', status: '待审阅', comment: '' },
      { id: 'REV-203', courseId: 'C-205', requirementId: 'GR-01', evidence: '图算法实践已覆盖复杂工程问题建模，作业与测验记录完整。', submitter: '数据结构课程组', status: '已附议', comment: '覆盖证据充分，建议保留。', reviewer: '院系审阅人：周岚' },
    ],
    revision: 'R99',
    locked: true,
    draft: '旧草稿备注',
  }),
)
{
  const mod = await loadStore()
  const store = mod.curriculumStore
  let state: any
  const unsub = store.subscribe((s: any) => (state = s)); void unsub
  check('自动生成升级批次并激活，v1 键被移除', () => {
    assert.equal(state.migratedFromV1, true)
    assert.equal(state.batches.length, 1)
    assert.ok(state.activeBatch.title.includes('旧草稿'))
    assert.equal(localStorage.getItem('curriculum-map-draft-v1'), null)
  })
  check('旧草稿差异逐条转入补录队列并自动合并（缺失连边、位置变化节点）', () => {
    const ids = state.activeBatch.entries.map((e: any) => e.entityId)
    assert.ok(ids.includes('M-NEW'))
    assert.ok(ids.includes('OBJ-01'))
    assert.ok(state.server.mappings.some((m: any) => m.id === 'M-NEW'))
  })
  const mod2 = await loadStore()
  let state2: any
  const unsub2 = mod2.curriculumStore.subscribe((s: any) => (state2 = s)); void unsub2
  check('v2 持久化恢复后批次保持合并状态', () => {
    assert.equal(state2.batches.length, 1)
    assert.equal(state2.migratedFromV1, true)
    assert.equal(state2.activeBatch.entries.every((e: any) => e.status === '已合并' || e.status === '已放弃'), true)
  })
}

console.log('\nB. 全新用户完整断网→冲突→重算→重试→导出流程')
memory.clear()
{
  const mod = await loadStore()
  const store = mod.curriculumStore
  let state: any
  const unsub = store.subscribe((s: any) => (state = s)); void unsub

  store.createRevisionBatch({ title: '测试批次', owner: '顾明', reviewer: '周岚', revision: 'R13' })
  check('建批次后冻结节点/连边/审阅，默认断网', () => {
    assert.equal(state.activeBatch.online, false)
    assert.equal(state.activeBatch.snapshot.mappings.length, state.server.mappings.length)
    assert.equal(state.view.nodes.length, state.server.nodes.length)
  })

  // 断网补录：课程方改 M-05 权重、补 REV-202 证据；审阅人断网退回 REV-201
  store.updateMapping('M-05', { weight: 0.45 })
  store.updateReviewEvidence('REV-202', '补充评分记录与量规明细，覆盖全班三十六份作业材料。')
  store.updateReview('REV-201', '已退回', '断网退回：还需课堂表现记录。')
  const pendingIds = state.activeBatch.entries.map((e: any) => e.entityId)
  check('断网操作全部进队列，工作视图立即反映本地值', () => {
    assert.deepEqual(pendingIds, ['M-05', 'REV-202', 'REV-201'])
    assert.equal(state.view.mappings.find((m: any) => m.id === 'M-05').weight, 0.45)
  })

  // 对端在线：审阅人在线改 M-05（不同权重）→ 制造冲突；在线附议 REV-202 → 冲突
  store.onlineUpsertMapping({ ...state.server.mappings.find((m: any) => m.id === 'M-05'), weight: 0.88 })
  store.onlineReviewDecision('REV-202', '已附议', '在线附议：材料已收到。')
  check('在线改动落服务端但不覆盖本地工作视图', () => {
    assert.equal(state.server.mappings.find((m: any) => m.id === 'M-05').weight, 0.88)
    assert.equal(state.view.mappings.find((m: any) => m.id === 'M-05').weight, 0.45)
  })

  const report = store.goOnlineAndMerge()
  check('回网按条目合并：M-05/REV-202 双方改动留待确认，REV-201 快进合并', () => {
    assert.ok(report.conflicts.includes('M-05'))
    assert.ok(report.conflicts.includes('REV-202'))
    assert.ok(report.applied.includes('REV-201'))
    assert.equal(state.activeBatch.status, 'partial')
    // 在线附议意见没有被回传覆盖
    assert.equal(state.server.reviews.find((r: any) => r.id === 'REV-202').status, '已附议')
  })

  // REV-202 字段级合并：课程方新证据 + 在线附议
  store.resolveEntry(state.activeBatch.entries.find((e: any) => e.entityId === 'REV-202').id, 'merge-fields')
  check('字段级合并后：证据=本地，状态/意见=服务端', () => {
    const rev = state.server.reviews.find((r: any) => r.id === 'REV-202')
    assert.equal(rev.status, '已附议')
    assert.equal(rev.comment, '在线附议：材料已收到。')
    assert.ok(rev.evidence.includes('评分记录与量规'))
  })

  // M-05 采用本地，随后结论重算（GR-03→C-308 影响 REV-201）
  const m05Entry = state.activeBatch.entries.find((e: any) => e.entityId === 'M-05')
  store.resolveEntry(m05Entry.id, 'local')
  check('采用本地连边后服务端更新，且冲突批次最终 merged', () => {
    assert.equal(state.server.mappings.find((m: any) => m.id === 'M-05').weight, 0.45)
    assert.equal(state.activeBatch.status, 'merged')
  })

  // 审阅失效重算：新批次里直接改连边验证
  store.createRevisionBatch({ title: '第二批', owner: '顾明', reviewer: '周岚', revision: 'R14' })
  store.onlineReviewDecision('REV-203', '已附议', '再次确认通过。', '周岚')
  store.updateMapping('M-04', { weight: 0.2 }) // GR-03→C-205
  const r2 = store.goOnlineAndMerge()
  check('映射变更导致相关审阅结论失效重算并进入历史', () => {
    assert.ok(r2.invalidated.some((i: any) => i.reviewId === 'REV-203'))
    const rev = state.server.reviews.find((r: any) => r.id === 'REV-203')
    assert.equal(rev.status, '待审阅')
    assert.equal(rev.reviewer, '系统复核')
    assert.match(rev.comment, /自动复核/)
    const archived = state.server.history.filter((h: any) => h.reviewId === 'REV-203')
    assert.ok(archived.length >= 2)
  })

  // 导出随批次
  store.createRevisionBatch({ title: '导出批', owner: '顾明', reviewer: '周岚', revision: 'R15' })
  const exported = store.exportMap()
  check('导出先生成内容并在服务端待登记，回传后登记', () => {
    assert.ok(exported.content.includes('R15'))
    assert.equal(exported.record.status, '待登记')
    const r3 = store.goOnlineAndMerge()
    assert.ok(r3.exports.length >= 1)
    assert.equal(state.server.exports[0].status, '已登记')
    assert.ok(state.server.exports[0].registeredAt)
  })

  // 失败重试演练
  store.createRevisionBatch({ title: '失败批', owner: '顾明', reviewer: '周岚', revision: 'R16' })
  store.addMapping('GR-06', 'C-101', '支撑', 0.5)
  store.armFailure()
  const failed = store.goOnlineAndMerge()
  check('演练中断：现场保留，可重试且不重复', () => {
    assert.equal(failed.stopped, true)
    assert.equal(state.activeBatch.status, 'partial')
    assert.ok(state.activeBatch.entries[0].lastError.includes('回传中断'))
    const again = store.retryMerge()
    assert.ok(again.applied.length >= 1)
    assert.equal(state.server.mappings.filter((m: any) => m.source === 'GR-06' && m.target === 'C-101').length, 1)
  })

  // 持久化检查
  const raw = JSON.parse(localStorage.getItem('curriculum-revision-batches-v2')!)
  check('全部状态持久化到 v2 键', () => {
    assert.equal(raw.version, 2)
    assert.ok(raw.server.history.length >= 2)
    assert.ok(raw.batches.length >= 4)
  })
}

console.log(`\nStore 层 ${passed} 组集成场景通过 ✅`)
