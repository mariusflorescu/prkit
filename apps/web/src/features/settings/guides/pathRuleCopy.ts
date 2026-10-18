export type PathRuleKind = "ignore" | "sensitive";

interface PathRuleCopy {
  title: string;
  intro: string;
  /** Finishes "`!pattern` ...". */
  negation: string;
  /** What "the last ... that matches decides" calls one item. */
  order: string;
  placeholder: string;
  emptyGlobal: string;
  emptyOwn: string;
  add: string;
  save: string;
  /** Names the inherited items ("3 ignore rules"). */
  noun: string;
  /** Names a deleted inherited item that an override still points at. */
  danglingNoun: string;
  /** The success toast reads "{saved} saved". */
  saved: string;
  form: (scopeLabel: string) => string;
  list: (scopeLabel: string) => string;
  input: (position: number) => string;
  remove: (pattern: string) => string;
}

export const PATH_RULE_COPY: Record<PathRuleKind, PathRuleCopy> = {
  ignore: {
    title: "Ignore rules",
    intro: "Skipped files stay out of the guide; prkit lists them in a chapter of their own.",
    negation: "keeps files an earlier rule skipped.",
    order: "rule",
    placeholder: "dist/",
    emptyGlobal: "No rules yet.",
    emptyOwn: "No rules of its own yet.",
    add: "Add rule",
    save: "Save ignore rules",
    noun: "ignore rules",
    danglingNoun: "rules",
    saved: "Ignore rules",
    form: (scopeLabel) => `${scopeLabel} ignore rules`,
    list: (scopeLabel) => `${scopeLabel} rules`,
    input: (position) => `Rule ${position}`,
    remove: (pattern) => `Remove rule ${pattern}`,
  },
  sensitive: {
    title: "Always look closely at",
    intro:
      "Files that match always get a careful read: the guide rates their chapter at least medium and shows them next to the risk level. They stay in the guide like any other file.",
    negation: "leaves out a file an earlier pattern matched.",
    order: "path",
    placeholder: "src/auth/",
    emptyGlobal: "No paths yet.",
    emptyOwn: "No paths of its own yet.",
    add: "Add path",
    save: "Save look-closely paths",
    noun: "look-closely paths",
    danglingNoun: "paths",
    saved: "Look-closely paths",
    form: (scopeLabel) => `${scopeLabel} look-closely paths`,
    list: (scopeLabel) => `${scopeLabel} paths`,
    input: (position) => `Path ${position}`,
    remove: (pattern) => `Remove path ${pattern}`,
  },
};
