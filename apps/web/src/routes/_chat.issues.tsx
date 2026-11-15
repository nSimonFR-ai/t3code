import { createFileRoute } from "@tanstack/react-router";

import { validateIssuesSearch } from "../components/issue/issuesSearch";

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: validateIssuesSearch,
});
