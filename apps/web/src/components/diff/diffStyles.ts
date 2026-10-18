export const DIFF_CSS = `
[data-diff], [data-file], [data-error-wrapper] {
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-bg: var(--code-background);
  --diffs-light-bg: var(--code-background);
  --diffs-dark-bg: var(--code-background);
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: var(--code-background);
  --diffs-bg-separator-override: var(--code-background);
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-addition));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--code-background) 78%, var(--diff-addition));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-deletion));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--code-background) 78%, var(--diff-deletion));
  background: var(--code-background);
  color: var(--code-foreground);
}
[data-separator-content] { font-family: var(--font-sans); }
:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  height: 24px !important;
  margin-block: 0 !important;
  background-color: var(--code-background) !important;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-wrapper] {
  padding-inline: 8px 12px !important;
  background-color: transparent !important;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  gap: 8px;
  padding-inline: 0 !important;
  background-color: transparent !important;
  color: color-mix(in srgb, var(--code-foreground) 52%, var(--code-background)) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-unmodified-lines] {
  display: flex !important;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-unmodified-lines]::before,
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-unmodified-lines]::after {
  height: 1px;
  flex: 1 1 auto;
  content: "";
  background-color: color-mix(in srgb, var(--code-background) 92%, var(--code-foreground));
}
:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index] [data-separator-wrapper] {
  grid-template-columns: 0 minmax(0, 1fr) !important;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index] [data-separator-content] {
  grid-column: 2 !important;
  cursor: pointer;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-expand-button] {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
  border: 0 !important;
  white-space: nowrap !important;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]:is(:hover, :focus-within) [data-separator-content] {
  color: color-mix(in srgb, var(--code-foreground) 76%, var(--code-background)) !important;
}
:is([data-separator="line-info"], [data-separator="line-info-basic"]):focus-within {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
[data-diff-type="split"][data-overflow="wrap"] { container-type: inline-size; }
[data-overflow="scroll"] [data-deletions] [data-gutter] > [data-separator="line-info"] [data-separator-wrapper] {
  width: 100cqi;
}
[data-overflow="wrap"] [data-deletions] [data-gutter] > [data-separator="line-info"] [data-separator-wrapper] {
  width: 50cqi;
}
[data-unmodified-lines] > [data-scope] {
  order: -1;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 11px var(--font-mono);
  color: color-mix(in srgb, var(--code-foreground) 64%, var(--code-background));
}
[data-scope] > [data-scope-between] {
  color: color-mix(in srgb, var(--code-foreground) 40%, var(--code-background));
}
[data-unmodified-lines][data-scoped]::after { display: none; }
:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]:is(:hover, :focus-within) [data-scope] {
  color: color-mix(in srgb, var(--code-foreground) 76%, var(--code-background));
}
[data-gutter] > [data-column-number] {
  scroll-margin-bottom: var(--pr-covered-bottom, 0px);
}
[data-gutter] > [data-column-number]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
[data-line-annotation], [data-gutter-buffer='annotation'] { --diffs-annotation-bg: var(--diffs-bg); }
[data-line][data-line-type='change-addition'] + [data-line-annotation],
[data-column-number][data-line-type='change-addition'] + [data-gutter-buffer='annotation'] {
  --diffs-computed-diff-line-bg: var(--diffs-bg-addition-override);
}
[data-line-annotation][data-selected-line],
[data-gutter-buffer='annotation'][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
}
[data-line][data-line-type='change-deletion'] + [data-line-annotation],
[data-column-number][data-line-type='change-deletion'] + [data-gutter-buffer='annotation'] {
  --diffs-computed-diff-line-bg: var(--diffs-bg-deletion-override);
}
`;
