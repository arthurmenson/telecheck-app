import type { NerHit } from './ner-spans.js';

export const NER_MAX_CHARACTERS = 16_000;
export class NerScreeningError extends Error {
  constructor() {
    super('pii_screening_unavailable');
    this.name = 'NerScreeningError';
  }
}

/** No wait queue. A timed-out native invocation retains its permit until it
 * settles; the deadline stops subsequent windows but cannot cancel native work. */
export function createBoundedClassifier(
  infer: (text: string, expired: () => boolean) => Promise<readonly NerHit[]>,
  options: { capacity?: number; deadlineMs?: number } = {},
): {
  classify: (text: string) => Promise<readonly NerHit[]>;
  status: () => { inFlight: number; capacity: number; degraded: boolean };
} {
  const capacity = options.capacity ?? 2;
  const deadlineMs = options.deadlineMs ?? 10_000;
  let inFlight = 0;
  let timedOut = 0;
  let failed = false;
  return {
    status: () => ({ inFlight, capacity, degraded: timedOut > 0 || failed }),
    async classify(text) {
      if (!text.length) return [];
      if (
        text.length > NER_MAX_CHARACTERS ||
        inFlight >= capacity ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
      )
        throw new NerScreeningError();
      inFlight++;
      let expired = false;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          expired = true;
          timedOut++;
          reject(new NerScreeningError());
        }, deadlineMs);
        void Promise.resolve()
          .then(() => infer(text, () => expired))
          .then(
            (hits) => {
              if (!expired) {
                failed = false;
                resolve(hits);
              }
            },
            () => {
              failed = true;
              reject(new NerScreeningError());
            },
          )
          .finally(() => {
            clearTimeout(timer);
            inFlight--;
            if (expired) timedOut--;
          });
      });
    },
  };
}
