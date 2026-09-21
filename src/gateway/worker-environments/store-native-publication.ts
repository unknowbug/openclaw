import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  workerEnvironmentProjections,
  type WorkerEnvironmentNativePatch,
} from "./store-projection.js";

/** Pairing and placement keep their atomic writes, then publish through the inventory owner. */
export function publishWorkerEnvironmentNativeMutation(
  db: DatabaseSync,
  environmentId: string,
  patch: WorkerEnvironmentNativePatch,
): void {
  const owner = workerEnvironmentProjections.get(requireOpenClawStateDatabaseIdentity({ db }));
  if (!owner?.active) {
    return;
  }
  const captured = structuredClone(patch);
  // Reserve order while this transaction holds the writer lock, before observers can reenter.
  const revision = owner.nextSequence();
  if (
    !stageSqliteTransactionState(db, {
      stage() {},
      rollback() {},
      commit() {
        if (owner.active) {
          owner.publishPatch(environmentId, captured, revision);
        }
      },
    })
  ) {
    throw new Error("Worker environment publication requires its owning transaction");
  }
  sessionChanges.emit({ all: true, scope: "worker-environments" }, db);
}
