import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Send, Square, Copy, MessageSquare, Sparkles } from 'lucide-react';
import { marked } from 'marked';
import type { AIPublic, ChatSession } from '../types';
import { fetchChat, saveChat, streamChat } from '../api';
import { uid, rulesSuffix } from '../util';

const SYSTEM_PROMPT =
  '你是一位经验丰富的中文写作伙伴，与创作者自由讨论选题、结构、素材与写作技巧。回答实用、具体、不空谈，语气自然，适当用 Markdown 分点。';

const STARTERS = ['帮我就「本地优先工具」头脑风暴 5 个切入角度', '我文章的开头太平了，给我几种更有钩子的写法', '检查这段论证有没有逻辑漏洞'];

export default function ChatView({ aiInfo, onOpenSettings }: { aiInfo: AIPublic; onOpenSettings: () => void }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionsRef = useRef<ChatSession[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

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
        [{ role: 'system', content: SYSTEM_PROMPT + rulesSuffix(aiInfo.rules) }, ...updated.messages.map((m) => ({ role: m.role, content: m.content }))],
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
    } catch {
      // 剪贴板未授权时静默失败
    }
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
          {sessions.map((s) => (
            <button key={s.id} className={'chat-sid' + (s.id === activeId ? ' on' : '')} onClick={() => setActiveId(s.id)}>
              <MessageSquare size={13} />
              <span className="chat-sid-title">{s.title || '新对话'}</span>
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
