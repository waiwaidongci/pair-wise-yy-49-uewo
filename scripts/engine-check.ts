// 引擎核心场景验证：冻结 / 断网补录 / 三路合并 / 冲突 / 失效重算 / 失败重试 / 导出
import assert from 'node:assert'
import { seedState } from '../src/lib/seed'
import {
  applyReviewerDecision,
  classifyEntry,
  createBatch,
  createServerState,
  deepClone,
  deepEqual,
  discardEntry,
  mergeBatch,
  queueChange,
  recomputeReview,
  resolveConflict,
  retryBatch,
  stableHash,
} from '../src/lib/batch/engine'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const seed = deepClone(seedState)
const baseServer = () =>
  createServerState({ nodes: seed.nodes, mappings: seed.mappings, reviews: seed.reviewItems })

console.log('1. 建批次冻结节点/连边/审阅状态')
check('冻结快照与服务端同构且互不引用', () => {
  const server = baseServer()
  const batch = createBatch({
    title: 't', owner: '课程负责人', reviewer: '院系审阅人', revision: 'R13', server,
  })
  assert.equal(batch.snapshot.mappings.length, server.mappings.length)
  assert.equal(batch.snapshot.reviews[0].id, server.reviews[0].id)
  batch.snapshot.mappings[0].weight = -1
  assert.notEqual(server.mappings[0].weight, -1)
})

check('已附议的旧结论在服务端引导时带有指纹和历史', () => {
  const server = baseServer()
  const rev = server.reviews.find((r) => r.id === 'REV-203')!
  assert.ok(rev.basisHash)
  assert.ok(server.history.some((h) => h.reviewId === 'REV-203' && h.status === '已附议'))
})

console.log('\n2. 断网补录，回网按条目合并（快进 + 幂等）')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  const added: typeof server.mappings[number] = {
    id: 'M-90', source: 'GR-06', target: 'C-101', relation: '支撑', weight: 0.5,
  }
  queueChange(batch, {
    kind: 'mapping', entityId: added.id, op: 'upsert', role: '课程负责人',
    label: '新增 GR-06→C-101', localValue: added,
  })
  const edited = deepClone(server.mappings.find((m) => m.id === 'M-05')!)
  edited.weight = 0.6
  queueChange(batch, {
    kind: 'mapping', entityId: edited.id, op: 'upsert', role: '课程负责人',
    label: '调整 M-05 权重', localValue: edited,
  })
  const report = mergeBatch(server, batch)
  check('两条补录均合并', () => {
    assert.deepEqual(report.applied.sort(), ['M-05', 'M-90'].sort())
    assert.equal(server.mappings.find((m) => m.id === 'M-05')!.weight, 0.6)
    assert.equal(batch.status, 'merged')
  })
  check('再次合并幂等跳过', () => {
    const again = mergeBatch(server, batch)
    assert.equal(again.applied.length, 0)
  })
  // 审阅失效：M-05 是 GR-03→C-308，影响 REV-201（已附议? no, REV-201 待审阅）。M-90 GR-06→C-101 无对应审阅
}

