// 修订批次合并引擎（纯函数，不依赖 DOM / Svelte，方便单测）。
//
// 合并模型：每个条目携带 baseValue（建批次时冻结）与 localValue（断网补录值），
// 回网后与服务端当前值做三路比较：
//   - 服务端未动（server == base）            → 直接快进合并
//   - 双方都改（server != base 且 server != local）→ 待确认，保留双方现场
//   - 服务端已独立应用同样结果（server == local）→ 幂等跳过
// 映射 / 证据一旦变化，相关审阅结论归档失效并自动重算建议，旧结论进入 history 可追溯。

import type {
  ActorRole,
  ArchivedDecision,
  Batch,
  ChangeEntry,
  EntityKind,
  FrozenSnapshot,
  GraphNode,
  Mapping,
  MergeReport,
  Op,
  ReviewItem,
  ReviewStatus,
  ServerState,
} from './types'

// ---- 基础工具 ------------------------------------------------------------

export function nowStamp(now: Date = new Date()): string {
  return now.toISOString()
}

/** 稳定指纹：键排序后做 FNV-1a，用于判断审阅依据是否变化 */
export function stableHash(value: unknown): string {
  const json = JSON.stringify(sortKeys(value))
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableHash(a) === stableHash(b)
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}

// ---- 服务端引导 ----------------------------------------------------------

export function createServerState(input: {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviews: ReviewItem[]
}): ServerState {
  const server: ServerState = {
    nodes: deepClone(input.nodes),
    mappings: deepClone(input.mappings),
    reviews: deepClone(input.reviews),
    exports: [],
    history: [],
  }
  // 为已有审阅结论补指纹，并把旧结论登记为可追溯的第一条历史
  server.reviews.forEach((review) => {
    if (review.status === '已附议' || review.status === '已退回') {
      const hash = reviewBasisHash(review, server)
      review.basisHash = hash
      review.reviewer ??= '院系审阅人（历史结论）'
      review.decidedAt ??= '2026-09-20T10:00:00.000Z'
      server.history.push({
        reviewId: review.id,
        status: review.status,
        comment: review.comment,
        reviewer: review.reviewer,
        decidedAt: review.decidedAt,
        basisHash: hash,
        reason: '初始结论（建批次前的历史审阅）',
      })
    }
  })
  return server
}

// ---- 批次建立与冻结 ------------------------------------------------------

export function freezeSnapshot(server: ServerState, revision: string, now = new Date()): FrozenSnapshot {
  return {
    nodes: deepClone(server.nodes),
    mappings: deepClone(server.mappings),
    reviews: deepClone(server.reviews),
    frozenAt: nowStamp(now),
    revision,
  }
}

let batchSeq = 0
export function nextBatchId(now = new Date()): string {
  batchSeq += 1
  return `B-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(batchSeq).padStart(2, '0')}`
}

let entrySeq = 0
export function nextEntryId(): string {
  entrySeq += 1
  return `E-${Date.now().toString(36).toUpperCase()}-${String(entrySeq).padStart(2, '0')}`
}

export type CreateBatchInput = {
  title: string
  owner: string
  reviewer: string
  revision: string
  server: ServerState
  note?: string
  now?: Date
}

export function createBatch(input: CreateBatchInput): Batch {
  const now = input.now ?? new Date()
  return {
    id: nextBatchId(now),
    title: input.title,
    owner: input.owner,
    reviewer: input.reviewer,
    revision: input.revision,
    baseRevision: input.revision,
    createdAt: nowStamp(now),
    status: 'active',
    online: false,
    snapshot: freezeSnapshot(input.server, input.revision, now),
    entries: [],
    note: input.note,
  }
}

// ---- 条目登记（断网照常补录） --------------------------------------------

export type QueueChangeInput = {
  kind: EntityKind
  entityId: string
  op: Op
  role: ActorRole
  label: string
  localValue: unknown
}

export function lookupBase(batch: Batch, kind: EntityKind, entityId: string): unknown {
  if (kind === 'node') return batch.snapshot.nodes.find((item) => item.id === entityId) ?? null
  if (kind === 'mapping') return batch.snapshot.mappings.find((item) => item.id === entityId) ?? null
  if (kind === 'review') return batch.snapshot.reviews.find((item) => item.id === entityId) ?? null
  return null
}

