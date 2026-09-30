// 【xxx】要素标签渲染：把金手指/伏笔/爽点这类结构化标注渲染成高亮小标签
export default function RichText({ text }: { text: string }) {
  const parts = text.split(/(【[^】]{1,14}】)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('【') && p.endsWith('】') ? (
          <span key={i} className="tagchip">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