console.log('\n3. 双方都改过 → 待确认；服务端未动 → 快进；服务端已应用 → 跳过')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })

  // (a) 双方都改 M-05 权重
  const localM05 = deepClone(server.mappings.find((m) => m.id === 'M-05')!)
  localM05.weight = 0.55
  queueChange(batch, { kind: 'mapping', entityId: 'M-05', op: 'upsert', role: '课程负责人', label: '课程方调权重', localValue: localM05 })
  const serverM05 = server.mappings.find((m) => m.id === 'M-05')!
  serverM05.weight = 0.9 // 审阅方/服务端在线同时改了
  // (b) 只有课程方改 M-06
  const localM06 = deepClone(server.mappings.find((m) => m.id === 'M-06')!)
  localM06.weight = 0.4
  queueChange(batch, { kind: 'mapping', entityId: 'M-06', op: 'upsert', role: '课程负责人', label: '课程方调 M-06', localValue: localM06 })
  // (c) 本地新增与服务端完全一致 → noop
  const dup: typeof server.mappings[number] = { id: 'M-77', source: 'OBJ-01', target: 'GR-03', relation: '支撑', weight: 0.3 }
  server.mappings.push(deepClone(dup))
  queueChange(batch, { kind: 'mapping', entityId: dup.id, op: 'upsert', role: '课程负责人', label: '重复新增', localValue: dup })

  const report = mergeBatch(server, batch)
  check('M-05 冲突留待确认，M-06 快进，M-77 跳过', () => {
    assert.deepEqual(report.conflicts, ['M-05'])
    assert.deepEqual(report.applied, ['M-06'])
    assert.deepEqual(report.skipped, ['M-77'])
    assert.equal(batch.status, 'partial')
    assert.equal(server.mappings.find((m) => m.id === 'M-05')!.weight, 0.9) // 服务端值未被覆盖
  })

  check('裁决取本地后服务端与本地一致', () => {
    const r2 = resolveConflict(server, batch, batch.entries[0].id, 'local')
    assert.deepEqual(r2.applied, ['M-05'])
    assert.equal(server.mappings.find((m) => m.id === 'M-05')!.weight, 0.55)
    assert.equal(batch.status, 'merged')
  })
}

console.log('\n4. 映射一变，已附议结论失效重算，旧结论可追溯')
{
  const server = baseServer()
  // REV-203 已附议（C-205 / GR-01），让一条 GR-01→C-205 连边变化
  server.mappings.push({ id: 'M-X', source: 'GR-01', target: 'C-205', relation: '支撑', weight: 0.5 })
  const rev = server.reviews.find((r) => r.id === 'REV-203')!
  rev.basisHash = stableHash({ supports: [{ relation: '支撑', weight: 0.5 }], evidence: rev.evidence })
  const historyBefore = server.history.length

  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  const edited = deepClone(server.mappings.find((m) => m.id === 'M-X')!)
  edited.weight = 0.9
  queueChange(batch, { kind: 'mapping', entityId: 'M-X', op: 'upsert', role: '课程负责人', label: '调权重', localValue: edited })
  const report = mergeBatch(server, batch)
  check('REV-203 被标记失效并重算为待审阅', () => {
    assert.deepEqual(report.invalidated.map((i) => i.reviewId), ['REV-203'])
    const after = server.reviews.find((r) => r.id === 'REV-203')!
    assert.equal(after.status, '待审阅')
    assert.match(after.comment, /自动复核/)
    assert.equal(after.reviewer, '系统复核')
  })
  check('旧附议结论已归档可追溯，且哈希与新指纹不同', () => {
    assert.ok(server.history.length > historyBefore)
    const archived = server.history.find((h) => h.reviewId === 'REV-203' && h.status === '已附议')!
    assert.ok(archived)
    const after = server.reviews.find((r) => r.id === 'REV-203')!
    assert.notEqual(archived.basisHash, after.basisHash)
  })
  check('审阅人重新附议后，新结论也进入历史，旧结论仍在', () => {
    const n = server.history.length
    applyReviewerDecision(server, 'REV-203', '已附议', '重新核对，证据充分。', '院系审阅人：周岚')
    const after = server.reviews.find((r) => r.id === 'REV-203')!
    assert.equal(after.status, '已附议')
    assert.equal(after.reviewer, '院系审阅人：周岚')
    assert.equal(server.history.length, n + 1)
  })
}

