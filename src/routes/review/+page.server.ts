import { fail } from '@sveltejs/kit'
import { revisionSchema } from '$lib/schema'

export const actions = {
  // 无 JS 兜底：仅做服务端 Zod 校验。
  // 正常路径下修订由前端 enhance 拦截并进入修订批次（可断网补录、回网按条目合并）。
  submitRevision: async ({ request }) => {
    const form = await request.formData()
    const parsed = revisionSchema.safeParse({
      courseId: form.get('courseId'),
      requirementId: form.get('requirementId'),
      evidence: form.get('evidence'),
      revisionNote: form.get('revisionNote'),
      submitter: form.get('submitter'),
    })
    if (!parsed.success) {
      return fail(400, { errors: parsed.error.flatten().fieldErrors, values: Object.fromEntries(form) })
    }
    return { success: true, item: { id: `REV-${Date.now().toString().slice(-4)}` } }
  },
}
