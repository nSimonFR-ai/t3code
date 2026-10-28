import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import { IssueTrackerHost } from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as JiraApi from "./JiraApi.ts";

export function makeJiraTransport(
  http: HttpClient.HttpClient,
  host: Parameters<typeof IssueTrackerHost.of>[0],
) {
  return JiraApi.make.pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(IssueTrackerHost, host),
    Effect.provide(SourceControlRateLimit.layer),
    Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
}

export const jiraDocument = <Content extends unknown[]>(content: Content) => ({
  type: "doc",
  version: 1,
  content,
});
