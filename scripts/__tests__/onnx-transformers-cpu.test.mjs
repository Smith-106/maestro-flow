import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as ort from 'onnxruntime-node';

const fixture = new URL('./fixtures/tiny-bert/', import.meta.url);
const modelPath = fileURLToPath(new URL('onnx/model.onnx', fixture));
const modelDirectory = fileURLToPath(fixture).replace(/\\/g, '/');
const require = createRequire(import.meta.url);

// These tests intentionally use native sessions and the shipped bundle, not mocks.
// The tiny synthetic graph tests compatibility only, not pretrained model quality.
test('real ONNX CPU inference produces exact values and releases its session', { timeout: 30_000 }, async t => {
  t.diagnostic(`Node ${process.version}; native binding ${require('onnxruntime-node/package.json').version}`);
  assert.equal(require('onnxruntime-node/package.json').version, '1.30.0');
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  try {
    assert.deepEqual(session.inputNames, ['input_ids']);
    assert.deepEqual(session.outputNames, ['last_hidden_state']);
    for (const ids of [[2n, 5n, 6n, 3n], [2n, 6n, 3n]]) {
      const result = await session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids), [1, ids.length]),
      });
      assert.equal(result.last_hidden_state.type, 'float32');
      assert.deepEqual(result.last_hidden_state.dims, [1, ids.length, 1]);
      assert.deepEqual(Array.from(result.last_hidden_state.data), ids.map(id => Number(id) + 0.5));
    }
  } finally {
    await session.release();
  }
});

test('real vendored #maestro-transformers tokenizes, runs CPU inference, pools and disposes', { timeout: 30_000 }, async t => {
  const bundle = require.resolve('#maestro-transformers').replace(/\\/g, '/');
  assert.ok(bundle.endsWith('/dashboard/vendor/transformers/dist/transformers.node.mjs'), bundle);
  t.diagnostic(`Vendored bundle ${bundle}`);
  const { pipeline, env } = await import('#maestro-transformers');
  const original = {
    allowRemoteModels: env.allowRemoteModels,
    allowLocalModels: env.allowLocalModels,
    useFSCache: env.useFSCache,
    useBrowserCache: env.useBrowserCache,
  };
  Object.assign(env, { allowRemoteModels: false, allowLocalModels: true, useFSCache: false, useBrowserCache: false });
  let extractor;
  try {
    extractor = await pipeline('feature-extraction', modelDirectory, {
      device: 'cpu', dtype: 'fp32', local_files_only: true,
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    const tokens = extractor.tokenizer('hello world');
    assert.deepEqual(Array.from(tokens.input_ids.data), [2n, 5n, 6n, 3n]);
    const hidden = await extractor('hello world', { pooling: 'none', normalize: false });
    assert.deepEqual(hidden.dims, [1, 4, 1]);
    assert.deepEqual(Array.from(hidden.data), [2.5, 5.5, 6.5, 3.5]);
    // The shorter sequence is padded; pooling must exclude that padding.
    const pooled = await extractor(['hello world', 'world'], { pooling: 'mean', normalize: false });
    assert.deepEqual(pooled.dims, [2, 1]);
    assert.deepEqual(Array.from(pooled.data), [4.5, Math.fround(25 / 6)]);
    const normalized = await extractor('hello world', { pooling: 'mean', normalize: true });
    assert.deepEqual(Array.from(normalized.data), [1]);
  } finally {
    try {
      await extractor?.dispose();
    } finally {
      Object.assign(env, original);
    }
  }
});
