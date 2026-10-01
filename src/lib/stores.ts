import { writable, get } from 'svelte/store'
import { browser } from '$app/environment'
import type { GraphNode, Mapping, ReviewItem, Actor } from './seed'
import { seedState } from './seed'
import {
  type Batch,
  type Change,
  type ConflictItem,
  type Invalidation,
  type ExportRecord,
  type MergeRound,
  type MergeResult,
  makeBatch,
  makeLegacyBatch,
  newChangeId,
  newExportId,
} from './batch'

const DRAFT_KEY = 'curriculum-map-draft-v2'
const LEGACY_KEY = 'curriculum-map-draft-v1'

export type CurriculumState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviewItems: ReviewItem[]
  revision: string
  locked: boolean
  draft: string
  batchId: string | null
  batches: Batch[]
  outbox: Change[]
  conflicts: ConflictItem[]
  invalidations: Invalidation[]
  mergeRounds: MergeRound[]
  pendingResolutions: Record<string, unknown>
  mergeError: string | null
  online: boolean
  actor: Actor
  exports: ExportRecord[]
  upgradedFromLegacy: boolean
}

function defaultState(): CurriculumState {
  return {
    ...structuredClone(seedState),
    draft: 'C-308 对 GR-06 的案例证据不足，需补充评分记录。',
    batchId: null,
    batches: [],
    outbox: [],
    conflicts: [],
    invalidations: [],
    mergeRounds: [],
    pendingResolutions: {},
    mergeError: null,
    online: true,
    actor: 'owner',
    exports: [],
    upgradedFromLegacy: false,
  }
}

function normalize(raw: Partial<CurriculumState>): CurriculumState {
  const d = defaultState()
  return {
    ...d,
    ...raw,
    nodes: raw.nodes ?? d.nodes,
    mappings: raw.mappings ?? d.mappings,
    reviewItems: raw.reviewItems ?? d.reviewItems,
    batches: raw.batches ?? d.batches,
    outbox: raw.outbox ?? d.outbox,
    conflicts: raw.conflicts ?? d.conflicts,
    invalidations: raw.invalidations ?? d.invalidations,
    mergeRounds: raw.mergeRounds ?? d.mergeRounds,
    pendingResolutions: raw.pendingResolutions ?? d.pendingResolutions,
    exports: raw.exports ?? d.exports,
  }
}

async function registerBatch(batch: Batch) {
  try {
    await fetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
    })
  } catch {
    /* 离线时忽略，合并时会补注册 */
  }
}

function upgradeFromLegacy(legacy: Partial<CurriculumState>): CurriculumState {
  const base = normalize(legacy)
  const batch = makeLegacyBatch(base)
  const state: CurriculumState = { ...base, batchId: batch.id, batches: [batch], upgradedFromLegacy: true }
  if (browser) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state))
    void registerBatch(batch)
  }
  return state
}

function freshSeed(): CurriculumState {
  const base = defaultState()
  const batch = makeBatch(base)
  const state: CurriculumState = { ...base, batchId: batch.id, batches: [batch] }
  if (browser) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state))
    void registerBatch(batch)
  }
  return state
}

function initState(): CurriculumState {
  if (!browser) return defaultState()
  try {
    const v2 = localStorage.getItem(DRAFT_KEY)
    if (v2) {
      const parsed = JSON.parse(v2) as Partial<CurriculumState>
      if (parsed.batchId) return normalize(parsed)
      return upgradeFromLegacy(parsed)
    }
    const v1 = localStorage.getItem(LEGACY_KEY)
    if (v1) return upgradeFromLegacy(JSON.parse(v1) as Partial<CurriculumState>)
  } catch (err) {
    console.warn('草稿恢复失败，使用初始数据', err)
  }
  return freshSeed()
}

/** 把一条条目级变更记入补录箱，基线冻结不变 */
function commit(state: CurriculumState, itemType: Change['itemType'], itemId: string, op: Change['op'], before: unknown, after: unknown): CurriculumState {
  if (!state.batchId) return state
  const change: Change = {
    id: newChangeId(),
    batchId: state.batchId,
    actor: state.actor,
    itemType,
    itemId,
    op,
    before,
    after,
    at: new Date().toISOString(),
    status: 'pending',
  }
  return { ...state, outbox: [...state.outbox, change] }
}

