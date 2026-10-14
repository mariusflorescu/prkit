import { createContext } from "react";

/**
 * The stack the guide on screen belongs to: `#123` for one of its layers opens that
 * layer's Guide tab instead of GitHub.
 */
export interface StackLinks {
  /** `https://<host>/<owner>/<repo>`, as the guide's PR links start. */
  readonly repositoryUrl: string;
  readonly layers: ReadonlySet<number>;
  readonly open: (number: number) => void;
}

export const StackLinksContext = createContext<StackLinks | null>(null);
