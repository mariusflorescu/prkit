import type {
  AccountId,
  CommentAnchor,
  CommentPlacement,
  NoteRef,
  PullRequestKey,
  ReviewCommentId,
} from "@prkit/contracts";
import { create } from "zustand";

/** A PR as one account reads it; comments written on it belong to that account. */
type Owner = { readonly key: PullRequestKey; readonly accountId: AccountId };
/** Where a guide note is shown: its revision's own diff on the Guide, or GitHub's diff on Files. */
export type NoteSurface = "guide" | "files";
/** The diff a composer was opened on, whose line numbers its placement uses. */
export type ComposerSite =
  | { readonly on: "files" }
  | { readonly on: "guide"; readonly revision: number };
/** A comment started from a guide note, and where its line is now if the code moved. */
export type NoteDraft = { ref: NoteRef; text: string; movedTo: CommentAnchor | null };
/**
 * Where a new comment is being written; one composer per PR, like GitHub. Its lines are
 * captured with the rows around them, so after a push it follows its code like a draft.
 */
export type Composer = {
  pr: Owner;
  site: ComposerSite;
  placement: CommentPlacement;
  note: NoteDraft | null;
};
/** An outdated draft waiting for the user to pick its new line in the same file. */
type Moving = { key: PullRequestKey; path: string; id: ReviewCommentId };
/** A form whose words are kept here: a PR's composer, an edit of a draft, or a reply to a thread. */
export type FormKey = `composer:${string}` | `edit:${string}` | `reply:${string}`;
/** What a form holds and where its caret was, read back when the diff remounts the field. */
export type Words = { readonly text: string; readonly start: number; readonly end: number };
/**
 * The form to focus when its field shows. A form just opened takes focus; a field the diff
 * remounted takes it back only if nothing else took it meanwhile.
 */
type Focus = { readonly form: FormKey; readonly restore: boolean };

const ownerOf = ({ key, accountId }: Owner) => `${accountId} ${key}`;
export const composerForm = (pr: Owner): FormKey => `composer:${ownerOf(pr)}`;
export const editForm = (id: ReviewCommentId): FormKey => `edit:${id}`;
export const replyForm = (pr: Owner, threadId: string): FormKey =>
  `reply:${ownerOf(pr)} ${threadId}`;
/**
 * Pierre keys its annotation slots by position, so one note's words would stay in the field
 * when the composer moves to another note. A key per note starts the field again.
 */
export const composerKey = ({ note }: Composer) =>
  note === null ? "lines" : `${note.ref.revision}:${note.ref.path}:${note.ref.index}`;

const wordsOf = (text: string): Words => ({ text, start: text.length, end: text.length });
const without = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

type State = {
  composers: ReadonlyMap<string, Composer>;
  moving: Moving | null;
  /** Inline edits and replies on screen per PR, besides the composer. */
  forms: Partial<Record<PullRequestKey, number>>;
  /** An edit or a reply is open while it has words here. */
  words: ReadonlyMap<FormKey, Words>;
  focus: Focus | null;
};

export const useReviewCommentsStore = create<
  State & {
    /** Opens a PR's composer. Words already typed on other lines of the PR come along. */
    compose: (composer: Composer) => void;
    /** Closes this composer, unless another one has taken its place since. */
    closeComposer: (composer: Composer) => void;
    /** Opens an edit or a reply holding `text`. */
    beginWriting: (form: FormKey, text: string) => void;
    stopWriting: (form: FormKey) => void;
    /** Updates an open form's words; a closed form stays closed. */
    keepWords: (form: FormKey, words: Words) => void;
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
      const form = composerForm(composer.pr);
      const open = state.composers.get(ownerOf(composer.pr));
      const typed = state.words.get(form);
      const carried =
        composer.note === null &&
        typed !== undefined &&
        typed.text.trim() !== "" &&
        typed.text !== (open?.note?.text ?? "");
      return {
        composers: new Map(state.composers).set(ownerOf(composer.pr), composer),
        moving: null,
        words: new Map(state.words).set(form, carried ? typed : wordsOf(composer.note?.text ?? "")),
        focus: { form, restore: false },
      };
    }),
  closeComposer: (composer) =>
    set((state) => {
      if (state.composers.get(ownerOf(composer.pr)) !== composer) return state;
      const form = composerForm(composer.pr);
      return {
        composers: without(state.composers, ownerOf(composer.pr)),
        words: without(state.words, form),
        focus: state.focus?.form === form ? null : state.focus,
      };
    }),
  beginWriting: (form, text) =>
    set((state) => ({
      words: new Map(state.words).set(form, wordsOf(text)),
      focus: { form, restore: false },
    })),
  stopWriting: (form) =>
    set((state) => ({
      words: without(state.words, form),
      focus: state.focus?.form === form ? null : state.focus,
    })),
  // React reports a selection in the same keydown that closed the form, which must not reopen it.
  keepWords: (form, words) =>
    set((state) =>
      state.words.has(form) ? { words: new Map(state.words).set(form, words) } : state,
    ),
  focusForm: (form) => set({ focus: { form, restore: true } }),
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

/** The composer open on a PR as this account reads it, on any surface. */
export const composerOn = (pr: Owner) => (state: State) => state.composers.get(ownerOf(pr)) ?? null;

/** Whether words are being written in a form inside a PR's Files diffs: a new comment, an edit or a reply. */
export const writingOn = (pr: Owner) => (state: State) =>
  state.composers.get(ownerOf(pr))?.site.on === "files" || (state.forms[pr.key] ?? 0) > 0;
