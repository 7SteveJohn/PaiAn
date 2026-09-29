import type { AppData, AIPublic, AIRule, ObsidianConfig, Project } from './types';
import { stripVersions, type FlatStore } from './versions';
import type { BenchBook } from './bench';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DataResponse extends AppData {
  dataDir: string;
  ai: AIPublic;
  obsidian: ObsidianConfig;
  warnings?: string[]; // 服务端读盘异常（文件损坏/被占用），界面要让人看见
  versionCounts?: Record<string, number>; // 每条快照 key 有几份：首屏不带快照，只带这个
}

export async function fetchData(): Promise<DataResponse> {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`读取数据失败（HTTP ${res.status}）`);
  return (await res.json()) as DataResponse;
}

// 非 2xx 一律把服务端给的原因带出去（如「请求体超过上限」），别让界面只能显示「保存失败」
async function putJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) reason = j.error;
    } catch {
      // 非 JSON 错误响应，保留状态码
    }
    throw new Error(reason);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

// 自动保存的热路径只发正文：历史快照由 saveVersions 单独发，且只在快照变化时才发。
// 返回 stale：服务端发现这次写入比它已有内容更旧（多半是另一个标签页盖了新改动）
export async function saveData(data: Pick<AppData, 'ideas' | 'projects' | 'stats' | 'gacha' | 'cards'>): Promise<{ stale: boolean }> {
  const r = await putJson('/api/data', { ...data, projects: stripVersions(data.projects) });
  return { stale: Boolean(r.stale) };
}

// 快照按 key 增量写（默认 merge）；只有「从备份恢复」那种整表替换才传 mode: 'replace'
export async function saveVersions(versions: FlatStore, mode: 'merge' | 'replace' = 'merge'): Promise<void> {
  await putJson('/api/versions', { versions, mode });
}

// 懒读某一本作品的快照（首屏不带快照，几十 MB 的书不必每次开机搬一遍）
export async function fetchVersions(projectId: string): Promise<FlatStore> {
  const res = await fetch('/api/versions?project=' + encodeURIComponent(projectId));
  const json = (await res.json().catch(() => ({}))) as { versions?: FlatStore; error?: string };
  if (!res.ok) throw new Error(json?.error || `读取历史快照失败（HTTP ${res.status}）`);
  return json.versions ?? {};
}

