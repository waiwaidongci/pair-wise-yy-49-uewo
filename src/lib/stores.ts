import { writable } from 'svelte/store'
import { browser } from '$app/environment'
import { seedState } from './seed'
import {
  applyReviewerDecision,
  createBatch,
  deepClone,
  deepEqual,
  discardEntry as engineDiscardEntry,
  lookupBase,
  mergeBatch,
  queueChange,
  recomputeReview,
  resolveConflict,
  retryBatch,
  stableHash,
} from './batch/engine'
import type {
  ActorRole,
  Batch,
  ChangeEntry,
  EntityKind,
  ExportRecord,
  GraphNode,
  Mapping,
  MergeReport,
  Op,
  ReviewItem,
  ReviewStatus,
  ServerState,
} from './batch/types'

const STORAGE_KEY = 'curriculum-revision-batches-v2'
const LEGACY_KEY = 'curriculum-map-draft-v1'

export type PersistState = {
  version: 2
  server: ServerState
  batches: Batch[]
  activeBatchId: string | null
  revision: string
  locked: boolean
  draft: string
  migratedFromV1: boolean
}

export type CurriculumView = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  exports: ExportRecord[]
  history: ServerState['history']
}

type LastReport = { report: MergeReport | null; at: string }

// ---- 持久化与旧草稿升级 ---------------------------------------------------

function buildFreshPersist(): PersistState {
  const server: ServerState = {
    nodes: deepClone(seedState.nodes),
    mappings: deepClone(seedState.mappings),
    reviews: deepClone(seedState.reviewItems),
    exports: [],
    history: [],
  }
  bootstrapSeedHistory(server)
  return {
    version: 2,
    server,
    batches: [],
    activeBatchId: null,
    revision: seedState.revision,
    locked: false,
    draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    migratedFromV1: false,
  }
}

/** 种子里已附议的旧结论补指纹 + 历史条目（与引擎 createServerState 保持一致） */
function bootstrapSeedHistory(server: ServerState) {
  server.reviews.forEach((review) => {
    if (review.status === '已附议' || review.status === '已退回') {
      const supports = server.mappings
        .filter((mapping) => mapping.source === review.requirementId && mapping.target === review.courseId)
        .map((mapping) => ({ relation: mapping.relation, weight: mapping.weight }))
      review.basisHash = stableHash({ supports, evidence: review.evidence })
      review.reviewer ??= '院系审阅人（历史结论）'
      review.decidedAt ??= '2026-09-20T10:00:00.000Z'
      server.history.push({
        reviewId: review.id,
        status: review.status,
        comment: review.comment,
        reviewer: review.reviewer,
        decidedAt: review.decidedAt,
        basisHash: review.basisHash,
        reason: '初始结论（建批次前的历史审阅）',
      })
    }
  })
}

type LegacyDraft = {
  nodes?: GraphNode[]
  mappings?: Mapping[]
  reviewItems?: ReviewItem[]
  revision?: string
  locked?: boolean
  draft?: string
}

/**
 * 旧草稿没有批次号：首次打开时兼容升级——
 * 以种子为服务端基线建一个「旧草稿升级」批次，只对旧草稿中「确实包含且与基线不同」
 * 的对象逐条生成补录条目（旧草稿可能只持久化了部分数组，缺省即视为沿用基线，不建条目），
 * 并立即回传合并；随后删除 v1 键，避免重复升级。
 */
