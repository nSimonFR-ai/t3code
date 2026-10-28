import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard, Platform } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import type { IssueParams } from "./issueSelection";

/** Android shows one page at a time; iOS pushes, or replaces a presenting sheet. */
export function useOpenIssue(options?: { readonly replace?: boolean }) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const replace = options?.replace;
  return useCallback(
    (params: IssueParams) => {
      Keyboard.dismiss();
      if (Platform.OS === "android") selectDetail({ name: "Issue", params });
      else if (replace) navigation.dispatch(StackActions.replace("Issue", params));
      else navigation.navigate("Issue", params);
    },
    [navigation, selectDetail, replace],
  );
}
