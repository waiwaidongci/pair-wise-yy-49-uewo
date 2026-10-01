import type { GraphNode, Mapping, ReviewItem, Actor } from './seed'

export type { Actor, ConclusionRecord } from './seed'

export type ChangeOp = 'add' | 'update' | 'remove'
export type ChangeStatus = 'pending' | 'merged' | 'conflict'
export type ItemType = 'node' | 'mapping' | 'review'

export type Change = {
  id: string
  batchId: string
  actor: Actor
  itemType: ItemType
  itemId: string
  op: ChangeOp
  before: unknown | null
  after: unknown | null
  at: string
  status: ChangeStatus
}

export type BatchBase = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
}

export type Batch = {
  id: string
  revision: string
  createdAt: string
  base: BatchBase
  status: 'open' | 'merged'
  upgraded?: boolean
}

export type ExportRecord = {
  id: string
  batchId: string
  filename: string
  exportedAt: string
}

export type ConflictItem = {
  key: string
  itemType: ItemType
  itemId: string
  ownerChange: Change | null
  reviewerChange: Change | null
}

export type Invalidation = {
  reviewId: string
  reason: string
  at: string
}

export type MergeRound = {
  at: string
  applied: number
  conflicts: number
  invalidations: number
}

export type MergeResult = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  applied: Change[]
  conflicts: ConflictItem[]
  invalidations: Invalidation[]
  mergedAt: string
}

export function newBatchId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `B-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function newChangeId(d = new Date()): string {
  return `CHG-${d.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function newExportId(d = new Date()): string {
  return `EXP-${d.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function freezeBase(base: BatchBase): BatchBase {
  return structuredClone({ nodes: base.nodes, mappings: base.mappings, reviewItems: base.reviewItems })
}

export function makeBatch(state: BatchBase & { revision: string }, upgraded = false): Batch {
  return {
    id: newBatchId(),
    revision: state.revision,
    createdAt: new Date().toISOString(),
    base: freezeBase(state),
    status: 'open',
    upgraded,
  }
}

export function makeLegacyBatch(state: BatchBase & { revision: string }): Batch {
  return { ...makeBatch(state, true), id: `B-LEGACY-${state.revision || 'DRAFT'}` }
}

type ItemMaps = {
  nodes: Map<string, GraphNode>
  mappings: Map<string, Mapping>
  reviewItems: Map<string, ReviewItem>
}

function buildMaps(base: BatchBase): ItemMaps {
  return {
    nodes: new Map(base.nodes.map((n) => [n.id, structuredClone(n)])),
    mappings: new Map(base.mappings.map((m) => [m.id, structuredClone(m)])),
    reviewItems: new Map(base.reviewItems.map((r) => [r.id, structuredClone(r)])),
  }
}

function applyValue(maps: ItemMaps, itemType: ItemType, itemId: string, value: unknown, remove: boolean) {
  if (remove || value == null) {
    if (itemType === 'node') maps.nodes.delete(itemId)
    else if (itemType === 'mapping') maps.mappings.delete(itemId)
    else maps.reviewItems.delete(itemId)
    return
  }
  if (itemType === 'node') maps.nodes.set(itemId, structuredClone(value as GraphNode))
  else if (itemType === 'mapping') maps.mappings.set(itemId, structuredClone(value as Mapping))
  else maps.reviewItems.set(itemId, structuredClone(value as ReviewItem))
}

/**
 * 按条目合并：以冻结批次为基线，同一_item_只被一方修改时采用该方版本，
 * 双方都修改时列入待确认冲突（保留基线值，不覆盖）。
 * newChanges 用于本轮失效重算，避免历史变更重复触发。
 */
export function mergeBatch(
  base: BatchBase,
  changes: Change[],
  resolutions: Record<string, unknown> = {},
  at: string = new Date().toISOString(),
  newChanges: Change[] = changes,
): MergeResult {
  const maps = buildMaps(base)
  const groups = new Map<string, Change[]>()
  for (const ch of changes) {
    const key = `${ch.itemType}:${ch.itemId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(ch)
  }

  const conflicts: ConflictItem[] = []
  const applied: Change[] = []
  const appliedIds = new Set<string>()

  for (const [key, group] of groups) {
    const [itemType, itemId] = key.split(':') as [ItemType, string]
    const ownerChanges = group.filter((c) => c.actor === 'owner')
    const reviewerChanges = group.filter((c) => c.actor === 'reviewer')
    const lastOwner = ownerChanges[ownerChanges.length - 1] ?? null
    const lastReviewer = reviewerChanges[reviewerChanges.length - 1] ?? null

    if (key in resolutions) {
      applyValue(maps, itemType, itemId, resolutions[key], false)
      const winner = lastOwner ?? lastReviewer
      if (winner) {
        applied.push(winner)
        appliedIds.add(winner.id)
      }
      continue
    }

    if (lastOwner && lastReviewer) {
      conflicts.push({ key, itemType, itemId, ownerChange: lastOwner, reviewerChange: lastReviewer })
      continue
    }

    const winner = lastOwner ?? lastReviewer
    if (!winner) continue
    applyValue(maps, itemType, itemId, winner.after, winner.op === 'remove')
    applied.push(winner)
    appliedIds.add(winner.id)
  }

  const invalidations = invalidateConclusions(base, maps, newChanges.filter((c) => appliedIds.has(c.id)), at)

  return {
    nodes: [...maps.nodes.values()],
    mappings: [...maps.mappings.values()],
    reviewItems: [...maps.reviewItems.values()],
    applied,
    conflicts,
    invalidations,
    mergedAt: at,
  }
}

/**
 * 映射或证据一变，审阅结论失效重算：旧结论（状态、意见、时间、操作人）
 * 转入 conclusionHistory 保留追溯，条目回到待审阅。
 */
function invalidateConclusions(base: BatchBase, maps: ItemMaps, newlyApplied: Change[], at: string): Invalidation[] {
  const result: Invalidation[] = []
  for (const review of maps.reviewItems.values()) {
    const baseReview = base.reviewItems.find((r) => r.id === review.id)
    if (!baseReview) continue

    const lastReviewed = review.reviewedEvidence ?? baseReview.evidence
    const evidenceChanged = review.evidence !== lastReviewed
    const mappingTouched = newlyApplied.some((c) => {
      if (c.itemType !== 'mapping') return false
      const after = c.after as Mapping | null
      const before = c.before as Mapping | null
      const source = after?.source ?? before?.source
      const target = after?.target ?? before?.target
      return (
        (source === review.requirementId && target === review.courseId) ||
        (source === review.courseId && target === review.requirementId)
      )
    })

    if ((evidenceChanged || mappingTouched) && review.status !== '待审阅') {
      const reason = evidenceChanged ? '证据已修改，原审阅结论失效，需重新审阅' : '相关映射已调整，原审阅结论失效，需重新审阅'
      const record = {
        status: review.status,
        comment: review.comment,
        decidedAt: review.decidedAt ?? baseReview.decidedAt ?? at,
        decidedBy: review.decidedBy ?? baseReview.decidedBy ?? ('reviewer' as Actor),
        invalidatedAt: at,
        reason,
      }
      review.conclusionHistory = [...(review.conclusionHistory ?? []), record]
      review.status = '待审阅'
      review.comment = ''
      review.decidedAt = undefined
      review.decidedBy = undefined
      review.reviewedEvidence = undefined
      result.push({ reviewId: review.id, reason, at })
    }
  }
  return result
}
