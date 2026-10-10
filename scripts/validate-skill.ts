// キャラクタースキル（skill.md）の検証。
//   npx tsx scripts/validate-skill.ts characters/sample/skill.md [ほかのファイル...] [--strict]
// エラーが1件でもあれば終了コード 1。--strict のときは警告でも 1。
// 仕様: docs/CHARACTER_SKILL_FORMAT.md
import fs from 'node:fs';
import path from 'node:path';
import { LENGTH, validateSkill } from '../src/main/character/skillFile';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.log('使い方: npx tsx scripts/validate-skill.ts <skill.md> [...] [--strict]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`✗ ${file}: ファイルがありません`);
    failed = true;
    continue;
  }
  const folderName = path.basename(path.dirname(path.resolve(file)));
  const { issues, chars } = validateSkill(fs.readFileSync(file, 'utf8'), { folderName });
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const ok = errors.length === 0 && (!strict || warnings.length === 0);
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${file}  エラー ${errors.length} 件 / 警告 ${warnings.length} 件 / 本文 ${chars} 文字（推奨 ${LENGTH.recommendedMin}〜${LENGTH.recommendedMax}）`);
  for (const i of issues) {
    const where = i.line > 0 ? `${file}:${i.line}` : file;
    console.log(`  ${i.level === 'error' ? 'エラー' : '警告  '} ${where}  [${i.code}] ${i.message}`);
  }
}
process.exit(failed ? 1 : 0);
