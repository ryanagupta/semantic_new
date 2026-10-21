export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type CircuitCompletion = (failed: boolean | null) => void;

export class CircuitOpenError extends Error {
  readonly status = 503;
  constructor(readonly endpointId: string, readonly retryAfter: number) {
    super('Upstream service degraded');
    this.name = 'CircuitOpenError';
  }
}

/** A rolling failure window with bounded half-open probes and deterministic clock injection. */
export class CircuitBreaker {
  private samples: { at: number; failed: boolean }[] = [];
  private openedAt: number | null = null;
  private probesInFlight = 0;
  private probesSucceeded = 0;
  constructor(readonly endpointId: string, private readonly now: () => number = Date.now) {}
  get state(): CircuitState {
    if (this.openedAt === null) return 'CLOSED';
    return this.now() - this.openedAt >= 15_000 ? 'HALF_OPEN' : 'OPEN';
  }
  assertAvailable(): void {
    if (this.state === 'OPEN') throw new CircuitOpenError(this.endpointId, Math.max(1, Math.ceil((15_000 - (this.now() - this.openedAt!)) / 1000)));
    if (this.state === 'HALF_OPEN' && this.probesInFlight + this.probesSucceeded >= 5) throw new CircuitOpenError(this.endpointId, 1);
  }
  acquire(): CircuitCompletion {
    this.assertAvailable();
    const probe = this.state === 'HALF_OPEN';
    const generation = this.openedAt;
    if (probe) this.probesInFlight++;
    let recorded = false;
    return (failed: boolean | null) => {
      if (recorded) return;
      recorded = true;
      if (probe) {
        if (this.openedAt !== generation) return;
        this.probesInFlight = Math.max(0, this.probesInFlight - 1);
        if (failed === null) return;
        if (failed) this.open();
        else if (++this.probesSucceeded >= 5) { this.openedAt = null; this.probesSucceeded = 0; this.samples = []; }
        return;
      }
      if (this.openedAt !== null) return;
      if (failed === null) return;
      const now = this.now();
      this.samples = this.samples.filter(sample => now - sample.at < 30_000);
      this.samples.push({ at: now, failed });
      if (this.samples.length >= 5 && this.samples.filter(sample => sample.failed).length / this.samples.length > 0.5) this.open();
    };
  }
  private open() { this.openedAt = this.now(); this.probesInFlight = 0; this.probesSucceeded = 0; }
}

export const circuitBreakers = new Map<string, CircuitBreaker>();
function getCircuit(endpointId: string) {
  let breaker = circuitBreakers.get(endpointId);
  if (!breaker) { breaker = new CircuitBreaker(endpointId); circuitBreakers.set(endpointId, breaker); }
  return breaker;
}
export const assertCircuitAvailable = (endpointId: string): void => getCircuit(endpointId).assertAvailable();
export const isCircuitOpen = (endpointId: string): boolean => getCircuit(endpointId).state === 'OPEN';
export const acquireCircuit = (endpointId: string): CircuitCompletion => getCircuit(endpointId).acquire();
