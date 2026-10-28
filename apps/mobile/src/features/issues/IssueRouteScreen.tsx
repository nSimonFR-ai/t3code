import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type IssueComment,
  type IssueDetail,
  type IssueEvent,
  type IssueLinkedPullRequest,
  type IssueReactionContent,
  type IssueListOrder,
  type IssueState,
} from "@t3tools/contracts";
import { use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useProject, useProjects, useServerConfigs } from "../../state/entities";
import {
  issueEnvironment,
  useIssueComments,
  useIssueHistory,
  useIssueLinkedPullRequests,
} from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { PullRequestCardGroup, PullRequestCardRow } from "../pull-requests/PullRequestControls";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import { PullRequestMediaContext } from "../pull-requests/PullRequestMedia";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import { issueReactionAllowed, issueTimeline, linkedPullRequestContext } from "./issueDetail";
import {
  mergeIssueComments,
  confirmIssueReaction,
  issueReactionsView,
  type IssueConfirmedReactions,
} from "./issueComments";
import { IssueReactions } from "./IssueReactions";
import { issueParamsKey, type IssueParams } from "./issueSelection";
import { issueStatus } from "./issueStatus";
import { issueTarget, markIssueTargetWritten, useIssueAccess } from "./useIssueAccess";

function linkedPullRequestStatus(link: IssueLinkedPullRequest) {
  return link.state === null
    ? ({ label: "Unknown", icon: PullRequestGlyph.pullRequest, tint: "accent-icon-muted" } as const)
    : pullRequestStatus({ state: link.state, isDraft: link.isDraft === true });
}

function LinkedPullRequestRow(props: {
  readonly link: IssueLinkedPullRequest;
  readonly environmentId: string;
  readonly last: boolean;
}) {
  const { link } = props;
  const projects = useProjects();
  const configs = useServerConfigs();
  const context = linkedPullRequestContext(
    link.url,
    props.environmentId,
    projects,
    configs.get(EnvironmentId.make(props.environmentId))?.environment.capabilities,
  );
  const openPullRequest = useOpenPullRequest(context ? { context } : undefined);
  const linkStatus = linkedPullRequestStatus(link);
  return (
    <PullRequestCardRow
      title={link.title}
      icon={linkStatus.icon}
      tint={linkStatus.tint}
      detail={`${link.repository}#${link.number}${link.closesIssue ? " · closes this issue" : ""}`}
      accessibilityLabel={`Pull request ${link.number}, ${link.title}, ${linkStatus.label}`}
      last={props.last}
      onPress={() =>
        void (context ? openPullRequest(link.url) : tryOpenExternalUrl(link.url, "pull-request"))
      }
    />
  );
}

function IssueEventRow({ event }: { readonly event: IssueEvent }) {
  const verb: Record<IssueEvent["kind"], string> = {
    closed: "closed this",
    reopened: "reopened this",
    labeled: "added",
    unlabeled: "removed",
    assigned: "assigned",
    unassigned: "unassigned",
    renamed: "renamed this to",
    referenced: "referenced this in",
    "state-changed": "moved this to",
    changed: "changed this",
    updated: "updated this",
  };
  return (
    <View className="flex-row items-center gap-2 px-1">
      <SymbolView name="circle" size={8} tintColorClassName="accent-icon-muted" />
      <Pressable
        accessibilityRole={event.url || event.reference ? "link" : undefined}
        onPress={() => {
          const url = event.url ?? event.reference?.url;
          if (url) void tryOpenExternalUrl(url, "markdown-link");
        }}
        className="min-w-0 flex-1"
      >
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          <Text className="font-t3-medium text-foreground">{event.actor?.login ?? "Someone"}</Text>{" "}
          {verb[event.kind]}
          {(event.reference?.identifier ?? event.reference?.title ?? event.detail)
            ? ` ${event.reference?.identifier ?? event.reference?.title ?? event.detail}`
            : ""}
        </Text>
      </Pressable>
      <Text className="text-2xs text-foreground-tertiary">{relativeTime(event.createdAt)}</Text>
    </View>
  );
}