function upgradeLegacyDraft(legacy: LegacyDraft, base: PersistState): PersistState {
  const next = deepClone(base)
  const batch = createBatch({
    title: '旧草稿兼容升级',
    owner: '课程负责人（旧草稿）',
    reviewer: '院系审阅人（旧草稿）',
    revision: legacy.revision ?? next.revision,
    server: next.server,
    note: '该批次由无批次号的本地旧草稿自动升级生成，条目为旧草稿相对系统基线的差异。',
  })
  batch.online = true // 旧草稿是本机既有数据，直接具备合并条件

  legacy.nodes?.forEach((node) => {
    const baseNode = next.server.nodes.find((item) => item.id === node.id)
    if (baseNode && !deepEqual(baseNode, node)) {
      queueChange(batch, {
        kind: 'node',
        entityId: node.id,
        op: 'upsert',
        role: '课程负责人',
        label: `节点 ${node.id} 位置/信息`,
        localValue: node,
      })
    }
  })
  legacy.mappings?.forEach((mapping) => {
    const baseMapping = next.server.mappings.find((item) => item.id === mapping.id)
    if (!baseMapping || !deepEqual(baseMapping, mapping)) {
      // 基线里不存在（旧草稿新增）或确实不同才建条目；端点缺失的坏数据忽略
      const endpointsExist =
        next.server.nodes.some((item) => item.id === mapping.source) &&
        next.server.nodes.some((item) => item.id === mapping.target)
      if (endpointsExist) {
        queueChange(batch, {
          kind: 'mapping',
          entityId: mapping.id,
          op: 'upsert',
          role: '课程负责人',
          label: `连边 ${mapping.id}（${mapping.relation}）`,
          localValue: mapping,
        })
      }
    }
  })
  legacy.reviewItems?.forEach((review) => {
    const baseReview = next.server.reviews.find((item) => item.id === review.id)
    if (baseReview && !deepEqual(scrubSystem(review), scrubSystem(baseReview))) {
      queueChange(batch, {
        kind: 'review',
        entityId: review.id,
        op: 'upsert',
        role: review.status === '待审阅' ? '课程负责人' : '院系审阅人',
        label: `审阅 ${review.id}`,
        localValue: { ...review, stale: undefined },
      })
    }
  })

  next.revision = legacy.revision ?? next.revision
  next.locked = legacy.locked ?? false
  if (legacy.draft) next.draft = legacy.draft
  // 旧草稿是本机既有数据，立即按条目合并进权威状态；批次与条目仍保留供追溯
  if (batch.entries.length > 0) mergeBatch(next.server, batch)
  next.batches.push(batch)
  next.activeBatchId = batch.id
  next.migratedFromV1 = true
  return next
}

function scrubFrontend(review: ReviewItem) {
  const { stale: _s, ...rest } = review
  return rest
}

/** 升级比较时只看业务字段，忽略系统补充的指纹/结论时间/复核人 */
function scrubSystem(review: ReviewItem) {
  const { basisHash: _b, decidedAt: _d, reviewer: _r, stale: _s, ...rest } = review
  return rest
}

function loadPersist(): PersistState {
  if (!browser) return buildFreshPersist()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PersistState
      if (parsed.version === 2 && parsed.server && Array.isArray(parsed.batches)) return parsed
    }
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    const fresh = buildFreshPersist()
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as LegacyDraft
      const upgraded = upgradeLegacyDraft(legacy, fresh)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(upgraded))
      localStorage.removeItem(LEGACY_KEY)
      return upgraded
    }
    return fresh
  } catch {
    return buildFreshPersist()
  }
}

// ---- 工作视图：服务端权威状态 + 活跃批次未合并的本地补录叠加 -------------

