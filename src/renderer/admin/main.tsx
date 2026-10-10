// Admin window (SC-10..15): sidebar navigation with hash routing.
import './style.css';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AdminPage } from '@shared/ipc';
import { onAdmin } from './api';
import { HistoryPage } from './pages/HistoryPage';
import { MemoryPage } from './pages/MemoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { ToolsPage } from './pages/ToolsPage';
import { VoicePage } from './pages/VoicePage';
import { FlashHost } from './ui';

const NAV: { id: AdminPage; label: string; icon: string }[] = [
  { id: 'settings', label: '設定', icon: '⚙' },
  { id: 'voice', label: '調声', icon: '♪' },
  { id: 'memory', label: '記憶', icon: '✦' },
  { id: 'history', label: '会話履歴', icon: '☰' },
  { id: 'tools', label: '作業履歴', icon: '✓' },
  { id: 'setup', label: 'はじめに', icon: '★' },
];

function pageFromHash(): AdminPage {
  const h = location.hash.replace('#', '') as AdminPage;
  return NAV.some((n) => n.id === h) ? h : 'settings';
}

function App() {
  const [page, setPage] = useState<AdminPage>(pageFromHash());
  const [dirty, setDirty] = useState(false);

  const go = (p: AdminPage) => {
    if (p === page) return;
    if (dirty && !confirm('調声の変更が保存されていません。破棄して移動しますか？')) return;
    setDirty(false);
    location.hash = p;
    setPage(p);
  };

  useEffect(() => onAdmin('admin:navigate', (p) => go(p as AdminPage)), [page, dirty]);
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (dirty && !confirm('調声の変更が保存されていません。閉じますか？')) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);

  return (
    <div class="layout">
      <nav class="sidebar">
        <div class="brand">
          <span class="logo">◕‿◕</span>
          <div>
            <div class="brand-name">DesktopMMD</div>
            <div class="brand-sub">アシスタント管理</div>
          </div>
        </div>
        {NAV.map((n) => (
          <button type="button" class={`nav ${page === n.id ? 'active' : ''}`} onClick={() => go(n.id)}>
            <span class="nav-icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>
      <main class="content">
        {page === 'settings' && <SettingsPage />}
        {page === 'voice' && <VoicePage setDirty={setDirty} />}
        {page === 'memory' && <MemoryPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'tools' && <ToolsPage />}
        {page === 'setup' && <SetupPage onDone={() => go('settings')} />}
      </main>
      <FlashHost />
    </div>
  );
}

render(<App />, document.getElementById('app')!);