/**
 * 把一次编辑追加为补录条目；同一实体连续编辑折叠为一条，
 * 但 baseValue 始终保持为建批次冻结值，三路比较才不会失真。
 */
export function queueChange(batch: Batch, input: QueueChangeInput, now = new Date()): ChangeEntry {
  const folding = batch.entries.find(
    (entry) =>
      entry.kind === input.kind &&
      entry.entityId === input.entityId &&
      (entry.status === '排队中' || entry.status === '已失败'),
  )
  if (folding) {
    folding.op = input.op
    folding.role = input.role
    folding.label = input.label
    folding.localValue = deepClone(input.localValue)
    folding.updatedAt = nowStamp(now)
    folding.lastError = undefined
    folding.conflictReason = undefined
    if (folding.status === '已失败') {
      // 修改后重新排队，下次合并接续处理
      folding.status = '排队中'
    }
    return folding
  }
  const entry: ChangeEntry = {
    id: nextEntryId(),
    kind: input.kind,
    entityId: input.entityId,
    op: input.op,
    role: input.role,
    label: input.label,
    baseValue: deepClone(lookupBase(batch, input.kind, input.entityId)),
    localValue: deepClone(input.localValue),
    createdAt: nowStamp(now),
    updatedAt: nowStamp(now),
    status: '排队中',
    attempts: 0,
  }
  batch.entries.push(entry)
  return entry
}

// ---- 服务端实体读写 ------------------------------------------------------

export function findEntity(
  server: ServerState,
  kind: EntityKind,
  id: string,
): GraphNode | Mapping | ReviewItem | null {
  if (kind === 'node') return server.nodes.find((item) => item.id === id) ?? null
  if (kind === 'mapping') return server.mappings.find((item) => item.id === id) ?? null
  if (kind === 'review') return server.reviews.find((item) => item.id === id) ?? null
  return null
}

function writeEntity(server: ServerState, kind: EntityKind, value: unknown): void {
  if (kind === 'node') {
    const node = value as GraphNode
    const index = server.nodes.findIndex((item) => item.id === node.id)
    if (index >= 0) server.nodes[index] = deepClone(node)
    else server.nodes.push(deepClone(node))
  } else if (kind === 'mapping') {
    const mapping = value as Mapping
    const index = server.mappings.findIndex((item) => item.id === mapping.id)
    if (index >= 0) server.mappings[index] = deepClone(mapping)
    else server.mappings.push(deepClone(mapping))
  } else if (kind === 'review') {
    const review = value as ReviewItem
    const index = server.reviews.findIndex((item) => item.id === review.id)
    if (index >= 0) server.reviews[index] = deepClone(review)
    else server.reviews.push(deepClone(review))
  }
}

function removeEntity(server: ServerState, kind: EntityKind, id: string): boolean {
  const list = kind === 'node' ? server.nodes : kind === 'mapping' ? server.mappings : server.reviews
  const index = list.findIndex((item) => item.id === id)
  if (index < 0) return false
  list.splice(index, 1)
  return true
}

// ---- 三路分类 ------------------------------------------------------------

export type EntryVerdict = 'clean' | 'fast-forward' | 'noop' | 'conflict'

export function classifyEntry(server: ServerState, entry: ChangeEntry): EntryVerdict {
  if (entry.kind === 'export') return 'clean'
  const current = findEntity(server, entry.kind, entry.entityId)
  if (entry.op === 'delete') {
    if (!current) return 'noop' // 服务端也已删除，幂等
    if (deepEqual(current, entry.baseValue)) return 'clean'
    return 'conflict'
  }
  // upsert
  if (!current) {
    if (entry.baseValue) return 'conflict' // 服务端删除了基线仍存在的实体
    return 'clean' // 新建
  }
  if (deepEqual(current, entry.localValue)) return 'noop' // 服务端已应用同一结果
  if (deepEqual(current, entry.baseValue)) return 'fast-forward'
  return 'conflict'
}

// ---- 审阅依据指纹与失效重算 ----------------------------------------------

