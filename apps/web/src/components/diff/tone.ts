import { CircleHelp, Sparkles, TriangleAlert } from "lucide-react";

export const tones = {
  note: { label: "Note from the guide", icon: Sparkles },
  question: { label: "Question for the author", icon: CircleHelp },
  risk: { label: "Risk worth checking", icon: TriangleAlert },
} as const;
