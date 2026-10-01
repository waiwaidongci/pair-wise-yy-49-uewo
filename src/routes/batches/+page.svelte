<script lang="ts">
  import { curriculumStore } from '$lib/stores'
  import type { ChangeEntry } from '$lib/batch/types'

  // 新建批次表单
  let newTitle = $state('软件工程实践课程修订')
  let newOwner = $state('顾明（课程负责人）')
  let newReviewer = $state('周岚（院系审阅人）')
  let newRevision = $derived(`R${Number($curriculumStore.revision.slice(1)) + 1}`)

  const batch = $derived($curriculumStore.activeBatch)
  const entries = $derived(batch?.entries ?? [])
  const report = $derived($curriculumStore.lastReport?.report ?? null)
  const statusColor: Record<string, string> = {
    排队中: 'queued', 已合并: 'merged', 待确认: 'conflict', 已失败: 'failed', 已放弃: 'dropped',
  }

  let simMappingId = $state('M-05')
  function createBatchAndGoOffline() {
    curriculumStore.createRevisionBatch({ title: newTitle, owner: newOwner, reviewer: newReviewer, revision: newRevision })
    curriculumStore.setOnline(false)
  }

  function toggleNetwork() {
    curriculumStore.setOnline(!$curriculumStore.online)
  }

  function merge() {
    curriculumStore.goOnlineAndMerge()
  }
  function retry() {
    curriculumStore.retryMerge()
  }

  // 断网演练动作
  function offlineEditMapping() {
    const current = $curriculumStore.server.mappings.find((m) => m.id === simMappingId)
    if (!current) return
    curriculumStore.updateMapping(current.id, { weight: Math.max(0.1, Number((current.weight - 0.25).toFixed(2))) })
  }
  function offlineAddMapping() {
    curriculumStore.addMapping('GR-06', 'C-101', '支撑', 0.6)
  }
  function offlineDeleteDup() {
    curriculumStore.deleteMapping('M-11')
  }
  function offlineReview() {
    curriculumStore.updateReview('REV-202', '已退回', '断网退回：评分记录仍不完整，请补交评分表。', newReviewer || '院系审阅人：周岚')
  }
  function offlineEvidence() {
    curriculumStore.updateReviewEvidence('REV-202', '数据合规案例分析已补充评分记录、量规与达成度统计表，覆盖全班 36 份作业。')
  }

  // 在线（模拟对端）演练动作
  function onlineEditMapping() {
    const current = $curriculumStore.server.mappings.find((m) => m.id === simMappingId)
    if (!current) return
    curriculumStore.onlineUpsertMapping({ ...current, weight: Math.min(1, Number((current.weight + 0.15).toFixed(2))) })
  }
  function onlineReviewDecision() {
    curriculumStore.onlineReviewDecision('REV-202', '已附议', '在线附议：已看到补充材料，同意纳入。')
  }
  function armFailure() {
    curriculumStore.armFailure()
  }

  function entityDisplay(entry: ChangeEntry) {
    if (entry.kind === 'mapping' || entry.kind === 'node') {
      const value = entry.localValue as { source?: string; target?: string; relation?: string; weight?: number } | null
      return value ? `${value.relation ?? '节点'} ${value.source ?? ''}${value.target ? ' → ' + value.target : ''}${typeof value.weight === 'number' ? ` · 权重 ${value.weight}` : ''}` : entry.entityId
    }
    if (entry.kind === 'review') {
      const value = entry.localValue as { status?: string; comment?: string; evidence?: string } | null
      return value ? `${value.status ?? ''} ${value.comment?.slice(0, 28) ?? ''}` : entry.entityId
    }
    return entry.label
  }
</script>

<svelte:head><title>修订批次与断网合并</title></svelte:head>

