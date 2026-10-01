<script lang="ts">
  import { enhance } from '$app/forms'
  import { curriculumStore } from '$lib/stores'
  import { revisionSchema } from '$lib/schema'

  let selectedIds = $state<string[]>([])
  let reviewComments = $state<Record<string, string>>({})
  let evidenceDrafts = $state<Record<string, string>>({})
  let notice = $state<{ kind: 'success' | 'error'; text: string } | null>(null)

  const view = $derived($curriculumStore.view)
  const pending = $derived(view.reviewItems.filter((item) => item.status === '待审阅'))
  const courseNames = $derived(view.nodes.filter((node) => node.type === '课程'))
  const requirements = $derived(view.nodes.filter((node) => node.type === '毕业要求'))
  const historyFor = (id: string) => $curriculumStore.server.history.filter((item) => item.reviewId === id)

  function review(item: (typeof view.reviewItems)[number], status: '已附议' | '已退回') {
    curriculumStore.updateReview(
      item.id,
      status,
      reviewComments[item.id] || (status === '已附议' ? '证据充分，同意纳入修订。' : '请补充可验证的评分记录。'),
    )
    notice = { kind: 'success', text: `${item.id} 的${status}意见已进入「{$curriculumStore.activeBatch?.id ?? '当前批次'}」，回网后按条目合并。` }
  }

  function onlineReview(item: (typeof view.reviewItems)[number]) {
    curriculumStore.onlineReviewDecision(item.id, '已退回', '在线退回：请先补充评分记录后再提交。')
    notice = { kind: 'success', text: `已模拟院系审阅人在另一台设备在线退回 ${item.id}（用于演示双方并发）。` }
  }

  function saveEvidence(id: string) {
    const text = (evidenceDrafts[id] ?? '').trim()
    if (text.length < 12) {
      notice = { kind: 'error', text: '证据补充至少 12 个字符。' }
      return
    }
    curriculumStore.updateReviewEvidence(id, text)
    evidenceDrafts[id] = ''
    notice = { kind: 'success', text: `${id} 证据已补录进批次；回网后该审阅结论会自动失效重算。` }
  }

  function bulkApprove() {
    selectedIds.forEach((id) => curriculumStore.updateReview(id, '已附议', '批量附议：证据链完整。'))
    selectedIds = []
  }

  // 提交修订：先走 Zod 校验并进入修订批次（断网也能提交）；同时保留 Form Action 作为服务端兜底
  function handleSubmit({ formData, cancel }: { formData: FormData; cancel: () => void }) {
    const parsed = revisionSchema.safeParse({
      courseId: formData.get('courseId'),
      requirementId: formData.get('requirementId'),
      evidence: formData.get('evidence'),
      revisionNote: formData.get('revisionNote'),
      submitter: formData.get('submitter'),
    })
    if (!parsed.success) {
      notice = { kind: 'error', text: `表单未通过校验：${Object.values(parsed.error.flatten().fieldErrors).flat().join('；')}` }
      cancel()
      return
    }
    const id = curriculumStore.submitReviewItem(parsed.data)
    notice = { kind: 'success', text: `修订 ${id} 已进入「${$curriculumStore.activeBatch?.title ?? '当前批次'}」补录队列，进入院系审阅队列。` }
    cancel()
  }
</script>

<svelte:head><title>课程改革审阅</title></svelte:head>

