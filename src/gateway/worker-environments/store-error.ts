export class WorkerSessionAlreadyAttachedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly environmentId: string,
  ) {
    super(`Session ${sessionId} is already attached to worker environment ${environmentId}`);
  }
}
