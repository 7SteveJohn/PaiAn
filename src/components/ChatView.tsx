import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Send, Square, Copy, MessageSquare, Sparkles, Download, Search } from 'lucide-react';
import { marked } from 'marked';
import type { AIPublic, ChatSession } from '../types';
import { fetchChat, saveChat, streamChat } from '../api';
import { uid, rulesSuffix } from '../util';
import { promptOf, type PromptOverrides } from '../ai-prompt';

const STARTERS = ['帮我就「本地优先工具」头脑风暴 5 个切入角度', '我文章的开头太平了，给我几种更有钩子的写法', '检查这段论证有没有逻辑漏洞'];

export default function ChatView({ aiInfo, onOpenSettings, promptOverrides }: { aiInfo: AIPublic; onOpenSettings: () => void; promptOverrides?: PromptOverrides }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionsRef = useRef<ChatSession[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copyTip, setCopyTip] = useState('');
  const [sessQ, setSessQ] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const copyTimer = useRef<number | undefined>(undefined);
  sessionsRef.current = sessions;

  useEffect(() => {
    fetchChat()
      .then((d) => {
        const sorted = [...d.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setSessions(sorted);
        setActiveId(sorted[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  // 会话一多全是「新对话」：按标题或内容过滤，找回之前那次讨论
  const shown = useMemo(() => {
    const q = sessQ.trim();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.includes(q) || s.messages.some((m) => m.content.includes(q)));
  }, [sessions, sessQ]);

  /** 把一段对话导成 Markdown：选题和结构的讨论是实际上的创作草稿，不该锁在工具里 */
  const exportSession = (s: ChatSession) => {
    if (!s.messages.length) return;
    const head = `# ${s.title || '新对话'}\n\n> ${s.messages.length} 条消息 · 导出于 ${new Date().toISOString().slice(0, 10)}\n`;
    const body = s.messages.map((m) => `\n**${m.role === 'user' ? '我' : 'AI'}**：\n\n${m.content}`).join('\n');
    const blob = new Blob([head + body + '\n'], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `对话-${(s.title || '新对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };


  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, streaming]); // 不写依赖数组 = 每次渲染都拽到底：打个字都把人拉回末尾，没法翻着读历史

  /** 会话标题可改：聊多了全是「新对话」，找不到之前那次讨论 */
  const renameSession = (id: string, title: string) => {
    const next = sessionsRef.current.map((s) => (s.id === id ? { ...s, title: title.trim() || s.title } : s));
    setSessions(next);
    saveChat(next).catch(() => {});
  };

  const newSession = () => {
    const s: ChatSession = { id: uid(), title: '新对话', messages: [], updatedAt: new Date().toISOString() };
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
  };

  const removeSession = (id: string) => {
    if (!confirm('删除这个对话？')) return;
    const next = sessionsRef.current.filter((s) => s.id !== id);
    setSessions(next);
    saveChat(next).catch(() => {});
    if (activeId === id) setActiveId(next[0]?.id ?? null);
  };

  const patchActive = (sid: string, fn: (s: ChatSession) => ChatSession) => {
    setSessions((prev) => prev.map((s) => (s.id === sid ? fn(s) : s)));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const now = new Date().toISOString();
    const sid = active?.id ?? uid();
    const baseMessages = active?.messages ?? [];
    const updated: ChatSession = {
      id: sid,
      title: baseMessages.length > 0 ? (active?.title ?? '新对话') : text.slice(0, 16),
      messages: [...baseMessages, { role: 'user', content: text, at: now }],
      updatedAt: now,
    };
    const nextSessions = active ? sessionsRef.current.map((s) => (s.id === sid ? updated : s)) : [updated, ...sessionsRef.current];
    setSessions(nextSessions);
    if (!active) setActiveId(sid);
    setInput('');
    setStreaming(true);

    // 占位的助手消息，随流式填充
    patchActive(sid, (s) => ({ ...s, messages: [...s.messages, { role: 'assistant', content: '', at: now }] }));

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await streamChat(
        [{ role: 'system', content: promptOf('chat', promptOverrides) + rulesSuffix(aiInfo.rules) }, ...updated.messages.map((m) => ({ role: m.role, content: m.content }))],
        (t) =>
          patchActive(sid, (s) => ({
            ...s,
            messages: s.messages.map((m, i) => (i === s.messages.length - 1 ? { ...m, content: m.content + t } : m)),
          })),
        abort.signal,
      );
    } catch (err) {
      const e = err as Error;
      const msg = e.name === 'AbortError' ? '（已停止生成）' : `调用失败：${e.message}`;
      patchActive(sid, (s) => ({
        ...s,
        messages: s.messages.map((m, i) => (i === s.messages.length - 1 && !m.content ? { ...m, content: msg } : m)),
      }));
    } finally {
      setStreaming(false);
      const finalSessions = sessionsRef.current.map((s) => (s.id === sid ? { ...s, updatedAt: new Date().toISOString() } : s));
      setSessions(finalSessions);
      saveChat(finalSessions).catch(() => {});
    }
  };

  const stop = () => abortRef.current?.abort();

  const copyMsg = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyTip('已复制');
    } catch (e) {
      setCopyTip('复制失败：' + (e as Error).message);
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyTip(''), 1800);
  };

  if (!aiInfo.ready) {
    return (
      <>
        <header className="view-head">
          <div className="overline">AI CHAT · 和模型自由讨论</div>
          <h1>AI 对话</h1>
          <hr className="head-rule" />
        </header>
        <div className="empty">
          先到「设置」配置模型服务（云端 API 或本地 Ollama），就能在这里和 AI 聊选题、聊结构、聊技巧。
          <div style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={onOpenSettings}>
              去设置
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="view-head">
        <div className="overline">AI CHAT · 和模型自由讨论</div>
        <h1>AI 对话</h1>
        <hr className="head-rule" />
      </header>

      <div className="chat-layout">
        <aside className="chat-sessions">
          <button className="btn small new-chat" onClick={newSession}>
            <Plus size={13} /> 新对话
          </button>
          <div className="chat-search-row">
            <Search size={12} />
            <input className="chat-search" value={sessQ} onChange={(e) => setSessQ(e.target.value)} placeholder="搜标题或内容…" />
          </div>
            {shown.length === 0 ? (
              <p className="hint" style={{ padding: "0 10px" }}>{sessQ.trim() ? "没有匹配的对话。" : "还没有对话。"}</p>
            ) : shown.map((s) => (
            <button key={s.id} className={'chat-sid' + (s.id === activeId ? ' on' : '')} onClick={() => setActiveId(s.id)}>
              <MessageSquare size={13} />
              {renameId === s.id ? (
                <input
                  className="chat-sid-rename"
                  value={renameText}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenameId(null);
                  }}
                  onBlur={() => {
                    renameSession(s.id, renameText);
                    setRenameId(null);
                  }}
                />
              ) : (
                <span
                  className="chat-sid-title"
                  title="双击重命名"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenameId(s.id);
                    setRenameText(s.title);
                  }}
                >
                  {s.title || '新对话'}
                </span>
              )}
                <span
                  className="icon-btn chat-sid-export"
                  title="导出这段对话为 Markdown"
                  onClick={(e) => {
                    e.stopPropagation();
                    exportSession(s);
                  }}
                >
                  <Download size={12} />
                </span>
              <span
                className="icon-btn chat-sid-del"
                title="删除对话"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSession(s.id);
                }}
              >
                <Trash2 size={12} />
              </span>
            </button>
            ))}
        </aside>

        <div className="chat-main">
          <div className="chat-messages" ref={scrollRef}>
            {!active || active.messages.length === 0 ? (
              <div className="chat-empty">
                <Sparkles size={22} />
                <p>和 AI 聊聊你的创作——它会记住这个对话的上下文。</p>
                <div className="chat-starters">
                  {STARTERS.map((s) => (
                    <button key={s} className="chip" onClick={() => setInput(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              active.messages.map((m, i) => (
                <div key={i} className={'msg ' + m.role}>
                  <div className={'msg-bubble' + (m.role === 'assistant' ? ' md-body' : '')}>
                    {m.role === 'assistant' ? (
                      m.content ? (
                        <div dangerouslySetInnerHTML={{ __html: marked.parse(m.content) as string }} />
                      ) : (
                        <span className="msg-thinking">思考中<span className="dot-anim">…</span></span>
                      )
                    ) : (
                      m.content
                    )}
                  </div>
                  {m.role === 'assistant' && m.content && (
                    <button className="mini-btn msg-copy" onClick={() => copyMsg(m.content)} title="复制这条回复">
                      <Copy size={12} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="chat-input-row">
            {copyTip && <span className="hint">{copyTip}</span>}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
              rows={2}
            />
            {streaming ? (
              <button className="btn" onClick={stop} title="停止生成">
                <Square size={14} /> 停止
              </button>
            ) : (
              <button className="btn primary" onClick={send} disabled={!input.trim()}>
                <Send size={14} /> 发送
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
