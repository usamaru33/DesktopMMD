// skill.md のローダー。characters/<id>/skill.md を読み、検証し、更新日時でキャッシュする。
// エラーのある skill.md は使わず、character.json の persona にフォールバックする（docs 5章・9章）。
import fs from 'node:fs';
import path from 'node:path';
import type { SkillStatus } from '@shared/types';
import { type SkillFile, validateSkill } from './skillFile';
import { overlaysOf, skillName } from './skillPrompt';

export interface LoadedSkill {
  status: SkillStatus;
  /** 使える（エラーなし）ときだけ入る */
  skill: SkillFile | null;
}

export class CharacterSkillService {
  private cache = new Map<string, { mtimeMs: number; size: number; loaded: LoadedSkill }>();

  constructor(private readonly folderOf: (id: string) => string) {}

  pathOf(id: string): string {
    return path.join(this.folderOf(id), 'skill.md');
  }

  /** ファイルが変わっていなければキャッシュを返す。新しいセッションの開始時に呼べば、編集が次のセッションから反映される。 */
  load(id: string): LoadedSkill {
    const file = this.pathOf(id);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.cache.delete(id);
      return { status: { state: 'none', path: file, name: null, version: null, chars: 0, overlays: [], issues: [] }, skill: null };
    }
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.loaded;

    let loaded: LoadedSkill;
    try {
      const src = fs.readFileSync(file, 'utf8');
      const { skill, issues, chars } = validateSkill(src, { folderName: id });
      const errors = issues.filter((i) => i.level === 'error');
      loaded = {
        skill: errors.length ? null : skill,
        status: {
          state: errors.length ? 'invalid' : 'ok',
          path: file,
          name: skillName(skill) || null,
          version: typeof skill.frontmatter.version === 'string' ? skill.frontmatter.version : null,
          chars,
          overlays: overlaysOf(skill),
          issues: issues.map((i) => ({ level: i.level, line: i.line, message: i.message })),
        },
      };
    } catch (e) {
      loaded = {
        skill: null,
        status: { state: 'invalid', path: file, name: null, version: null, chars: 0, overlays: [], issues: [{ level: 'error', line: 0, message: `読み込めませんでした: ${(e as Error).message}` }] },
      };
    }
    this.cache.set(id, { mtimeMs: st.mtimeMs, size: st.size, loaded });
    return loaded;
  }

  invalidate(id?: string): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }
}

export interface DraftSource {
  id: string;
  name: string;
  firstPerson: string;
  persona: string;
  speechExamples: string[][];
}

/**
 * テンプレートから skill.md の下書きを作る（character.json からの移行の手助け）。
 * 名前・一人称・関係性（speechExamples）を埋め、persona は書き直しの材料としてコメントで残す。
 * 埋まっていない必須項目があるので、そのままでは検証エラーになる（＝書き終えるまで使われない）。
 */
export function draftSkillFromTemplate(template: string, src: DraftSource): string {
  let out = template.replace(/^id:\s*$/m, `id: ${src.id}`).replace(/^name:\s*$/m, `name: ${src.name}`);
  out = out.replace(/^- 一人称:\s*$/m, `- 一人称: ${src.firstPerson}`);
  const stages = ['初対面', '顔なじみ', '親しい', '相棒'];
  stages.forEach((st, i) => {
    const ex = src.speechExamples[i] ?? [];
    if (!ex.length) return;
    out = out.replace(new RegExp(`^### ${st}\\s*$`, 'm'), `### ${st}\n\n<!-- 以前の設定の話し方の例: ${ex.join(' / ').replace(/--/g, '—')} -->`);
  });
  if (src.persona.trim()) {
    out = out.replace(
      /^## 話し方\s*$/m,
      `<!--\n以前の「性格と口調」（character.json の persona）。「話し方」と「性格」に分けて書き直してください:\n${src.persona.replace(/--/g, '—')}\n-->\n\n## 話し方`,
    );
  }
  return out;
}