export function reviewBasisHash(review: ReviewItem, server: ServerState): string {
  const supports = server.mappings
    .filter((mapping) => mapping.source === review.requirementId && mapping.target === review.courseId)
    .map((mapping) => ({ relation: mapping.relation, weight: mapping.weight }))
  return stableHash({ supports, evidence: review.evidence })
}

/** 受某条连边变更影响的审阅条目（毕业要求 ↔ 课程 的直接支撑对） */
export function reviewsAffectedByMapping(server: ServerState, mapping: Mapping): ReviewItem[] {
  const source = server.nodes.find((node) => node.id === mapping.source)
  const target = server.nodes.find((node) => node.id === mapping.target)
  const affected = new Set<ReviewItem>()
  if (source?.type === '毕业要求' && target?.type === '课程') {
    server.reviews
      .filter((review) => review.requirementId === mapping.source && review.courseId === mapping.target)
      .forEach((review) => affected.add(review))
  }
  // 连到课程节点本身的其它链路（前置/教学/考核）变化，同样影响该课程全部审阅
  ;[mapping.source, mapping.target].forEach((endpoint) => {
    if (server.nodes.find((node) => node.id === endpoint && node.type === '课程')) {
      server.reviews.filter((review) => review.courseId === endpoint).forEach((review) => affected.add(review))
    }
  })
  return [...affected]
}

function archiveDecision(
  server: ServerState,
  review: ReviewItem,
  reason: string,
  when: string,
): ArchivedDecision | null {
  const human = review.status !== '待审阅' && review.reviewer && review.reviewer !== '系统复核'
  if (!human) return null
  const archived: ArchivedDecision = {
    reviewId: review.id,
    status: review.status,
    comment: review.comment,
    reviewer: review.reviewer ?? review.submitter,
    decidedAt: review.decidedAt ?? when,
    basisHash: review.basisHash ?? reviewBasisHash(review, server),
    reason,
  }
  server.history.push(archived)
  return archived
}

/**
 * 依据变化后重算审阅结论：
 * 人工旧结论归档（仍可追溯），系统给出复核建议并置回待审阅。
 */
export function recomputeReview(
  server: ServerState,
  reviewId: string,
  reason: string,
  when = nowStamp(),
): { review: ReviewItem; archived: ArchivedDecision | null; suggestion: string } {
  const review = server.reviews.find((item) => item.id === reviewId)
  if (!review) throw new Error(`审阅条目不存在：${reviewId}`)
  const archived = archiveDecision(server, review, reason, when)

  const supports = server.mappings
    .filter((mapping) => mapping.source === review.requirementId && mapping.target === review.courseId)
    .sort((a, b) => b.weight - a.weight)
  const strongest = supports[0]

  let suggestion: string
  if (supports.length === 0) {
    suggestion = `【自动复核】${reason}：毕业要求到课程的支撑连边缺失，原结论失效，请审阅人重新确认。`
  } else if ((review.evidence ?? '').trim().length < 12) {
    suggestion = `【自动复核】${reason}：保留 ${strongest.id}（权重 ${Math.round(
      strongest.weight * 100,
    )}%）支撑，但证据说明不足 12 字，需补充可核验材料后重新审阅。`
  } else {
    suggestion = `【自动复核】${reason}：依据最新连边重算，最强支撑为 ${strongest.id}（权重 ${Math.round(
      strongest.weight * 100,
    )}%，${supports.length} 条支撑链），证据已更新，请审阅人重新附议或退回。`
  }
  review.status = '待审阅'
  review.comment = suggestion
  review.reviewer = '系统复核'
  review.decidedAt = when
  review.basisHash = reviewBasisHash(review, server)
  return { review, archived, suggestion }
}

