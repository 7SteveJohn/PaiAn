import { useRef, useState } from 'react';
import { X, Sparkles, Check, Loader } from 'lucide-react';
import type { AIPublic } from '../types';
import { streamChat } from '../api';
import { rulesSuffix } from '../util';
import RichText from './RichText';

const SYSTEM = '你是资深网文策划。按用户要求直接输出方案本身，不要寒暄、不要解释格式，严格按指定标注与分隔符输出。';

type Step = 0 | 1 | 2 | 3;
const STEP_NAMES = ['灵感', '核心设定', '主角', '故事大纲'];

interface Props {
  aiInfo: AIPublic;
  onClose: () => void;
  onFinish: (p: { title: string; type: string; notes: string; outline: string }) => void;
}

// AI 引导创建：灵感 → 核心设定卡 → 主角卡 → 故事大纲，每步 3 个方案点选采纳（可跳过）
export default function ProjectWizard({ aiInfo, onClose, onFinish }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [idea, setIdea] = useState('');
  const [type, setType] = useState('小说');
  const [title, setTitle] = useState('');
  const [slots, setSlots] = useState<string[]>(['', '', '']);
  const [adopt, setAdopt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const settingRef = useRef('');
  const charRef = useRef('');

  const stop = () => abortRef.current?.abort();

  const generate = async (target: Step) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError('');
    setSlots(['', '', '']);
    setAdopt(null);
    const context =
      target === 1
        ? `我想写一篇${type}。灵感："""${idea}"""。请给出 3 个截然不同的核心设定方案。每个方案一段话（120 字以内），必须包含并用【】标注：【世界观】【金手指/核心看点】【基调】【主要冲突】。三个方案之间用单独一行 --- 分隔。`
        : target === 2
          ? `核心设定如下：\n"""${settingRef.current}"""\n\n请为它给出 3 个截然不同的主角方案。每个方案一段话（120 字以内），必须包含并用【】标注：【姓名】【年龄/身份】【性格】【能力/来历】【核心执念】【成长弧线】。三个方案之间用单独一行 --- 分隔。`
          : `核心设定：\n"""${settingRef.current}"""\n\n主角：\n"""${charRef.current}"""\n\n请给出 3 个不同走向的章节级故事大纲方案。每个方案包含 8-12 行，每行格式：第N章 章节名：一句话剧情（在关键节点用【转折】【伏笔】【高潮】【爽点】标注）。三个方案之间用单独一行 --- 分隔。`;
    const one = (i: number) =>
      streamChat(
        [
          { role: 'system', content: SYSTEM + rulesSuffix(aiInfo.rules) },
          { role: 'user', content: context },
        ],
        (t) => setSlots((prev) => prev.map((x, j) => (j === i ? x + t : x))),
        controller.signal,
      ).catch((e: Error) => setSlots((prev) => prev.map((x, j) => (j === i ? x || `（生成失败：${e.message}）` : x))));
    await Promise.all([one(0), one(1), one(2)]);
    setRunning(false);
  };

  const next = () => {
    if (step === 0) {
      if (!idea.trim()) return;
      generate(1);
      setStep(1);
    } else if (step === 1) {
      settingRef.current = adopt != null ? slots[adopt] : '';
      generate(2);
      setStep(2);
    } else if (step === 2) {
      charRef.current = adopt != null ? slots[adopt] : '';
      generate(3);
      setStep(3);
    } else {
      const outline = adopt != null ? slots[adopt] : '';
      const notes = [
        settingRef.current && `【核心设定】\n${settingRef.current}`,
        charRef.current && `【主角】\n${charRef.current}`,
        outline && `【故事大纲】\n${outline}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      onFinish({ title: title.trim() || idea.trim().slice(0, 20) || '未命名作品', type, notes, outline });
    }
  };

  if (!aiInfo.ready) {
    return (
      <div className="wizard-mask">
        <div className="wizard-panel">
          <div className="wizard-head">
            <span>
              <Sparkles size={15} /> AI 引导创建
            </span>
            <button className="icon-btn" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <div className="wizard-step-body">
            <p className="hint">先到「设置」配置模型服务（云端 API 或本地 Ollama），即可用 AI 引导完成世界观、主角与大纲的冷启动。</p>
            <button className="btn primary" onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-mask">
      <div className="wizard-panel">
        <div className="wizard-head">
          <span>
            <Sparkles size={15} /> AI 引导创建 · {STEP_NAMES[step]}
          </span>
          <span className="wizard-steps">
            {STEP_NAMES.map((n, i) => (
              <em key={n} className={i === step ? 'on' : i < step ? 'done' : ''}>
                {n}
              </em>
            ))}
          </span>
          <button className="icon-btn" onClick={running ? stop : onClose} title={running ? '停止生成' : '关闭'}>
            {running ? <Loader size={16} className="spin" /> : <X size={16} />}
          </button>
        </div>

        {step === 0 && (
          <div className="wizard-step-body">
            <label className="field">
              作品名（可留空，AI 会根据灵感起）
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：从码头开始的长生路" />
            </label>
            <label className="field">
              类型
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {['小说', '剧本', '故事', '短篇'].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              一句话说清你的灵感
              <textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="例如：少年在码头捡到一块会吞噬骨头的古玉，从此走上吞噬万物的修行路…"
                rows={4}
              />
            </label>
            <div className="wizard-actions">
              <button className="btn primary" disabled={!idea.trim()} onClick={next}>
                <Sparkles size={14} /> 生成 3 个核心设定方案
              </button>
            </div>
          </div>
        )}

        {step > 0 && (
          <div className="wizard-step-body">
            {error && <div className="ai-error">{error}</div>}
            <div className="wizard-cards">
              {slots.map((s, i) => (
                <button
                  key={i}
                  className={'wizard-card' + (adopt === i ? ' on' : '')}
                  onClick={() => !running && setAdopt(i)}
                >
                  <span className="gacha-head">
                    方案 {i + 1}
                    {adopt === i && (
                      <em>
                        <Check size={11} /> 已采纳
                      </em>
                    )}
                  </span>
                  <span className={'gacha-body wizard-card-body' + (running ? ' cursor-blink' : '')}>
                    <RichText text={s} />
                    {!s && running && '生成中…'}
                  </span>
                </button>
              ))}
            </div>
            <div className="wizard-actions">
              <button className="btn" disabled={running} onClick={() => generate(step)}>
                换一批
              </button>
              <button className="btn" disabled={running} onClick={() => setAdopt(null)}>
                跳过此步
              </button>
              <button className="btn primary" disabled={running} onClick={next}>
                {step === 3 ? (
                  <>
                    <Check size={14} /> 创建项目
                  </>
                ) : (
                  <>
                    下一步：{STEP_NAMES[step + 1]}
                  </>
                )}
              </button>
            </div>
            <p className="hint">点卡片采纳（可换一批）；跳过则该部分留空，之后仍可在抽屉与备注中补写。</p>
          </div>
        )}
      </div>
    </div>
  );
}