function buildView(state: PersistState): CurriculumView {
  const server = state.server
  const batch = state.batches.find((item) => item.id === state.activeBatchId && item.status !== 'merged')
  const view: CurriculumView = {
    nodes: deepClone(server.nodes),
    mappings: deepClone(server.mappings),
    reviewItems: deepClone(server.reviews),
    exports: deepClone(server.exports),
    history: server.history,
  }
  if (!batch) return view

  batch.entries
    .filter((entry) => entry.status === '排队中' || entry.status === '已失败' || entry.status === '待确认')
    .forEach((entry) => {
      if (entry.kind === 'node') {
        if (entry.op === 'delete') {
          view.nodes = view.nodes.filter((item) => item.id !== entry.entityId)
        } else {
          const value = entry.localValue as GraphNode
          const index = view.nodes.findIndex((item) => item.id === entry.entityId)
          if (index >= 0) view.nodes[index] = deepClone(value)
          else view.nodes.push(deepClone(value))
        }
      } else if (entry.kind === 'mapping') {
        if (entry.op === 'delete') {
          view.mappings = view.mappings.filter((item) => item.id !== entry.entityId)
        } else {
          const value = entry.localValue as Mapping
          const index = view.mappings.findIndex((item) => item.id === entry.entityId)
          if (index >= 0) view.mappings[index] = deepClone(value)
          else view.mappings.push(deepClone(value))
        }
      } else if (entry.kind === 'review') {
        const value = entry.localValue as ReviewItem
        const index = view.reviewItems.findIndex((item) => item.id === entry.entityId)
        if (index >= 0) view.reviewItems[index] = deepClone(value)
        else view.reviewItems.push(deepClone(value))
      }
    })

  // 本地映射/证据已经动过但尚未回网，相关结论在视图上标记 stale（回网后真正归档重算）
  const touchedRequirements = new Set<string>()
  const touchedCourses = new Set<string>()
  batch.entries
    .filter((entry) => entry.kind === 'mapping' && entry.op === 'upsert' && (entry.status === '排队中' || entry.status === '已失败'))
    .forEach((entry) => {
      const mapping = entry.localValue as Mapping
      const from = server.nodes.find((node) => node.id === mapping.source)
      const to = server.nodes.find((node) => node.id === mapping.target)
      if (from?.type === '毕业要求' && to?.type === '课程') touchedRequirements.add(`${mapping.source}::${mapping.target}`)
      if (to?.type === '课程') touchedCourses.add(mapping.target)
      if (from?.type === '课程') touchedCourses.add(mapping.source)
    })
  view.reviewItems.forEach((review) => {
    const directChanged = touchedRequirements.has(`${review.requirementId}::${review.courseId}`)
    const chainChanged = touchedCourses.has(review.courseId)
    const evidenceChanged = batch.entries.some(
      (entry) =>
        entry.kind === 'review' &&
        entry.entityId === review.id &&
        entry.op === 'upsert' &&
        (entry.status === '排队中' || entry.status === '已失败') &&
        (entry.localValue as ReviewItem).evidence !== (lookupBase(batch, 'review', review.id) as ReviewItem | null)?.evidence,
    )
    if ((directChanged || chainChanged || evidenceChanged) && review.status !== '待审阅') {
      review.stale = true
    }
  })
  return view
}

// ---- Store ---------------------------------------------------------------

export type CurriculumStoreState = PersistState & {
  view: CurriculumView
  activeBatch: Batch | null
  online: boolean
  pendingCount: number
  conflictCount: number
  failedCount: number
  lastReport: LastReport | null
}

function derive(state: PersistState, lastReport: LastReport | null): CurriculumStoreState {
  const activeBatch = state.batches.find((batch) => batch.id === state.activeBatchId) ?? null
  return {
    ...state,
    view: buildView(state),
    activeBatch,
    online: activeBatch ? activeBatch.online : true,
    pendingCount: activeBatch
      ? activeBatch.entries.filter((entry) => entry.status === '排队中' || entry.status === '已失败').length
      : 0,
    conflictCount: activeBatch
      ? activeBatch.entries.filter((entry) => entry.status === '待确认').length
      : 0,
    failedCount: activeBatch ? activeBatch.entries.filter((entry) => entry.status === '已失败').length : 0,
    lastReport,
  }
}

let persist = loadPersist()
let lastReport: LastReport | null = null
const internal = writable<CurriculumStoreState>(derive(persist, lastReport))

function commit(next: PersistState) {
  persist = next
  if (browser) localStorage.setItem(STORAGE_KEY, JSON.stringify(persist))
  internal.set(derive(persist, lastReport))
}

function mutate(fn: (draft: PersistState) => void) {
  const draft = deepClone(persist)
  fn(draft)
  commit(draft)
}

function setReport(report: MergeReport | null) {
  lastReport = report ? { report, at: new Date().toISOString() } : null
  internal.set(derive(persist, lastReport))
}

function ensureActiveBatch(draft: PersistState): Batch {
  let batch = draft.batches.find((item) => item.id === draft.activeBatchId)
  if (!batch || batch.status === 'merged') {
    // 已全部合并的批次不再接收补录，自动开一个接续批次（基线为最新服务端状态）
    draft.revision = bumpRevision(draft.revision)
    batch = createBatch({
      title: `修订批次 ${draft.revision}`,
      owner: batch?.owner ?? '课程负责人',
      reviewer: batch?.reviewer ?? '院系审阅人',
      revision: draft.revision,
      server: draft.server,
      note: batch ? `接续批次，上一批次 ${batch.id} 已合并。` : undefined,
    })
    draft.batches.push(batch)
    draft.activeBatchId = batch.id
  }
  return batch
}