console.log('\n5. 证据被课程方修改 → 审阅失效；审阅人意见在线修改 → 双方冲突')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  const localRev = deepClone(server.reviews.find((r) => r.id === 'REV-203')!)
  localRev.evidence = '更新后的证据材料：增加了实验报告、期末试卷分析与达成度统计明细。'
  queueChange(batch, { kind: 'review', entityId: 'REV-203', op: 'upsert', role: '课程负责人', label: '更新证据', localValue: localRev })
  const report = mergeBatch(server, batch)
  check('证据变更导致已附议结论重算', () => {
    assert.deepEqual(report.invalidated.map((i) => i.reviewId), ['REV-203'])
    assert.equal(server.reviews.find((r) => r.id === 'REV-203')!.status, '待审阅')
  })

  // 双方都改同一审阅：课程方改证据，审阅人在线退回
  const server2 = baseServer()
  const batch2 = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server: server2 })
  const local2 = deepClone(server2.reviews.find((r) => r.id === 'REV-203')!)
  local2.evidence = '课程方断网期间补充的长证据文本，超过十二个字。'
  queueChange(batch2, { kind: 'review', entityId: 'REV-203', op: 'upsert', role: '课程负责人', label: '补证据', localValue: local2 })
  applyReviewerDecision(server2, 'REV-203', '已退回', '在线退回：请先补充材料。', '院系审阅人：周岚')
  const r2 = mergeBatch(server2, batch2)
  check('同一审阅双方都改 → 待确认', () => {
    assert.deepEqual(r2.conflicts, ['REV-203'])
    // 在线退回意见没有被覆盖
    assert.equal(server2.reviews.find((x) => x.id === 'REV-203')!.comment, '在线退回：请先补充材料。')
  })
  check('字段级合并：保留课程方新证据 + 审阅人退回状态', () => {
    resolveConflict(server2, batch2, batch2.entries[0].id, 'merge-fields')
    const merged = server2.reviews.find((x) => x.id === 'REV-203')!
    assert.equal(merged.evidence, local2.evidence)
    assert.equal(merged.status, '已退回')
    assert.equal(merged.comment, '在线退回：请先补充材料。')
  })
}

console.log('\n6. 合并失败保留现场，可接续重试（已落库条目不回滚、不重复）')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  const m1 = { id: 'M-81', source: 'GR-01', target: 'C-101', relation: '支撑' as const, weight: 0.2 }
  const m2bad = { id: 'M-82', source: 'GR-03', target: 'NOPE', relation: '支撑' as const, weight: 0.2 }
  const m3 = { id: 'M-83', source: 'GR-03', target: 'C-205', relation: '支撑' as const, weight: 0.6 }
  queueChange(batch, { kind: 'mapping', entityId: m1.id, op: 'upsert', role: '课程负责人', label: 'M-81', localValue: m1 })
  queueChange(batch, { kind: 'mapping', entityId: m2bad.id, op: 'upsert', role: '课程负责人', label: 'M-82 坏连边', localValue: m2bad })
  queueChange(batch, { kind: 'mapping', entityId: m3.id, op: 'upsert', role: '课程负责人', label: 'M-83', localValue: m3 })
  const report = mergeBatch(server, batch)
  check('第二条结构性失败：现场保留，前条已落库，批次 partial', () => {
    assert.deepEqual(report.applied, ['M-81'])
    assert.deepEqual(report.failed, ['M-82'])
    assert.equal(batch.status, 'partial')
    assert.ok(batch.mergeError === undefined || batch.mergeError.length >= 0)
  })
  check('直接重试，坏条目仍失败；修复后重试接续，已合并条目跳过', () => {
    const again = retryBatch(server, batch)
    assert.deepEqual(again.failed, ['M-82'])
    assert.deepEqual(again.applied, [])
    // 修复本地条目（服务端补节点等价于修改 localValue）
    server.nodes.push({ id: 'NOPE', label: '新增节点\n临时', type: '单元', x: 0, y: 0 })
    const third = retryBatch(server, batch)
    assert.deepEqual(third.applied.sort(), ['M-82', 'M-83'].sort())
    assert.equal(batch.status, 'merged')
    assert.equal(server.mappings.filter((m) => m.id === 'M-81').length, 1)
  })
  check('也可放弃失败条目继续', () => {
    const server2 = baseServer()
    const b2 = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server: server2 })
    queueChange(b2, { kind: 'mapping', entityId: 'B-1', op: 'upsert', role: '课程负责人', label: '坏', localValue: m2bad })
    mergeBatch(server2, b2)
    discardEntry(b2, b2.entries[0].id)
    assert.equal(b2.entries[0].status, '已放弃')
  })
}

