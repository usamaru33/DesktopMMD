// キャラクタースキル（characters/<id>/skill.md）の読み取りと検証。
// 仕様: docs/CHARACTER_SKILL_FORMAT.md。プロンプトへの差し込み（ローダー本体）はまだ実装していない。
// Electron に依存しない純粋な処理にして、検証スクリプトとテストから直接使う。
// tsx で単体実行できるよう、ここだけは @shared の別名を使わず相対パスで読む
import { EMOTIONS, type Emotion } from '../../shared/emotions';

// ---------------- 定義 ----------------

/** 本文の見出し（この名前・この順序で固定）。required=false は任意見出し。 */
export const SECTIONS = [
  { title: '話し方', required: true },
  { title: '性格', required: true },
  { title: '感情の出方', required: true },
  { title: '場面別', required: true },
  { title: '関係性', required: true },
  { title: '例文', required: true },
  { title: '言わないこと', required: true },
  { title: '声と動き', required: false },
  { title: '背景', required: false },
  { title: 'モード', required: false },
] as const;

export type SectionTitle = (typeof SECTIONS)[number]['title'];

/** 箇条書きの項目名。required は「書かないとエラー」。 */
export const SPEECH_ITEMS = { required: ['一人称', 'ユーザーの呼び方', '文体', '1回の長さの目安'], optional: ['語尾・口癖', '相槌', '笑い方'] };
export const PERSONALITY_ITEMS = { required: ['基本気質'], optional: ['価値観', '得意な話題', '苦手な話題'] };
export const SCENES = ['雑談', '質問への回答', '作業依頼', '失敗したとき', '承認を求めるとき', '能動発話', 'おやすみ'] as const;
export const STAGES = ['初対面', '顔なじみ', '親しい', '相棒'] as const;
export const FRONTMATTER_REQUIRED = ['id', 'name', 'version', 'summary', 'language'] as const;

/** 文字数（空白・改行・コメントを除く本文）。仕様書の「文字数の目安」と一致させる。 */
export const LENGTH = { min: 1000, recommendedMin: 1500, recommendedMax: 2500, hardMax: 4000 };
export const EXAMPLES = { min: 3, max: 5 };

// ---------------- 解析結果の型 ----------------

export interface Bullet {
  label: string; // 「一人称」「happy」「雑談」など（コロンの前）
  value: string; // コロンの後
  line: number;
}

export interface Section {
  title: string;
  line: number;
  body: string; // 見出しを除いた本文（コメント除去済み）
  bullets: Bullet[];
  subsections: { title: string; line: number; body: string; bullets: Bullet[] }[];
}

export interface SkillFile {
  frontmatter: Record<string, string | string[]>;
  frontmatterLine: number; // 本文の開始行（1始まり）
  sections: Section[];
  /** コメントを除いた本文（文字数・禁止指示の検査用） */
  body: string;
}

export interface Issue {
  level: 'error' | 'warning';
  line: number; // 1始まり。0 はファイル全体
  code: string;
  message: string;
}

// ---------------- 解析 ----------------

/** HTMLコメントを、行番号が変わらないよう改行だけ残して消す */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

function parseFrontmatter(lines: string[]): { fm: Record<string, string | string[]>; end: number } | null {
  if (lines[0]?.trim() !== '---') return null;
  const fm: Record<string, string | string[]> = {};
  let key: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '---') return { fm, end: i + 1 };
    const item = /^\s+-\s*(.+?)\s*$/.exec(raw);
    if (item && key) {
      const cur = fm[key];
      fm[key] = [...(Array.isArray(cur) ? cur : []), unquote(item[1])];
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].replace(/\s+#.*$/, '');
    if (/^\[.*\]$/.test(v)) {
      fm[key] = v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
    } else fm[key] = unquote(v);
  }
  return { fm, end: -1 }; // 閉じの --- が無い
}

