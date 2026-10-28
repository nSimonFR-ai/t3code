import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

export function createIssueEnvironmentTestRuntime(
  supervisorTarget: "environment" | "none" = "environment",
) {
  return Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" } as const);
        const session = yield* SubscriptionRef.make(Option.some({}));
        const connectionState = { state: connection, session };
        const supervisor = (environmentId: EnvironmentId) =>
          (supervisorTarget === "environment"
            ? { target: { environmentId }, ...connectionState }
            : connectionState) as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (id, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(id),
            ),
          followStream: (id, stream) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(id),
            ),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
}
