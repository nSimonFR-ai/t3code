import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export function createIssueTestRoot(registry = AtomRegistry.make()) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const unmount = () => act(async () => root.unmount());
  return {
    container,
    registry,
    render: (children: ReactNode) =>
      root.render(createElement(RegistryContext.Provider, { value: registry }, children)),
    unmount,
    async dispose() {
      await unmount();
      registry.dispose();
    },
  };
}

export function createIssueTestHook<T>(registry: AtomRegistry.AtomRegistry, useHook: () => T) {
  const root = createIssueTestRoot(registry);
  let current: T;
  function Probe() {
    const next = useHook();
    useLayoutEffect(() => {
      current = next;
    });
    return null;
  }
  return {
    get current() {
      return current;
    },
    render: () => root.render(createElement(Probe)),
    unmount: root.unmount,
  };
}
