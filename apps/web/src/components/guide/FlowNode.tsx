import type { FlowLayout } from "./flowLayout";

const markers = { added: "+", removed: "-", changed: "~", unchanged: "" };

export function FlowNode({
  node,
  onChapter,
}: {
  node: FlowLayout["nodes"][number];
  onChapter: (id: string) => void;
}) {
  const content = (
    <>
      {markers[node.status] && <span data-flow-marker="">{markers[node.status]}</span>}
      <span data-flow-label="">{node.label}</span>
      {node.chapterIndex && (
        <span data-flow-badge="">{String(node.chapterIndex).padStart(2, "0")}</span>
      )}
    </>
  );
  const style = { left: node.x, top: node.y, width: node.w, height: node.h };
  if (node.chapter)
    return (
      <button
        type="button"
        data-flow-node=""
        data-status={node.status}
        style={style}
        title={node.detail ?? `${node.label}. Open chapter ${node.chapterIndex}`}
        onClick={() => {
          if (node.chapter) onChapter(node.chapter);
        }}
      >
        {content}
      </button>
    );
  return (
    <div
      data-flow-node=""
      data-status={node.status}
      style={style}
      title={node.detail ?? node.label}
    >
      {content}
    </div>
  );
}
