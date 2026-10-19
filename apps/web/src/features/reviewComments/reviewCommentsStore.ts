import type {
  AccountId,
  CommentAnchor,
  CommentPlacement,
  NoteKey,
  NoteRef,
  PullRequestKey,
  ReviewCommentId,
} from "@prkit/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/** A PR as one account reads it; comments written on it belong to that account. */
type Owner = { readonly key: PullRequestKey; readonly accountId: AccountId };
/** Where a guide note is shown: its revision's own diff on the Guide, or GitHub's diff on Files. */
export type NoteSurface = "guide" | "files";
/** The diff a composer is on, whose line numbers its placement is read against. */
export type ComposerSite =
  | { readonly on: "files" }
  | { readonly on: "guide"; readonly revision: number };
/**
 * A comment started from a guide note. `remark` names it on every surface and revision,
 * `ref` the note it was opened from, and `movedTo` where its line is now if the code moved.
 */
export type NoteDraft = {
  ref: NoteRef;
  remark: NoteKey;
  text: string;
  movedTo: CommentAnchor | null;
};
/**
 * Where a new comment is being written: one under picked lines per PR, like GitHub, and one per
 * guide remark. Its lines are captured with the rows around them, so after a push it follows
 * its code like a draft.
 */
export type Composer = {
  pr: Owner;
  site: ComposerSite;
  placement: CommentPlacement;
  note: NoteDraft | null;
};
/** An outdated draft waiting for the user to pick its new line in the same file. */
type Moving = { key: PullRequestKey; path: string; id: ReviewCommentId };
/** A form whose words are kept here: a composer, an edit of a draft, or a reply to a thread. */
export type FormKey =
  | `composer:${string}`
  | `note:${string}`
  | `edit:${string}`
  | `reply:${string}`;
/** What a form holds and where its caret was, read back when the diff remounts the field. */
export type Words = { readonly text: string; readonly start: number; readonly end: number };
/** An open form's words, and why its last send failed, until the words change or go again. */
type Writing = Words & { readonly failed: string | null };
/**
 * The form to focus when its field shows: always, for one just opened, or only if focus went
 * nowhere, for one whose field had it before the diff remounted it.
 */
type Focus = { readonly form: FormKey; readonly take: "opened" | "lost" };

const ownerOf = ({ key, accountId }: Owner) => `${accountId} ${key}`;
export const noteForm = (pr: Owner, note: NoteKey): FormKey => `note:${ownerOf(pr)} ${note}`;
export const composerForm = ({ pr, note }: Composer): FormKey =>
  note === null ? `composer:${ownerOf(pr)}` : noteForm(pr, note.remark);
export const editForm = (id: ReviewCommentId): FormKey => `edit:${id}`;
export const replyForm = (pr: Owner, threadId: string): FormKey =>
  `reply:${ownerOf(pr)} ${threadId}`;

const without = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};
/** Opens a form holding `text`, unless it is open already: what it holds is never replaced. */
const opened = (words: ReadonlyMap<FormKey, Writing>, form: FormKey, text: string) =>
  words.has(form)
    ? words
    : new Map(words).set(form, { text, start: text.length, end: text.length, failed: null });

type State = {
  composers: ReadonlyMap<FormKey, Composer>;
  moving: Moving | null;
  /** Inline edits and replies on screen per PR, besides the composers. */
  forms: Partial<Record<PullRequestKey, number>>;
  /** An edit or a reply is open while it has words here. */
  words: ReadonlyMap<FormKey, Writing>;
  focus: Focus | null;
};

