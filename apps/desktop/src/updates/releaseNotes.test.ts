import { describe, expect, it } from "vite-plus/test";

import {
  MAX_ITEM_LENGTH,
  MAX_ITEMS_PER_VERSION,
  MAX_VERSIONS,
  normalizeReleaseNotes,
} from "./releaseNotes.ts";

const PULL = "https://github.com/acme/widgets/pull";

/** A release body as git-cliff writes it (cliff.toml), which is what a generic feed carries. */
const MARKDOWN = `### Features

- Group PRs by why they need you ([#12](${PULL}/12))
- Show **what changed** before you update ([#13](${PULL}/13))

### Fixes

- Keep \`Restart to update\` in view ([#14](${PULL}/14))`;

/** The same body as GitHub's releases.atom serves it: rendered HTML with issue-link anchors. */
const issueLink = (number: number) =>
  `<a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="58456${number}" data-permission-text="Title is private" data-url="https://github.com/acme/widgets/issues/${number}" data-hovercard-type="pull_request" data-hovercard-url="/acme/widgets/pull/${number}/hovercard" href="${PULL}/${number}">#${number}</a>`;
const HTML = `<h3>Features</h3>
<ul>
<li>Group PRs by why they need you (${issueLink(12)})</li>
<li>Show <strong>what changed</strong> before you update (${issueLink(13)})</li>
</ul>
<h3>Fixes</h3>
<ul>
<li>Keep <code>Restart to update</code> in view (${issueLink(14)})</li>
</ul>`;

const EXPECTED_GROUPS = [
  {
    title: "Features",
    items: [
      { text: "Group PRs by why they need you", prUrl: `${PULL}/12` },
      { text: "Show what changed before you update", prUrl: `${PULL}/13` },
    ],
  },
  { title: "Fixes", items: [{ text: "Keep Restart to update in view", prUrl: `${PULL}/14` }] },
];

const STABLE_UPDATE = { offered: "0.2.0", running: "0.1.0", channel: "stable" } as const;