<section class="page batch-page">
  <div class="page-head">
    <div>
      <p class="eyebrow">REVISION BATCH / 修订批次</p>
      <h1>修订批次 · 断网补录 · 回网合并</h1>
      <p class="muted">建批次时冻结节点、连边与审阅状态；断网照常补录，回网按条目三路合并，双方都改过的留在待确认；映射/证据一变结论失效重算，旧结论可追溯；失败保留现场可重试。</p>
    </div>
  </div>

  {#if $curriculumStore.migratedFromV1}
    <div class="notice migration">
      <strong>已完成旧草稿兼容升级</strong>
      <span>检测到没有批次号的旧版本地草稿，已自动生成「旧草稿兼容升级」批次并冻结基线，旧草稿差异已逐条转入补录队列，检查后即可合并。</span>
    </div>
  {/if}

  <!-- 批次列表 / 新建 -->
  <section class="panel">
    <div class="panel-head"><h3>修订批次</h3><span class="muted">服务端权威版本 {$curriculumStore.revision}</span></div>
    <div class="batch-row">
      <div class="batch-list">
        {#each $curriculumStore.batches as b}
          <button class="batch-card" class:active={b.id === $curriculumStore.activeBatchId} onclick={() => curriculumStore.activateBatch(b.id)}>
            <strong>{b.id} · {b.title}</strong>
            <span>{b.owner} ↔ {b.reviewer}</span>
            <span class="pill {b.status}">{b.status} · {b.online ? '在线' : '断网'}</span>
            <small>基线 {b.baseRevision} · 冻结 {b.snapshot.frozenAt.slice(0, 16).replace('T', ' ')}</small>
            <small>{b.entries.length} 条目（{b.entries.filter((e) => e.status === '已合并').length} 合并 / {b.entries.filter((e) => e.status === '待确认').length} 冲突 / {b.entries.filter((e) => e.status === '已失败').length} 失败）</small>
          </button>
        {/each}
        {#if $curriculumStore.batches.length === 0}<div class="empty">尚无批次，先在下方建立一个修订批次（会冻结当前节点、连边和审阅状态）。</div>{/if}
      </div>
      <div class="new-batch">
        <h4>建立新批次并冻结基线</h4>
        <label>批次标题<input bind:value={newTitle} /></label>
        <label>课程负责人<input bind:value={newOwner} /></label>
        <label>院系审阅人<input bind:value={newReviewer} /></label>
        <label>修订版本<input value={newRevision} readonly /></label>
        <button class="btn-primary" onclick={createBatchAndGoOffline}>建立批次并进入断网补录</button>
      </div>
    </div>
  </section>

  {#if batch}
    <!-- 状态条与回传 -->
    <section class="panel console">
      <div class="panel-head">
        <h3>批次 {batch.id} 控制台</h3>
        <span class="net {batch.online ? 'on' : 'off'}">{batch.online ? '● 已回网' : '○ 断网补录'}</span>
      </div>
      <div class="freeze-grid">
        <div><b>{batch.snapshot.nodes.length}</b><span>冻结节点</span></div>
        <div><b>{batch.snapshot.mappings.length}</b><span>冻结连边</span></div>
        <div><b>{batch.snapshot.reviews.length}</b><span>冻结审阅</span></div>
        <div><b>{entries.filter((e) => e.status === '排队中').length}</b><span>排队中</span></div>
        <div><b>{entries.filter((e) => e.status === '待确认').length}</b><span>待确认</span></div>
        <div><b>{entries.filter((e) => e.status === '已失败').length}</b><span>已失败</span></div>
        <div><b>{entries.filter((e) => e.status === '已合并').length}</b><span>已合并</span></div>
      </div>
      <div class="console-actions">
        <button class="btn-secondary" onclick={toggleNetwork}>{batch.online ? '模拟断网' : '模拟回网（仅切换状态）'}</button>
        <button class="btn-primary" onclick={merge} disabled={batch.online && $curriculumStore.pendingCount + $curriculumStore.conflictCount + $curriculumStore.failedCount === 0}>回网并按条目合并</button>
        <button class="btn-secondary" onclick={retry} disabled={$curriculumStore.failedCount === 0}>接续重试（{$curriculumStore.failedCount}）</button>
        <button class="btn-danger" onclick={armFailure}>演练：下次合并中断</button>
      </div>
      {#if batch.mergeError}<div class="notice error" style="margin:12px">{batch.mergeError}</div>{/if}

      {#if report}
        <div class="report">
          <strong>上次合并报告</strong>
          <span>应用 {report.applied.length}</span><span>跳过 {report.skipped.length}</span>
          <span class="conflict">待确认 {report.conflicts.length}</span><span class="failed">失败 {report.failed.length}</span>
          {#if report.invalidated.length > 0}
            <div class="invalidated">审阅结论失效重算：{report.invalidated.map((i) => `${i.reviewId}（${i.fromStatus}→待审阅）`).join('，')}</div>
          {/if}
        </div>
      {/if}
    </section>

    <!-- 断网补录 / 在线对端 演练 -->
    <div class="sim-grid">
      <section class="panel sim offline-panel">
        <div class="panel-head"><h3>① 断网照常补录（本机）</h3><span class="muted">进入本地批次队列</span></div>
        <div class="sim-body">
          <label class="pick">演练连边
            <select bind:value={simMappingId}>
              {#each $curriculumStore.server.mappings as m}<option value={m.id}>{m.id} · {m.source} → {m.target} · {m.relation}</option>{/each}
            </select>
          </label>
          <button class="btn-secondary" onclick={offlineEditMapping}>改连边 {simMappingId} 权重 −0.25</button>
          <button class="btn-secondary" onclick={offlineAddMapping}>新增连边 GR-06 → C-101</button>
          <button class="btn-secondary" onclick={offlineDeleteDup}>删除重复连边 M-11</button>
          <button class="btn-secondary" onclick={offlineEvidence}>课程方补录 REV-202 证据</button>
          <button class="btn-secondary" onclick={offlineReview}>审阅人断网退回 REV-202</button>
          <p class="muted">也可以直接去「映射图谱」拖拽/删边、去「改革审阅」写意见，都会进入同一批次。</p>
        </div>
      </section>
      <section class="panel sim online-panel">
        <div class="panel-head"><h3>② 对端在线修改（模拟）</h3><span class="muted">直接改服务端权威数据</span></div>
        <div class="sim-body">
          <label class="pick">演练连边
            <select bind:value={simMappingId}>
              {#each $curriculumStore.server.mappings as m}<option value={m.id}>{m.id} · {m.source} → {m.target} · {m.relation}</option>{/each}
            </select>
          </label>
          <button class="btn-secondary" onclick={onlineEditMapping}>在线改 {simMappingId} 权重 +0.15</button>
          <button class="btn-secondary" onclick={onlineReviewDecision}>在线附议 REV-202</button>
          <p class="muted">先在左栏补录、再点这里制造「双方都改过」，回网合并时该条目会留在待确认。</p>
        </div>
      </section>
    </div>

    <!-- 条目列表 -->
    <section class="panel">
      <div class="panel-head"><h3>③ 补录条目（按条目合并 / 冲突裁决 / 失败重试）</h3><span class="muted">基线值建批次时冻结</span></div>
      <div class="entry-table">
        <div class="entry-row head"><span>条目</span><span>对象</span><span>角色/操作</span><span>基线 → 本地</span><span>状态</span><span>处理</span></div>
        {#each entries as entry}
          <div class="entry-row" class:row-conflict={entry.status === '待确认'} class:row-failed={entry.status === '已失败'}>
            <span><b>{entry.entityId}</b><small>{entry.id} · 尝试 {entry.attempts} 次</small></span>
            <span>{entry.label}<small>{entry.kind}</small></span>
            <span>{entry.role}<small>{entry.op}</small></span>
            <span class="diff"><small>基线：{JSON.stringify(entry.baseValue).slice(0, 46)}</small><small>本地：{JSON.stringify(entry.localValue).slice(0, 46)}</small></span>
            <span><span class="pill {statusColor[entry.status]}">{entry.status}</span>{#if entry.conflictReason}<small class="conflict">{entry.conflictReason}</small>{/if}{#if entry.lastError}<small class="failed">{entry.lastError}</small>{/if}</span>
            <span class="entry-actions">
              {#if entry.status === '待确认'}
                <button class="btn-primary" onclick={() => curriculumStore.resolveEntry(entry.id, 'local')}>采用本地</button>
                <button class="btn-secondary" onclick={() => curriculumStore.resolveEntry(entry.id, 'server')}>采用服务端</button>
                {#if entry.kind === 'review'}<button class="btn-secondary" onclick={() => curriculumStore.resolveEntry(entry.id, 'merge-fields')}>字段合并(证据+意见)</button>{/if}
                <button class="btn-danger" onclick={() => curriculumStore.discardEntry(entry.id)}>放弃</button>
              {:else if entry.status === '已失败'}
                <button class="btn-primary" onclick={retry}>重试</button>
                <button class="btn-danger" onclick={() => curriculumStore.discardEntry(entry.id)}>放弃</button>
              {:else}
                <small class="muted">{entry.mergedAt ? '合并于 ' + entry.mergedAt.slice(11, 16) : '—'}</small>
              {/if}
            </span>
          </div>
        {/each}
        {#if entries.length === 0}<div class="empty">该批次还没有补录条目。先断网，然后到图谱/审阅页操作，或用上方演练按钮。</div>{/if}
      </div>
    </section>

    <!-- 审阅结论追溯 -->
    <section class="panel">
      <div class="panel-head"><h3>④ 审阅结论失效重算与追溯</h3><span class="muted">旧结论只归档不删除</span></div>
      <div class="trace-grid">
        {#each $curriculumStore.server.reviews as review}
          {@const decisions = $curriculumStore.server.history.filter((h) => h.reviewId === review.id)}
          <article class="trace-card" class:stale={review.status === '待审阅' && review.reviewer === '系统复核'}>
            <div class="trace-head"><strong>{review.id}</strong><span class="pill {review.status === '已附议' ? 'merged' : review.status === '已退回' ? 'failed' : 'queued'}">{review.status}</span></div>
            <small>{review.courseId} / {review.requirementId} · {review.reviewer ?? '—'} · 指纹 {review.basisHash ?? '无'}</small>
            <p>{review.comment || '（暂无结论）'}</p>
            {#if decisions.length > 0}
              <details>
                <summary>历史结论 {decisions.length} 条（含失效归档）</summary>
                {#each [...decisions].reverse() as d}
                  <div class="decision-line"><b class={d.status === '已附议' ? 'ok' : 'bad'}>{d.status}</b><span>{d.comment}</span><small>{d.reviewer} · {d.decidedAt.slice(0, 16).replace('T', ' ')} · {d.reason} · {d.basisHash}</small></div>
                {/each}
              </details>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <!-- 导出登记 -->
    <section class="panel">
      <div class="panel-head"><h3>⑤ 导出结果回传登记</h3><span class="muted">导出先随批次排队，回网后幂等登记</span></div>
      <div class="export-list">
        {#each $curriculumStore.server.exports.filter((e) => e.batchId === batch.id) as rec}
          <div class="export-row">
            <strong>{rec.filename}</strong>
            <span>校验和 {rec.checksum}</span>
            <span>导出 {rec.exportedAt.slice(0, 16).replace('T', ' ')}</span>
            {#if rec.registeredAt}<span>登记 {rec.registeredAt.slice(0, 16).replace('T', ' ')}</span>{/if}
            <span class="pill merged">{rec.status === '已登记' ? '已登记' : rec.status}</span>
          </div>
        {/each}
        {#each batch.entries.filter((e) => e.kind === 'export') as entry}
          {@const rec = entry.localValue as import('$lib/batch/types').ExportRecord}
          <div class="export-row">
            <strong>{rec.filename}</strong>
            <span>校验和 {rec.checksum}</span>
            <span>导出 {rec.exportedAt.slice(0, 16).replace('T', ' ')}</span>
            <span class="pill {statusColor[entry.status]}">{entry.status === '已合并' ? '已登记' : '待登记'}</span>
            {#if entry.status === '排队中' || entry.status === '已失败'}<small class="muted">回网合并后登记</small>{/if}
          </div>
        {/each}
        {#if batch.entries.filter((e) => e.kind === 'export').length === 0}
          <div class="empty">尚无导出。去「映射图谱」点「导出课程地图」，导出记录会作为 export 条目随本批次回传。</div>
        {/if}
      </div>
    </section>
  {/if}
</section>

<style>
  .notice { margin: 12px 0; padding: 12px 14px; border-radius: 8px; font-size: 12px; }
  .notice strong, .notice span { display: block; }
  .migration { border-left: 3px solid #2f6f72; color: #27565a; background: #e9f3f2; }
  .notice.error { color: #913c2b; background: #fff1ec; }
  .batch-row { display: grid; grid-template-columns: minmax(0,1fr) 300px; gap: 14px; padding: 14px; }
  .batch-list { display: grid; gap: 10px; align-content: start; }
  .batch-card { display: grid; gap: 4px; padding: 12px; border: 1px solid #dce3e3; border-radius: 8px; background: #fbfcfc; text-align: left; cursor: pointer; }
  .batch-card.active { border-color: #2f6f72; border-width: 2px; background: #f0f6f5; }
  .batch-card span, .batch-card small { font-size: 11px; color: #78868c; }
  .new-batch { display: grid; gap: 9px; align-content: start; padding: 12px; border: 1px dashed #b9c8c9; border-radius: 8px; background: #f8fafa; }
  .new-batch h4 { margin: 0; font-size: 13px; }
  .pill { display: inline-block; justify-self: start; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 700; }
  .pill.queued, .pill.active { color: #34637c; background: #e7f0f6; }
  .pill.merged { color: #2e7359; background: #e7f4ec; }
  .pill.conflict, .pill.partial { color: #9b6a18; background: #fdf0d6; }
  .pill.failed { color: #a94331; background: #ffe6e0; }
  .pill.dropped { color: #7a848a; background: #eef0f1; }
  .console .net { font-size: 12px; font-weight: 700; }
  .console .net.on { color: #2e7359; }
  .console .net.off { color: #b0742b; }
  .freeze-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 8px; padding: 14px; }
  .freeze-grid div { display: grid; gap: 3px; padding: 10px; border-radius: 8px; background: #f3f7f6; text-align: center; }
  .freeze-grid b { font-size: 20px; color: #25434b; }
  .freeze-grid span { font-size: 10px; color: #7a878d; }
  .console-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 14px 14px; }
  .report { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 14px 14px; padding: 12px; border-radius: 8px; background: #f5f8f7; font-size: 12px; }
  .report .conflict { color: #9b6a18; font-weight: 700; }
  .report .failed { color: #a94331; font-weight: 700; }
  .report .invalidated { flex-basis: 100%; color: #2f6f72; }
  .sim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 14px 0; }
  .sim-body { display: grid; gap: 8px; padding: 14px; }
  .sim-body .pick { display: grid; gap: 5px; font-size: 11px; color: #5f7077; font-weight: 700; }
  .sim-body p { margin: 4px 0 0; font-size: 11px; line-height: 1.6; }
  .offline-panel { border-top: 3px solid #cf944e; }
  .online-panel { border-top: 3px solid #4f84a0; }
  .entry-table { padding: 8px 14px 14px; }
  .entry-row { display: grid; grid-template-columns: 130px 170px 110px minmax(0,1.4fr) 150px minmax(0,1fr); gap: 10px; align-items: start; padding: 11px 8px; border-bottom: 1px solid #edf0f0; font-size: 11px; }
  .entry-row.head { color: #7d8b91; font-weight: 700; }
  .entry-row small { display: block; color: #8a969b; word-break: break-all; }
  .entry-row .diff small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .entry-row.row-conflict { background: #fff9ee; }
  .entry-row.row-failed { background: #fdf1ee; }
  .entry-actions { display: flex; gap: 5px; flex-wrap: wrap; }
  .entry-actions button { padding: 5px 8px; font-size: 10px; }
  .conflict { color: #9b6a18; }
  .failed { color: #a94331; }
  .trace-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(320px,1fr)); gap: 12px; padding: 14px; }
  .trace-card { padding: 12px; border: 1px solid #e0e6e6; border-radius: 8px; background: #fbfcfc; }
  .trace-card.stale { border-color: #d9a85f; background: #fff9ee; }
  .trace-head { display: flex; justify-content: space-between; align-items: center; }
  .trace-card p { margin: 8px 0; color: #5f6e74; font-size: 11px; line-height: 1.6; }
  .trace-card details summary { cursor: pointer; font-size: 11px; color: #5f7d80; }
  .decision-line { display: grid; gap: 2px; margin-top: 7px; padding: 7px; border-left: 2px solid #c7d6d5; background: #f6f9f8; }
  .decision-line b.ok { color: #2e7359; }
  .decision-line b.bad { color: #a94331; }
  .decision-line span { font-size: 11px; color: #4c5f66; }
  .export-list { padding: 8px 14px 14px; display: grid; gap: 8px; }
  .export-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid #e3e9e9; border-radius: 8px; font-size: 11px; }
  .empty { padding: 22px; color: #7a8d90; font-size: 12px; text-align: center; }
  @media (max-width: 1100px) {
    .batch-row, .sim-grid { grid-template-columns: 1fr; }
    .freeze-grid { grid-template-columns: repeat(4,1fr); }
    .entry-row { grid-template-columns: 1fr; }
    .entry-row.head { display: none; }
  }
</style>
