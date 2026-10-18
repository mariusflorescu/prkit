import { answerText, type AnswerAgent, type Question } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { PinIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { agentName } from "~/components/review/agent/agentSelection";
import { Button } from "~/components/ui/button";
import { agentCatalogQuery } from "~/rpc/queries";

import { AnswerMarkdown } from "./AnswerMarkdown";
import type { AskTarget } from "./askTarget";

/**
 * An answer pinned where it was asked, outside the diff so it never reads as one of the
 * guide's own notes: the question, the answer cut to a few lines until Show all, and Unpin.
 */
export function AskPinnedNote({
  question,
  agent,
  target,
  files,
  unpin,
  unpinning,
}: {
  question: Question;
  agent: AnswerAgent;
  target: AskTarget;
  files: ReadonlySet<string>;
  unpin: () => void;
  unpinning: boolean;
}) {
  const catalog = useQuery(agentCatalogQuery).data;
  const [all, setAll] = useState(false);
  const [cut, setCut] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || all) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    measure();
    return () => resize.disconnect();
  }, [all]);
  const { openLine } = target;
  const onLine = useCallback(
    (path: string, line: number) => openLine(question.revision, path, line),
    [openLine, question.revision],
  );
  return (
    <aside
      aria-label={`Pinned answer: ${question.text}`}
      data-ask-pin=""
      className="rounded-lg border border-border bg-card p-3 text-card-foreground"
    >
      <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <PinIcon aria-hidden="true" className="size-3" />
        Pinned from Ask · {agentName(catalog, { instance: agent.instance, provider: agent.kind })} ·
        r{question.revision}
      </p>
      <p className="mt-1.5 text-sm font-semibold break-words whitespace-pre-wrap">
        {question.text}
      </p>
      <div ref={body} className={all ? "mt-2" : "mt-2 max-h-36 overflow-hidden"}>
        <AnswerMarkdown text={answerText(question.answer)} files={files} onLine={onLine} />
      </div>
      <div className="mt-2 flex gap-1">
        {(cut || all) && (
          <Button
            size="xs"
            variant="ghost-muted"
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
          >
            {all ? "Show less" : "Show all"}
          </Button>
        )}
        <Button size="xs" variant="ghost-muted" disabled={unpinning} onClick={unpin}>
          Unpin
        </Button>
      </div>
    </aside>
  );
}
