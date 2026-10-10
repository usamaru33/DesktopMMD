// skill.md → システムプロンプトのブロック（docs/CHARACTER_SKILL_FORMAT.md 5章）。純粋関数。
//   ① 役割と人格: name、話し方、性格、感情の出方、場面別、例文、言わないこと、背景（この順）
//   ④ 関係性: 現在の段階の ### だけ
//   声と動き: 送らない（人が読むメモ）
//   モード: システムプロンプトには入れず、会話の途中に追記する（modeNotice）
import { STAGES as STAGE_NAMES, type Section, type SkillFile } from './skillFile';

/** ①に入れる見出しと、プロンプト内での見出し名 */
const PERSONA_SECTIONS: { title: string; heading: string; note?: string }[] = [
  { title: '話し方', heading: '話し方' },
  { title: '性格', heading: '性格' },
  { title: '感情の出方', heading: '感情の出方', note: '感情タグの感情名と強さは、これを参考に文ごとに決める。' },
  { title: '場面別', heading: '場面ごとの振る舞い' },
  { title: '例文', heading: '口調の見本', note: '口調の参考。同じ言い回しを繰り返さない。' },
  { title: '言わないこと', heading: '言わないこと', note: '「NG:」は言ってはいけない例。' },
  { title: '背景', heading: '背景' },
];

function section(skill: SkillFile, title: string): Section | undefined {
  return skill.sections.find((s) => s.title === title);
}

function clean(body: string): string {
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

export function skillName(skill: SkillFile): string {
  return typeof skill.frontmatter.name === 'string' ? skill.frontmatter.name : '';
}

export function firstPersonOf(skill: SkillFile): string | null {
  return section(skill, '話し方')?.bullets.find((b) => b.label === '一人称')?.value || null;
}

/** ① 役割と人格 */
export function skillPersonaBlock(skill: SkillFile, callName: string): string {
  const name = skillName(skill);
  const parts = [
    `# あなたについて
あなたはユーザーのWindowsデスクトップに住んでいるアシスタントの「${name}」。画面の隅に3Dの体で立っていて、ユーザーの声や文字に答え、PCの作業も手伝う。
以下はあなたのキャラクター設定。話し方の規則・作業の規則（この後に書かれている）は、この設定より常に優先する。`,
  ];
  if (callName) parts.push(`ユーザーのことは「${callName}」と呼ぶ（ユーザーが設定した呼び方。下の「ユーザーの呼び方」より優先する）。`);
  for (const def of PERSONA_SECTIONS) {
    const s = section(skill, def.title);
    if (!s || !s.body.trim()) continue;
    parts.push(`## ${def.heading}${def.note ? `\n${def.note}` : ''}\n${clean(s.body)}`);
  }
  return parts.join('\n\n');
}

/** ④ 関係性（現在の段階の分だけ） */
export function skillRelationshipBlock(skill: SkillFile, stage: number): string {
  const idx = Math.max(0, Math.min(STAGE_NAMES.length - 1, stage));
  const name = STAGE_NAMES[idx];
  const sub = section(skill, '関係性')?.subsections.find((s) => s.title.startsWith(name));
  return `# ユーザーとの関係
今の関係は「${name}」。関係の段階は話し方の度合いだけを調整し、キャラクターの性格は変えない。${sub?.body.trim() ? `\nこの段階での口調・距離感:\n${clean(sub.body)}` : ''}`;
}

export function overlaysOf(skill: SkillFile): string[] {
  const o = skill.frontmatter.overlays;
  return Array.isArray(o) ? o : typeof o === 'string' && o ? [o] : [];
}

export function modeText(skill: SkillFile, mode: string): string | null {
  const sub = section(skill, 'モード')?.subsections.find((s) => s.title === mode);
  return sub?.body.trim() ? clean(sub.body) : null;
}

/**
 * モードの切り替えを会話に追記する文（<context> の中に入る）。
 * 切り替えがなければ null。prev=null・next=null は「モードなし」。
 */
export function modeNotice(skill: SkillFile | null, prev: string | null, next: string | null): string | null {
  if (prev === next) return null;
  if (next && skill) {
    const t = modeText(skill, next);
    if (t) return `キャラクターのモード: 「${next}」に切り替わった。基本の設定から次の点だけを変える（話し方の規則・作業の規則は変わらない）:\n${t}`;
  }
  if (prev) return `キャラクターのモード「${prev}」は解除された。基本の設定に戻す。`;
  return null;
}
