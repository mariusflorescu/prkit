import { describeSignal, type RiskSignal, SCOPE_LABELS, signalFiles } from "@prkit/contracts";

const LISTED_FILES = 20;

const CHECKED: Record<RiskSignal["_tag"], string> = {
  sensitive: "paths the reviewer always looks closely at",
  migration: "database migrations and schema files",
  dependencies: "dependency and lockfile changes",
  ci: "CI config",
  "fewer-checks": "removed or skipped tests",
  untested: "code changed with no test changed",
  large: "a large change",
};

const filesOf = (signal: RiskSignal) => {
  const items =
    signal._tag === "sensitive"
      ? signal.files.map(
          (file) => `\`${file.path}\` matches \`${file.pattern}\` (${SCOPE_LABELS[file.scope]})`,
        )
      : signalFiles(signal).map((path) => `\`${path}\``);
  const hidden = items.length - LISTED_FILES;
  return [
    ...items.slice(0, LISTED_FILES).map((item) => `  ${item}`),
    ...(hidden > 0 ? [`  and ${hidden} more`] : []),
  ];
};

/** The prompt's section on what prkit found in the reviewed files, and the log label for it. */
export const riskSignalLines = (signals: ReadonlyArray<RiskSignal>) => {
  const fired: ReadonlySet<string> = new Set(signals.map((signal) => signal._tag));
  const missing = Object.entries(CHECKED).flatMap(([tag, words]) =>
    fired.has(tag) ? [] : [words],
  );
  return {
    label: `signals:${signals.length === 0 ? "none" : signals.map((signal) => signal._tag).join(",")}`,
    lines: [
      'prkit checked the reviewed files for facts that bear on how carefully to read. They are evidence, not verdicts: weigh them with what you read when you write `risk` (see "How carefully to read" in your instructions). The reviewer sees them next to your level.',
      ...(signals.length === 0
        ? [
            `prkit checked for ${missing.join(", ")}. None of them fired. That alone is no reason for \`low\`: judge the level from what you read.`,
          ]
        : [
            ...signals.flatMap((signal) => {
              const { label, text } = describeSignal(signal);
              return [`- ${label}: ${text}`, ...filesOf(signal)];
            }),
            ...(fired.has("sensitive")
              ? [
                  "Every chapter that holds a file matching one of those look-closely paths is at least `medium`.",
                ]
              : []),
            ...(missing.length === 0
              ? []
              : [`prkit also checked for, and didn't find: ${missing.join(", ")}.`]),
          ]),
      "",
    ],
  };
};