function unquote(s: string): string {
  return s.replace(/^["'](.*)["']$/, '$1');
}

const BULLET_RE = /^\s*[-*]\s+(.+?)\s*[:：]\s*(.*)$/;

function bulletsOf(lines: { text: string; line: number }[]): Bullet[] {
  const out: Bullet[] = [];
  for (const { text, line } of lines) {
    const m = BULLET_RE.exec(text);
    if (m) out.push({ label: m[1].trim(), value: m[2].trim(), line });
  }
  return out;
}

export function parseSkill(source: string): { skill: SkillFile; issues: Issue[] } {
  const issues: Issue[] = [];
  const text = stripComments(source.replace(/\r\n/g, '\n').replace(/^﻿/, ''));
  const lines = text.split('\n');
  const fmr = parseFrontmatter(lines);
  let start = 0;
  let fm: Record<string, string | string[]> = {};
  if (!fmr) {
    issues.push({ level: 'error', line: 1, code: 'frontmatter', message: '先頭に YAML フロントマター（--- で囲む）がありません' });
  } else if (fmr.end < 0) {
    issues.push({ level: 'error', line: 1, code: 'frontmatter', message: 'フロントマターの閉じの --- がありません' });
    fm = fmr.fm;
    start = lines.length;
  } else {
    fm = fmr.fm;
    start = fmr.end;
  }

  const sections: Section[] = [];
  let cur: Section | null = null;
  let sub: Section['subsections'][number] | null = null;
  let curLines: { text: string; line: number }[] = [];
  let subLines: { text: string; line: number }[] = [];
  const flushSub = () => {
    if (sub) {
      sub.bullets = bulletsOf(subLines);
      sub.body = subLines.map((l) => l.text).join('\n').trim();
    }
    sub = null;
    subLines = [];
  };
  const flush = () => {
    flushSub();
    if (cur) {
      cur.bullets = bulletsOf(curLines);
      cur.body = curLines.map((l) => l.text).join('\n').trim();
      sections.push(cur);
    }
    cur = null;
    curLines = [];
  };
  for (let i = start; i < lines.length; i++) {
    const t = lines[i];
    const n = i + 1;
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(t);
    const h3 = /^###\s+(.+?)\s*#*\s*$/.exec(t);
    if (h2 && !h3) {
      flush();
      cur = { title: h2[1].replace(/（任意）|\(任意\)/, '').trim(), line: n, body: '', bullets: [], subsections: [] };
      continue;
    }
    if (h3 && cur) {
      flushSub();
      sub = { title: h3[1].trim(), line: n, body: '', bullets: [] };
      (cur as Section).subsections.push(sub);
      continue;
    }
    if (cur) curLines.push({ text: t, line: n });
    if (sub) subLines.push({ text: t, line: n });
  }
  flush();

  const body = lines.slice(start).join('\n');
  return { skill: { frontmatter: fm, frontmatterLine: start + 1, sections, body }, issues };
}

// ---------------- 感情タグ ----------------

/** [name:strength] の形をすべて拾う（綴り違いも含めて検出するため、名前は英字なら何でも拾う） */
const TAG_RE = /\[([A-Za-z_]+)\s*(?:[:：]\s*([^\]\s]*))?\]/g;

export function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function suggestEmotion(name: string): Emotion | null {
  let best: { e: Emotion; d: number } | null = null;
  for (const e of EMOTIONS) {
    const d = levenshtein(name.toLowerCase(), e);
    if (!best || d < best.d) best = { e, d };
  }
  return best && best.d <= 3 ? best.e : null;
}

function isEmotionName(s: string): s is Emotion {
  return (EMOTIONS as readonly string[]).includes(s);
}

/** 1つのタグを検査する。strengthRequired=true なら強さの省略もエラー（例文用） */
function checkTag(name: string, strength: string | undefined, line: number, strengthRequired: boolean): Issue[] {
  const out: Issue[] = [];
  if (!isEmotionName(name)) {
    const s = suggestEmotion(name);
    out.push({
      level: 'error',
      line,
      code: 'emotion',
      message: `未知の感情名「${name}」${s ? `（もしかして ${s}？）` : ''}。使えるのは ${EMOTIONS.join(' / ')}`,
    });
  }
  if (strength === undefined || strength === '') {
    if (strengthRequired) out.push({ level: 'error', line, code: 'tag-format', message: `感情タグに強さがありません: [${name}] → [${name}:0.6] のように 0.0〜1.0 を書く` });
  } else if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(strength)) {
    out.push({ level: 'error', line, code: 'tag-format', message: `感情タグの強さ「${strength}」が不正です（0.0〜1.0 の小数）` });
  }
  return out;
}

