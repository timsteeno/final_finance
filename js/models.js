// Model registry. Paths are relative to the site root.
export const MODELS = {
  fast: {
    label: 'Fast',
    description: 'U²-Netp · 4.6 MB · quick, softer edges',
    files: ['models/u2netp.onnx'],
    bytes: 4574861,
    size: 320,
    norm: 'imagenet-max',
    out: 'minmax',
    gpuFriendly: true,
  },
  balanced: {
    label: 'Balanced',
    description: 'ISNet 8-bit · 44 MB · great quality',
    files: ['models/isnet_quint8.onnx'],
    bytes: 44342436,
    size: 1024,
    norm: 'isnet',
    out: 'raw',
    gpuFriendly: false,
  },
  best: {
    label: 'Best',
    description: 'ISNet fp16 · 88 MB · highest fidelity',
    files: ['models/isnet_fp16.onnx.part0', 'models/isnet_fp16.onnx.part1'],
    bytes: 88188479,
    size: 1024,
    norm: 'isnet',
    out: 'raw',
    gpuFriendly: true,
  },
};
export const DEFAULT_MODEL = 'balanced';
