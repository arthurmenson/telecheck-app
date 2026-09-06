/** Local English statistical privacy classifier. No runtime networking or regex-only fallback.
 * The model reduces disclosure risk; a pass does not certify arbitrary prose PII-free.
 * Assets are acquired separately by scripts/setup-ner-model.mjs, then verified here.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { InferenceSession, Tensor } from 'onnxruntime-node';
import { Tokenizer } from 'tokenizers';

import { createBoundedClassifier, NerScreeningError } from './ner-capacity.js';
import { MODEL, LABELS } from './ner-manifest.js';
import { aggregateHits, makeWindows, sourceEncoding, type NerHit } from './ner-spans.js';

export type { NerHit } from './ner-spans.js';
export { NerScreeningError } from './ner-capacity.js';

const assetDirectory = new URL('../../../assets/pii-ner/', import.meta.url);
let assetsVerified = false;
let warmedUp = false;
let loadPromise: Promise<{ tokenizer: Tokenizer; session: InferenceSession }> | undefined;

async function loadModel(): Promise<{ tokenizer: Tokenizer; session: InferenceSession }> {
  loadPromise ??= (async () => {
    for (const [name, expected] of Object.entries(MODEL.files)) {
      const bytes = await readFile(new URL(name, assetDirectory));
      if (
        bytes.length !== expected.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== expected.sha256
      )
        throw new NerScreeningError();
    }
    const config = JSON.parse(await readFile(new URL('config.json', assetDirectory), 'utf8')) as {
      id2label?: Record<string, string>;
    };
    if (
      !config.id2label ||
      JSON.stringify(Object.values(config.id2label)) !== JSON.stringify(LABELS)
    )
      throw new NerScreeningError();
    assetsVerified = true;
    const tokenizer = Tokenizer.fromFile(fileURLToPath(new URL('tokenizer.json', assetDirectory)));
    tokenizer.disablePadding();
    tokenizer.disableTruncation();
    if (tokenizer.tokenToId('[CLS]') !== 101 || tokenizer.tokenToId('[SEP]') !== 102)
      throw new NerScreeningError();
    const session = await InferenceSession.create(
      fileURLToPath(new URL('model_int8.onnx', assetDirectory)),
      {
        executionProviders: ['cpu'],
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        logSeverityLevel: 4,
      },
    );
    try {
      if (
        session.inputNames.join(',') !== 'input_ids,attention_mask,token_type_ids' ||
        session.outputNames.join(',') !== 'logits'
      )
        throw new NerScreeningError();
      if (
        session.inputMetadata.length !== 3 ||
        session.inputMetadata.some(
          (value) => !value.isTensor || value.type !== 'int64' || value.shape.length !== 2,
        )
      )
        throw new NerScreeningError();
      const outputMetadata = session.outputMetadata[0];
      if (
        !outputMetadata?.isTensor ||
        outputMetadata.type !== 'float32' ||
        outputMetadata.shape.length !== 3 ||
        outputMetadata.shape[2] !== LABELS.length
      )
        throw new NerScreeningError();
      const loaded = { tokenizer, session };
      const positive = await infer('My name is John Smith.', loaded, () => false);
      const negative = await infer('Take medication today with water.', loaded, () => false);
      if (!positive.some((hit) => hit.entityType === 'PERSON') || negative.length !== 0)
        throw new NerScreeningError();
      warmedUp = true;
      return loaded;
    } catch {
      await session.release();
      throw new NerScreeningError();
    }
  })().catch(() => {
    throw new NerScreeningError();
  });
  return loadPromise;
}

async function infer(
  text: string,
  loaded: { tokenizer: Tokenizer; session: InferenceSession },
  expired: () => boolean,
): Promise<readonly NerHit[]> {
  const encoding = await loaded.tokenizer.encode(text, null, { addSpecialTokens: false });
  const source = sourceEncoding(text, encoding);
  const windows = makeWindows(source.ids.length);
  const detected: Array<{ token: number; entityType: string }> = [];
  for (const window of windows) {
    if (expired()) throw new NerScreeningError();
    const ids = [101, ...source.ids.slice(window.start, window.end), 102];
    const feeds: Record<string, Tensor> = {
      input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      attention_mask: new Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
      token_type_ids: new Tensor('int64', new BigInt64Array(ids.length), [1, ids.length]),
    };
    let outputs: InferenceSession.ReturnType | undefined;
    try {
      outputs = await loaded.session.run(feeds);
      if (expired()) throw new NerScreeningError();
      const logits = outputs['logits'];
      if (
        !logits ||
        logits.type !== 'float32' ||
        logits.dims.join(',') !== `1,${ids.length},${LABELS.length}` ||
        logits.data.length !== ids.length * LABELS.length
      )
        throw new NerScreeningError();
      const values = logits.data as Float32Array;
      if (!values.every(Number.isFinite)) throw new NerScreeningError();
      for (let position = 1; position < ids.length - 1; position++) {
        let winner = 0;
        for (let label = 1; label < LABELS.length; label++) {
          if (
            values[position * LABELS.length + label]! > values[position * LABELS.length + winner]!
          )
            winner = label;
        }
        const entityType = SELECTED_LABELS[LABELS[winner]!.slice(2)];
        if (entityType) detected.push({ token: window.start + position - 1, entityType });
      }
    } finally {
      if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose();
      for (const tensor of Object.values(feeds)) tensor.dispose();
    }
  }
  return aggregateHits(text, source, detected);
}

// Policy confidence is categorical, not a probability threshold. Retain every
// winning token in these classes, including weak trailing subwords.
const SELECTED_LABELS: Readonly<Record<string, string>> = {
  first_name: 'PERSON',
  last_name: 'PERSON',
  city: 'GPE',
  country: 'GPE',
  county: 'GPE',
  state: 'GPE',
  street_address: 'LOCATION',
  postcode: 'LOCATION',
  coordinate: 'LOCATION',
  company_name: 'ORG',
  date_of_birth: 'DOB',
};

const bounded = createBoundedClassifier(async (text, expired) =>
  infer(text, await loadModel(), expired),
);
export const classifyEntities = bounded.classify;

/** Warm-up errors are safe. Crisis handling remains independent of this promise. */
export async function initializeNer(): Promise<void> {
  await loadModel();
}

export function getNerReadiness(): {
  modelId: string;
  revision: string;
  assetsVerified: boolean;
  warmedUp: boolean;
  inFlight: number;
  capacity: number;
  degraded: boolean;
  ready: boolean;
} {
  const capacity = bounded.status();
  return {
    modelId: MODEL.id,
    revision: MODEL.revision,
    assetsVerified,
    warmedUp,
    ...capacity,
    degraded: !assetsVerified || !warmedUp || capacity.degraded,
    ready:
      assetsVerified && warmedUp && !capacity.degraded && capacity.inFlight < capacity.capacity,
  };
}
