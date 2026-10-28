import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { IssueFieldValues } from "@t3tools/contracts";
import {
  composeTemplateBody,
  initialTemplateValues,
  missingRequiredTemplateFields,
  type IssueTemplateValues,
} from "@t3tools/client-runtime/issue-form";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { use, useRef, useState } from "react";
import { Alert, Linking, Platform, Pressable, View } from "react-native";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import { PullRequestSheetContent as SheetContent } from "../pull-requests/PullRequestSheetContent";
import { issueCreateBlocked, resolveIssueType } from "./issueDetail";
import {
  fillIssueTemplate,
  mobileNativeFieldError,
  mobileNativeFieldValues,
  issueTemplateBodyRead,
  issueTemplateCatalogRead,
  selectedIssueTemplate,
} from "./issueTemplate";
import type { IssueCreateScope } from "./issueList";
import { useOpenIssue } from "./useOpenIssue";
import { markIssueWritten } from "./issueList";

const BLANK = "";

export function IssueCreateSheet({
  route,
}: StaticScreenProps<{ readonly scopes: ReadonlyArray<IssueCreateScope> }>) {
  const { scopes } = route.params;
  const registry = use(RegistryContext);
  const openIssue = useOpenIssue({ replace: true });
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)] ?? null;
  const scopeKey = JSON.stringify([scope?.environmentId, scope?.scope]);
  const [heldScopeKey, setHeldScopeKey] = useState(scopeKey);
  const [templateKey, setTemplateKey] = useState(BLANK);
  const [templateChosen, setTemplateChosen] = useState(false);
  const [values, setValues] = useState<IssueTemplateValues>({});
  const [nativeValues, setNativeValues] = useState<IssueFieldValues>({});
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [bodyEdited, setBodyEdited] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<{
    scopeKey: string;
    key: string;
    title: boolean;
    body: boolean;
  } | null>(null);
  const [extras, setExtras] = useState<{
    labels: ReadonlyArray<string>;
    assignees: ReadonlyArray<string>;
  }>({ labels: [], assignees: [] });
  const [issueType, setIssueType] = useState<string | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (heldScopeKey !== scopeKey) {
    setHeldScopeKey(scopeKey);
    setTemplateKey(BLANK);
    setTemplateChosen(false);
    setTemplateDraft(null);
    setValues({});
    setNativeValues({});
    setExtras({ labels: [], assignees: [] });
    setIssueType(null);
  }
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: false });
  const canWrite = useAtomValue(
    issueEnvironment.create.permissionAtom(scope?.environmentId ?? null),
  );
  const requestedIssueType = heldScopeKey === scopeKey ? issueType : null;
  const catalogRead = issueTemplateCatalogRead(scope);
  const templatesQuery = useEnvironmentQuery(
    catalogRead ? issueEnvironment.templates(catalogRead) : null,
  );
  const bodyRead = issueTemplateBodyRead(scope, templatesQuery.data, templateKey);
  const selectedQuery = useEnvironmentQuery(bodyRead ? issueEnvironment.templates(bodyRead) : null);
  const chosenTemplate = selectedIssueTemplate(templateKey, templatesQuery, selectedQuery);
  if (
    templateDraft &&
    templateDraft.scopeKey === scopeKey &&
    templateDraft.key === templateKey &&
    chosenTemplate.template
  ) {
    const filled = fillIssueTemplate(templateDraft, chosenTemplate.template, { title, body });
    setTitle(filled.title);
    setBody(filled.body);
    setExtras({ labels: filled.labels, assignees: filled.assignees });
    setValues(initialTemplateValues(chosenTemplate.template.fields ?? []));
    setTemplateDraft(null);
  }
  const templateRead = templatesQuery.error ? templatesQuery : selectedQuery;
  const templates = templatesQuery.data?.templates ?? [];
  const externalTemplates = templatesQuery.data?.externalTemplates ?? [];
  const blankAllowed = templatesQuery.data?.blankIssuesEnabled ?? true;
  const candidatesQuery = useEnvironmentQuery(
    scope && (scope.createIssueTypes === true || scope.createFields === true)
      ? issueEnvironment.candidates({
          environmentId: scope.environmentId,
          input: {
            ...scope.scope,
            ...(requestedIssueType === null ? {} : { issueType: requestedIssueType }),
          },
        })
      : null,
  );
  const issueTypes = candidatesQuery.data?.issueTypes ?? [];
  const chosenIssueType = resolveIssueType(issueTypes, requestedIssueType);
  const nativeFields = candidatesQuery.data?.fields ?? [];
  const nativeForm = scope?.createFields === true || nativeFields.length > 0;
  if (nativeForm && issueType === null && chosenIssueType !== null) setIssueType(chosenIssueType);
  const templateFields = chosenTemplate.template?.fields ?? [];
  const missing = missingRequiredTemplateFields(templateFields, values);
  const nativeError = nativeForm
    ? (candidatesQuery.error ??
      (candidatesQuery.isPending || candidatesQuery.data === null
        ? "Loading fields…"
        : mobileNativeFieldError(nativeFields, nativeValues)))
    : null;
  const blocked =
    (scope?.templates ? templatesQuery.error : null) ??
    issueCreateBlocked({
      hasScope: scope !== null,
      canWrite,
      templates: scope?.templates
        ? { pending: templatesQuery.isPending, list: templatesQuery.data }
        : null,
      blankChosen: templateKey === BLANK,
      issueTypes:
        scope?.createIssueTypes === true
          ? {
              pending: candidatesQuery.isPending,
              error: candidatesQuery.error,
              count: issueTypes.length,
              chosen: chosenIssueType,
            }
          : null,
    }) ??
    chosenTemplate.blocked ??
    nativeError ??
    (missing.length ? `Fill in ${missing.join(", ")}.` : null);
  const select = (event: string) => {
    let selection: unknown;
    try {
      selection = JSON.parse(event);
    } catch {
      return;
    }
    if (!Array.isArray(selection) || typeof selection[0] !== "string") return;
    const [field, value] = selection as [string, string];
    if (field === "scope") {
      const index = Number(value);
      if (!Number.isInteger(index) || !scopes[index]) return;
      setScopeIndex(index);
      setTemplateKey(BLANK);
      setTemplateChosen(false);
      setValues({});
      setNativeValues({});
      setTemplateDraft(null);
      setExtras({ labels: [], assignees: [] });
      setIssueType(null);
    } else if (field === "template") {
      const template = templates.find((entry) => entry.key === value);
      setTemplateKey(template ? template.key : BLANK);
      setTemplateChosen(true);
      setValues({});
      setExtras({ labels: [], assignees: [] });
      setTemplateDraft(
        template
          ? {
              scopeKey,
              key: template.key,
              title: !titleEdited,
              body: !bodyEdited,
            }
          : null,
      );
    } else if (field === "type" && issueTypes.some((type) => type.id === value)) {
      setIssueType(value);
      setNativeValues({});
    }
  };
  if (
    scope?.templates &&
    !templateChosen &&
    !templatesQuery.isPending &&
    templatesQuery.error === null &&
    templates[0]
  ) {
    const first = templates[0];
    setTemplateKey(first.key);
    setTemplateChosen(true);
    setTemplateDraft({ scopeKey, key: first.key, title: !titleEdited, body: !bodyEdited });
  }
  const submit = async () => {
    if (pending.current || scope === null || blocked !== null || !title.trim()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const result = await settlePromise(async () => {
      const response = await create({
        environmentId: scope.environmentId,
        input: {
          ...scope.scope,
          title: title.trim(),
          body: templateFields.length ? composeTemplateBody(templateFields, values) : body,
          ...(templateKey ? { templateKey } : {}),
          ...(nativeForm
            ? { fieldValues: mobileNativeFieldValues(nativeFields, nativeValues) }
            : {}),
          labels: extras.labels,
          assignees: extras.assignees,
          ...(chosenIssueType === null ? {} : { issueType: chosenIssueType }),
        },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      markIssueWritten(registry, scope.environmentId, scope.scope);
      openIssue({
        environmentId: scope.environmentId,
        projectId: scope.scope.projectId,
        ...(scope.scope.connectionId ? { connectionId: scope.scope.connectionId } : {}),
        tracker: scope.scope.tracker,
        host: scope.scope.host,
        scope: scope.scope.scope,
        key: response.value.key,
        displayKey: response.value.displayKey,
      });
      if (response.value.warnings?.length)
        Alert.alert(`Created ${response.value.displayKey}`, response.value.warnings.join("\n"));
    });
    pending.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "The tracker refused it. Try again.");
    }
  };
  const choice = (field: string, value: string, title: string, on: boolean) => ({
    id: JSON.stringify([field, value]),
    title,
    state: on ? ("on" as const) : ("off" as const),
  });
  return (
    <SheetContent
      title="New issue"
      subtitle={
        scope ? `${scope.projectTitle} · ${scope.scope.scope}` : "No project can file issues"
      }
      busy={busy}
      footer={
        <Button
          label={busy ? "Creating…" : "Create issue"}
          fullWidth
          tone={Platform.OS === "android" ? "primary" : "contrast"}
          loading={busy}
          disabled={blocked !== null || !title.trim()}
          onPress={() => void submit()}
        />
      }
    >
      <View className="flex-row flex-wrap gap-2">
        {scopes.length > 1 ? (
          <ListFilterMenu
            label={scope ? `${scope.projectTitle} · ${scope.scope.scope}` : "Project"}
            accessibilityLabel="Project"
            actions={scopes.map((entry, index) =>
              choice(
                "scope",
                String(index),
                `${entry.projectTitle} · ${entry.scope.scope}`,
                index === scopeIndex,
              ),
            )}
            onSelect={select}
          />
        ) : null}
        {scope?.templates && (templates.length > 0 || templatesQuery.isPending) ? (
          <ListFilterMenu
            label={
              templatesQuery.isPending
                ? "Loading templates…"
                : (templates.find((entry) => entry.key === templateKey)?.name ?? "Blank issue")
            }
            accessibilityLabel="Template"
            actions={[
              ...(blankAllowed
                ? [choice("template", BLANK, "Blank issue", templateKey === BLANK)]
                : []),
              ...templates.map((template) => ({
                ...choice("template", template.key, template.name, template.key === templateKey),
                ...(template.about ? { subtitle: template.about } : {}),
              })),
            ]}
            onSelect={select}
          />
        ) : null}
        {scope?.createIssueTypes === true && issueTypes.length > 1 ? (
          <ListFilterMenu
            label={issueTypes.find((type) => type.id === chosenIssueType)?.name ?? "Choose a type"}
            active={chosenIssueType === null}
            accessibilityLabel="Issue type"
            actions={issueTypes.map((type) =>
              choice("type", type.id, type.name, type.id === chosenIssueType),
            )}
            onSelect={select}
          />
        ) : null}
      </View>
      {externalTemplates.map((template) => (
        <Pressable
          key={template.url}
          accessibilityRole="link"
          accessibilityLabel={`Fill in ${template.name} on the tracker`}
          onPress={() => void Linking.openURL(template.url)}
          className="flex-row items-center gap-1.5 active:opacity-70"
        >
          <Text className="text-xs text-primary-text">{template.name}</Text>
          <SymbolView name="arrow.up.right" size={10} tintColorClassName="accent-link" />
        </Pressable>
      ))}
      <TextInput
        accessibilityLabel="Title"
        placeholder="A short summary"
        placeholderTextColorClassName="accent-foreground-muted"
        editable={!busy}
        value={title}
        maxLength={1024}
        onChangeText={(next) => {
          setTitleEdited(true);
          setTemplateDraft((held) => (held ? { ...held, title: false } : null));
          setTitle(next);
        }}
        className="min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
      />
      {templateFields.length ? (
        templateFields.map((field) => {
          if (field.kind === "markdown") return <Text key={field.value}>{field.value}</Text>;
          const value = values[field.id];
          const label = `${field.label}${field.required ? " *" : ""}`;
          const set = (next: string | readonly string[]) =>
            setValues((held) => ({ ...held, [field.id]: next }));
          return (
            <View key={field.id} className="gap-2">
              <Text>{label}</Text>
              {field.description ? (
                <Text className="text-xs text-foreground-muted">{field.description}</Text>
              ) : null}
              {field.kind === "dropdown" || field.kind === "checkboxes" ? (
                <ListFilterMenu
                  label={
                    typeof value === "string" ? value || "Choose…" : value?.join(", ") || "Choose…"
                  }
                  accessibilityLabel={field.label}
                  actions={(field.kind === "dropdown"
                    ? field.options
                    : field.options.map((option) => option.label)
                  ).map((option) => ({
                    id: option,
                    title: option,
                    state: (typeof value === "string" ? value === option : value?.includes(option))
                      ? "on"
                      : "off",
                  }))}
                  onSelect={(next) => {
                    if (field.kind === "dropdown" && !field.multiple) set(next);
                    else {
                      const selected = typeof value === "string" ? [] : (value ?? []);
                      set(
                        selected.includes(next)
                          ? selected.filter((item) => item !== next)
                          : [...selected, next],
                      );
                    }
                  }}
                />
              ) : (
                <TextInput
                  accessibilityLabel={field.label}
                  value={typeof value === "string" ? value : ""}
                  placeholder={field.placeholder ?? undefined}
                  multiline={field.kind === "textarea"}
                  maxLength={65536}
                  editable={!busy}
                  onChangeText={set}
                  className="min-h-12 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
                />
              )}
            </View>
          );
        })
      ) : (
        <TextInput
          multiline
          accessibilityLabel="Description"
          placeholder="Markdown is supported"
          placeholderTextColorClassName="accent-foreground-muted"
          editable={!busy}
          value={body}
          maxLength={65536}
          onChangeText={(next) => {
            setBodyEdited(true);
            setTemplateDraft((held) => (held ? { ...held, body: false } : null));
            setBody(next);
          }}
          className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
          style={{ textAlignVertical: "top" }}
        />
      )}
      {nativeFields.map((field) => {
        const value = nativeValues[field.id];
        const set = (next: string | readonly string[]) =>
          setNativeValues((held) => ({ ...held, [field.id]: next }));
        return (
          <View key={field.id} className="gap-2">
            <Text>
              {field.label}
              {field.required ? " *" : ""}
            </Text>
            {field.description ? (
              <Text className="text-xs text-foreground-muted">{field.description}</Text>
            ) : null}
            {field.kind === "json" || field.kind === "cascading-select" ? (
              <Text className="text-xs text-foreground-muted">
                Fill in this field on the tracker.
              </Text>
            ) : field.kind === "select" || field.kind === "multiselect" ? (
              <ListFilterMenu
                label={
                  typeof value === "string"
                    ? (field.options?.find((option) => option.value === value)?.label ?? "Choose…")
                    : value
                        ?.map(
                          (selected) =>
                            field.options?.find((option) => option.value === selected)?.label ??
                            selected,
                        )
                        .join(", ") || "Choose…"
                }
                accessibilityLabel={field.label}
                actions={(field.options ?? []).map((option) => ({
                  id: option.value,
                  title: option.label,
                  state: (
                    typeof value === "string"
                      ? value === option.value
                      : value?.includes(option.value)
                  )
                    ? "on"
                    : "off",
                }))}
                onSelect={(next) => {
                  if (field.kind === "select") set(next);
                  else {
                    const selected = typeof value === "string" ? [] : (value ?? []);
                    set(
                      selected.includes(next)
                        ? selected.filter((item) => item !== next)
                        : [...selected, next],
                    );
                  }
                }}
              />
            ) : (
              <TextInput
                accessibilityLabel={field.label}
                value={typeof value === "string" ? value : ""}
                multiline={field.kind === "textarea"}
                placeholder={
                  field.kind === "date"
                    ? "YYYY-MM-DD"
                    : field.kind === "datetime"
                      ? "YYYY-MM-DDTHH:mm:ssZ"
                      : undefined
                }
                keyboardType={field.kind === "number" ? "numeric" : "default"}
                maxLength={65536}
                editable={!busy}
                onChangeText={set}
                className="min-h-12 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
              />
            )}
          </View>
        );
      })}
      {scope &&
      nativeFields.some((field) => field.kind === "json" || field.kind === "cascading-select") ? (
        <Button
          label="Open tracker"
          tone="text"
          onPress={() => void Linking.openURL(`https://${scope.scope.host}`)}
        />
      ) : null}
      {extras.labels.length || extras.assignees.length ? (
        <Text className="text-xs text-foreground-muted">
          {[
            extras.labels.length ? `Labels: ${extras.labels.join(", ")}` : null,
            extras.assignees.length ? `Assignees: ${extras.assignees.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
      {blocked ? <Text className="text-xs text-foreground-muted">{blocked}</Text> : null}
      {scope?.templates && (templatesQuery.error || chosenTemplate.retry) ? (
        <View className="gap-2">
          {templateRead.error ? (
            <Text selectable className="text-sm text-danger-foreground">
              {templateRead.error}
            </Text>
          ) : null}
          <Button label="Retry templates" tone="text" onPress={templateRead.refresh} />
        </View>
      ) : null}
      {(scope?.createIssueTypes === true || scope?.createFields === true) &&
      candidatesQuery.error ? (
        <Button label="Retry issue types" tone="text" onPress={candidatesQuery.refresh} />
      ) : null}
      {error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </SheetContent>
  );
}