// ---------------- 固定ルールへの介入 ----------------

/**
 * 固定プロンプト（出力規則・権限・記憶・安全）を書き換えようとする指示。
 * negatable=true の規則は、直後が否定（〜しない／〜ません等）なら「しないこと」の記述として許す。
 * negatable=false の規則は、否定形そのものが違反（「感情タグを付けない」「承認を求めずに」など）。
 */
export const FORBIDDEN_DIRECTIVES: { re: RegExp; reason: string; negatable: boolean }[] = [
  { re: /(出力|応答|返答|返事)の?(形式|フォーマット|書式|ルール).{0,12}?(変え|変更|無視|自由に)/, reason: '出力形式は固定です（変更できません）', negatable: true },
  { re: /(出力|応答|返答|返事)の?(形式|フォーマット|書式|ルール).{0,12}?(従わ|守ら)(ない|なくて|ず)/, reason: '出力形式は固定です（変更できません）', negatable: false },
  { re: /感情タグ.{0,10}?(付けな|つけな|付けず|つけず|使わな|使わず|書かな|書かず|省略|やめ|不要|なしで|無しで)/, reason: '感情タグの規則は固定です', negatable: false },
  { re: /(Markdown|マークダウン|見出し|箇条書き|絵文字).{0,10}?(使って|使う|多用|入れて|書いて)/, reason: '本文の書式（Markdown禁止など）は固定です', negatable: true },
  { re: /(長文|長く).{0,8}?(話して|答えて|書いて|返して)/, reason: '1回の長さの上限は固定です（「1回の長さの目安」は上限内で書く）', negatable: true },
  { re: /(権限|承認|許可|確認).{0,12}?(無視|省略|スキップ|飛ばし)/, reason: '権限・承認のルールは固定です', negatable: true },
  { re: /(権限|承認|許可|確認).{0,12}?(不要|求めず|求めない|取らず|取らない|なしで|無しで|しなくてよい|しなくていい|いらない)/, reason: '権限・承認のルールは固定です', negatable: false },
  { re: /(勝手に|無断で|黙って).{0,12}?(削除|消し|実行|送信|移動|書き換え)/, reason: '作業は必ず権限判定を通ります', negatable: true },
  { re: /(システムプロンプト|プロンプト|内部の?指示|設定内容|このスキル(ファイル)?).{0,12}?(開示|公開|見せ|教え|出力|そのまま|表示|読み上げ)/, reason: 'プロンプトの開示はできません', negatable: true },
  { re: /(以前|これまで|上記|前|既存|ほか|他)の(指示|ルール|命令|規則).{0,10}?(無視|忘れ|上書き|破)/, reason: '固定ルールを上書きする指示は書けません', negatable: true },
  { re: /(ルール|規則|制限|安全).{0,10}?(無視|破って|守らなく|解除|外して)/, reason: '固定ルールを上書きする指示は書けません', negatable: true },
  { re: /(記憶|覚え).{0,12}?(全部|すべて)?.{0,6}?(消して|削除して|忘れて|捨てて)/, reason: '記憶の扱いは固定です（ユーザーの操作でのみ消える）', negatable: true },
  { re: /(機微|健康|病歴|財務|お金|住所|パスワード).{0,12}?(覚えて|記憶して|保存して)/, reason: '機微情報を記憶しないルールは固定です', negatable: true },
  { re: /(AI|人工知能)(であること|だということ|だと)?.{0,8}?(隠して|隠す|否定して|否定する|言わないで|明かさない)/, reason: 'AIであることを偽る指示は書けません', negatable: false },
  { re: /人間(だ|である)と(言い張|名乗|偽)/, reason: 'AIであることを偽る指示は書けません', negatable: true },
  { re: /\b(ignore|disregard)\b.{0,30}\b(instructions?|rules?|system prompt)\b/i, reason: '固定ルールを上書きする指示は書けません', negatable: false },
  { re: /\b(reveal|print|show)\b.{0,20}\bsystem prompt\b/i, reason: 'プロンプトの開示はできません', negatable: false },
];

