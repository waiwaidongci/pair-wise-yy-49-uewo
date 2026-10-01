<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { browser } from '$app/environment'
  import { curriculumStore, validateCurriculum } from '$lib/stores'
  import type { GraphNode, Mapping, ReviewItem } from '$lib/seed'

  type CurriculumResponse = { nodes: GraphNode[]; mappings: Mapping[]; reviewItems: ReviewItem[]; updatedAt: string }
  const query = createQuery<CurriculumResponse>(() => ({
    queryKey: ['curriculum'],
    enabled: browser,
    queryFn: async () => {
      const response = await fetch('/api/curriculum')
      return response.json()
    },
  }))
  const issues = $derived(validateCurriculum($curriculumStore))
  const reviewOpen = $derived($curriculumStore.reviewItems.filter((item) => item.status === '待审阅').length)
  const covered = $derived($curriculumStore.nodes.filter((node) => node.type === '毕业要求' && $curriculumStore.mappings.some((mapping) => mapping.source === node.id)).length)
  const currentBatch = $derived($curriculumStore.batches.find((batch) => batch.id === $curriculumStore.batchId))
  let forceFail = $state(false)
</script>

<svelte:head><title>课程标准映射总览</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">CURRICULUM REFORM / 课程改革</p><h1>专业课程图谱总览</h1><p class="muted">从培养目标到考核证据的完整映射，当前数据由 SvelteKit API 与 TanStack Query 提供。</p></div>
    <div class="actions"><a class="btn-secondary" href="/matrix">查看图谱</a><a class="btn-primary" href="/review">处理审阅</a></div>
  </div>

  <div class="metric-grid">
    <article class="metric"><span>培养目标</span><strong>{$curriculumStore.nodes.filter((node) => node.type === '目标').length}</strong><small>2 条毕业要求主链</small></article>
    <article class="metric"><span>毕业要求覆盖</span><strong>{covered}/{$curriculumStore.nodes.filter((node) => node.type === '毕业要求').length}</strong><small>{issues.filter((issue) => issue.severity === '错误').length} 个阻断缺口</small></article>
    <article class="metric"><span>课程映射</span><strong>{$curriculumStore.mappings.length}</strong><small>含前置、教学与考核</small></article>
    <article class="metric"><span>待审阅提交</span><strong style="color:#b45c34">{reviewOpen}</strong><small>院系审阅队列</small></article>
  </div>

  {#if $curriculumStore.upgradedFromLegacy}
    <div class="notice upgrade">检测到旧版草稿没有批次号，已兼容升级为修订批次：节点、连边与审阅状态已冻结，断网补录将按条目合并，不再整体覆盖。</div>
  {/if}

  <div class="overview-grid">
    <section class="panel">
      <div class="panel-head"><h3>培养目标达成链</h3>{#if query.data}<span class="muted">数据更新 {query.data.updatedAt.slice(11,16)}</span>{/if}</div>
      <div class="chain">
        {#each $curriculumStore.nodes.filter((node) => node.type === '目标') as objective}
          <article>
            <div class="node-title">{objective.label.split('\n')[0]}</div>
            <p>{objective.label.split('\n')[1]}</p>
            <div class="arrow">↓</div>
            <div class="requirements">
              {#each $curriculumStore.mappings.filter((mapping) => mapping.source === objective.id) as mapping}
                {@const requirement = $curriculumStore.nodes.find((node) => node.id === mapping.target)}
                <div>{requirement?.label.split('\n')[0]} <span>权重 {Math.round(mapping.weight * 100)}%</span></div>
              {/each}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>结构校验</h3><span class="muted">{issues.length} 项提示</span></div>
      <div class="issue-list">
        {#each issues as issue}
          <article class:error={issue.severity === '错误'}>
            <strong>{issue.title}</strong><p>{issue.detail}</p><span>{issue.severity}</span>
          </article>
        {/each}
        {#if issues.length === 0}<div class="empty">未发现覆盖缺口或重复映射。</div>{/if}
      </div>
      <div class="hint-box"><strong>当前草稿</strong><p>{$curriculumStore.draft}</p></div>
    </aside>
  </div>

  {#if browser}
    <section class="batch-panel">
      <div class="batch-grid">
        <div class="panel batch-card">
          <div class="panel-head"><h3>修订批次</h3><span class="muted">冻结节点 / 连边 / 审阅状态</span></div>
          <dl class="batch-meta">
            <div><dt>批次号</dt><dd>{$curriculumStore.batchId ?? '未建立'}</dd></div>
            <div><dt>版本</dt><dd>{$curriculumStore.revision}</dd></div>
            <div><dt>冻结时间</dt><dd>{currentBatch ? new Date(currentBatch.createdAt).toLocaleString('zh-CN') : '—'}</dd></div>
            <div><dt>批次状态</dt><dd>{currentBatch?.upgraded ? '旧草稿兼容升级' : '新建批次'}{currentBatch?.status === 'merged' ? ' · 已合并' : ' · 进行中'}</dd></div>
            <div><dt>最近合并</dt><dd>{$curriculumStore.mergeRounds.length ? `${$curriculumStore.mergeRounds.at(-1)?.applied} 条已合并 / ${$curriculumStore.mergeRounds.at(-1)?.conflicts} 条待确认` : '尚未合并'}</dd></div>
          </dl>
          <div class="card-actions">
            <button class="btn-secondary" onclick={() => curriculumStore.createBatch()}>建立修订批次</button>
          </div>
        </div>

        <div class="panel batch-card">
          <div class="panel-head"><h3>补录与回网</h3><span class="muted">当前角色：{$curriculumStore.actor === 'owner' ? '课程负责人' : '院系审阅人'}</span></div>
          <label class="force-fail"><input type="checkbox" bind:checked={forceFail} /> 模拟回网失败（服务端未确认，保留现场可重试）</label>
          <div class="card-actions">
            {#if $curriculumStore.online}
              <button class="btn-primary" onclick={() => curriculumStore.mergeChanges(forceFail)} disabled={$curriculumStore.outbox.length === 0}>回网合并（{$curriculumStore.outbox.length} 条待回传）</button>
            {:else}
              <button class="btn-secondary" disabled>断网补录中 · {$curriculumStore.outbox.length} 条待回传</button>
            {/if}
          </div>
          {#if $curriculumStore.mergeError}
            <div class="merge-error">
              <strong>合并失败，现场已保留</strong>
              <p>{$curriculumStore.mergeError}</p>
              <button class="btn-primary" onclick={() => curriculumStore.mergeChanges(forceFail)}>重试合并</button>
            </div>
          {/if}
        </div>

        <div class="panel batch-card">
          <div class="panel-head"><h3>待回传变更</h3><span class="muted">按条目合并，不覆盖</span></div>
          {#if $curriculumStore.outbox.length === 0}
            <div class="card-empty">断网补录的映射、证据和审阅意见会先存放在这里，回网后按条目合并。</div>
          {:else}
            <ul class="change-list">
              {#each $curriculumStore.outbox as ch}
                <li>
                  <span class="actor-badge" class:owner={ch.actor === 'owner'}>{ch.actor === 'owner' ? '负责人' : '审阅人'}</span>
                  <span class="change-type">{ch.itemType === 'node' ? '节点' : ch.itemType === 'mapping' ? '连边' : '审阅'}</span>
                  <code>{ch.itemId}</code>
                  <span class="op">{ch.op === 'add' ? '新增' : ch.op === 'update' ? '修改' : '删除'}</span>
                  <span class="change-status" class:conflict={ch.status === 'conflict'}>{ch.status === 'conflict' ? '待确认' : '待回传'}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="panel batch-card">
          <div class="panel-head"><h3>待确认冲突</h3><span class="muted">双方都改过的条目</span></div>
          {#if $curriculumStore.conflicts.length === 0}
            <div class="card-empty">无冲突条目。双方修改同一条目时在此列出，确认后才会采用。</div>
          {:else}
            {#each $curriculumStore.conflicts as conflict}
              <div class="conflict-item">
                <strong>{conflict.itemType === 'node' ? '节点' : conflict.itemType === 'mapping' ? '连边' : '审阅'} {conflict.itemId}</strong>
                <div class="conflict-versions">
                  <div><span class="actor-badge owner">负责人</span><pre>{JSON.stringify(conflict.ownerChange?.after ?? conflict.ownerChange?.before, null, 2)}</pre></div>
                  <div><span class="actor-badge reviewer">审阅人</span><pre>{JSON.stringify(conflict.reviewerChange?.after ?? conflict.reviewerChange?.before, null, 2)}</pre></div>
                </div>
                <div class="card-actions">
                  <button class="btn-secondary" onclick={() => curriculumStore.resolveConflict(conflict.key, 'owner')}>采用负责人版本</button>
                  <button class="btn-secondary" onclick={() => curriculumStore.resolveConflict(conflict.key, 'reviewer')}>采用审阅人版本</button>
                </div>
              </div>
            {/each}
          {/if}
        </div>

        <div class="panel batch-card">
          <div class="panel-head"><h3>失效审阅结论</h3><span class="muted">映射/证据变更触发重算</span></div>
          {#if $curriculumStore.invalidations.length === 0}
            <div class="card-empty">暂无失效结论。映射或证据变更后，原审阅结论会作废并可追溯。</div>
          {:else}
            <ul class="invalidation-list">
              {#each $curriculumStore.invalidations as inv}
                <li><code>{inv.reviewId}</code><span>{inv.reason}</span><small class="muted">{new Date(inv.at).toLocaleString('zh-CN')}</small></li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="panel batch-card">
          <div class="panel-head"><h3>导出记录</h3><span class="muted">导出结果绑定批次</span></div>
          {#if $curriculumStore.exports.length === 0}
            <div class="card-empty">导出课程地图时文件名与内容都会带上批次号。</div>
          {:else}
            <ul class="export-list">
              {#each $curriculumStore.exports as exp}
                <li><code>{exp.filename}</code><small class="muted">{new Date(exp.exportedAt).toLocaleString('zh-CN')} · 批次 {exp.batchId}</small></li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</section>

<style>
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions a { text-decoration: none; }
  .overview-grid { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 14px; }
  .chain { padding: 16px; }
  .chain article { padding: 14px; border-left: 4px solid #347d7b; background: #f5f8f8; }
  .chain article + article { margin-top: 12px; }
  .node-title { font-weight: 800; }
  .chain p { margin: 5px 0 12px; color: #6f7d83; font-size: 12px; }
  .arrow { color: #6b8a8b; font-size: 18px; }
  .requirements { display: grid; gap: 7px; margin-top: 9px; }
  .requirements div { display: flex; justify-content: space-between; padding: 8px 10px; border: 1px solid #dce6e5; border-radius: 6px; background: white; font-size: 12px; }
  .requirements span { color: #537579; }
  .issue-list { padding: 8px 16px 16px; }
  .issue-list article { position: relative; padding: 12px 0; border-bottom: 1px solid #edf0f0; }
  .issue-list article strong { color: #9c6d25; font-size: 13px; }
  .issue-list article.error strong { color: #ac4433; }
  .issue-list p { margin: 5px 0 0; color: #68767d; font-size: 12px; line-height: 1.5; }
  .issue-list article > span { position: absolute; top: 12px; right: 0; color: #809096; font-size: 10px; }
  .empty { padding: 22px 0; color: #3d7b63; font-size: 12px; }
  .hint-box { margin: 0 16px 16px; padding: 13px; border-left: 3px solid #cd813a; background: #fff6e9; }
  .hint-box strong { font-size: 12px; }
  .hint-box p { margin: 6px 0 0; color: #6c6256; font-size: 11px; line-height: 1.5; }
  .notice { margin-bottom: 14px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; font-size: 13px; }
  .notice.upgrade { border-color: #cd813a; color: #7a5223; background: #fff6e9; }
  .batch-panel { margin-top: 16px; }
  .batch-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: start; }
  .batch-card { min-width: 0; }
  .batch-meta { display: grid; gap: 9px; padding: 14px 16px; margin: 0; }
  .batch-meta div { display: grid; grid-template-columns: 74px 1fr; gap: 8px; align-items: baseline; }
  .batch-meta dt { color: #839096; font-size: 11px; }
  .batch-meta dd { margin: 0; color: #25434b; font-size: 12px; word-break: break-all; }
  .card-actions { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 16px 14px; }
  .card-empty { padding: 16px; color: #839096; font-size: 12px; line-height: 1.6; }
  .force-fail { display: flex; align-items: center; gap: 8px; padding: 12px 16px 0; color: #6c6256; font-size: 12px; font-weight: 400; }
  .force-fail input { width: auto; }
  .merge-error { margin: 12px 16px 14px; padding: 12px; border: 1px solid #e5b8a8; border-radius: 8px; background: #fff1ec; }
  .merge-error strong { color: #a54431; font-size: 12px; }
  .merge-error p { margin: 6px 0 10px; color: #913c2b; font-size: 11px; line-height: 1.5; }
  .change-list, .invalidation-list, .export-list { display: grid; gap: 8px; padding: 12px 16px; margin: 0; list-style: none; }
  .change-list li { display: flex; align-items: center; gap: 8px; font-size: 11px; }
  .change-list code, .invalidation-list code, .export-list code { padding: 2px 6px; border-radius: 4px; background: #eef2f2; font-size: 10px; }
  .actor-badge { padding: 2px 6px; border-radius: 4px; color: #537579; background: #e7eff0; font-size: 10px; }
  .actor-badge.owner { color: #2e7359; background: #e7f4ec; }
  .actor-badge.reviewer { color: #9b5a25; background: #fff0de; }
  .change-type { color: #839096; }
  .op { color: #6c6256; }
  .change-status { margin-left: auto; color: #b45c34; }
  .change-status.conflict { color: #a54431; font-weight: 700; }
  .conflict-item { padding: 12px 16px; border-bottom: 1px solid #edf0f0; }
  .conflict-item strong { font-size: 12px; }
  .conflict-versions { display: grid; gap: 8px; margin: 9px 0; }
  .conflict-versions > div { display: grid; gap: 4px; }
  .conflict-versions pre { margin: 0; padding: 8px; overflow: auto; border-radius: 6px; background: #f6f8f7; font-size: 10px; line-height: 1.5; }
  .invalidation-list li { display: grid; gap: 4px; font-size: 11px; color: #6c6256; }
  .export-list li { display: grid; gap: 2px; font-size: 11px; }
  @media (max-width: 1100px) { .batch-grid { grid-template-columns: 1fr; } }
  @media (max-width: 1000px) { .overview-grid { grid-template-columns: 1fr; } }
</style>
