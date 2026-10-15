import {
  cleanClientName,
  OUTSIDE_BRIDGE_HEADER,
  OUTSIDE_CLIENT_HEADER,
  OUTSIDE_MCP_PATH,
  OUTSIDE_OFF,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import { boundPort } from "../../listenAddress.ts";
import { OutsideAgents } from "../../outside/OutsideAgents.ts";
import { OutsideWork } from "../../outside/OutsideWork.ts";
import { makeResponses } from "../../outside/responses.ts";
import { OUTSIDE_INSTRUCTIONS } from "../../outside/instructions.ts";
import { CurrentClient, reads, startsWork, toLayer } from "./access.ts";
import { makeOutsideToolkit, type OutsideToolkit } from "./tools.ts";

const handlers = (toolkit: OutsideToolkit) =>
  toLayer(
    toolkit,
    Effect.gen(function* () {
      const work = yield* OutsideWork;
      const respond = yield* makeResponses;
      return {
        prkit_status: reads((input) => respond("prkit_status", input, () => work.status())),
        list_inbox: reads((input) => respond("list_inbox", input, () => work.inbox(input))),
        list_open_pull_requests: reads((input) =>
          respond("list_open_pull_requests", input, () => work.openPullRequests()),
        ),
        read_pull_request: reads((input) =>
          respond("read_pull_request", input, () => work.pullRequest(input)),
        ),
        read_guide: reads((input) => respond("read_guide", input, () => work.guide(input))),
        list_review_comments: reads((input) =>
          respond("list_review_comments", input, () => work.comments(input)),
        ),
        read_fix: reads((input) => respond("read_fix", input, () => work.fix(input))),
        wait_for: reads((input) => respond("wait_for", input, () => work.waitFor(input))),
        list_accounts: reads((input) =>
          respond("list_accounts", input, () => work.listAccounts(input)),
        ),
        list_repositories: reads((input) =>
          respond("list_repositories", input, () => work.repositories(input)),
        ),
        list_repository_pull_requests: reads((input) =>
          respond("list_repository_pull_requests", input, () => work.repositoryPullRequests(input)),
        ),
        list_agents: reads((input) => respond("list_agents", input, () => work.catalog(input))),
        read_pull_request_files: reads((input) =>
          respond("read_pull_request_files", input, () => work.files(input)),
        ),
        read_file_contents: reads((input) =>
          respond("read_file_contents", input, () => work.fileContents(input)),
        ),
        read_timeline: reads((input) =>
          respond("read_timeline", input, () => work.timeline(input)),
        ),
        read_threads: reads((input) => respond("read_threads", input, () => work.threads(input))),
        read_checks: reads((input) => respond("read_checks", input, () => work.checks(input))),
        read_conversation: reads((input) =>
          respond("read_conversation", input, () => work.conversation(input)),
        ),
        read_stack: reads((input) => respond("read_stack", input, () => work.stack(input))),
        read_pull_request_action_candidates: reads((input) =>
          respond("read_pull_request_action_candidates", input, () => work.candidates(input)),
        ),
        list_reviews: reads((input) =>
          respond("list_reviews", input, () => work.listReviews(input)),
        ),
        list_guide_revisions: reads((input) =>
          respond("list_guide_revisions", input, () => work.revisions(input)),
        ),
        read_guide_revision: reads((input) =>
          respond("read_guide_revision", input, () => work.revision(input)),
        ),
        read_guide_progress: reads((input) =>
          respond("read_guide_progress", input, () => work.progress(input)),
        ),
        read_review_diff: reads((input) =>
          respond("read_review_diff", input, () => work.reviewDiff(input)),
        ),
        read_guide_duration: reads((input) =>
          respond("read_guide_duration", input, () => work.duration(input)),
        ),
        read_guide_settings: reads((input) =>
          respond("read_guide_settings", input, () => work.guideSettingsFor(input)),
        ),
        read_guide_scope: reads((input) =>
          respond("read_guide_scope", input, () => work.guideScope(input)),
        ),
        list_guide_repositories: reads((input) =>
          respond("list_guide_repositories", input, () => work.guideRepositories(input)),
        ),
        find_guide_repository: reads((input) =>
          respond("find_guide_repository", input, () => work.findGuideRepository(input)),
        ),
        list_fixes: reads((input) => respond("list_fixes", input, () => work.listFixes(input))),
        read_fix_turn: reads((input) => respond("read_fix_turn", input, () => work.fixTurn(input))),
        read_fix_diff: reads((input) => respond("read_fix_diff", input, () => work.fixDiff(input))),
        read_fix_patch: reads((input) =>
          respond("read_fix_patch", input, () => work.fixPatch(input)),
        ),
        read_fix_access: reads((input) =>
          respond("read_fix_access", input, () => work.fixAccess(input)),
        ),
        read_settings: reads((input) =>
          respond("read_settings", input, () => work.settings(input)),
        ),
        open_pull_request: startsWork((input) =>
          respond("open_pull_request", input, () => work.open(input)),
        ),
        generate_guide: startsWork((input) =>
          respond("generate_guide", input, () => work.generateGuide(input)),
        ),
        stop_guide: startsWork((input) =>
          respond("stop_guide", input, () => work.stopGuide(input)),
        ),
        add_review_comment: startsWork((input) =>
          respond("add_review_comment", input, () => work.addComment(input)),
        ),
        send_to_fix_agent: startsWork((input) =>
          respond("send_to_fix_agent", input, () => work.sendToFix(input)),
        ),
        ask_fix_agent_to_change: startsWork((input) =>
          respond("ask_fix_agent_to_change", input, () => work.revise(input)),
        ),
        stop_fix: startsWork((input) => respond("stop_fix", input, () => work.stopFix(input))),
        retry_fix: startsWork((input) => respond("retry_fix", input, () => work.retryFix(input))),
        resolve_conflicts: startsWork((input) =>
          respond("resolve_conflicts", input, () => work.resolveConflicts(input)),
        ),
        close_pull_request_tab: startsWork((input) =>
          respond("close_pull_request_tab", input, () => work.close(input)),
        ),
        focus_pull_request_tab: startsWork((input) =>
          respond("focus_pull_request_tab", input, () => work.focus(input)),
        ),
        reorder_pull_request_tabs: startsWork((input) =>
          respond("reorder_pull_request_tabs", input, () => work.reorder(input)),
        ),
        save_inbox_filters: startsWork((input) =>
          respond("save_inbox_filters", input, () => work.saveInboxFilters(input)),
        ),
        save_pull_request_guide_settings: startsWork((input) =>
          respond("save_pull_request_guide_settings", input, () => work.saveGuideSettings(input)),
        ),
        edit_review_comment: startsWork((input) =>
          respond("edit_review_comment", input, () => work.editComment(input)),
        ),
        move_review_comment: startsWork((input) =>
          respond("move_review_comment", input, () => work.moveComment(input)),
        ),
      };
    }),
  );

/**
 * Only the bridge may call: no `Origin` (browsers always send one, the bridge never does),
 * `Host` exactly this loopback address and port, the switch on, and the current token.
 * Answers carry nothing about why beyond the status.
 */
const layerAuth = HttpRouter.middleware(
  Effect.gen(function* () {
    const outside = yield* OutsideAgents;
    const server = yield* HttpServer.HttpServer;
    const host = Option.map(boundPort(server.address), (port) => `127.0.0.1:${port}`);
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const refuse = (status: 401 | 403, reason: string, message: string) =>
          Effect.logWarning("Refused an outside agent request").pipe(
            Effect.annotateLogs({ reason }),
            Effect.as(HttpServerResponse.text(message, { status })),
          );
        if (request.headers["origin"] !== undefined)
          return yield* refuse(403, "origin", "Forbidden");
        if (Option.isNone(host) || request.headers["host"] !== host.value)
          return yield* refuse(403, "host", "Forbidden");
        const settings = outside.current();
        if (!settings.enabled) return yield* refuse(403, "off", OUTSIDE_OFF);
        const authorization = request.headers["authorization"] ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        if (!(yield* outside.accepts(token)))
          return yield* refuse(401, token === "" ? "missing token" : "wrong token", "Unauthorized");
        const name = request.headers[OUTSIDE_CLIENT_HEADER] ?? "";
        yield* outside.seen(request.headers[OUTSIDE_BRIDGE_HEADER] ?? "", name);
        return yield* httpEffect.pipe(
          Effect.provideService(CurrentClient, {
            name: cleanClientName(name),
            access: settings.access,
          }),
        );
      });
  }),
).layer;

/**
 * `/mcp/outside`: the outside agents' endpoint, on the server's own listener with its own
 * auth and toolkit (docs/features/outside-agents.md). `Layer.fresh` gives it an `McpServer`
 * of its own: effect's server layer is memoized, so without it both endpoints would list
 * both toolkits, and agent turns would see these tools.
 */
export const layer = Layer.fresh(
  Layer.unwrap(
    Effect.gen(function* () {
      const outside = yield* OutsideAgents;
      const toolkit = makeOutsideToolkit(() => outside.current().access === "work");
      return McpServer.toolkit(toolkit).pipe(
        Layer.provide(handlers(toolkit)),
        Layer.provide(
          McpServer.layerHttp({
            name: "prkit",
            version: packageJson.version,
            instructions: OUTSIDE_INSTRUCTIONS,
            path: OUTSIDE_MCP_PATH,
            protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_11_25],
            allowSessionTermination: true,
          }).pipe(Layer.provide(layerAuth)),
        ),
      );
    }),
  ),
);