function applyValueToState(state: CurriculumState, itemType: Change['itemType'], itemId: string, value: unknown): CurriculumState {
  if (itemType === 'node') return { ...state, nodes: state.nodes.map((n) => (n.id === itemId ? (value as GraphNode) : n)) }
  if (itemType === 'mapping') return { ...state, mappings: state.mappings.map((m) => (m.id === itemId ? (value as Mapping) : m)) }
  return { ...state, reviewItems: state.reviewItems.map((r) => (r.id === itemId ? (value as ReviewItem) : r)) }
}

function dedupeInvalidations(existing: Invalidation[], incoming: Invalidation[]): Invalidation[] {
  const seen = new Set(existing.map((i) => `${i.reviewId}-${i.at}`))
  const merged = [...existing]
  for (const inv of incoming) {
    const key = `${inv.reviewId}-${inv.at}`
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(inv)
    }
  }
  return merged
}

function createCurriculumStore() {
  const { subscribe, update } = writable<CurriculumState>(initState())

  async function postMerge(batchId: string, payload: unknown): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
    let res = await fetch(`/api/batches/${batchId}/merge`, init)
    if (res.status === 404) {
      const batch = get(curriculumStore).batches.find((b) => b.id === batchId)
      if (batch) await registerBatch(batch)
      res = await fetch(`/api/batches/${batchId}/merge`, init)
    }
    return res
  }

  const store = {
    subscribe,
    setActor(actor: Actor) {
      update((state) => ({ ...state, actor }))
    },
    setOnline(online: boolean) {
      update((state) => ({ ...state, online }))
      if (online) void store.mergeChanges()
    },
    /** 建立修订批次：冻结当前节点、连边与审阅状态，作为后续合并基线 */
    createBatch(revision?: string) {
      update((state) => {
        const batch = makeBatch({
          nodes: state.nodes,
          mappings: state.mappings,
          reviewItems: state.reviewItems,
          revision: revision ?? state.revision,
        })
        void registerBatch(batch)
        return {
          ...state,
          batchId: batch.id,
          batches: [...state.batches, batch],
          outbox: [],
          conflicts: [],
          pendingResolutions: {},
          mergeError: null,
          mergeRounds: [],
        }
      })
    },
    moveNode(id: string, x: number, y: number) {
      update((state) => {
        const before = state.nodes.find((node) => node.id === id)
        if (!before) return state
        const after = { ...before, x, y }
        const next = { ...state, nodes: state.nodes.map((node) => (node.id === id ? after : node)) }
        return commit(next, 'node', id, 'update', before, after)
      })
    },
    addMapping(source: string, target: string, relation: Mapping['relation'], weight: number) {
      update((state) => {
        const mapping: Mapping = { id: `M-${Date.now()}`, source, target, relation, weight }
        const next = { ...state, mappings: [...state.mappings, mapping] }
        return commit(next, 'mapping', mapping.id, 'add', null, mapping)
      })
    },
    updateReview(id: string, status: ReviewItem['status'], comment: string) {
      update((state) => {
        const before = state.reviewItems.find((item) => item.id === id)
        if (!before) return state
        const after: ReviewItem = {
          ...before,
          status,
          comment,
          decidedAt: new Date().toISOString(),
          decidedBy: state.actor,
          reviewedEvidence: before.evidence,
        }
        const next = { ...state, reviewItems: state.reviewItems.map((item) => (item.id === id ? after : item)) }
        return commit(next, 'review', id, 'update', before, after)
      })
    },
    editEvidence(id: string, evidence: string) {
      update((state) => {
        const before = state.reviewItems.find((item) => item.id === id)
        if (!before) return state
        const after: ReviewItem = { ...before, evidence }
        const next = { ...state, reviewItems: state.reviewItems.map((item) => (item.id === id ? after : item)) }
        return commit(next, 'review', id, 'update', before, after)
      })
    },
    submitRevision(item: ReviewItem) {
      update((state) => {
        const next = { ...state, reviewItems: [...state.reviewItems, item] }
        return commit(next, 'review', item.id, 'add', null, item)
      })
    },
    saveDraft(draft: string) {
      update((state) => ({ ...state, draft }))
    },
    lock(revision: string) {
      update((state) => ({ ...state, revision, locked: true }))
    },
    /** 回网按条目合并；失败时保留补录箱现场，可重试 */
    async mergeChanges(forceFail = false) {
      const state = get(curriculumStore)
      if (!state.batchId) return
      update((cur) => ({ ...cur, mergeError: null }))
      try {
        const res = await postMerge(state.batchId, {
          changes: state.outbox,
          resolutions: state.pendingResolutions,
          forceFail,
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? `合并失败（HTTP ${res.status}）`)
        }
        const data = (await res.json()) as { ok: boolean; merge: MergeResult }
        const merge = data.merge
        const conflictKeys = new Set(merge.conflicts.map((c) => c.key))
        update((cur) => ({
          ...cur,
          nodes: merge.nodes,
          mappings: merge.mappings,
          reviewItems: merge.reviewItems,
          outbox: cur.outbox
            .map((ch) =>
              conflictKeys.has(`${ch.itemType}:${ch.itemId}`)
                ? { ...ch, status: 'conflict' as const }
                : { ...ch, status: 'merged' as const },
            )
            .filter((ch) => ch.status !== 'merged'),
          conflicts: merge.conflicts,
          invalidations: dedupeInvalidations(cur.invalidations, merge.invalidations),
          mergeRounds: [
            ...cur.mergeRounds,
            {
              at: merge.mergedAt,
              applied: merge.applied.length,
              conflicts: merge.conflicts.length,
              invalidations: merge.invalidations.length,
            },
          ],
          pendingResolutions: {},
          mergeError: null,
          batches: cur.batches.map((b) => (b.id === cur.batchId ? { ...b, status: 'merged' as const } : b)),
        }))
      } catch (err) {
        update((cur) => ({ ...cur, mergeError: err instanceof Error ? err.message : String(err) }))
      }
    },
    retryMerge() {
      return store.mergeChanges()
    },
    /** 采用冲突某一方的版本：本地生效并随下次回网确认 */
    resolveConflict(key: string, side: 'owner' | 'reviewer') {
      const state = get(curriculumStore)
      const conflict = state.conflicts.find((c) => c.key === key)
      if (!conflict) return
      const change = side === 'owner' ? conflict.ownerChange : conflict.reviewerChange
      if (!change) return
      update((cur) => {
        const next = applyValueToState(cur, conflict.itemType, conflict.itemId, change.after)
        return {
          ...next,
          pendingResolutions: { ...cur.pendingResolutions, [key]: change.after },
          conflicts: cur.conflicts.filter((c) => c.key !== key),
          outbox: cur.outbox.map((ch) =>
            `${ch.itemType}:${ch.itemId}` === key ? { ...ch, status: 'merged' as const } : ch,
          ),
        }
      })
      void store.mergeChanges()
    },
    /** 导出课程地图，结果绑定批次号并登记 */
    exportMap() {
      const state = get(curriculumStore)
      const filename = `课程地图-${state.batchId ?? 'draft'}.json`
      const payload = {
        batchId: state.batchId,
        revision: state.revision,
        exportedAt: new Date().toISOString(),
        nodes: state.nodes,
        mappings: state.mappings,
        reviewItems: state.reviewItems,
        conflicts: state.conflicts,
        invalidations: state.invalidations,
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
      const record: ExportRecord = {
        id: newExportId(),
        batchId: state.batchId ?? 'draft',
        filename,
        exportedAt: new Date().toISOString(),
      }
      update((cur) => ({ ...cur, exports: [...cur.exports, record] }))
    },
  }

  if (browser) {
    store.subscribe((state) => localStorage.setItem(DRAFT_KEY, JSON.stringify(state)))
    window.addEventListener('online', () => store.setOnline(true))
    window.addEventListener('offline', () => store.setOnline(false))
  }

  return store
}

export const curriculumStore = createCurriculumStore()

export function validateCurriculum(state: CurriculumState) {
  const issues: Array<{ id: string; severity: '错误' | '警告'; title: string; detail: string }> = []
  const outgoing = new Map<string, Mapping[]>()
  state.mappings.forEach((mapping) => outgoing.set(mapping.source, [...(outgoing.get(mapping.source) ?? []), mapping]))
  state.nodes.filter((node) => node.type === '毕业要求').forEach((node) => {
    if (!(outgoing.get(node.id) ?? []).some((mapping) => state.nodes.find((item) => item.id === mapping.target)?.type === '课程')) {
      issues.push({ id: `coverage-${node.id}`, severity: '错误', title: `${node.label.split('\n')[0]} 存在覆盖缺口`, detail: '未关联任何课程支撑证据。' })
    }
  })
  const seen = new Set<string>()
  state.mappings.forEach((mapping) => {
    const key = `${mapping.source}-${mapping.target}-${mapping.relation}`
    if (seen.has(key)) issues.push({ id: `dup-${mapping.id}`, severity: '警告', title: `${mapping.id} 为重复映射`, detail: '相同来源、目标和关系重复录入，可合并。' })
    seen.add(key)
  })
  return issues
}
