// 修订批次领域模型：节点 / 连边 / 审阅 / 导出都以「条目」形式进入批次，
// 建立批次时冻结基线快照，断网补录在本地排队，回网后按条目三路合并。

export type NodeType = '目标' | '毕业要求' | '课程' | '单元' | '教学活动' | '考核'
export type Relation = '支撑' | '前置' | '考核' | '教学'
export type ReviewStatus = '待审阅' | '已附议' | '已退回'
export type ActorRole = '课程负责人' | '院系审阅人' | '系统'

export type GraphNode = {
  id: string
  label: string
  type: NodeType
  x: number
  y: number
  course?: string
}

export type Mapping = {
  id: string
  source: string
  target: string
  relation: Relation
  weight: number
}

export type ReviewItem = {
  id: string
  courseId: string
  requirementId: string
  evidence: string
  submitter: string
  status: ReviewStatus
  comment: string
  reviewer?: string
  /** 最近一次有效结论生成的时间；映射/证据变更后会被新的结论刷新 */
  decidedAt?: string
  /** 结论依据的数据指纹（相关连边与证据），变化即失效 */
  basisHash?: string
  /** 仅用于前端工作视图：本地补录已使其依据过期，回网合并后会重算 */
  stale?: boolean
}

/** 历史审阅结论：旧结论永远追加，不覆盖，保证可追溯 */
export type ArchivedDecision = {
  reviewId: string
  status: ReviewStatus
  comment: string
  reviewer: string
  decidedAt: string
  basisHash: string
  reason: string
}

export type ExportRecord = {
  id: string
  batchId: string
  revision: string
  filename: string
  checksum: string
  /** 导出时批次条目数，回网登记后用于核对 */
  entries: number
  exportedAt: string
  registeredAt?: string
  status: '待登记' | '已登记' | '登记失败'
}

/** 权威服务端状态（模拟服务端） */
export type ServerState = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviews: ReviewItem[]
  exports: ExportRecord[]
  /** 全部历史审阅结论，只追加不覆盖 */
  history: ArchivedDecision[]
}

// ---- 批次与条目 ----------------------------------------------------------

export type EntityKind = 'node' | 'mapping' | 'review' | 'export'
export type EntryStatus = '排队中' | '已合并' | '待确认' | '已失败' | '已放弃'
export type Op = 'upsert' | 'delete'

export type BatchStatus = 'active' | 'merging' | 'partial' | 'merged' | 'failed'

/**
 * 一条补录条目。baseValue 是建立批次时冻结的基线值（delete 时为原对象快照），
 * localValue 是断网期间本地的新值；服务端当前值由合并时从 ServerState 读取。
 */
export type ChangeEntry = {
  id: string
  kind: EntityKind
  entityId: string
  op: Op
  role: ActorRole
  label: string
  baseValue: unknown
  localValue: unknown
  createdAt: string
  updatedAt: string
  status: EntryStatus
  /** 三路合并判定后记录冲突原因 */
  conflictReason?: string
  attempts: number
  lastError?: string
  mergedAt?: string
  /** 字段级合并时：保留服务端审阅状态/意见，仅落课程方证据等内容字段 */
  preserveDecision?: boolean
}

/** 建立批次时冻结的节点、连边、审阅状态快照 */
export type FrozenSnapshot = {
  nodes: GraphNode[]
  mappings: Mapping[]
  reviews: ReviewItem[]
  frozenAt: string
  revision: string
}

export type Batch = {
  id: string
  title: string
  owner: string
  reviewer: string
  revision: string
  baseRevision: string
  createdAt: string
  status: BatchStatus
  online: boolean
  snapshot: FrozenSnapshot
  entries: ChangeEntry[]
  lastMergeAt?: string
  mergeError?: string
  /** 合并是否被故意打断（演练用）；为 true 时下一条必失败，触发保留现场 */
  failNext?: boolean
  note?: string
}

export type MergeReport = {
  applied: string[]
  conflicts: string[]
  failed: string[]
  skipped: string[]
  invalidated: Array<{ reviewId: string; fromStatus: ReviewStatus; reason: string }>
  exports: string[]
  stopped: boolean
}
