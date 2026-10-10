import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkill, validateSkill } from '../../src/main/character/skillFile';
import { firstPersonOf, modeNotice, overlaysOf, skillName, skillPersonaBlock, skillRelationshipBlock } from '../../src/main/character/skillPrompt';
import { CharacterSkillService, draftSkillFromTemplate } from '../../src/main/character/CharacterSkillService';
import { buildSessionSystem } from '../../src/main/llm/PromptBuilder';
import { DEFAULT_CHARACTER } from '../../src/shared/defaults';

const root = path.resolve(__dirname, '../..');
const SAMPLE = fs.readFileSync(path.join(root, 'characters/sample/skill.md'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(root, 'characters/_template/skill.md'), 'utf8');
const skill = parseSkill(SAMPLE).skill;

describe('skillPrompt', () => {
  it('① persona: name and the persona sections in the documented order; no 声と動き / モード / comments', () => {
    const p = skillPersonaBlock(skill, '');
    expect(p).toContain('アシスタントの「灯野ほたる」');
    const order = ['## 話し方', '## 性格', '## 感情の出方', '## 場面ごとの振る舞い', '## 口調の見本', '## 言わないこと', '## 背景'];
    const idx = order.map((h) => p.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(p).toContain('- 一人称: わたし');
    expect(p).toContain('[happy:0.6] 今夜は晴れる');
    expect(p).not.toContain('調声');
    expect(p).not.toContain('## 声と動き');
    expect(p).not.toContain('ユーザーが集中したいとき'); // mode text stays out of the system prompt
    expect(p).toContain('この設定より常に優先する');
  });

  it('the user-set call name overrides the skill', () => {
    expect(skillPersonaBlock(skill, 'ゆうたろうさん')).toContain('ユーザーのことは「ゆうたろうさん」と呼ぶ');
    expect(skillPersonaBlock(skill, '')).not.toContain('と呼ぶ（ユーザーが設定した');
  });

  it('④ relationship: only the current stage', () => {
    const r = skillRelationshipBlock(skill, 2);
    expect(r).toContain('今の関係は「親しい」');
    expect(r).toContain('自分の好きな星の話を少しだけする');
    expect(r).not.toContain('ときどき丁寧語が抜ける'); // 相棒
    expect(r).not.toContain('丁寧語を崩さない'); // 初対面
    expect(skillRelationshipBlock(skill, 99)).toContain('「相棒」');
    expect(skillRelationshipBlock(skill, -1)).toContain('「初対面」');
  });

  it('helpers', () => {
    expect(skillName(skill)).toBe('灯野ほたる');
    expect(firstPersonOf(skill)).toBe('わたし');
    expect(overlaysOf(skill)).toEqual(['集中']);
  });

  it('mode notices: switch on, no-op, switch off, unknown mode', () => {
    const on = modeNotice(skill, null, '集中')!;
    expect(on).toContain('「集中」に切り替わった');
    expect(on).toContain('返事は1文だけにし');
    expect(modeNotice(skill, '集中', '集中')).toBeNull();
    expect(modeNotice(skill, '集中', null)).toContain('解除');
    expect(modeNotice(skill, null, null)).toBeNull();
    expect(modeNotice(skill, null, '存在しない')).toBeNull();
  });
});

describe('PromptBuilder with a skill', () => {
  const base = { character: DEFAULT_CHARACTER, callName: '', affinityStage: 0, profile: [], allowedDirs: [], apps: [], webSearch: false };

  it('uses the skill for ① and ④ and keeps the fixed blocks and cache breakpoints', () => {
    const sys = buildSessionSystem({ ...base, skill });
    expect(sys[0].text).toContain('灯野ほたる');
    expect(sys[0].text).not.toContain(DEFAULT_CHARACTER.persona);
    expect(sys[1].text).toContain('# 話し方の規則');
    expect(sys[3].text).toContain('今の関係は「初対面」');
    expect(sys.map((b) => !!b.cache_control)).toEqual([false, false, true, false, true]);
  });

  it('falls back to character.json without a skill', () => {
    const sys = buildSessionSystem({ ...base, skill: null });
    expect(sys[0].text).toContain(DEFAULT_CHARACTER.persona);
  });
});

describe('CharacterSkillService', () => {
  function folder() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-skill-'));
    fs.mkdirSync(path.join(dir, 'sample'));
    return dir;
  }

  it('none → ok → invalid, cached by mtime and reloaded after a change', () => {
    const dir = folder();
    const svc = new CharacterSkillService((id) => path.join(dir, id));
    expect(svc.load('sample').status.state).toBe('none');
    const file = path.join(dir, 'sample', 'skill.md');
    fs.writeFileSync(file, SAMPLE);
    const ok = svc.load('sample');
    expect(ok.status).toMatchObject({ state: 'ok', name: '灯野ほたる', version: '1.0.0', overlays: ['集中'] });
    expect(ok.skill).not.toBeNull();
    expect(svc.load('sample')).toBe(ok); // cached object

    fs.writeFileSync(file, SAMPLE.replace('## 関係性', '## 関係'));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    const bad = svc.load('sample');
    expect(bad.status.state).toBe('invalid');
    expect(bad.skill).toBeNull(); // never use a skill with errors
    expect(bad.status.issues.some((i) => i.level === 'error' && i.message.includes('関係性'))).toBe(true);

    fs.rmSync(file);
    expect(svc.load('sample').status.state).toBe('none');
  });

  it('a folder/id mismatch makes the skill invalid', () => {
    const dir = folder();
    fs.mkdirSync(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'other', 'skill.md'), SAMPLE);
    const svc = new CharacterSkillService((id) => path.join(dir, id));
    expect(svc.load('other').status.state).toBe('invalid');
  });

  it('the migration draft carries over name, first person and old persona, but stays invalid until filled', () => {
    const draft = draftSkillFromTemplate(TEMPLATE, {
      id: 'mine', name: 'テスト子', firstPerson: 'ぼく', persona: '元気で前向き。--ハイフン付き', speechExamples: [['はじめまして'], [], ['やっほー'], []],
    });
    const { skill: s, issues } = validateSkill(draft, { folderName: 'mine' });
    expect(s.frontmatter.id).toBe('mine');
    expect(s.frontmatter.name).toBe('テスト子');
    expect(firstPersonOf(s)).toBe('ぼく');
    expect(draft).toContain('元気で前向き');
    expect(draft).toContain('はじめまして');
    // the persona comment must not break the HTML comment
    expect(draft.match(/<!--/g)!.length).toBe(draft.match(/-->/g)!.length);
    expect(issues.some((i) => i.level === 'error')).toBe(true);
  });
});