describe("normalizeReleaseNotes", () => {
  it("reads one markdown body from a generic feed as the offered version", () => {
    expect(normalizeReleaseNotes(MARKDOWN, STABLE_UPDATE)).toEqual({
      versions: [{ version: "0.2.0", groups: EXPECTED_GROUPS, summary: null, omittedItems: 0 }],
      omittedVersions: 0,
    });
  });

  it("reads GitHub's HTML for several versions, newest first, links kept", () => {
    const notes = normalizeReleaseNotes(
      [
        { version: "0.2.0-nightly.20261016.2", note: HTML },
        {
          version: "0.2.0-nightly.20261016.1",
          note: `<h3>Performance</h3>\n<ul>\n<li>Open tabs faster (${issueLink(11)})</li>\n</ul>`,
        },
      ],
      {
        offered: "0.2.0-nightly.20261016.2",
        running: "0.1.0-nightly.20261014.5",
        channel: "nightly",
      },
    );
    expect(notes.versions.map((version) => version.version)).toEqual([
      "0.2.0-nightly.20261016.2",
      "0.2.0-nightly.20261016.1",
    ]);
    expect(notes.versions[0]?.groups).toEqual(EXPECTED_GROUPS);
    expect(notes.versions[1]?.groups).toEqual([
      { title: "Performance", items: [{ text: "Open tabs faster", prUrl: `${PULL}/11` }] },
    ]);
  });

  it("keeps a body with no changes as that one line, and drops an empty one", () => {
    const notes = normalizeReleaseNotes(
      [
        { version: "0.2.1", note: "<p>No user-facing changes in this release.</p>" },
        { version: "0.2.0", note: "" },
        { version: "0.1.9", note: null },
      ],
      { ...STABLE_UPDATE, offered: "0.2.1" },
    );
    expect(notes).toEqual({
      versions: [
        {
          version: "0.2.1",
          groups: [],
          summary: "No user-facing changes in this release.",
          omittedItems: 0,
        },
      ],
      omittedVersions: 0,
    });
    expect(normalizeReleaseNotes(null, { ...STABLE_UPDATE, offered: "0.2.1" })).toEqual({
      versions: [],
      omittedVersions: 0,
    });
  });

  it("strips HTML noise to plain text and never keeps markup or unsafe links", () => {
    const noisy = `<h2>What&#39;s Changed</h2>
<script>alert("x")</script>
<ul>
<li>Fix &quot;Couldn&#39;t check&quot; &amp; retry by <a class="user-mention notranslate" href="https://github.com/octocat">@octocat</a> in ${issueLink(21)}</li>
<li><img src="x" onerror="alert(1)">Click <a href="javascript:alert(1)">here</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/acme/widgets/compare/v0.1.0...v0.2.0">v0.1.0...v0.2.0</a></p>`;
    const [version] = normalizeReleaseNotes(noisy, STABLE_UPDATE).versions;
    expect(version?.groups).toEqual([
      {
        title: "Changes",
        items: [
          { text: `Fix "Couldn't check" & retry by @octocat in #21`, prUrl: `${PULL}/21` },
          { text: "Click here" },
        ],
      },
    ]);
    expect(JSON.stringify(version)).not.toMatch(/<|javascript:|alert/);
  });

  it("keeps a markdown body's angle brackets as text", () => {
    const [version] = normalizeReleaseNotes(
      `### Fixes\n\n- Show \`<details>\` blocks & <kbd>Esc</kbd> in a guide ([#20](${PULL}/20))`,
      STABLE_UPDATE,
    ).versions;
    expect(version?.groups[0]?.items).toEqual([
      { text: "Show <details> blocks & <kbd>Esc</kbd> in a guide", prUrl: `${PULL}/20` },
    ]);
  });

  it("caps versions, lines per version and line length", () => {
    const longLine = "x".repeat(MAX_ITEM_LENGTH + 50);
    const body = [
      "### Fixes",
      ...Array.from({ length: MAX_ITEMS_PER_VERSION + 3 }, (_, index) => `- Fix ${index}`),
      `- ${longLine}`,
    ].join("\n");
    const many = Array.from({ length: MAX_VERSIONS + 2 }, (_, index) => ({
      version: `0.${20 - index}.0`,
      note: index === 0 ? `### Features\n- ${longLine}` : body,
    }));
    const notes = normalizeReleaseNotes(many, { ...STABLE_UPDATE, offered: "0.20.0" });
    expect(notes.versions).toHaveLength(MAX_VERSIONS);
    expect(notes.omittedVersions).toBe(2);
    const first = notes.versions[0]?.groups[0]?.items[0]?.text ?? "";
    expect(first).toHaveLength(MAX_ITEM_LENGTH);
    expect(first.endsWith("…")).toBe(true);
    expect(notes.versions[1]?.groups[0]?.items).toHaveLength(MAX_ITEMS_PER_VERSION);
    expect(notes.versions[1]?.omittedItems).toBe(4);
  });

  it("leaves out versions of the other track", () => {
    const notes = normalizeReleaseNotes(
      [
        { version: "0.2.0", note: MARKDOWN },
        { version: "0.2.0-nightly.20261020.1", note: MARKDOWN },
      ],
      STABLE_UPDATE,
    );
    expect(notes.versions.map((version) => version.version)).toEqual(["0.2.0"]);
  });

  it("keeps only the versions the update brings, from the manifest's list of the track", () => {
    const notes = normalizeReleaseNotes(
      ["0.4.0", "0.3.0", "0.2.0", "0.1.0"].map((version) => ({ version, note: MARKDOWN })),
      { offered: "0.4.0", running: "0.2.0", channel: "stable" },
    );
    expect(notes.versions.map((version) => version.version)).toEqual(["0.4.0", "0.3.0"]);
  });
});
