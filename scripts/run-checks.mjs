// 统一运行引擎与 store 两层场景验证（无需额外测试框架）。
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// 输出到工作区内：store-check 需要能从产物解析到 esbuild 包。
const targets = ['scripts/engine-check.ts', 'scripts/store-check.ts']
for (const target of targets) {
  const out = `./.tmp-${target.split('/').pop().replace('.ts', '.mjs')}`
  await build({
    entryPoints: [target],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['esbuild'],
    outfile: out,
  })
  console.log(`\n=== ${target} ===`)
  execFileSync(process.execPath, [out], { stdio: 'inherit' })
  rmSync(out, { force: true })
}
