import { detectPoseHints } from '../lib/zh-intent.js'
for (const t of ['少女跪趴回头，从正后方俯拍', '正后方', '从正后方拍', '跪在床边', '从背后看']) {
  console.log(t, '=>', JSON.stringify(detectPoseHints(t)))
}
