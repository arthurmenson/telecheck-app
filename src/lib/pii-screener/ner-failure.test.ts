import { afterEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  asset: false,
  corrupt: false,
  native: false,
  dimensions: false,
  nonfinite: false,
  calls: 0,
  disposals: 0,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (faults.asset) throw new Error('PRIVATE ASSET ERROR');
      const result = await fs.readFile(...args);
      return faults.corrupt && Buffer.isBuffer(result) ? Buffer.alloc(result.length) : result;
    },
  };
});
vi.mock('onnxruntime-node', async (original) => {
  const ort = await original<typeof import('onnxruntime-node')>();
  return {
    ...ort,
    InferenceSession: {
      create: async (...args: Parameters<typeof ort.InferenceSession.create>) => {
        const session = await ort.InferenceSession.create(...args);
        const run = session.run.bind(session);
        session.run = async (feeds) => {
          faults.calls++;
          if (faults.native) throw new Error('PRIVATE NATIVE ERROR');
          if (faults.dimensions || faults.nonfinite) {
            const length = feeds['input_ids']!.dims[1]!;
            const data = new Float32Array(length * 106);
            if (faults.nonfinite) data[0] = Number.NaN;
            const tensor = new ort.Tensor('float32', data, [1, length, 106]);
            const dispose = tensor.dispose.bind(tensor);
            tensor.dispose = () => {
              faults.disposals++;
              dispose();
            };
            return faults.dimensions ? { wrong: tensor } : { logits: tensor };
          }
          return run(feeds);
        };
        return session;
      },
    },
  };
});

afterEach(() => {
  faults.asset = false;
  faults.corrupt = false;
  faults.native = false;
  faults.dimensions = false;
  faults.nonfinite = false;
  faults.calls = 0;
  faults.disposals = 0;
  vi.resetModules();
});

describe('real local model failure contract', () => {
  it('corrupt model bytes fail integrity verification before inference', async () => {
    faults.corrupt = true;
    const { classifyEntities, getNerReadiness } = await import('./ner.js');
    await expect(classifyEntities('candidate')).rejects.toThrow('pii_screening_unavailable');
    expect(getNerReadiness().assetsVerified).toBe(false);
    expect(faults.calls).toBe(0);
  });

  it('missing assets do not pass through to native inference or original text', async () => {
    faults.asset = true;
    const { screenInput, screenOutput } = await import('./index.js');
    expect((await screenInput('sensitive candidate', 'audit_bound')).blockReason).toBe(
      'screening_unavailable',
    );
    const result = await screenOutput('sensitive candidate');
    expect(result.output).toBe('[REDACTED:Unverified output]');
    expect(result.hits[0]?.match).toBe('');
    expect(faults.calls).toBe(0);
  });

  it.each(['native', 'dimensions', 'nonfinite'] as const)(
    'fails closed on %s and disposes output tensors',
    async (fault) => {
      faults[fault] = true;
      const { classifyEntities, getNerReadiness } = await import('./ner.js');
      await expect(classifyEntities('private candidate')).rejects.toThrow(
        'pii_screening_unavailable',
      );
      expect(getNerReadiness().ready).toBe(false);
      if (fault !== 'native') expect(faults.disposals).toBe(1);
    },
  );
});
