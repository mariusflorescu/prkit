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
import { OUTSIDE_INSTRUCTIONS } from "../../outside/instructions.ts";
import { CurrentClient, reads, startsWork, toLayer } from "./access.ts";
import { makeOutsideToolkit, type OutsideToolkit } from "./tools.ts";

const handlers = (toolkit: OutsideToolkit) =>
  toLayer(
    toolkit,
    Effect.gen(function* () {
      const work = yield* OutsideWork;
      return {
        prkit_status: reads(() => work.status()),
        list_inbox: reads((input) => work.inbox(input)),
        list_open_pull_requests: reads(() => work.openPullRequests()),
        read_pull_request: reads((input) => work.pullRequest(input)),
        read_guide: reads((input) => work.guide(input)),
        list_review_comments: reads((input) => work.comments(input)),
        read_fix: reads((input) => work.fix(input)),
        wait_for: reads((input) => work.waitFor(input)),
        list_accounts: reads((input) => work.listAccounts(input)),
        list_repositories: reads((input) => work.repositories(input)),
        list_repository_pull_requests: reads((input) => work.repositoryPullRequests(input)),
        list_agents: reads((input) => work.catalog(input)),
        read_pull_request_files: reads((input) => work.files(input)),
        read_file_contents: reads((input) => work.fileContents(input)),
        read_timeline: reads((input) => work.timeline(input)),
        read_threads: reads((input) => work.threads(input)),
        read_checks: reads((input) => work.checks(input)),
        read_conversation: reads((input) => work.conversation(input)),
        read_stack: reads((input) => work.stack(input)),
        read_pull_request_candidates: reads((input) => work.candidates(input)),
        list_reviews: reads((input) => work.listReviews(input)),
        list_guide_revisions: reads((input) => work.revisions(input)),
        read_guide_revision: reads((input) => work.revision(input)),
        read_guide_progress: reads((input) => work.progress(input)),
        read_review_diff: reads((input) => work.reviewDiff(input)),
        read_guide_duration: reads((input) => work.duration(input)),
        read_guide_settings: reads((input) => work.guideSettingsFor(input)),
        read_guide_scope: reads((input) => work.guideScope(input)),
        list_guide_repositories: reads((input) => work.guideRepositories(input)),
        find_guide_repository: reads((input) => work.findGuideRepository(input)),
        list_fixes: reads((input) => work.listFixes(input)),
        read_fix_turn: reads((input) => work.fixTurn(input)),
        read_fix_diff: reads((input) => work.fixDiff(input)),
        read_fix_patch: reads((input) => work.fixPatch(input)),
        read_fix_access: reads((input) => work.fixAccess(input)),
        read_settings: reads((input) => work.settings(input)),
        open_pull_request: startsWork((input) => work.open(input)),
        generate_guide: startsWork((input) => work.generateGuide(input)),
        stop_guide: startsWork((input) => work.stopGuide(input)),
        add_review_comment: startsWork((input) => work.addComment(input)),
        send_to_fix_agent: startsWork((input) => work.sendToFix(input)),
        ask_fix_agent_to_change: startsWork((input) => work.revise(input)),
        stop_fix: startsWork((input) => work.stopFix(input)),
        retry_fix: startsWork((input) => work.retryFix(input)),
        resolve_conflicts: startsWork((input) => work.resolveConflicts(input)),
        close_pull_request: startsWork((input) => work.close(input)),
        focus_pull_request: startsWork((input) => work.focus(input)),
        reorder_pull_requests: startsWork((input) => work.reorder(input)),
        save_inbox_filters: startsWork((input) => work.saveInboxFilters(input)),
        save_pull_request_guide_settings: startsWork((input) => work.saveGuideSettings(input)),
        edit_review_comment: startsWork((input) => work.editComment(input)),
        move_review_comment: startsWork((input) => work.moveComment(input)),
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