/** 审阅人给出新结论：写入状态并登记为一条可追溯的有效结论 */
export function applyReviewerDecision(
  server: ServerState,
  reviewId: string,
  status: Extract<ReviewStatus, '已附议' | '已退回'>,
  comment: string,
  reviewer: string,
  when = nowStamp(),
  reason = '审阅人重新确认',
): ReviewItem {
  const review = server.reviews.find((item) => item.id === reviewId)
  if (!review) throw new Error(`审阅条目不存在：${reviewId}`)
  if (review.status === '已附议' || review.status === '已退回') {
    archiveDecision(server, review, '新结论覆盖旧结论', when)
  }
  review.status = status
  review.comment = comment
  review.reviewer = reviewer
  review.decidedAt = when
  review.basisHash = reviewBasisHash(review, server)
  server.history.push({
    reviewId: review.id,
    status,
    comment,
    reviewer,
    decidedAt: when,
    basisHash: review.basisHash,
    reason,
  })
  return review
}

// ---- 结构校验（连边端点必须存在） ----------------------------------------

export function validateMappingStructural(server: ServerState, mapping: Mapping): string | null {
  if (!server.nodes.some((node) => node.id === mapping.source)) return `连边起点 ${mapping.source} 不存在`
  if (!server.nodes.some((node) => node.id === mapping.target)) return `连边终点 ${mapping.target} 不存在`
  if (mapping.weight < 0 || mapping.weight > 1) return `权重 ${mapping.weight} 越界`
  return null
}

// ---- 单条目应用 ----------------------------------------------------------

type ApplyOutcome =
  | { outcome: 'applied' | 'skipped'; invalidated: string[] }
  | { outcome: 'conflict'; reason: string }
  | { outcome: 'failed'; error: string }

function describeConflict(entry: ChangeEntry, current: unknown): string {
  if (entry.op === 'upsert' && !current && entry.baseValue) return '服务端已删除该条目，本地有修改'
  if (entry.op === 'delete') return '服务端在基线之后改动过该条目，本地要求删除'
  return '双方都改过：课程方与审阅方修改了同一内容'
}

function applyEntry(
  server: ServerState,
  entry: ChangeEntry,
  when: string,
  force = false,
): ApplyOutcome {
  const verdict = classifyEntry(server, entry)
  if (!force && verdict === 'noop') return { outcome: 'skipped', invalidated: [] }
  if (!force && verdict === 'conflict') {
    return { outcome: 'conflict', reason: describeConflict(entry, findEntity(server, entry.kind, entry.entityId)) }
  }

  if (entry.kind === 'export') {
    const local = entry.localValue as ServerState['exports'][number]
    const existing = server.exports.find((item) => item.id === local.id)
    if (existing?.status === '已登记' && existing.checksum === local.checksum) {
      return { outcome: 'skipped', invalidated: [] }
    }
    const record = existing ?? local
    record.status = '已登记'
    record.registeredAt = when
    if (!existing) server.exports.push(deepClone(record))
    return { outcome: 'applied', invalidated: [] }
  }

  const invalidated: string[] = []

  if (entry.op === 'delete') {
    const removed = findEntity(server, entry.kind, entry.entityId)
    removeEntity(server, entry.kind, entry.entityId)
    if (removed && entry.kind === 'mapping') {
      reviewsAffectedByMapping(server, removed as Mapping).forEach((review) => {
        recomputeReview(server, review.id, `连边 ${(removed as Mapping).id} 被删除`, when)
        invalidated.push(review.id)
      })
    }
  } else {
    const value = entry.localValue as GraphNode | Mapping | ReviewItem
    if (entry.kind === 'mapping') {
      const structural = validateMappingStructural(server, value as Mapping)
      if (structural) return { outcome: 'failed', error: structural }
      const before = server.mappings.find((item) => item.id === value.id)
      writeEntity(server, 'mapping', value)
      const changed = !before || !deepEqual(before, value)
      if (changed) {
        reviewsAffectedByMapping(server, value as Mapping).forEach((review) => {
          recomputeReview(server, review.id, `连边 ${value.id} 发生变更`, when)
          invalidated.push(review.id)
        })
      }
    } else if (entry.kind === 'review') {
      const before = server.reviews.find((item) => item.id === value.id)
      const evidenceChanged = before && before.evidence !== (value as ReviewItem).evidence
      writeEntity(server, 'review', value)
      const after = server.reviews.find((item) => item.id === value.id)!
      if (entry.preserveDecision && before) {
        // 字段级裁决：服务端的状态/意见/结论指纹保持有效
        after.status = before.status
        after.comment = before.comment
        after.reviewer = before.reviewer
        after.decidedAt = before.decidedAt
        after.basisHash = reviewBasisHash(after, server)
      } else {
        const isReviewerDecision =
          entry.role === '院系审阅人' && (after.status === '已附议' || after.status === '已退回')
        if (isReviewerDecision) {
          // 审阅人结论本身就是新的有效结论
          after.reviewer = after.reviewer ?? entry.role
          after.decidedAt = when
          after.basisHash = reviewBasisHash(after, server)
          const duplicated = server.history.some(
            (item) =>
              item.reviewId === after.id &&
              item.status === after.status &&
              item.comment === after.comment &&
              item.decidedAt === when,
          )
          if (!duplicated) {
            server.history.push({
              reviewId: after.id,
              status: after.status,
              comment: after.comment,
              reviewer: after.reviewer ?? entry.role,
              decidedAt: when,
              basisHash: after.basisHash,
              reason: '审阅人断网期间给出的结论，回网合并',
            })
          }
        } else if (
          before &&
          (before.status === '已附议' || before.status === '已退回') &&
          (evidenceChanged || !deepEqual(scrubDecision(before), scrubDecision(after)))
        ) {
          recomputeReview(server, after.id, '证据内容被课程方修改', when)
          invalidated.push(after.id)
        } else {
          after.basisHash = reviewBasisHash(after, server)
        }
      }
    } else {
      writeEntity(server, entry.kind, value)
    }
  }

  return { outcome: 'applied', invalidated }
}

