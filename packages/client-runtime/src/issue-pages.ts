import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import type * as Cause from "effect/Cause";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

type EnvironmentQueryTarget<Input> = {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
};

type IssuePageOptions<Input> = {
  readonly useRegistry: () => AtomRegistry.AtomRegistry;
  readonly formatError: (cause: Cause.Cause<unknown>) => string;
  readonly useRefresh?: (
    refresh: () => void,
    targets: ReadonlyArray<EnvironmentQueryTarget<Input>>,
    key: string,
  ) => void;
};

interface IssueQueryAnswer<A> {
  readonly value: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

const EMPTY_ANSWERS = Atom.make<ReadonlyArray<IssueQueryAnswer<never>>>([]).pipe(
  Atom.withLabel("web-issues:answers:empty"),
);

function createIssueQueries<Input, A>(
  label: string,
  options: IssuePageOptions<Input>,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get) =>
      (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>).map(
        (target): IssueQueryAnswer<A> => {
          const result = get(atomFor(target));
          return {
            value: Option.getOrNull(AsyncResult.value(result)),
            error: result._tag === "Failure" ? options.formatError(result.cause) : null,
            isPending: result.waiting || result._tag === "Initial",
          };
        },
      ),
    ).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  return function useIssueQueries(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const registry = options.useRegistry();
    const key = JSON.stringify(targets);
    const answers = useAtomValue(
      targets.length === 0
        ? (EMPTY_ANSWERS as unknown as Atom.Atom<ReadonlyArray<IssueQueryAnswer<A>>>)
        : family(key),
    );
    const refresh = () => {
      const target = (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>)[0];
      if (target !== undefined) registry.refresh(atomFor(target));
    };
    return { answers, refresh };
  };
}

export interface IssuePagedView<T> {
  readonly items: ReadonlyArray<T>;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly loadMore: () => void;
  readonly refresh: () => void;
}

export function createIssuePagedQuery<
  Input extends {
    readonly cursor?: string | undefined;
    readonly projectId?: ProjectId | undefined;
  },
  A,
  T,
  Extra = undefined,
>(
  options: IssuePageOptions<Input>,
  label: string,
  family: (target: EnvironmentQueryTarget<Input>) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  page: (value: A) => {
    readonly items: ReadonlyArray<T>;
    readonly nextCursor: string | null;
    readonly truncated?: boolean | undefined;
  },
  extra: (first: A | null) => Extra = () => undefined as Extra,
) {
  const useQueries = createIssueQueries(label, options, family);
  return function useIssuePages(
    environmentId: EnvironmentId | null,
    input: Input | null,
  ): IssuePagedView<T> & { readonly extra: Extra } {
    const registry = options.useRegistry();
    const key =
      environmentId === null || input === null ? "" : JSON.stringify([environmentId, input]);
    const [cursors, setCursors] = useState<{
      key: string;
      seed: A | null;
      values: ReadonlyArray<string>;
    }>({
      key,
      seed: null,
      values: [],
    });
    const values = cursors.key === key ? cursors.values : [];
    const { answers, refresh } = useQueries(
      environmentId === null || input === null
        ? []
        : [undefined, ...values].map((cursor) => ({
            environmentId,
            input: cursor === undefined ? input : { ...input, cursor },
          })),
    );
    const first = answers[0]?.value ?? null;
    const refreshPages = () => {
      setCursors({ key, seed: first, values: [] });
      refresh();
    };
    options.useRefresh?.(
      refreshPages,
      environmentId === null || input === null ? [] : [{ environmentId, input }],
      key,
    );
    const retained = cursors.seed === first;
    if (values.length > 0 && !retained) setCursors({ key, seed: first, values: [] });
    const activeAnswers = retained ? answers : answers.slice(0, 1);
    const pages = activeAnswers.map((answer) =>
      answer.value === null ? null : page(answer.value),
    );
    const last = activeAnswers.at(-1);
    const nextCursor = last?.error == null ? (pages.at(-1)?.nextCursor ?? null) : null;
    const failedCursor =
      last?.error !== null && last?.error !== undefined ? values.at(-1) : undefined;
    return {
      items: pages.flatMap((entry) => entry?.items ?? []),
      truncated:
        pages.some((entry) => entry?.truncated === true) ||
        (nextCursor !== null && values.includes(nextCursor)),
      hasMore: failedCursor !== undefined || (nextCursor !== null && !values.includes(nextCursor)),
      isPending: activeAnswers.some((answer) => answer.isPending),
      error: activeAnswers.find((answer) => answer.error !== null)?.error ?? null,
      extra: extra(answers[0]?.value ?? null),
      loadMore: () => {
        if (last?.isPending) return;
        if (failedCursor !== undefined && environmentId !== null && input !== null) {
          registry.refresh(family({ environmentId, input: { ...input, cursor: failedCursor } }));
          return;
        }
        if (nextCursor === null || values.includes(nextCursor) || last?.isPending) return;
        if (environmentId !== null && input !== null)
          registry.refresh(family({ environmentId, input: { ...input, cursor: nextCursor } }));
        setCursors({ key, seed: first, values: [...values, nextCursor] });
      },
      refresh: refreshPages,
    };
  };
}
