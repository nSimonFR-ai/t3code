import { useNavigation } from "@react-navigation/native";
import { useEffect, useRef } from "react";
import { BackHandler, Keyboard, View, type TextInputInstance } from "react-native";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { SearchField } from "../../components/ui/SearchField";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceListToolbarRow } from "../workspace/WorkspaceListToolbarRow";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WORKSPACE_SEARCH_LABELS } from "../workspace/workspace-tabs-state";
import type { PullRequestFilterMenu } from "./PullRequestListFilters";
import { openSettings } from "../settings/settings-navigation";

/** PR and issue search share the thread list's Android header row. */
export function PullRequestToolbar(props: {
  readonly filters: PullRequestFilterMenu | null;
  /** The list this row searches; defaults to pull requests. */
  readonly tab?: "pullRequests" | "issues";
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const { filters } = props;
  const workspace = useWorkspaceTabs()!;
  const { dispatch, getScrollOffset, recordScrollOffset, isTabActive } = workspace;
  const { onRequestVisibility } = props;
  const tabId = props.tab ?? "pullRequests";
  const searchLabel = WORKSPACE_SEARCH_LABELS[tabId];
  const tab = workspace.state.tabs[tabId];
  const input = useRef<TextInputInstance>(null);
  const searching = tab.searchMode !== "resting";
  const openSearch = () => {
    onRequestVisibility?.();
    dispatch({ type: "scroll", tab: tabId, offset: getScrollOffset(tabId) });
    dispatch({ type: "search", tab: tabId });
    input.current?.focus();
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = () => {
    Keyboard.dismiss();
    recordScrollOffset(tabId, tab.searchEntryOffset);
    dispatch({ type: "cancel", tab: tabId });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close the list search on Android back
  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens stay mounted under a detail route or another tab,
      // so back only applies while this list is in front.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "Home" || !isTabActive(tabId)) return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, navigation, isTabActive, tabId]);
  const { paddingTop, paddingBottom } = useToolbarLayout();
  return (
    <View className="bg-header px-2" style={{ paddingTop, paddingBottom }}>
      <WorkspaceListToolbarRow
        searching={searching}
        searchField={
          <SearchField
            inputRef={input}
            accessibilityLabel={searchLabel}
            clearAccessibilityLabel="Clear search"
            placeholder={searchLabel}
            value={tab.query}
            onChangeText={(query) => dispatch({ type: "query", tab: tabId, query })}
          />
        }
        onCloseSearch={closeSearch}
        onOpenSearch={openSearch}
        searchAccessibilityLabel={searchLabel}
        titleAccessibilityLabel={`T3 Code, ${tabId === "issues" ? "Issues" : "Pull requests"}`}
        onOpenEnvironments={() => openSettings(navigation, "SettingsEnvironments")}
        filter={
          filters ? (
            <AndroidAnchoredMenu
              actions={filters.actions}
              onPressAction={({ nativeEvent }) => filters.onSelect(nativeEvent.event)}
            >
              {(open) => (
                <AndroidHeaderIconButton
                  accessibilityLabel="Filter pull requests"
                  icon={
                    filters.customized
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  onPress={open}
                />
              )}
            </AndroidAnchoredMenu>
          ) : null
        }
      />
    </View>
  );
}