export async function saveAIConfig(cfg: {
  provider: string;
  baseUrl: string;
  model: string;
  protocol?: 'openai' | 'anthropic' | 'ollama';
  apiKey?: string;
  rules?: AIRule[];
  memoryExtract?: boolean;
  gateDraft?: boolean;
  judgeOnly?: boolean;
}): Promise<AIPublic> {
  const res = await fetch('/api/ai-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error(`保存 AI 配置失败（HTTP ${res.status}）`);
  const json = (await res.json()) as { ai: AIPublic };
  return json.ai;
}

// 非流式文本通道：整段返回（用于记忆抽取等结构化任务）
export async function askText(messages: ChatMessage[], temperature?: number): Promise<string> {
  const res = await fetch('/api/ai/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, ...(typeof temperature === 'number' ? { temperature } : {}) }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; text?: string; error?: string } | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error || `AI 抽取失败（HTTP ${res.status}）`);
  return json.text ?? '';
}

// 拉取供应商的已安装/可用模型列表（OpenAI 兼容 /models，Ollama 回退 /api/tags）
export async function fetchAIModels(): Promise<string[]> {
  const res = await fetch('/api/ai/models', { method: 'POST' });
  const json = (await res.json()) as { ok?: boolean; models?: string[]; message?: string };
  if (!json.ok || !json.models) throw new Error(json.message || '获取模型列表失败');
  return json.models;
}

export async function testAI(): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('/api/ai/test', { method: 'POST' });
  return (await res.json()) as { ok: boolean; message: string };
}

export async function saveObsidianConfig(cfg: ObsidianConfig): Promise<ObsidianConfig> {
  const res = await fetch('/api/obsidian/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  const json = (await res.json()) as { error?: string; obsidian?: ObsidianConfig };
  if (!res.ok || !json.obsidian) throw new Error(json.error || `保存失败（HTTP ${res.status}）`);
  return json.obsidian;
}

export interface ObsidianNote {
  path: string;
  name: string;
  mtime: number;
  bytes: number;
  /** 带 wb-id 属性 = 工作台自己同步出去的镜像，不是库里的原创素材 */
  wb: boolean;
}

export async function listObsidianNotes(q: string): Promise<{ notes: ObsidianNote[]; warning: string }> {
  const res = await fetch(`/api/obsidian/notes?q=${encodeURIComponent(q)}`);
  const json = (await res.json()) as { error?: string; notes?: ObsidianNote[]; warning?: string };
  if (!res.ok || !json.notes) throw new Error(json.error || '读取库失败');
  return { notes: json.notes, warning: json.warning || '' };
}

export async function fetchObsidianNote(rel: string): Promise<{ content: string; bytes: number; wb: boolean }> {
  const res = await fetch(`/api/obsidian/note?path=${encodeURIComponent(rel)}`);
  const json = (await res.json()) as { error?: string; content?: string; bytes?: number; wb?: boolean };
  if (!res.ok || typeof json.content !== 'string') throw new Error(json.error || '读取笔记失败');
  return { content: json.content, bytes: json.bytes ?? json.content.length, wb: json.wb === true };
}

/** 一趟双向同步的结果。conflicts 非空时必须由人判定，服务端不会自动偏向任何一边。 */
export interface SyncResult {
  root: string;
  pushed: string[];
  pulled: string[];
  pruned: string[];
  conflicts: Array<{ rel: string; id: string; kind: string; ours: string; theirs: string }>;
  skipped: Array<{ rel: string; 因为: string }>;
  nextProject: Project | null;
}

/** 一次同步一本书；resolve 是上一趟冲突的人工判定结果 */
export async function syncToObsidian(projectId: string, resolve: Record<string, 'app' | 'vault'> = {}): Promise<SyncResult> {
  const res = await fetch('/api/obsidian/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, resolve }),
  });
  const json = (await res.json()) as Partial<SyncResult> & { error?: string };
  if (!res.ok || !json.root) throw new Error(json.error || '同步失败');
  return {
    root: json.root,
    pushed: json.pushed ?? [],
    pulled: json.pulled ?? [],
    pruned: json.pruned ?? [],
    conflicts: json.conflicts ?? [],
    skipped: json.skipped ?? [],
    nextProject: json.nextProject ?? null,
  };
}

export interface ObsidianStatusBook {
  root: string;
  book: string;
  syncedAt: string;
}

/** 状态表概览（不扫库）：回收站用它判断「这本书在库里还有没有镜像」 */
export async function fetchObsidianStatus(): Promise<{ books: ObsidianStatusBook[] }> {
  const res = await fetch('/api/obsidian/status');
  const json = (await res.json()) as { books?: ObsidianStatusBook[] };
  return { books: json.books ?? [] };
}

/** 彻底删除一本书时回收它在库里的整棵镜像（只删带我方 wb 标记的文件）。 */
export async function purgeVaultBook(root: string): Promise<{ ok: boolean; removed: number }> {
  const res = await fetch('/api/obsidian/purge-book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  const json = (await res.json()) as { ok?: boolean; removed?: number; error?: string };
  if (!res.ok || !json.ok) throw new Error(json.error || `回收失败（HTTP ${res.status}）`);
  return { ok: true, removed: json.removed ?? 0 };
}

export interface SyncBookRow {
  projectId: string;
  title: string;
  root: string;
  pushed: number;
  pulled: number;
  conflicts: Array<{ rel: string; id: string; kind: string }>;
  nextProject: Project | null;
}

export async function syncAllToObsidian(): Promise<{ count: number; pushed: number; pulled: number; conflicts: number; books: SyncBookRow[]; errors: string[] }> {
  const res = await fetch('/api/obsidian/sync-all', { method: 'POST' });
  const json = (await res.json()) as { count?: number; pushed?: number; pulled?: number; conflicts?: number; books?: SyncBookRow[]; errors?: string[]; error?: string };
  if (!res.ok || typeof json.count !== 'number') throw new Error(json.error || '同步失败');
  return { count: json.count, pushed: json.pushed ?? 0, pulled: json.pulled ?? 0, conflicts: json.conflicts ?? 0, books: json.books ?? [], errors: json.errors ?? [] };
}

// ---------- AI 对话 ----------

export interface ChatSessionData {
  sessions: { id: string; title: string; messages: { role: 'user' | 'assistant'; content: string; at: string }[]; updatedAt: string }[];
}

export async function fetchChat(): Promise<ChatSessionData> {
  const res = await fetch('/api/chat');
  if (!res.ok) throw new Error(`读取对话历史失败（HTTP ${res.status}）`);
  return (await res.json()) as ChatSessionData;
}

export async function saveChat(sessions: ChatSessionData['sessions']): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions }),
  });
  if (!res.ok) throw new Error(`保存对话失败（HTTP ${res.status}）`);
}

export async function openDataFolder(): Promise<void> {
  const res = await fetch('/api/open-folder', { method: 'POST' });
  if (!res.ok) throw new Error('打开目录失败');
}

// 供应商返回的用量信息（缓存命中：DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens）
export interface UsageInfo {
  hit: number;
  total: number;
}

// 解析 OpenAI 兼容的 SSE 流（data: {...} 行），把增量文本交给 onDelta；
// 流末尾的 usage 块（若供应商返回）交给 onUsage，用于显示缓存命中率
export async function streamChat(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  onUsage?: (u: UsageInfo) => void,
): Promise<void> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      // 非 JSON 错误响应，保留 HTTP 状态码信息
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const ev = JSON.parse(payload);
        const delta = ev?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) onDelta(delta);
        if (ev?.usage && onUsage) {
          const total = Number(ev.usage.prompt_tokens) || 0;
          const hit = Number(ev.usage.prompt_cache_hit_tokens ?? ev.usage.prompt_tokens_details?.cached_tokens) || 0;
          if (total > 0) onUsage({ hit, total });
        }
      } catch {
        // 单行 JSON 不完整时跳过，等待下一个分隔符
      }
    }
  }
}

// ---------- 拆文对标 ----------

export async function fetchBenchmarks(): Promise<BenchBook[]> {
  const res = await fetch('/api/benchmarks');
  const j = (await res.json().catch(() => null)) as { books?: BenchBook[]; error?: string } | null;
  if (!res.ok || !j?.books) throw new Error(j?.error || `读取对标书失败（HTTP ${res.status}）`);
  return j.books;
}

export async function saveBenchmarks(books: BenchBook[]): Promise<void> {
  await putJson('/api/benchmarks', { books });
}