<section class="page">
  <div class="page-head">
    <div><p class="eyebrow">REFORM REVIEW / 改革审阅</p><h1>修订提交与逐项审阅</h1><p class="muted">证据与审阅意见都按条目进入修订批次；映射或证据一变，结论自动失效重算，旧结论可追溯。</p></div>
    <div class="actions"><button class="btn-secondary" disabled={selectedIds.length === 0} onclick={bulkApprove}>批量附议 {selectedIds.length ? `(${selectedIds.length})` : ''}</button><button class="btn-secondary" onclick={() => window.print()}>打印审阅单</button></div>
  </div>

  {#if $curriculumStore.activeBatch}
    <div class="batch-strip" class:offline={!$curriculumStore.online}>
      <strong>批次 {$curriculumStore.activeBatch.id}</strong>
      <span>{$curriculumStore.activeBatch.title}</span>
      <span>{$curriculumStore.online ? '在线' : '断网补录中'}</span>
      <span>排队 {$curriculumStore.pendingCount} · 待确认 {$curriculumStore.conflictCount} · 失败 {$curriculumStore.failedCount}</span>
      <a href="/batches">合并 / 冲突处理 →</a>
    </div>
  {/if}

  {#if notice}
    <div class="notice {notice.kind === 'success' ? 'success' : 'error'}">{notice.text}<button onclick={() => (notice = null)}>×</button></div>
  {/if}

  <div class="review-layout">
    <section class="panel">
      <div class="panel-head"><h3>审阅队列</h3><span class="muted">{pending.length} 项待处理 · {$curriculumStore.server.history.length} 条历史结论</span></div>
      <div class="review-list">
        {#each view.reviewItems as item}
          {@const history = historyFor(item.id)}
          <article class:selected={selectedIds.includes(item.id)}>
            <div class="select"><input type="checkbox" checked={selectedIds.includes(item.id)} onchange={(event) => selectedIds = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id)} /></div>
            <div class="review-main">
              <div class="review-title">
                <strong>{item.id} · {courseNames.find((node) => node.id === item.courseId)?.label.split('\n')[0]}</strong>
                <span class:approved={item.status === '已附议'} class:returned={item.status === '已退回'} class:pending={item.status === '待审阅'}>
                  {item.status}{#if item.stale} · 依据已变待重算{/if}
                </span>
              </div>
              <p>{item.evidence}</p>
              <small>对应 {requirements.find((node) => node.id === item.requirementId)?.label.split('\n')[0]} · {item.submitter} 提交{#if item.reviewer} · 最近结论：{item.reviewer}{/if}</small>

              {#if history.length > 0}
                <details class="history">
                  <summary>历史审阅结论（{history.length}）</summary>
                  {#each [...history].reverse() as decision}
                    <div>
                      <b class={decision.status === '已附议' ? 'ok' : 'bad'}>{decision.status}</b>
                      <span>{decision.comment}</span>
                      <small>{decision.reviewer} · {decision.decidedAt.slice(0, 16).replace('T', ' ')} · {decision.reason} · 指纹 {decision.basisHash}</small>
                    </div>
                  {/each}
                </details>
              {/if}

              <div class="evidence-box">
                <input bind:value={evidenceDrafts[item.id]} placeholder="课程负责人补录证据（≥12 字），回网后旧结论自动失效" />
                <button class="btn-secondary" onclick={() => saveEvidence(item.id)}>补录证据</button>
              </div>

              {#if item.status === '待审阅'}
                <div class="review-actions">
                  <input bind:value={reviewComments[item.id]} placeholder="填写附议或退回意见（断网也能保存）" />
                  <button class="btn-primary" onclick={() => review(item, '已附议')}>附议</button>
                  <button class="btn-danger" onclick={() => review(item, '已退回')}>退回补充</button>
                  <button class="btn-secondary" title="模拟院系审阅人此刻在另一台设备在线操作" onclick={() => onlineReview(item)}>在线退回(演练)</button>
                </div>
              {:else}
                <div class:returned={item.status === '已退回'} class="decision">
                  审阅意见：{item.comment}
                  {#if item.stale}<em>映射/证据已变更，该结论已在本地标记失效，回网合并后重算。</em>{/if}
                </div>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>

    <aside class="panel">
      <div class="panel-head"><h3>提交课程修订</h3><span class="muted">校验后进入批次</span></div>
      <form method="POST" action="?/submitRevision" use:enhance={handleSubmit}>
        <label>课程<select name="courseId">{#each courseNames as course}<option value={course.id}>{course.id} · {course.label.split('\n')[0]}</option>{/each}</select></label>
        <label>毕业要求<select name="requirementId">{#each requirements as requirement}<option value={requirement.id}>{requirement.id} · {requirement.label.split('\n')[0]}</option>{/each}</select></label>
        <label>证据说明<textarea name="evidence" rows="4" placeholder="说明教学活动、考核记录与达成证据"></textarea></label>
        <label>修订说明<textarea name="revisionNote" rows="3" placeholder="说明本轮为什么调整映射或证据"></textarea></label>
        <label>提交人<input name="submitter" placeholder="课程负责人姓名" /></label>
        <button class="btn-primary" type="submit">提交院系审阅{!$curriculumStore.online ? '（断网排队）' : ''}</button>
      </form>
      <div class="version-compare">
        <strong>{$curriculumStore.activeBatch ? `批次 ${$curriculumStore.activeBatch.id}（基线 ${$curriculumStore.activeBatch.baseRevision}）` : '尚无活跃批次'}</strong>
        <div><span>冻结节点</span><b>{$curriculumStore.activeBatch?.snapshot.nodes.length ?? '—'}</b></div>
        <div><span>冻结连边</span><b>{$curriculumStore.activeBatch?.snapshot.mappings.length ?? '—'}</b></div>
        <div><span>冻结审阅</span><b>{$curriculumStore.activeBatch?.snapshot.reviews.length ?? '—'}</b></div>
        <div><span>补录条目</span><b>{$curriculumStore.activeBatch?.entries.length ?? 0}</b></div>
      </div>
    </aside>
  </div>
</section>

<style>
  .actions { display: flex; gap: 8px; }
  .batch-strip { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; padding: 10px 14px; border: 1px solid #b8d3d1; border-radius: 8px; color: #27565a; background: #e9f3f2; font-size: 12px; }
  .batch-strip.offline { border-color: #e0b98d; color: #8a5a23; background: #fff5e8; }
  .batch-strip a { margin-left: auto; color: #2f6f72; font-weight: 700; }
  .notice { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; padding: 12px 14px; border-left: 3px solid #3f8869; color: #27634d; background: #ebf6f0; font-size: 12px; }
  .notice.error { border-color: #bd4d35; color: #913c2b; background: #fff1ec; }
  .notice button { border: 0; background: transparent; cursor: pointer; font-size: 15px; color: inherit; }
  .review-layout { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
  .review-list { padding: 8px 16px 16px; }
  .review-list article { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid #e8eded; }
  .review-list article.selected { background: #f4f8f7; }
  .review-title { display: flex; justify-content: space-between; gap: 10px; }
  .review-title span { padding: 3px 6px; border-radius: 5px; color: #9b5a25; background: #fff0de; font-size: 10px; }
  .review-title span.approved { color: #2e7359; background: #e7f4ec; }
  .review-title span.returned { color: #a94331; background: #ffebe6; }
  .review-title span.pending { color: #34637c; background: #e9f1f6; }
  .review-main p { margin: 7px 0; color: #5f6e74; font-size: 12px; line-height: 1.55; }
  .review-main small { color: #839096; }
  .review-actions { display: flex; gap: 7px; margin-top: 10px; flex-wrap: wrap; }
  .review-actions input { flex: 1; min-width: 200px; }
  .review-actions button { white-space: nowrap; }
  .evidence-box { display: flex; gap: 7px; margin-top: 9px; }
  .decision { margin-top: 9px; padding: 8px; color: #2f6f58; background: #edf7f1; font-size: 11px; }
  .decision.returned { color: #a54431; background: #fff0ec; }
  .decision em { display: block; margin-top: 5px; color: #a56a23; font-style: normal; }
  .history { margin-top: 8px; font-size: 11px; }
  .history summary { cursor: pointer; color: #5f7d80; }
  .history > div { display: grid; gap: 2px; margin-top: 6px; padding: 7px 8px; border-left: 2px solid #c7d6d5; background: #f6f9f8; }
  .history b.ok { color: #2e7359; }
  .history b.bad { color: #a94331; }
  .history span { color: #4c5f66; }
  .history small { color: #8a969b; }
  form { display: grid; gap: 12px; padding: 16px; }
  form button { margin-top: 3px; }
  .version-compare { margin: 0 16px 16px; padding: 12px; border: 1px solid #dbe3e3; border-radius: 8px; background: #f6f8f7; }
  .version-compare strong { display: block; margin-bottom: 9px; font-size: 12px; }
  .version-compare div { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; color: #66757b; font-size: 10px; }
  .version-compare b { color: #2e7359; }
  @media (max-width: 1050px) { .review-layout { grid-template-columns: 1fr; } }
</style>