function bumpRevision(revision: string): string {
  const num = Number(revision.slice(1))
  return `R${Number.isFinite(num) ? num + 1 : Date.now()}`
}

type QueueOptions = { kind: EntityKind; entityId: string; op: Op; role: ActorRole; label: string; value: unknown }

function enqueue(draft: PersistState, options: QueueOptions) {
  const batch = ensureActiveBatch(draft)
  const entry = queueChange(batch, {
    kind: options.kind,
    entityId: options.entityId,
    op: options.op,
    role: options.role,
    label: options.label,
    localValue: options.value,
  })
  return { batch, entry }
}

// ---- 对外 API ------------------------------------------------------------

export const curriculumStore = {
  subscribe: internal.subscribe,

  // 批次生命周期
  createRevisionBatch(input: { title: string; owner: string; reviewer: string; revision?: string; note?: string }) {
    mutate((draft) => {
      if (input.revision) draft.revision = input.revision
      const batch = createBatch({
        title: input.title,
        owner: input.owner,
        reviewer: input.reviewer,
        revision: draft.revision,
        server: draft.server,
        note: input.note,
      })
      draft.batches.push(batch)
      draft.activeBatchId = batch.id
    })
  },
  activateBatch(id: string | null) {
    mutate((draft) => {
      draft.activeBatchId = id
    })
  },
  setOnline(online: boolean) {
    mutate((draft) => {
      const batch = draft.batches.find((item) => item.id === draft.activeBatchId)
      if (batch) batch.online = online
    })
  },
  goOnlineAndMerge(): MergeReport {
    let report: MergeReport | null = null
    mutate((draft) => {
      const batch = ensureActiveBatch(draft)
      report = mergeBatch(draft.server, batch)
    })
    setReport(report)
    return report!
  },
  retryMerge(): MergeReport {
    let report: MergeReport | null = null
    mutate((draft) => {
      const batch = draft.batches.find((item) => item.id === draft.activeBatchId)
      if (batch) report = retryBatch(draft.server, batch)
    })
    setReport(report)
    return report!
  },
  resolveEntry(entryId: string, resolution: 'local' | 'server' | 'merge-fields'): MergeReport {
    let report: MergeReport | null = null
    mutate((draft) => {
      const batch = draft.batches.find((item) => item.id === draft.activeBatchId)
      if (batch) report = resolveConflict(draft.server, batch, entryId, resolution)
    })
    setReport(report)
    return report!
  },
  discardEntry(entryId: string) {
    mutate((draft) => {
      const batch = draft.batches.find((item) => item.id === draft.activeBatchId)
      if (batch) engineDiscardEntry(batch, entryId)
    })
  },
  /** 演练：让下一次合并在下一条目处中断 */
  armFailure() {
    mutate((draft) => {
      const batch = draft.batches.find((item) => item.id === draft.activeBatchId)
      if (batch) batch.failNext = true
    })
  },

  // 课程、节点（连边/审阅以外的地图编辑同样进入批次）
  moveNode(id: string, x: number, y: number) {
    mutate((draft) => {
      const current = lookupLiveOrBase(draft, 'node', id) as GraphNode | null
      if (!current) return
      enqueue(draft, {
        kind: 'node',
        entityId: id,
        op: 'upsert',
        role: '课程负责人',
        label: `移动节点 ${id}`,
        value: { ...current, x, y },
      })
    })
  },

  // 映射（连边）
  addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
    if (source === target) return
    mutate((draft) => {
      const id = `M-${Date.now().toString(36).toUpperCase()}`
      const mapping: Mapping = { id, source, target, relation, weight }
      enqueue(draft, {
        kind: 'mapping',
        entityId: id,
        op: 'upsert',
        role: '课程负责人',
        label: `新增连边 ${source} → ${target}`,
        value: mapping,
      })
    })
  },
  updateMapping(id: string, patch: Partial<Omit<Mapping, 'id'>>) {
    mutate((draft) => {
      const current = lookupLiveOrBase(draft, 'mapping', id) as Mapping | undefined
      if (!current) return
      enqueue(draft, {
        kind: 'mapping',
        entityId: id,
        op: 'upsert',
        role: '课程负责人',
        label: `修改连边 ${id}`,
        value: { ...current, ...patch },
      })
    })
  },
  deleteMapping(id: string) {
    mutate((draft) => {
      const current = lookupLiveOrBase(draft, 'mapping', id)
      if (!current) return
      enqueue(draft, {
        kind: 'mapping',
        entityId: id,
        op: 'delete',
        role: '课程负责人',
        label: `删除连边 ${id}`,
        value: null,
      })
    })
  },

  // 审阅意见
  updateReview(id: string, status: ReviewStatus, comment: string, reviewer = '院系审阅人') {
    mutate((draft) => {
      const current = lookupLiveOrBase(draft, 'review', id) as ReviewItem | undefined
      if (!current) return
      if (status === '待审阅') {
        enqueue(draft, {
          kind: 'review',
          entityId: id,
          op: 'upsert',
          role: '院系审阅人',
          label: `重置审阅 ${id}`,
          value: { ...current, status, comment },
        })
        return
      }
      enqueue(draft, {
        kind: 'review',
        entityId: id,
        op: 'upsert',
        role: '院系审阅人',
        label: `${status} ${id}`,
        value: { ...current, status, comment, reviewer },
      })
    })
  },
  updateReviewEvidence(id: string, evidence: string) {
    mutate((draft) => {
      const current = lookupLiveOrBase(draft, 'review', id) as ReviewItem | undefined
      if (!current) return
      enqueue(draft, {
        kind: 'review',
        entityId: id,
        op: 'upsert',
        role: '课程负责人',
        label: `补充证据 ${id}`,
        value: { ...current, evidence },
      })
    })
  },
  submitReviewItem(input: {
    courseId: string
    requirementId: string
    evidence: string
    revisionNote: string
    submitter: string
  }) {
    let id = ''
    mutate((draft) => {
      id = `REV-${Date.now().toString().slice(-4)}`
      const review: ReviewItem = {
        id,
        courseId: input.courseId,
        requirementId: input.requirementId,
        evidence: `${input.evidence} 修订说明：${input.revisionNote}`,
        submitter: input.submitter,
        status: '待审阅',
        comment: '',
      }
      enqueue(draft, {
        kind: 'review',
        entityId: id,
        op: 'upsert',
        role: '课程负责人',
        label: `提交修订 ${id}`,
        value: review,
      })
    })
    return id
  },

  // 审阅人在线（服务端）直接复核 —— 模拟另一台设备在线操作，会与断网补录形成三路比较
  onlineReviewDecision(id: string, status: Extract<ReviewStatus, '已附议' | '已退回'>, comment: string, reviewer = '院系审阅人：周岚') {
    mutate((draft) => {
      applyReviewerDecision(draft.server, id, status, comment, reviewer)
    })
  },
  onlineRecomputeReview(id: string, reason: string) {
    mutate((draft) => {
      recomputeReview(draft.server, id, reason)
    })
  },
  /** 模拟审阅方/其它设备在线修改一条连边 */
  onlineUpsertMapping(mapping: Mapping) {
    mutate((draft) => {
      const index = draft.server.mappings.findIndex((item) => item.id === mapping.id)
      if (index >= 0) draft.server.mappings[index] = deepClone(mapping)
      else draft.server.mappings.push(deepClone(mapping))
      // 依据变了，在线结论也立即失效重算
      const affected = new Set<string>()
      draft.server.reviews
        .filter(
          (review) =>
            (review.requirementId === mapping.source && review.courseId === mapping.target) ||
            review.courseId === mapping.target ||
            review.courseId === mapping.source,
        )
        .forEach((review) => {
          if (review.status !== '待审阅') {
            recomputeReview(draft.server, review.id, `在线变更连边 ${mapping.id}`)
            affected.add(review.id)
          }
        })
      void affected
    })
  },
  onlineDeleteMapping(id: string) {
    mutate((draft) => {
      const mapping = draft.server.mappings.find((item) => item.id === id)
      draft.server.mappings = draft.server.mappings.filter((item) => item.id !== id)
      if (mapping) {
        draft.server.reviews
          .filter(
            (review) =>
              (review.requirementId === mapping.source && review.courseId === mapping.target) ||
              review.courseId === mapping.target ||
              review.courseId === mapping.source,
          )
          .forEach((review) => {
            if (review.status !== '待审阅') recomputeReview(draft.server, review.id, `在线删除连边 ${id}`)
          })
      }
    })
  },

  // 导出结果：先生成文件，再作为 export 条目随批次回传登记
  exportMap(filename?: string): { filename: string; content: string; record: ExportRecord } {
    let result!: { filename: string; content: string; record: ExportRecord }
    mutate((draft) => {
      const batch = ensureActiveBatch(draft)
      const view = buildView(draft)
      const content = JSON.stringify(
        {
          batchId: batch.id,
          baseRevision: batch.baseRevision,
          revision: draft.revision,
          frozenAt: batch.snapshot.frozenAt,
          exportedAt: new Date().toISOString(),
          nodes: view.nodes,
          mappings: view.mappings,
          reviewItems: view.reviewItems.map(({ stale: _s, ...rest }) => rest),
          pendingEntries: batch.entries.filter((entry) => entry.status !== '已合并').length,
        },
        null,
        2,
      )
      const checksum = stableHash(content)
      const name = filename ?? `课程地图-${draft.revision}-${batch.id}.json`
      const record: ExportRecord = {
        id: `X-${Date.now().toString(36).toUpperCase()}`,
        batchId: batch.id,
        revision: draft.revision,
        filename: name,
        checksum,
        entries: batch.entries.length,
        exportedAt: new Date().toISOString(),
        status: '待登记',
      }
      enqueue(draft, {
        kind: 'export',
        entityId: record.id,
        op: 'upsert',
        role: '课程负责人',
        label: `导出 ${name}`,
        value: record,
      })
      result = { filename: name, content, record }
    })
    return result
  },

  // 版本与草稿说明
  lock(revision?: string) {
    mutate((draft) => {
      draft.locked = true
      if (revision) draft.revision = revision
    })
  },
  saveDraft(draftNote: string) {
    mutate((draft) => {
      draft.draft = draftNote
    })
  },
  clearReport() {
    setReport(null)
  },
}

