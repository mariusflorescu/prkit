import { AccountId } from "@prkit/contracts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AppShell } from "~/components/AppShell";
import { AccountsSettings } from "~/features/accounts/AccountsSettings";
import { GuidesSettings } from "~/features/guides/GuidesSettings";
import { AboutSettings } from "~/features/settings/AboutSettings";
import { AgentsSettings } from "~/features/settings/agents/AgentsSettings";
import { AppearanceSettings } from "~/features/settings/appearance/AppearanceSettings";
import { VISIBLE_SETTINGS_SECTIONS } from "~/features/settings/settingsSections";
import { OutsideAgentsSettings } from "~/features/settings/outsideAgents/OutsideAgentsSettings";
import { KeyboardShortcutsSettings } from "~/features/settings/shortcuts/KeyboardShortcutsSettings";
import { UpdatesSettings } from "~/features/updates/UpdatesSettings";
import { updatesBridge } from "~/lib/desktop";
import { InboxPage } from "~/routes/InboxPage";
import { SettingsPage } from "~/routes/SettingsPage";
import { PullRequestPage } from "~/routes/PullRequestPage";
import { PullRequestTab, useWorkspaceSession } from "~/features/workspace/sessionStore";

const rootRoute = createRootRoute({ component: AppShell });

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: InboxPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

// /settings has no page of its own: it opens the section used last (Accounts the first time).
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    const last = useWorkspaceSession.getState().settingsTab.section;
    const section = VISIBLE_SETTINGS_SECTIONS.find((candidate) => candidate.id === last);
    throw redirect({ to: section?.to ?? "/settings/accounts", replace: true });
  },
});

const settingsSectionRoutes = [
  createRoute({
    getParentRoute: () => settingsRoute,
    path: "accounts",
    component: AccountsSettings,
  }),
  createRoute({ getParentRoute: () => settingsRoute, path: "agents", component: AgentsSettings }),
  createRoute({ getParentRoute: () => settingsRoute, path: "guides", component: GuidesSettings }),
  createRoute({
    getParentRoute: () => settingsRoute,
    path: "outside-agents",
    component: OutsideAgentsSettings,
  }),
  createRoute({
    getParentRoute: () => settingsRoute,
    path: "appearance",
    component: AppearanceSettings,
  }),
  createRoute({
    getParentRoute: () => settingsRoute,
    path: "shortcuts",
    component: KeyboardShortcutsSettings,
  }),
  createRoute({ getParentRoute: () => settingsRoute, path: "about", component: AboutSettings }),
  // A plain browser has no updates to show, so it has no such page.
  ...(updatesBridge === undefined
    ? []
    : [
        createRoute({
          getParentRoute: () => settingsRoute,
          path: "updates",
          component: UpdatesSettings,
        }),
      ]),
];

const pullRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$host/$owner/$repo/$number",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({
      account: AccountId,
      // A tab id from an older link (summary, timeline) opens Conversation, which replaced both.
      tab: Schema.optionalKey(
        PullRequestTab.pipe(Schema.catchDecoding(() => Effect.succeedSome("conversation"))),
      ),
    }),
  ),
  component: PullRequestPage,
});

const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/dev/guide/$fixture",
        loader: async ({ params }) => {
          const { loadFixture } = await import("~/routes/dev/fixtures");
          return loadFixture(params.fixture);
        },
        component: lazyRouteComponent(
          () => import("~/routes/dev/GuideFixturePage"),
          "GuideFixturePage",
        ),
        pendingComponent: lazyRouteComponent(
          () => import("~/routes/dev/GuideFixturePending"),
          "GuideFixturePending",
        ),
        errorComponent: lazyRouteComponent(
          () => import("~/routes/dev/GuideFixtureError"),
          "GuideFixtureError",
        ),
      }),
    ]
  : [];

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    inboxRoute,
    settingsRoute.addChildren([settingsIndexRoute, ...settingsSectionRoutes]),
    pullRequestRoute,
    ...devRoutes,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
