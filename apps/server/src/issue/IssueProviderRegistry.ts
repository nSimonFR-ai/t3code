import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  IssueTrackingError,
  IssueOperationError,
  IssueUnavailableError,
  issueRepositoryKey,
  sourceControlHostOf,
  SourceControlProviderKind,
  type IssueListInput,
  type IssueProviderKind,
  type IssueRef,
  type OrchestrationProjectShell,
  type SourceControlProviderInfo,
} from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as BitbucketApi from "@t3tools/source-control-bitbucket/server/BitbucketApi";
import * as GitHubApi from "@t3tools/source-control-github/server/GitHubApi";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as AzureDevOpsIssueCli from "./AzureDevOpsIssueCli.ts";
import * as AzureDevOpsIssueProvider from "./AzureDevOpsIssueProvider.ts";
import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";
import * as BitbucketIssueProvider from "./BitbucketIssueProvider.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
import * as GitLabIssueCli from "./GitLabIssueCli.ts";
import * as GitLabIssueProvider from "./GitLabIssueProvider.ts";
import * as ForgejoIssueProvider from "./ForgejoIssueProvider.ts";
import * as LinearIssueProvider from "./LinearIssueProvider.ts";
import {
  issueProviderContextKey,
  type IssueTracker,
  type IssueAdapter,
  type IssueAdapterSource,
} from "./IssueProvider.ts";

const SOURCE_RESOLUTION_CONCURRENCY = 12;

export interface IssueProjectSource {
  readonly project: OrchestrationProjectShell;
  readonly adapter: IssueAdapter;
  readonly repository: string;
  readonly host: string;
  readonly credentialId?: string;
  readonly projectBound?: boolean;
}

export interface IssueWorkspaceProjects {
  readonly supported: ReadonlyArray<IssueProjectSource>;
  readonly unimplemented: ReadonlyMap<
    string,
    {
      readonly host: string;
      readonly kind: IssueProviderKind;
      readonly projectCount: number;
    }
  >;
  readonly viewerRoots: ReadonlyMap<string, ReadonlyArray<string>>;
}

type IssueProjectFilter = Pick<IssueListInput, "projectId" | "host">;

type BoundIssueSource = IssueAdapterSource & { readonly adapter: IssueAdapter };

type ResolvedProjectSource = IssueAdapterSource & {
  readonly adapter: IssueAdapter | null;
  readonly kind: IssueProviderKind;
};

function repositoryIdentityOf(project: OrchestrationProjectShell): string | null {
  const identity = project.repositoryIdentity;
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  return identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null;
}

function issueHostOf(
  identity: OrchestrationProjectShell["repositoryIdentity"],
  kind: IssueProviderKind,
): string {
  if (kind === "forgejo")
    return sourceControlHostOf(identity, SourceControlProviderKind.make(kind));
  const canonicalHost = identity?.canonicalKey?.split("/")[0]?.trim();
  if (canonicalHost !== undefined && canonicalHost.length > 0) return canonicalHost.toLowerCase();
  const provider = identity
    ? detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl)
    : null;
  return provider === null ? kind : new URL(provider.baseUrl).host.toLowerCase();
}

function adapterSourcesOf(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  filter: IssueProjectFilter,
  adapters: ReadonlyMap<IssueProviderKind, IssueAdapter>,
): Effect.Effect<ReadonlyMap<OrchestrationProjectShell["id"], ReadonlyArray<BoundIssueSource>>> {
  return Effect.gen(function* () {
    const sources = new Map<OrchestrationProjectShell["id"], BoundIssueSource[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      for (const adapter of adapters.values()) {
        const source =
          adapter.resolveSource === undefined ? null : yield* adapter.resolveSource(project);
        if (source === undefined || source === null) continue;
        const bound = { adapter, ...source };
        const projectSources = sources.get(project.id);
        if (projectSources === undefined) sources.set(project.id, [bound]);
        else projectSources.push(bound);
      }
    }
    return sources;
  });
}

function resolveProjectSource(
  project: OrchestrationProjectShell,
  refinedKinds: ReadonlyMap<string, IssueProviderKind>,
  adapters: ReadonlyMap<IssueProviderKind, IssueAdapter>,
): ResolvedProjectSource | null {
  const identity = project.repositoryIdentity;
  let kind = identity?.provider;
  const repository = repositoryIdentityOf(project);
  if (!identity || kind === undefined || repository === null) return null;
  if (kind === "unknown") {
    const provider = detectSourceControlProviderFromRemoteUrl(identity.locator.remoteUrl);
    kind = provider === null ? kind : (refinedKinds.get(provider.baseUrl) ?? kind);
  }
  return {
    adapter: adapters.get(kind) ?? null,
    kind,
    repository,
    host: issueHostOf(identity, kind),
  };
}