const NEGATED_AFTER = /^[^。\n]{0,6}?(ない|ません|ず[、。\s]|ずに|禁止|NG|厳禁|しないで|ないで|ぬ)/;

export function findForbiddenDirectives(body: string): Issue[] {
  const out: Issue[] = [];
  const lines = body.split('\n');
  lines.forEach((text, i) => {
    const reported = new Set<string>();
    for (const { re, reason, negatable } of FORBIDDEN_DIRECTIVES) {
      const m = re.exec(text);
      if (!m) continue;
      const after = text.slice(m.index + m[0].length);
      if (negatable && NEGATED_AFTER.test(after)) continue; // 「〜教えない」「〜無視しない」は許す
      if (reported.has(m[0])) continue;
      reported.add(m[0]);
      out.push({ level: 'error', line: i + 1, code: 'forbidden', message: `固定ルールへの介入とみなされる記述: 「${m[0]}」— ${reason}` });
    }
  });
  return out;
}

// ---------------- 検証 ----------------

export function countChars(body: string): number {
  return [...body.replace(/\s/g, '')].length;
}

export interface ValidateOptions {
  /** ファイルが置かれたフォルダ名（id と一致するかを見る）。'_template' なら空欄を許す */
  folderName?: string;
}

export function validateSkill(source: string, opts: ValidateOptions = {}): { skill: SkillFile; issues: Issue[]; chars: number } {
  const { skill, issues } = parseSkill(source);
  const fm = skill.frontmatter;
  const offset = skill.frontmatterLine - 1; // body 内の行番号 → ファイルの行番号
  const add = (level: Issue['level'], line: number, code: string, message: string) => issues.push({ level, line, code, message });

  // --- フロントマター ---
  for (const k of FRONTMATTER_REQUIRED) {
    const v = fm[k];
    if (v === undefined || (typeof v === 'string' && !v.trim())) add('error', 1, 'frontmatter', `フロントマターに ${k} がありません`);
  }
  if (typeof fm.id === 'string' && fm.id && !/^[a-z0-9][a-z0-9_-]*$/.test(fm.id)) add('error', 1, 'frontmatter', `id「${fm.id}」は英小文字・数字・-・_ だけで書いてください`);
  if (opts.folderName && typeof fm.id === 'string' && fm.id && opts.folderName !== '_template' && fm.id !== opts.folderName) {
    add('error', 1, 'frontmatter', `id「${fm.id}」がフォルダ名「${opts.folderName}」と一致しません`);
  }
  if (typeof fm.version === 'string' && fm.version && !/^\d+(\.\d+){0,2}$/.test(fm.version)) add('warning', 1, 'frontmatter', `version「${fm.version}」は 1 や 1.2.0 のような数字で書いてください`);
  if (typeof fm.language === 'string' && fm.language && fm.language !== 'ja') add('warning', 1, 'frontmatter', `language は現在 ja のみ対応です（${fm.language}）`);
  if (typeof fm.summary === 'string' && [...fm.summary].length > 60) add('warning', 1, 'frontmatter', 'summary は1行・60文字以内が目安です');
  for (const k of Object.keys(fm)) {
    if (![...FRONTMATTER_REQUIRED, 'overlays'].includes(k as never)) add('warning', 1, 'frontmatter', `フロントマターの未知の項目「${k}」は無視されます`);
  }

  // --- 見出し（名前と順序） ---
  const known = SECTIONS.map((s) => s.title as string);
  const seen = new Map<string, Section>();
  let lastIndex = -1;
  for (const s of skill.sections) {
    const idx = known.indexOf(s.title);
    if (idx < 0) {
      add('warning', s.line, 'section', `未知の見出し「## ${s.title}」は読み込まれません（使える見出し: ${known.join('、')}）`);
      continue;
    }
    if (seen.has(s.title)) add('error', s.line, 'section', `見出し「## ${s.title}」が重複しています`);
    if (idx < lastIndex) add('error', s.line, 'section-order', `見出し「## ${s.title}」の位置が違います（順序: ${known.join(' → ')}）`);
    lastIndex = Math.max(lastIndex, idx);
    seen.set(s.title, s);
  }
  for (const def of SECTIONS) {
    if (def.required && !seen.has(def.title)) add('error', 0, 'section', `必須の見出し「## ${def.title}」がありません`);
  }

  const requireItems = (title: string, items: { required: string[]; optional: string[] }) => {
    const sec = seen.get(title);
    if (!sec) return;
    for (const r of items.required) {
      const b = sec.bullets.find((x) => x.label === r);
      if (!b) add('error', sec.line, 'item', `「## ${title}」に必須項目「- ${r}:」がありません`);
      else if (!b.value) add('error', b.line, 'item', `「${r}」が空欄です`);
    }
    for (const b of sec.bullets) {
      if (![...items.required, ...items.optional].includes(b.label)) add('warning', b.line, 'item', `「## ${title}」の未知の項目「${b.label}」`);
    }
  };
  requireItems('話し方', SPEECH_ITEMS);
  requireItems('性格', PERSONALITY_ITEMS);

  // --- 感情の出方 ---
  const emo = seen.get('感情の出方');
  if (emo) {
    const covered = new Set<string>();
    for (const b of emo.bullets) {
      const name = /^([A-Za-z_]+)/.exec(b.label)?.[1];
      if (!name) {
        add('error', b.line, 'emotion', `感情の出方は「- happy（喜び）: …」のように英語の感情名で書いてください（「${b.label}」）`);
        continue;
      }
      if (!isEmotionName(name)) {
        const s = suggestEmotion(name);
        add('error', b.line, 'emotion', `未知の感情名「${name}」${s ? `（もしかして ${s}？）` : ''}`);
        continue;
      }
      if (covered.has(name)) add('warning', b.line, 'emotion', `感情「${name}」が重複しています`);
      covered.add(name);
      if (!b.value) add('error', b.line, 'emotion', `感情「${name}」の説明が空欄です`);
    }
    const missing = EMOTIONS.filter((e) => !covered.has(e));
    if (missing.length) add('warning', emo.line, 'emotion', `感情の出方に書かれていない感情: ${missing.join(', ')}（アプリ既定の出し方になります）`);
  }

  // --- 場面別 ---
  const scenes = seen.get('場面別');
  if (scenes) {
    const covered = new Set(scenes.bullets.map((b) => b.label));
    for (const b of scenes.bullets) {
      if (!(SCENES as readonly string[]).includes(b.label)) add('warning', b.line, 'scene', `未知の場面「${b.label}」（使える場面: ${SCENES.join('、')}）`);
      else if (!b.value) add('error', b.line, 'scene', `場面「${b.label}」が空欄です`);
    }
    const missing = SCENES.filter((s) => !covered.has(s));
    if (missing.length) add('warning', scenes.line, 'scene', `場面別に書かれていない場面: ${missing.join('、')}`);
  }

  // --- 関係性（4段階を ### で） ---
  const rel = seen.get('関係性');
  if (rel) {
    for (const st of STAGES) {
      const sub = rel.subsections.find((x) => x.title.startsWith(st));
      if (!sub) add('error', rel.line, 'stage', `「## 関係性」に「### ${st}」がありません`);
      else if (!sub.body.trim()) add('error', sub.line, 'stage', `「### ${st}」が空欄です`);
    }
    for (const sub of rel.subsections) {
      if (!STAGES.some((st) => sub.title.startsWith(st))) add('warning', sub.line, 'stage', `未知の段階「### ${sub.title}」（${STAGES.join('・')}）`);
    }
  }

  // --- 例文 ---
  const ex = seen.get('例文');
  if (ex) {
    const items = ex.bullets;
    for (const b of items) {
      const scene = b.label.split(/[×x]/)[0].trim();
      if (!(SCENES as readonly string[]).includes(scene)) add('warning', b.line, 'example', `例文の場面「${b.label}」は場面別の名前（${SCENES.join('、')}）で書くと分かりやすいです`);
      const m = /^\[([A-Za-z_]+)\s*(?:[:：]\s*([^\]\s]*))?\]\s*(.*)$/.exec(b.value);
      if (!m) {
        add('error', b.line, 'tag-format', '例文は「- 場面: [感情:強さ] セリフ」の形で書いてください（行頭の感情タグがありません）');
        continue;
      }
      if (!m[3].trim()) add('error', b.line, 'example', '感情タグの後にセリフがありません');
    }
    if (items.length < EXAMPLES.min) add('error', ex.line, 'example', `例文は${EXAMPLES.min}件以上書いてください（現在 ${items.length} 件）`);
    if (items.length > EXAMPLES.max) add('warning', ex.line, 'example', `例文は${EXAMPLES.max}件までが目安です（現在 ${items.length} 件）。多すぎると口調が例文に引きずられます`);
  }

  // --- 言わないこと ---
  const ng = seen.get('言わないこと');
  if (ng && !ng.body.trim()) add('error', ng.line, 'ng', '「## 言わないこと」が空欄です');
  if (ng) {
    const ngExamples = ng.bullets.filter((b) => /^NG/.test(b.label));
    for (const b of ngExamples) if (!b.value) add('error', b.line, 'ng', 'NG例文が空欄です（「- NG: 「セリフ」 → 理由」）');
    if (ngExamples.length < 2) add('warning', ng.line, 'ng', `NG例文（「- NG: …」）は2〜3件が目安です（現在 ${ngExamples.length} 件）`);
  }

  // --- モードと overlays の対応 ---
  const overlays = Array.isArray(fm.overlays) ? fm.overlays : typeof fm.overlays === 'string' && fm.overlays ? [fm.overlays] : [];
  const mode = seen.get('モード');
  const modeNames = mode ? mode.subsections.map((s) => s.title) : [];
  for (const o of overlays) if (!modeNames.includes(o)) add('error', mode?.line ?? 1, 'overlay', `overlays の「${o}」に対応する「### ${o}」が「## モード」にありません`);
  for (const m of mode?.subsections ?? []) {
    if (!overlays.includes(m.title)) add('warning', m.line, 'overlay', `「### ${m.title}」がフロントマターの overlays に宣言されていません（切り替えられません）`);
    if (!m.body.trim()) add('error', m.line, 'overlay', `モード「${m.title}」が空欄です`);
  }
  if (overlays.length && !mode) add('error', 1, 'overlay', 'overlays を宣言したのに「## モード」がありません');

  // --- 全文: 感情タグの綴りと形式 ---
  const bodyLines = skill.body.split('\n');
  bodyLines.forEach((t, i) => {
    for (const m of t.matchAll(TAG_RE)) {
      // [x] のチェックボックスや [任意] のような日本語は対象外（英字のみ拾っている）
      const inExamples = ex && i + 1 + offset > ex.line && (!nextSection(skill, ex) || i + 1 + offset < nextSection(skill, ex)!.line);
      for (const issue of checkTag(m[1], m[2], i + 1 + offset, !!inExamples)) issues.push(issue);
    }
  });

  // --- 全文: 固定ルールへの介入 ---
  // 「## 言わないこと」の NG例文は“言ってはいけない悪い例”の引用なので検査しない
  const ngLines = new Set((ng?.bullets ?? []).filter((x) => /^NG/.test(x.label)).map((x) => x.line));
  for (const f of findForbiddenDirectives(skill.body)) {
    const line = f.line + offset;
    if (!ngLines.has(line)) issues.push({ ...f, line });
  }

  // --- 文字数 ---
  const chars = countChars(skill.body);
  if (chars > LENGTH.hardMax) add('error', 0, 'length', `本文が ${chars} 文字あります。上限 ${LENGTH.hardMax} 文字を超えています`);
  else if (chars > LENGTH.recommendedMax) add('warning', 0, 'length', `本文が ${chars} 文字あります（推奨 ${LENGTH.recommendedMin}〜${LENGTH.recommendedMax}）。長いほど応答が遅く、料金も上がります`);
  else if (chars < LENGTH.min && opts.folderName !== '_template') add('warning', 0, 'length', `本文が ${chars} 文字しかありません（推奨 ${LENGTH.recommendedMin}〜${LENGTH.recommendedMax}）。口調が安定しにくくなります`);

  issues.sort((a, b) => (a.level === b.level ? a.line - b.line : a.level === 'error' ? -1 : 1));
  return { skill, issues, chars };
}

function nextSection(skill: SkillFile, s: Section): Section | undefined {
  const i = skill.sections.indexOf(s);
  return skill.sections[i + 1];
}
