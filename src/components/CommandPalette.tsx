// Ctrl+K 命令面板：一个小而完整的键盘入口——所有页面与常用动作都能从这里一键直达。
// 刻意不懒加载：组件本身只有几十行，为它拆分包不值得。
import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';

export type PaletteView = 'home' | 'ideas' | 'projects' | 'stats' | 'chat' | 'gacha' | 'settings' | 'trash';

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigate: (v: PaletteView) => void;
  onOpenLast: () => void;
  onWizard: () => void;
  hasLast: boolean;
}

interface PaletteCommand {
  label: string;
  kind: '页面' | '动作';
  run: () => void;
}

/** 纯过滤，独立导出供测试：空串返回全部；非空按去掉首尾空格后的子串匹配 */
export function filterCommands<T extends { label: string }>(cmds: T[], q: string): T[] {
  const s = q.trim();
  if (!s) return cmds;
  return cmds.filter((c) => c.label.includes(s));
}

export default function CommandPalette({ open, onClose, onNavigate, onOpenLast, onWizard, hasLast }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // 打开时重置输入与高亮，别把上一次的搜索词带回来
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const commands: PaletteCommand[] = [
    { label: '首页', kind: '页面', run: () => onNavigate('home') },
    { label: '灵感库', kind: '页面', run: () => onNavigate('ideas') },
    { label: '创作项目', kind: '页面', run: () => onNavigate('projects') },
    { label: '统计复盘', kind: '页面', run: () => onNavigate('stats') },
    { label: 'AI 对话', kind: '页面', run: () => onNavigate('chat') },
    { label: '卡池', kind: '页面', run: () => onNavigate('gacha') },
    { label: '设置', kind: '页面', run: () => onNavigate('settings') },
    { label: '回收站', kind: '页面', run: () => onNavigate('trash') },
    { label: '新建作品（AI 引导）', kind: '动作', run: onWizard },
    ...(hasLast ? [{ label: '打开上次写作', kind: '动作' as const, run: onOpenLast }] : []),
  ];
  const visible = filterCommands(commands, query);

  // 任何命令执行前都先收起面板，落点交给命令自己
  const exec = (cmd: PaletteCommand) => {
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (visible.length ? (i + 1) % visible.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (visible.length ? (i - 1 + visible.length) % visible.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = visible[active];
      if (cmd) exec(cmd);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="cmdk-mask" onMouseDown={onClose}>
      <div className="cmdk" role="dialog" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmdk-input"
          autoFocus
          placeholder="输入命令…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list">
          {visible.length === 0 && <div className="cmdk-empty">没有匹配的命令</div>}
          {visible.map((c, i) => (
            <button
              key={c.label}
              type="button"
              className="cmdk-item"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => exec(c)}
            >
              <span className="cmdk-label">{c.label}</span>
              <span className="cmdk-kind">{c.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