function scrubDecision(review: ReviewItem) {
  const { status: _s, comment: _c, reviewer: _r, decidedAt: _d, basisHash: _h, ...rest } = review
  return rest
}

// ---- 整批合并（可中断、可重试、现场保留） --------------------------------

export function mergeBatch(server: ServerState, batch: Batch, now = new Date()): MergeReport {
  const when = nowStamp(now)
  const report: MergeReport = { applied: [], conflicts: [], failed: [], skipped: [], invalidated: [], exports: [], stopped: false }
  batch.online = true
  batch.status = 'merging'
  batch.mergeError = undefined

  for (const entry of batch.entries) {
    if (entry.status === '已合并' || entry.status === '已放弃') continue
    if (entry.status === '待确认') continue // 冲突必须人工处理，不自动重试

    // 演练用：failNext 为真时下一条必失败，已应用的条目不回滚 —— 现场原样保留
    if (batch.failNext) {
      batch.failNext = false
      entry.status = '已失败'
      entry.attempts += 1
      entry.lastError = '回传中断：服务端暂不可用（合并失败演练，现场已保留，可直接重试）'
      report.failed.push(entry.entityId)
      report.stopped = true
      batch.status = 'partial'
      batch.mergeError = `合并在 ${entry.label}（${entry.id}）处中断，之前条目已落库，可点击重试继续。`
      finalizeStatus(batch)
      return report
    }

    entry.attempts += 1
    const invalidatedBefore = new Map(server.reviews.map((review) => [review.id, review.status]))
    const result = applyEntry(server, entry, when)
    if (result.outcome === 'conflict') {
      entry.status = '待确认'
      entry.conflictReason = result.reason
      entry.lastError = undefined
      report.conflicts.push(entry.entityId)
    } else if (result.outcome === 'failed') {
      entry.status = '已失败'
      entry.lastError = result.error
      report.failed.push(entry.entityId)
      report.stopped = true
      // 失败即停：后续条目保持排队，现场原样保留，修复后从下一条接续重试
      batch.status = 'partial'
      batch.mergeError = `合并在 ${entry.label}（${entry.entityId}）处中断：${result.error}。之前条目已落库，可直接重试接续。`
      finalizeStatus(batch)
      return report
    } else if (result.outcome === 'skipped') {
      entry.status = '已合并'
      entry.conflictReason = undefined
      entry.lastError = undefined
      entry.mergedAt = when
      report.skipped.push(entry.entityId)
    } else {
      entry.status = '已合并'
      entry.conflictReason = undefined
      entry.lastError = undefined
      entry.mergedAt = when
      report.applied.push(entry.entityId)
      if (entry.kind === 'export') report.exports.push(entry.entityId)
      result.invalidated.forEach((reviewId) => {
        const from = invalidatedBefore.get(reviewId) ?? '待审阅'
        if (!report.invalidated.some((item) => item.reviewId === reviewId)) {
          report.invalidated.push({ reviewId, fromStatus: from, reason: '映射或证据已变更' })
        }
      })
    }
  }

  batch.lastMergeAt = when
  finalizeStatus(batch)
  return report
}