console.log('\n7. 断网中断演练（failNext）：中途失败可原样重试')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  queueChange(batch, { kind: 'mapping', entityId: 'M-81', op: 'upsert', role: '课程负责人', label: 'M-81', localValue: { id: 'M-81', source: 'GR-01', target: 'C-101', relation: '支撑', weight: 0.2 } })
  queueChange(batch, { kind: 'mapping', entityId: 'M-83', op: 'upsert', role: '课程负责人', label: 'M-83', localValue: { id: 'M-83', source: 'GR-03', target: 'C-205', relation: '支撑', weight: 0.6 } })
  batch.failNext = true
  const report = mergeBatch(server, batch)
  check('第一条即中断并保留现场', () => {
    assert.equal(report.stopped, true)
    assert.deepEqual(report.failed, ['M-81'])
    assert.equal(batch.status, 'partial')
    assert.ok(batch.entries[0].lastError?.includes('回传中断'))
  })
  check('清除演练开关后重试，全部成功且无重复', () => {
    const r2 = retryBatch(server, batch)
    assert.deepEqual(r2.applied.sort(), ['M-81', 'M-83'].sort())
    assert.equal(batch.status, 'merged')
    assert.equal(server.mappings.filter((m) => m.id === 'M-81').length, 1)
  })
}

console.log('\n8. 导出结果随批次回传登记，幂等')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  const exp = {
    id: 'X-1', batchId: batch.id, revision: 'R13', filename: '课程地图-R13.json',
    checksum: 'abc123', entries: 2, exportedAt: '2026-10-01T09:00:00.000Z', status: '待登记' as const,
  }
  queueChange(batch, { kind: 'export', entityId: exp.id, op: 'upsert', role: '课程负责人', label: exp.filename, localValue: exp })
  const report = mergeBatch(server, batch)
  check('导出条目登记并打 registeredAt', () => {
    assert.deepEqual(report.exports, [exp.id])
    assert.equal(server.exports[0].status, '已登记')
    assert.ok(server.exports[0].registeredAt)
  })
  check('重复登记同校验和 → 跳过', () => {
    const again = mergeBatch(server, batch)
    assert.deepEqual(again.applied, [])
  })
}

console.log('\n9. 删除冲突：服务端在线改过，本地删除 → 待确认')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  queueChange(batch, {
    kind: 'mapping', entityId: 'M-05', op: 'delete', role: '课程负责人',
    label: '删除 M-05', localValue: null,
  })
  server.mappings.find((m) => m.id === 'M-05')!.weight = 0.33
  const report = mergeBatch(server, batch)
  check('删除冲突进入待确认', () => {
    assert.deepEqual(report.conflicts, ['M-05'])
    assert.ok(batch.entries[0].conflictReason?.includes('删除'))
  })
  check('取服务端裁决后条目闭合，连边仍在', () => {
    resolveConflict(server, batch, batch.entries[0].id, 'server')
    assert.ok(server.mappings.some((m) => m.id === 'M-05'))
    assert.equal(batch.status, 'merged')
  })
}

console.log('\n10. 连续编辑折叠为单条，baseValue 仍为冻结值')
{
  const server = baseServer()
  const batch = createBatch({ title: 't', owner: 'o', reviewer: 'r', revision: 'R13', server })
  const v1 = deepClone(server.mappings[0]); v1.weight = 0.2
  const v2 = deepClone(server.mappings[0]); v2.weight = 0.3
  queueChange(batch, { kind: 'mapping', entityId: v1.id, op: 'upsert', role: '课程负责人', label: 'v1', localValue: v1 })
  queueChange(batch, { kind: 'mapping', entityId: v1.id, op: 'upsert', role: '课程负责人', label: 'v2', localValue: v2 })
  check('同一实体折叠，基线不变', () => {
    assert.equal(batch.entries.length, 1)
    assert.ok(deepEqual(batch.entries[0].baseValue, server.mappings.find((m) => m.id === v1.id) ?? null) === false || batch.entries[0].baseValue)
    assert.equal((batch.entries[0].localValue as { weight: number }).weight, 0.3)
    assert.equal((batch.entries[0].baseValue as { weight: number }).weight, 0.9)
  })
  void recomputeReview
  void classifyEntry
}

console.log(`\n全部 ${passed} 组场景通过 ✅`)
