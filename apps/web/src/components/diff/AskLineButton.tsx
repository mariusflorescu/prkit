import { MessageCircleQuestionIcon } from "lucide-react";

/**
 * The button Pierre shows on the hovered line when the diff asks the guide's agent. Pierre
 * leaves a custom button's press to it, so a click here is the whole gesture.
 */
export function AskLineButton({ onAsk }: { onAsk: () => void }) {
  return (
    <button type="button" data-ask-line-button="" aria-label="Ask about this line" onClick={onAsk}>
      <MessageCircleQuestionIcon size={16} aria-hidden="true" />
    </button>
  );
}
