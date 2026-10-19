/**
 * Migrations are statically imported and keyed `${id}_${name}`. The migrator
 * records each id in `effect_sql_migrations` and runs only ids above the latest
 * recorded one, so a migration runs once per database.
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./Migrations/001_Meta.ts";
import Migration0002 from "./Migrations/002_GitHubConfigDirs.ts";
import Migration0003 from "./Migrations/003_Workspace.ts";
import Migration0004 from "./Migrations/004_Reviews.ts";
import Migration0005 from "./Migrations/005_ReviewWatch.ts";
import Migration0006 from "./Migrations/006_PullRequestActions.ts";
import Migration0007 from "./Migrations/007_ReviewComments.ts";
import Migration0008 from "./Migrations/008_GuideGeneration.ts";
import Migration0009 from "./Migrations/009_GuideConfig.ts";
import Migration0010 from "./Migrations/010_GitHubReadCache.ts";
import Migration0011 from "./Migrations/011_Fixers.ts";
import Migration0012 from "./Migrations/012_Stacks.ts";
import Migration0013 from "./Migrations/013_FixerScriptTrust.ts";
import Migration0014 from "./Migrations/014_InboxFilters.ts";
import Migration0015 from "./Migrations/015_FixerTurnEnds.ts";
import Migration0016 from "./Migrations/016_AgentInstances.ts";
import Migration0017 from "./Migrations/017_OutsideAgents.ts";
import Migration0018 from "./Migrations/018_GuideNoteComments.ts";
import Migration0019 from "./Migrations/019_ReviewSubjects.ts";
import Migration0020 from "./Migrations/020_ReviewedFiles.ts";
import Migration0021 from "./Migrations/021_DraftContext.ts";
import Migration0022 from "./Migrations/022_OpenLocalReviews.ts";
import Migration0023 from "./Migrations/023_ManualCheckTicks.ts";
import Migration0024 from "./Migrations/024_WorkspaceVersion.ts";
import Migration0025 from "./Migrations/025_Asks.ts";
import Migration0026 from "./Migrations/026_ManualCheckTickCode.ts";

export const migrationEntries = [
  [1, "Meta", Migration0001],
  [2, "GitHubConfigDirs", Migration0002],
  [3, "Workspace", Migration0003],
  [4, "Reviews", Migration0004],
  [5, "ReviewWatch", Migration0005],
  [6, "PullRequestActions", Migration0006],
  [7, "ReviewComments", Migration0007],
  [8, "GuideGeneration", Migration0008],
  [9, "GuideConfig", Migration0009],
  [10, "GitHubReadCache", Migration0010],
  [11, "Fixers", Migration0011],
  [12, "Stacks", Migration0012],
  [13, "FixerScriptTrust", Migration0013],
  [14, "InboxFilters", Migration0014],
  [15, "FixerTurnEnds", Migration0015],
  [16, "AgentInstances", Migration0016],
  [17, "OutsideAgents", Migration0017],
  [18, "GuideNoteComments", Migration0018],
  [19, "ReviewSubjects", Migration0019],
  [20, "ReviewedFiles", Migration0020],
  [21, "DraftContext", Migration0021],
  [22, "OpenLocalReviews", Migration0022],
  [23, "ManualCheckTicks", Migration0023],
  [24, "WorkspaceVersion", Migration0024],
  [25, "Asks", Migration0025],
  [26, "ManualCheckTickCode", Migration0026],
] as const;

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

export const runMigrations = Effect.fn("runMigrations")(function* () {
  const executed = yield* run({ loader });
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logInfo("Database schema is current")
    : Effect.logInfo("Migrations ran").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});