/** 取「工作视图」中的当前实体：优先未合并的本地补录值，否则取服务端值 */
function lookupLiveOrBase(draft: PersistState, kind: EntityKind, id: string): unknown {
  const batch = draft.batches.find((item) => item.id === draft.activeBatchId && item.status !== 'merged')
  if (batch) {
    const local = [...batch.entries]
      .reverse()
      .find((entry) => entry.kind === kind && entry.entityId === id && entry.status !== '已放弃' && entry.status !== '已合并')
    if (local) return local.op === 'delete' ? null : deepClone(local.localValue)
  }
  if (kind === 'node') return draft.server.nodes.find((item) => item.id === id) ?? null
  if (kind === 'mapping') return draft.server.mappings.find((item) => item.id === id) ?? null
  return draft.server.reviews.find((item) => item.id === id) ?? null
}

// ---- 结构校验（保持原有页面 API） -----------------------------------------

export function validateCurriculum(state: CurriculumView | CurriculumStoreState) {
  const view = 'view' in state ? state.view : state
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  view.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  view.nodes
    .filter((node) => node.type === '毕业要求')
    .forEach((node) => {
      if (
        !(outgoing.get(node.id) ?? []).some(
          (mapping) => view.nodes.find((item) => item.id === mapping.target)?.type === '课程',
        )
      ) {
        issues.push({
          id: `coverage-${node.id}`,
          severity: '错误',
          title: `${node.label.split('\n')[0]} 存在覆盖缺口`,
          detail: '未关联任何课程支撑证据。',
        })
      }
    })
  const seen = new Set<string>()
  view.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key))
      issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}

export type { ChangeEntry }