export function finalizeStatus(batch: Batch): void {
  const pending = batch.entries.filter(
    (entry) => entry.status === '排队中' || entry.status === '已失败' || entry.status === '待确认',
  )
  if (pending.length === 0) {
    batch.status = batch.entries.length > 0 ? 'merged' : 'active'
  } else {
    const anyProgress = batch.entries.some((entry) => entry.status === '已合并' || entry.status === '已放弃')
    batch.status = anyProgress || batch.status === 'partial' || batch.status === 'failed' ? 'partial' : 'active'
  }
}

// ---- 冲突人工裁决 --------------------------------------------------------

export type Resolution = 'local' | 'server' | 'merge-fields'

export function resolveConflict(
  server: ServerState,
  batch: Batch,
  entryId: string,
  resolution: Resolution,
  now = new Date(),
): MergeReport {
  const when = nowStamp(now)
  const report: MergeReport = { applied: [], conflicts: [], failed: [], skipped: [], invalidated: [], exports: [], stopped: false }
  const entry = batch.entries.find((item) => item.id === entryId)
  if (!entry || entry.status !== '待确认') return report

  const current = findEntity(server, entry.kind, entry.entityId)
  let chosen: ChangeEntry = entry
  if (resolution === 'server') {
    // 以服务端为准：把当前服务端值固化为本地结果，直接落库（无写入），仅闭合条目
    entry.localValue = deepClone(current)
    entry.op = 'upsert'
    entry.status = '已合并'
    entry.mergedAt = when
    entry.conflictReason = undefined
    report.skipped.push(entry.entityId)
  } else {
    if (resolution === 'merge-fields' && entry.kind === 'review' && current) {
      // 字段级合并：课程方的证据 + 审阅人的状态/意见，双方修改都保留
      const mergedReview: ReviewItem = {
        ...(deepClone(current) as ReviewItem),
        evidence: (entry.localValue as ReviewItem).evidence,
      }
      entry.localValue = mergedReview
      entry.preserveDecision = true
    }
    chosen = entry
    // 人工裁决：绕过三路冲突判定，按选定结果强制落库
    const result = applyEntry(server, chosen, when, true)
    if (result.outcome === 'failed') {
      entry.status = '已失败'
      entry.lastError = result.error
      report.failed.push(entry.id)
      finalizeStatus(batch)
      return report
    }
    entry.status = '已合并'
    entry.conflictReason = undefined
    entry.lastError = undefined
    entry.mergedAt = when
    report.applied.push(entry.entityId)
    if ('invalidated' in result && result.outcome === 'applied') {
      result.invalidated.forEach((reviewId) =>
        report.invalidated.push({ reviewId, fromStatus: '已附议', reason: '冲突裁决后依据变化' }),
      )
    }
  }
  batch.lastMergeAt = when
  finalizeStatus(batch)
  return report
}

/** 放弃无法处理的失败/冲突条目（其余现场不受影响，批次可继续） */
export function discardEntry(batch: Batch, entryId: string): void {
  const entry = batch.entries.find((item) => item.id === entryId)
  if (!entry) return
  if (entry.status === '待确认' || entry.status === '已失败' || entry.status === '排队中') {
    entry.status = '已放弃'
    entry.conflictReason = undefined
    finalizeStatus(batch)
  }
}

/** 重试：失败条目恢复排队后重新整批合并（已合并条目幂等跳过，现场接续） */
export function retryBatch(server: ServerState, batch: Batch, now = new Date()): MergeReport {
  batch.entries.forEach((entry) => {
    if (entry.status === '已失败') entry.status = '排队中'
  })
  return mergeBatch(server, batch, now)
}
