import { Children, isValidElement, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

export function PullRequestRefreshControl({
  compact = false,
  refreshing,
  onRefresh,
  "aria-label": ariaLabel = "Refresh pull requests",
}: {
  compact?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  "aria-label"?: string;
}) {
  return (
    <Button
      size={compact ? "icon-sm" : "icon"}
      variant={compact ? "ghost" : "secondary"}
      aria-label={ariaLabel}
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshIcon size="md" refreshing={refreshing} />
    </Button>
  );
}

export function PullRequestDetailTabBar<Tab extends string>({
  tabs,
  value,
  onValueChange,
  onTabIntent,
  inert,
  children,
  "aria-label": ariaLabel = "Pull request tabs",
}: {
  tabs: ReadonlyArray<{ readonly value: Tab; readonly label: string }>;
  value: Tab;
  onValueChange?: (tab: Tab) => void;
  onTabIntent?: (tab: Tab) => void;
  inert?: boolean;
  children?: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <nav
      className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 px-4 py-2"
      aria-label={ariaLabel}
      inert={inert}
    >
      <ToggleGroup
        className="shrink-0"
        size="segmented"
        variant="segmented"
        value={[value]}
        onValueChange={(next) => {
          const nextTab = tabs.find((item) => item.value === next[0])?.value;
          if (nextTab) onValueChange?.(nextTab);
        }}
      >
        {tabs.map((tab) => (
          <Toggle
            key={tab.value}
            value={tab.value}
            onPointerEnter={onTabIntent ? () => onTabIntent(tab.value) : undefined}
            onFocus={onTabIntent ? () => onTabIntent(tab.value) : undefined}
          >
            {tab.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {children}
    </nav>
  );
}

function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`;
}

/** Inline facts joined by middle dots. */
export function PullRequestMetaLine({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const segments = Children.toArray(children);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span
                aria-hidden
                className="shrink-0 text-muted-foreground/50"
                key={separatorKey(segment)}
              >
                ·
              </span>,
              segment,
            ],
      )}
    </span>
  );
}