export const useReviewCommentsStore = create<
  State & {
    /** Opens a composer, or moves the one already open for the same lines or remark, words and all. */
    compose: (composer: Composer) => void;
    /** Closes a composer, wherever it moved since it opened. */
    closeComposer: (form: FormKey) => void;
    /** Takes a PR's composers on the Guide to the revision picked there. */
    moveToRevision: (pr: Owner, revision: number) => void;
    /** Opens an edit or a reply holding `text`, or keeps the words it already holds. */
    beginWriting: (form: FormKey, text: string) => void;
    stopWriting: (form: FormKey) => void;
    /** Updates an open form's words; a closed form stays closed, and new words clear a failure. */
    keepWords: (form: FormKey, words: Words) => void;
    /** Says why an open form's send failed, or `null` once it is sent again. */
    sendFailed: (form: FormKey, failed: string | null) => void;
    focusForm: (form: FormKey) => void;
    blurForm: (form: FormKey) => void;
    startMove: (moving: Moving) => void;
    stopMove: () => void;
    openForm: (key: PullRequestKey) => void;
    closeForm: (key: PullRequestKey) => void;
  }
>((set) => ({
  composers: new Map(),
  moving: null,
  forms: {},
  words: new Map(),
  focus: null,
  compose: (composer) =>
    set((state) => {
      const form = composerForm(composer);
      return {
        composers: new Map(state.composers).set(form, composer),
        moving: null,
        words: opened(state.words, form, composer.note?.text ?? ""),
        focus: { form, take: "opened" },
      };
    }),
  closeComposer: (form) =>
    set((state) => {
      if (!state.composers.has(form)) return state;
      return {
        composers: without(state.composers, form),
        words: without(state.words, form),
        focus: state.focus?.form === form ? null : state.focus,
      };
    }),
  moveToRevision: (pr, revision) =>
    set((state) => {
      const moved = [...state.composers].filter(
        ([, { pr: owner, site }]) =>
          ownerOf(owner) === ownerOf(pr) && site.on === "guide" && site.revision !== revision,
      );
      if (moved.length === 0) return state;
      const composers = new Map(state.composers);
      for (const [form, composer] of moved)
        composers.set(form, { ...composer, site: { on: "guide", revision } });
      return { composers };
    }),
  beginWriting: (form, text) =>
    set((state) => ({
      words: opened(state.words, form, text),
      focus: { form, take: "opened" },
    })),
  stopWriting: (form) =>
    set((state) => ({
      words: without(state.words, form),
      focus: state.focus?.form === form ? null : state.focus,
    })),
  // React reports a selection in the same keydown that closed the form, which must not reopen it.
  keepWords: (form, words) =>
    set((state) => {
      const kept = state.words.get(form);
      if (kept === undefined) return state;
      const failed = kept.text === words.text ? kept.failed : null;
      return { words: new Map(state.words).set(form, { ...words, failed }) };
    }),
  sendFailed: (form, failed) =>
    set((state) => {
      const kept = state.words.get(form);
      if (kept === undefined || kept.failed === failed) return state;
      return { words: new Map(state.words).set(form, { ...kept, failed }) };
    }),
  focusForm: (form) => set({ focus: { form, take: "lost" } }),
  blurForm: (form) => set((state) => (state.focus?.form === form ? { focus: null } : state)),
  startMove: (moving) => set({ moving }),
  stopMove: () => set({ moving: null }),
  openForm: (key) =>
    set((state) => ({ forms: { ...state.forms, [key]: (state.forms[key] ?? 0) + 1 } })),
  closeForm: (key) =>
    set((state) => ({
      forms: { ...state.forms, [key]: Math.max(0, (state.forms[key] ?? 0) - 1) },
    })),
}));

/** Whether a composer is on this surface, and on the Guide on this revision. */
export const onSite =
  (site: ComposerSite) =>
  ({ site: at }: Composer) =>
    at.on === "files" ? site.on === "files" : site.on === "guide" && at.revision === site.revision;

/** The composers open on a PR as this account reads it, on any surface. */
export const useComposers = (pr: Owner) =>
  useReviewCommentsStore(
    useShallow((state) =>
      [...state.composers.values()].filter((composer) => ownerOf(composer.pr) === ownerOf(pr)),
    ),
  );

/** Whether words are being written in a form inside a PR's Files diffs: a new comment, an edit or a reply. */
export const writingOn = (pr: Owner) => (state: State) =>
  [...state.composers.values()].some(
    (composer) => composer.site.on === "files" && ownerOf(composer.pr) === ownerOf(pr),
  ) || (state.forms[pr.key] ?? 0) > 0;