function IssueCommentCard(props: {
  readonly comment: IssueComment;
  readonly busy: boolean;
  readonly reactionContents: ReadonlyArray<IssueReactionContent> | undefined;
  readonly onReact: ((content: IssueReactionContent, reacted: boolean) => void) | undefined;
}) {
  const { comment } = props;
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={comment.author} size={22} />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium" numberOfLines={1}>
          {comment.author?.login ?? "Unknown author"}
        </Text>
        <Text className="text-2xs text-foreground-tertiary">{relativeTime(comment.createdAt)}</Text>
      </View>
      <View className="gap-2 rounded-2xl bg-grouped-card p-3">
        {comment.body.trim() ? <PullRequestMarkdown markdown={comment.body} /> : null}
        <IssueReactions
          reactions={comment.reactions}
          contents={props.reactionContents}
          busy={props.busy}
          onToggle={props.onReact}
        />
      </View>
    </View>
  );
}

type IssueActivityControls = { readonly refresh: () => void; readonly loadMore: () => void };

function IssueBody(props: {
  readonly params: IssueParams;
  readonly issue: IssueDetail;
  readonly registerActivity: (controls: IssueActivityControls | null) => void;
  readonly chosenOrder: IssueListOrder;
  readonly setOrder: (order: IssueListOrder) => void;
}) {
  const { issue, params } = props;
  const navigation = useNavigation();
  const registry = use(RegistryContext);
  const target = issueTarget(params);
  const access = useIssueAccess(params, issue);
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: false });
  const react = useAtomCommand(issueEnvironment.react, { reportFailure: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const commentOrders = issue.capabilities.commentOrders ?? ["desc", "asc"];
  const historyOrders = issue.capabilities.historyOrders ?? ["desc", "asc"];
  const commonOrders = commentOrders.filter((order) => historyOrders.includes(order));
  const availableOrders = commonOrders.length ? commonOrders : commentOrders;
  const { chosenOrder, setOrder } = props;
  const order = availableOrders.includes(chosenOrder)
    ? chosenOrder
    : (availableOrders[0] ?? "desc");
  const seeded = order === (commentOrders.includes("desc") ? "desc" : "asc");
  const commentPages = useIssueComments(
    target.environmentId,
    !seeded || issue.commentsCursor !== null
      ? {
          ...target.input,
          order,
          ...(seeded && issue.commentsCursor !== null ? { cursor: issue.commentsCursor } : {}),
          ...(issue.viewer === null ? {} : { viewer: issue.viewer }),
        }
      : null,
  );
  const comments = seeded
    ? mergeIssueComments(
        issue.comments,
        issue.viewer === null && commentPages.isPending ? [] : commentPages.items,
      )
    : commentPages.items;
  const history = useIssueHistory(
    target.environmentId,
    issue.capabilities.events
      ? {
          ...target.input,
          ...(historyOrders.length
            ? { order: historyOrders.includes(order) ? order : historyOrders[0] }
            : {}),
        }
      : null,
  );
  const linked = useIssueLinkedPullRequests(
    target.environmentId,
    issue.capabilities.linkedPullRequests ? target.input : null,
  );
  const [expandedLinks, setExpandedLinks] = useState(false);
  const links = [
    ...new Map(
      [...issue.linkedPullRequests, ...linked.items].map((link) => [link.url, link]),
    ).values(),
  ];
  const {
    hasMore: hasMoreLinks,
    isPending: linksPending,
    error: linksError,
    loadMore: loadMoreLinks,
  } = linked;
  useEffect(() => {
    if (hasMoreLinks && !linksPending && linksError === null) loadMoreLinks();
  }, [hasMoreLinks, linksPending, linksError, loadMoreLinks]);
  useLayoutEffect(() => {
    props.registerActivity({
      refresh: () => {
        commentPages.refresh();
        history.refresh();
        linked.refresh();
      },
      loadMore: () => {
        if (commentPages.hasMore && !commentPages.isPending && commentPages.error === null)
          commentPages.loadMore();
        if (history.hasMore && !history.isPending && history.error === null) history.loadMore();
      },
    });
    return () => {
      props.registerActivity(null);
    };
  });
  const [confirmed, setConfirmed] = useState<IssueConfirmedReactions | null>(null);
  const reactionView = issueReactionsView(target.environmentId, issue, comments, confirmed);
  if (confirmed !== reactionView.held) setConfirmed(reactionView.held);
  const reactionTarget = useRef({ issue, access, comments });
  useLayoutEffect(() => {
    reactionTarget.current = { issue, access, comments };
  });
  const run = async (work: () => Promise<void>, failure: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const result = await settlePromise(work);
    pending.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      Alert.alert(failure, cause instanceof Error ? cause.message : "Try again.");
    }
  };
  const changeState = (state: IssueState, closeReason?: string) => {
    if (state.fields?.some((field) => field.required)) {
      Alert.alert(
        "Complete this transition on the tracker",
        "This transition needs native fields.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open tracker", onPress: () => void Linking.openURL(issue.url) },
        ],
      );
      return;
    }
    return run(async () => {
      const response = await setState({
        ...target,
        input: {
          ...target.input,
          state: state.id ?? state.name,
          ...(state.transitionId === undefined ? {} : { transitionId: state.transitionId }),
          ...(closeReason ? { closeReason } : {}),
        },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      markIssueTargetWritten(registry, params);
    }, "Couldn't change this issue's state");
  };
  const toggleReaction =
    (subjectId?: string) => (content: IssueReactionContent, reacted: boolean) => {
      const current = reactionTarget.current;
      if (
        !issueReactionAllowed(current.issue, current.access, content, subjectId, current.comments)
      )
        return;
      return run(async () => {
        const response = await react({
          ...target,
          input: { ...target.input, ...(subjectId ? { subjectId } : {}), content, reacted },
        });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        setConfirmed((current) =>
          confirmIssueReaction(
            target.environmentId,
            issue,
            comments,
            current,
            content,
            reacted,
            subjectId,
          ),
        );
      }, "Couldn't update this reaction");
    };
  const status = issueStatus(issue.state);
  const stateActions = access.states.map((state, index) => ({
    id: JSON.stringify([index, ""]),
    title: state.name,
    ...(state.category === "closed" && access.closeReasons.length
      ? {
          subactions: access.closeReasons.map((reason) => ({
            id: JSON.stringify([index, reason]),
            title: reason,
          })),
        }
      : {}),
  }));
  const trigger = (
    <Pressable
      accessibilityRole={stateActions.length ? "button" : undefined}
      accessibilityLabel={`Issue state, ${status.label}`}
      disabled={!stateActions.length || busy}
      className="min-h-8 flex-row items-center gap-1.5 active:opacity-70"
    >
      <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
      <Text className={`text-xs font-t3-medium ${status.text}`}>{status.label}</Text>
      {issue.state.closeReason ? (
        <Text className="text-2xs text-foreground-muted">· {issue.state.closeReason}</Text>
      ) : null}
      {stateActions.length ? (
        <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-muted" />
      ) : null}
    </Pressable>
  );
  const events = [
    ...new Map([...issue.events, ...history.items].map((event) => [event.id, event])).values(),
  ];
  const separateHistory = commonOrders.length === 0 && historyOrders.length > 0;
  const timeline = issueTimeline(reactionView.comments, separateHistory ? [] : events, order);
  return (
    <View className="gap-5">
      <View className="gap-3">
        <View className="flex-row flex-wrap items-center gap-2">
          {stateActions.length ? (
            <Menu
              title="Issue state"
              actions={stateActions}
              onPressAction={({ nativeEvent }) => {
                let selection: unknown;
                try {
                  selection = JSON.parse(nativeEvent.event);
                } catch {
                  return;
                }
                if (!Array.isArray(selection) || typeof selection[0] !== "number") return;
                const state = access.states[selection[0]];
                const reason = selection[1];
                if (
                  !state ||
                  (reason && (typeof reason !== "string" || !access.closeReasons.includes(reason)))
                )
                  return;
                void changeState(state, reason || undefined);
              }}
            >
              {trigger}
            </Menu>
          ) : (
            trigger
          )}
          {busy ? <ActivityIndicator size="small" /> : null}
          {!issue.writable ? (
            <Text className="text-2xs text-foreground-muted">Read-only here</Text>
          ) : null}
        </View>
        <Text selectable className="text-xl font-t3-bold leading-7">
          {issue.title}
        </Text>
        <View className="flex-row items-center gap-2">
          <PullRequestAvatar actor={issue.author} size={20} />
          <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
            {issue.author?.login ?? "Unknown author"}
          </Text>
          <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
            Updated {relativeTime(issue.updatedAt)} ago
          </Text>
        </View>
      </View>
      <PullRequestCardGroup>
        <PullRequestCardRow
          title="Assignees"
          icon="person.2"
          compact
          value={issue.assignees.map((actor) => actor.name ?? actor.login).join(", ") || "No one"}
          onPress={
            access.assignees
              ? () => navigation.navigate("IssueCandidates", { ...params, kind: "assignees" })
              : undefined
          }
        />
        <PullRequestCardRow
          title="Labels"
          icon="ticket"
          compact
          last={!links.length}
          value={
            issue.labels.length
              ? `${issue.labels.map((label) => label.name).join(", ")}${issue.labelsTruncated ? "…" : ""}`
              : "None"
          }
          onPress={
            access.labels
              ? () => navigation.navigate("IssueCandidates", { ...params, kind: "labels" })
              : undefined
          }
        />
        {(expandedLinks ? links : links.slice(0, 3)).map((link, index, shown) => (
          <LinkedPullRequestRow
            key={link.url}
            link={link}
            environmentId={params.environmentId}
            last={index === shown.length - 1}
          />
        ))}
        {links.length > 3 &&
        !linked.hasMore &&
        !linked.isPending &&
        linked.error === null &&
        !linked.truncated ? (
          <Button
            label={expandedLinks ? "Show less" : `Show ${links.length - 3} more`}
            tone="text"
            onPress={() => setExpandedLinks(!expandedLinks)}
          />
        ) : null}
        {links.length > 3 && (linked.truncated || linked.error !== null) ? (
          <Button
            label={expandedLinks ? "Show less" : "Show known pull requests"}
            tone="text"
            onPress={() => setExpandedLinks(!expandedLinks)}
          />
        ) : null}
        {linked.truncated ? (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(issue.url)}>
            <Text className="text-2xs text-foreground-muted">
              More linked pull requests may be on the tracker.
            </Text>
          </Pressable>
        ) : null}
        {linked.isPending ? <ActivityIndicator /> : null}
        {linked.error ? (
          <Button
            label="Retry linked pull requests"
            onPress={linked.hasMore ? linked.loadMore : linked.refresh}
          />
        ) : null}
      </PullRequestCardGroup>
      {issue.body.trim() ? (
        <PullRequestMarkdown markdown={issue.body} />
      ) : (
        <Text className="text-sm text-foreground-muted">No description.</Text>
      )}
      <IssueReactions
        reactions={reactionView.reactions}
        contents={issue.capabilities.reactionContents}
        busy={busy}
        onToggle={access.react ? toggleReaction() : undefined}
      />
      <View className="gap-4">
        <Menu
          title="Activity order"
          actions={availableOrders.map((value) => ({
            id: value,
            title: value === "desc" ? "Newest first" : "Oldest first",
            state: value === order ? ("on" as const) : ("off" as const),
          }))}
          onPressAction={({ nativeEvent }) => {
            if (availableOrders.includes(nativeEvent.event as IssueListOrder))
              setOrder(nativeEvent.event as IssueListOrder);
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Activity order">
            <Text className="text-xs text-foreground-muted">
              {order === "desc" ? "Newest first" : "Oldest first"}
            </Text>
          </Pressable>
        </Menu>
        {issue.historyTruncated || history.truncated || historyOrders.length === 0 ? (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(issue.url)}>
            <Text className="text-2xs text-foreground-muted">
              {historyOrders.length === 0
                ? "Activity history is incomplete. Its global order is unavailable."
                : "More history is on the tracker."}
            </Text>
          </Pressable>
        ) : null}
        {commonOrders.length === 0 && historyOrders.length > 0 ? (
          <Text className="text-2xs text-foreground-muted">
            Comments and history use different native orders.
          </Text>
        ) : null}
        {commentOrders.length === 1 ? (
          <Text className="text-2xs text-foreground-muted">
            The tracker supports {order === "asc" ? "oldest" : "newest"}-first comments only.
          </Text>
        ) : null}
        {commentPages.error ? (
          <Button
            label="Retry comments"
            onPress={commentPages.hasMore ? commentPages.loadMore : commentPages.refresh}
          />
        ) : null}
        {history.error ? (
          <Button
            label="Retry history"
            onPress={history.hasMore ? history.loadMore : history.refresh}
          />
        ) : null}
        {commentPages.isPending || history.isPending ? <ActivityIndicator /> : null}
        {timeline.map((item) =>
          item.kind === "comment" ? (
            <IssueCommentCard
              key={`comment:${item.comment.id}`}
              comment={item.comment}
              busy={busy}
              reactionContents={issue.capabilities.reactionContents}
              onReact={
                access.commentReact && item.comment.reactions !== undefined
                  ? toggleReaction(item.comment.id)
                  : undefined
              }
            />
          ) : (
            <IssueEventRow key={`event:${item.event.id}`} event={item.event} />
          ),
        )}
        {separateHistory ? (
          <View className="gap-4">
            <Text className="text-xs text-foreground-muted">
              History · {historyOrders[0] === "asc" ? "Oldest first" : "Newest first"}
            </Text>
            {issueTimeline([], events, historyOrders[0]).map((item) =>
              item.kind === "event" ? (
                <IssueEventRow key={item.event.id} event={item.event} />
              ) : null,
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function IssueRouteScreen({ route }: StaticScreenProps<IssueParams>) {
  const returnToList = useAndroidWorkspaceBack("issues");
  try {
    issueParamsKey(route.params);
  } catch {
    return (
      <EmptyState
        title="Couldn't open this issue"
        detail="This link is incomplete or invalid."
        variant="plain"
        actionLabel="Back to issues"
        onAction={returnToList}
      />
    );
  }
  return <IssueRouteContent params={route.params} returnToList={returnToList} />;
}

function IssueRouteContent({
  params,
  returnToList,
}: {
  readonly params: IssueParams;
  readonly returnToList: () => void;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = issueTarget(params);
  const detailAtom = issueEnvironment.detail(target);
  const detailResult = useAtomValue(detailAtom);
  const result = useEnvironmentQuery(detailAtom);
  const pullRefresh = usePullToRefresh(detailAtom);
  const { refresh } = result;
  const issue = result.data;
  const [chosenOrder, setOrder] = useState<IssueListOrder>("desc");
  const [viewportHeight, setViewportHeight] = useState(0);
  const activity = useRef<IssueActivityControls | null>(null);
  const registerActivity = useCallback((controls: IssueActivityControls | null) => {
    activity.current = controls;
  }, []);
  const targetKey = JSON.stringify(target);
  const completedRead =
    detailResult._tag === "Success" && !detailResult.waiting ? detailResult : null;
  const lastRead = useRef({ targetKey, result: completedRead });
  useLayoutEffect(() => {
    const previous = lastRead.current;
    if (completedRead !== null) {
      if (
        previous.targetKey === targetKey &&
        previous.result !== null &&
        previous.result !== completedRead
      )
        activity.current?.refresh();
      lastRead.current = { targetKey, result: completedRead };
    } else if (previous.targetKey !== targetKey) lastRead.current = { targetKey, result: null };
  }, [completedRead, targetKey]);
  useFocusEffect(useCallback(() => refresh(), [refresh]));
  const [unknownSeed, setUnknownSeed] = useState({ comments: issue?.comments, version: 0 });
  if (issue?.viewer === null && unknownSeed.comments !== issue.comments) {
    setUnknownSeed({ comments: issue.comments, version: unknownSeed.version + 1 });
  }
  const access = useIssueAccess(params, issue);
  const cwd = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  })?.workspaceRoot;
  const media = useMemo(
    () => (cwd ? { environmentId: target.environmentId, cwd } : null),
    [target.environmentId, cwd],
  );
  const title = issue?.displayKey ?? params.displayKey ?? params.key;
  const subtitle = access.connected ? params.scope : `${params.scope} · Offline`;
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <NativeStackScreenOptions
        options={{ title, headerTitle: title, unstable_headerSubtitle: subtitle }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          subtitle={subtitle}
          onBack={layout.usesSplitView ? undefined : returnToList}
          leading={layout.usesSplitView ? <AndroidWorkspaceSidebarButton /> : undefined}
          actions={[
            ...(access.comment
              ? [
                  {
                    accessibilityLabel: "Add comment",
                    icon: "plus.bubble" as const,
                    onPress: () =>
                      navigation.navigate("IssueCompose", { ...params, mode: "comment" }),
                  },
                ]
              : []),
            ...(access.edit
              ? [
                  {
                    accessibilityLabel: "Edit issue",
                    icon: "pencil" as const,
                    onPress: () => navigation.navigate("IssueCompose", { ...params, mode: "edit" }),
                  },
                ]
              : []),
            ...(issue
              ? [
                  {
                    accessibilityLabel: "Open in browser",
                    icon: "arrow.up.right" as const,
                    onPress: () => void Linking.openURL(issue.url),
                  },
                ]
              : []),
          ]}
        />
      ) : null}
      <Toolbar placement="right">
        <Toolbar.Menu title="Issue" accessibilityLabel="Issue actions" icon="ellipsis">
          {access.comment ? (
            <Toolbar.MenuAction
              icon="plus.bubble"
              onPress={() => navigation.navigate("IssueCompose", { ...params, mode: "comment" })}
            >
              <Toolbar.Label>Add comment</Toolbar.Label>
            </Toolbar.MenuAction>
          ) : null}
          {access.edit ? (
            <Toolbar.MenuAction
              icon="pencil"
              onPress={() => navigation.navigate("IssueCompose", { ...params, mode: "edit" })}
            >
              <Toolbar.Label>Edit issue</Toolbar.Label>
            </Toolbar.MenuAction>
          ) : null}
          {issue ? (
            <Toolbar.MenuAction
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(issue.url)}
            >
              <Toolbar.Label>Open in browser</Toolbar.Label>
            </Toolbar.MenuAction>
          ) : null}
        </Toolbar.Menu>
      </Toolbar>
      <ScrollView
        onLayout={({ nativeEvent }) => setViewportHeight(nativeEvent.layout.height)}
        onContentSizeChange={(_width, height) => {
          if (viewportHeight > 0 && height <= viewportHeight + 240) activity.current?.loadMore();
        }}
        scrollEventThrottle={100}
        onScroll={({ nativeEvent }) => {
          if (
            nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >=
            nativeEvent.contentSize.height - 240
          )
            activity.current?.loadMore();
        }}
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-sheet-solid"
            : "flex-1"
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        refreshControl={
          <RefreshControl refreshing={pullRefresh.refreshing} onRefresh={pullRefresh.onRefresh} />
        }
      >
        {issue && result.error ? (
          <View className="mb-4 gap-2">
            <Text selectable className="text-sm text-danger-foreground">
              Couldn't refresh this issue: {result.error}
            </Text>
            <Button label="Retry" loading={result.isPending} onPress={refresh} />
          </View>
        ) : null}
        {issue ? (
          <PullRequestMediaContext value={media}>
            <IssueBody
              key={JSON.stringify([
                target,
                issue.viewer,
                issue.commentsCursor,
                issue.comments.map((comment) => comment.id),
                unknownSeed.version,
              ])}
              params={params}
              issue={issue}
              registerActivity={registerActivity}
              chosenOrder={chosenOrder}
              setOrder={setOrder}
            />
          </PullRequestMediaContext>
        ) : result.isPending ? (
          <ActivityIndicator className="my-12" />
        ) : (
          <EmptyState
            title="Couldn't load this issue"
            detail={result.error ?? "Try again."}
            variant="plain"
            actionLabel="Retry"
            onAction={refresh}
            action={
              params.originalURL && /^https?:\/\//i.test(params.originalURL) ? (
                <View className="items-center gap-2">
                  <Button label="Retry" tone="primary" onPress={refresh} />
                  <Button
                    label="Open in browser"
                    tone="text"
                    onPress={() => void tryOpenExternalUrl(params.originalURL!, "markdown-link")}
                  />
                </View>
              ) : undefined
            }
          />
        )}
      </ScrollView>
    </View>
  );
}
