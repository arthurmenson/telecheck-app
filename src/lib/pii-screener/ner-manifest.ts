import manifest from './ner-manifest.json' with { type: 'json' };

export const MODEL = manifest;
export const LABELS: readonly string[] = manifest.labels;