const projectResolver = Effect.fn("IssueProviderRegistry.projectResolver")(function* (
  byKind: ReadonlyMap<IssueProviderKind, IssueAdapter>,
) {
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const refineUnknownKinds = Effect.fn("IssueProviderRegistry.refineUnknownKinds")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: IssueProjectFilter,
  ) {
    type Candidate = {
      readonly project: OrchestrationProjectShell;
      readonly provider: SourceControlProviderInfo;
      readonly remoteName: string;
      readonly remoteUrl: string;
    };
    const refinements = new Map<string, Candidate[]>();
    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const identity = project.repositoryIdentity;
      if (identity?.provider !== "unknown" || repositoryIdentityOf(project) === null) continue;
      const host = issueHostOf(identity, "unknown");
      if (filter.host !== undefined && host !== "unknown" && host !== filter.host.toLowerCase()) {
        continue;
      }
      const { remoteName, remoteUrl } = identity.locator;
      const provider = detectSourceControlProviderFromRemoteUrl(remoteUrl);
      if (provider === null) continue;
      const candidate = { project, provider, remoteName, remoteUrl };
      const candidates = refinements.get(provider.baseUrl);
      if (candidates === undefined) refinements.set(provider.baseUrl, [candidate]);
      else candidates.push(candidate);
    }

    const resolved = yield* Effect.forEach(
      refinements,
      ([baseUrl, candidates]) =>
        Effect.firstSuccessOf(
          candidates.map(({ project, provider, remoteName, remoteUrl }) =>
            Effect.suspend(() =>
              sourceControlProviders.resolveHandle({
                cwd: project.workspaceRoot,
                context: { provider, remoteName, remoteUrl },
              }),
            ).pipe(
              Effect.flatMap((handle) => {
                const kind = handle.context?.provider.kind;
                return kind === undefined || kind === "unknown"
                  ? Effect.fail(undefined)
                  : Effect.succeed(kind);
              }),
            ),
          ),
        ).pipe(
          Effect.map((kind) => [baseUrl, kind] as const),
          Effect.orElseSucceed(() => [baseUrl, "unknown"] as const),
        ),
      { concurrency: SOURCE_RESOLUTION_CONCURRENCY },
    );
    return new Map<string, IssueProviderKind>(resolved);
  });

  return Effect.fn("IssueProviderRegistry.resolveProjects")(function* (
    projects: ReadonlyArray<OrchestrationProjectShell>,
    filter: IssueProjectFilter,
  ) {
    const boundSources = yield* adapterSourcesOf(projects, filter, byKind);
    const refinedKinds = yield* refineUnknownKinds(projects, filter);
    const supported: IssueProjectSource[] = [];
    const unimplemented = new Map<
      string,
      {
        host: string;
        kind: IssueProviderKind;
        projectCount: number;
      }
    >();
    const viewerRoots = new Map<string, string[]>();
    const seen = new Set<string>();

    for (const project of projects) {
      if (filter.projectId !== undefined && project.id !== filter.projectId) continue;
      const sources: ResolvedProjectSource[] = [];
      for (const bound of boundSources.get(project.id) ?? []) {
        const repository = bound.repository.trim();
        const host = bound.host.trim().toLowerCase();
        if (repository.length > 0 && host.length > 0) {
          sources.push({
            adapter: bound.adapter,
            kind: bound.adapter.kind,
            repository,
            host,
            ...(bound.credentialId === undefined ? {} : { credentialId: bound.credentialId }),
          });
        }
      }
      const sourceControl = resolveProjectSource(project, refinedKinds, byKind);
      if (sourceControl !== null) sources.push(sourceControl);

      for (const { adapter, kind, repository, host, credentialId } of sources) {
        if (filter.host !== undefined && host !== filter.host.toLowerCase()) continue;
        const sourceKey = issueProviderContextKey(kind, host, credentialId, repository);
        if (adapter !== null) {
          const roots = viewerRoots.get(sourceKey);
          if (roots === undefined) viewerRoots.set(sourceKey, [project.workspaceRoot]);
          else if (!roots.includes(project.workspaceRoot)) roots.push(project.workspaceRoot);
        }
        const key = `${issueRepositoryKey(kind, host, repository)}\n${credentialId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (adapter === null) {
          const counted = unimplemented.get(sourceKey);
          if (counted === undefined) {
            unimplemented.set(sourceKey, { host, kind, projectCount: 1 });
          } else counted.projectCount += 1;
          continue;
        }
        supported.push({
          project,
          adapter,
          repository,
          host,
          ...(credentialId === undefined ? {} : { credentialId }),
        });
      }
    }

    return { supported, unimplemented, viewerRoots };
  });
});

export class IssueProviderRegistry extends Context.Service<
  IssueProviderRegistry,
  {
    readonly tracker: (
      provider: IssueProviderKind,
      operation: IssueTrackingError["operation"],
    ) => Effect.Effect<IssueTracker, IssueTrackingError>;
    readonly resolveProjects: (
      projects: ReadonlyArray<OrchestrationProjectShell>,
      filter: IssueProjectFilter,
    ) => Effect.Effect<IssueWorkspaceProjects>;
    readonly resolveUrl: (input: {
      readonly reference: IssueRef & { readonly url: string };
      readonly project: OrchestrationProjectShell;
      readonly sources: ReadonlyArray<IssueProjectSource>;
    }) => Effect.Effect<IssueProjectSource, IssueOperationError | IssueUnavailableError>;
    /** Providers whose repositories can be named outright, independent of any project. */
    readonly referenceProviders: ReadonlySet<IssueProviderKind>;
    /** The first adapter that can read a repository the caller named outright, if any. */
    readonly resolveReference: (
      project: OrchestrationProjectShell,
      reference: {
        readonly repository: string;
        readonly provider?: IssueProviderKind | undefined;
        readonly host?: string | undefined;
      },
    ) => Effect.Effect<IssueProjectSource | null>;
  }
>()("t3/issue/IssueProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
export const fromProviders = Effect.fn("IssueProviderRegistry.fromProviders")(function* (
  providers: ReadonlyArray<IssueAdapter>,
) {
  const byKind = new Map<IssueProviderKind, IssueAdapter>(
    providers.map((provider) => [provider.kind, provider]),
  );
  return {
    tracker: (provider: IssueProviderKind, operation: IssueTrackingError["operation"]) => {
      const tracker = byKind.get(provider)?.tracker;
      return tracker === undefined
        ? Effect.fail(
            new IssueTrackingError({
              operation,
              detail: `Account management is not supported for ${provider}.`,
            }),
          )
        : Effect.succeed(tracker);
    },
    resolveProjects: yield* projectResolver(byKind),
    resolveUrl: Effect.fn("IssueProviderRegistry.resolveUrl")(function* ({
      reference,
      project,
      sources,
    }: {
      readonly reference: IssueRef & { readonly url: string };
      readonly project: OrchestrationProjectShell;
      readonly sources: ReadonlyArray<IssueProjectSource>;
    }) {
      const refuse = (detail: string) =>
        new IssueOperationError({ operation: "resolveRepository", detail });
      const url = URL.parse(reference.url);
      const hostSources = sources.filter(
        (source) => source.host.toLowerCase() === url?.host.toLowerCase(),
      );
      const kinds = new Set(hostSources.map((source) => source.adapter.kind));
      const knownKind = kinds.size === 1 ? [...kinds][0] : undefined;
      const parsed = parseIssueUrl(
        reference.url,
        knownKind === undefined ? {} : { provider: knownKind },
      );
      if (parsed === null || parsed.provider === undefined || parsed.provider === null) {
        return yield* refuse("This issue URL does not name a supported, configured host.");
      }
      const repository = reference.repository.toLowerCase();
      if (
        (reference.provider !== undefined && reference.provider !== parsed.provider) ||
        (reference.host !== undefined &&
          reference.host.toLowerCase() !== parsed.host.toLowerCase()) ||
        reference.number !== parsed.number ||
        (repository !== parsed.repository.toLowerCase() &&
          !(
            parsed.provider === "azure-devops" &&
            repository.startsWith(`${parsed.repository.toLowerCase()}/`)
          ))
      ) {
        return yield* refuse("The issue reference does not match its URL.");
      }
      const adapter = byKind.get(parsed.provider);
      if (adapter === undefined)
        return yield* new IssueUnavailableError({
          reason: "provider-unsupported",
          provider: parsed.provider,
        });
      const azureHosts = new Set([
        "dev.azure.com",
        `${parsed.repository.split("/")[0]!.toLowerCase()}.visualstudio.com`,
      ]);
      const matching = sources.filter(
        (source) =>
          source.adapter.kind === parsed.provider &&
          (source.host.toLowerCase() === parsed.host ||
            (parsed.provider === "azure-devops" &&
              azureHosts.has(parsed.host) &&
              azureHosts.has(source.host.toLowerCase()))) &&
          (source.repository.toLowerCase() === repository ||
            (parsed.provider === "azure-devops" &&
              repository === parsed.repository.toLowerCase() &&
              source.repository.toLowerCase().startsWith(`${repository}/`))),
      );
      const bound =
        matching.find((source) => source.project.id === project.id) ??
        (matching.length === 1 ? matching[0] : undefined);
      let credentialId = bound?.credentialId;
      if (parsed.provider === "linear" && bound === undefined) {
        if (adapter.tracker === undefined)
          return yield* new IssueUnavailableError({
            reason: "cli-unauthenticated",
            provider: "linear",
          });
        const connection = yield* adapter.tracker.status.pipe(
          Effect.mapError(
            (cause) =>
              new IssueOperationError({
                operation: "credential",
                detail: "Could not read the connected Linear accounts.",
                cause,
              }),
          ),
        );
        const accounts = connection.accounts.filter(
          (account) =>
            account.status === "authenticated" &&
            account.projects.some((team) => team.key.toLowerCase() === repository),
        );
        const environmentMatches =
          connection.environmentAccount?.status === "authenticated" &&
          connection.environmentAccount.projects.some(
            (team) => team.key.toLowerCase() === repository,
          );
        if (accounts.length + (environmentMatches ? 1 : 0) > 1)
          return yield* refuse(
            "More than one Linear account can read this team. Bind the intended account to the project.",
          );
        if (accounts.length === 0 && !environmentMatches)
          return yield* new IssueUnavailableError({
            reason: "cli-unauthenticated",
            provider: "linear",
          });
        credentialId = accounts[0]?.credentialId;
      }
      return {
        project: bound?.project ?? project,
        adapter,
        projectBound: bound !== undefined,
        repository: reference.repository,
        host: bound?.host ?? parsed.host,
        ...(credentialId === undefined ? {} : { credentialId }),
      };
    }),
    referenceProviders: new Set(
      providers.flatMap((provider) =>
        provider.resolveReference === undefined ? [] : [provider.kind],
      ),
    ),
    resolveReference: Effect.fn("IssueProviderRegistry.resolveReference")(function* (
      project: OrchestrationProjectShell,
      reference: {
        readonly repository: string;
        readonly provider?: IssueProviderKind | undefined;
        readonly host?: string | undefined;
      },
    ) {
      for (const adapter of byKind.values()) {
        if (adapter.resolveReference === undefined) continue;
        if (reference.provider !== undefined && adapter.kind !== reference.provider) continue;
        const source = yield* adapter.resolveReference(project, reference.repository.trim());
        if (source === null) continue;
        const host = source.host.trim().toLowerCase();
        if (reference.host !== undefined && host !== reference.host.toLowerCase()) continue;
        return {
          project,
          adapter,
          projectBound: false,
          repository: source.repository,
          host,
          ...(source.credentialId === undefined ? {} : { credentialId: source.credentialId }),
        } satisfies IssueProjectSource;
      }
      return null;
    }),
  };
});

/**
 * The hosts this build can read issues from. A host with no entry here still shows up in the
 * provider list as unimplemented, so its projects are explained rather than missing.
 */
const make = Effect.gen(function* () {
  const providers = yield* Effect.all([
    GitHubIssueProvider.make,
    GitLabIssueProvider.make,
    BitbucketIssueProvider.make,
    AzureDevOpsIssueProvider.make,
    LinearIssueProvider.make,
    ForgejoIssueProvider.make,
  ]);
  return yield* fromProviders(providers);
});

export const layer = Layer.effect(IssueProviderRegistry, make).pipe(
  Layer.provide(GitHubIssueCli.layer.pipe(Layer.provideMerge(GitHubApi.layerWithDependencies))),
  Layer.provide(GitLabIssueCli.layer.pipe(Layer.provide(GitLabCli.layer))),
  Layer.provide(BitbucketIssueApi.layer.pipe(Layer.provide(BitbucketApi.layer))),
  Layer.provide(AzureDevOpsIssueCli.layer.pipe(Layer.provide(AzureDevOpsCli.layer))),
  Layer.provide(ForgejoCli.layer),
);
