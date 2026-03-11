// src/utils/handwritingRecognizer.js
// ─────────────────────────────────────────────────────────────────────────────
// TensorFlow.js–based digit recogniser for the Alined dimension input system.
//
// This complements the existing Tesseract OCR in handwritingOCR.js.
// Tesseract is great for general text; this CNN is optimised purely for digit
// recognition (0-9) and runs faster on mobile devices.
//
// Setup:  npm install @tensorflow/tfjs
//
// The model loads from IndexedDB after the first network fetch, so all
// subsequent uses are fully offline (no CDN, no server).
//
// Usage:
//   import HandwritingRecognizer from './handwritingRecognizer';
//   const recognizer = new HandwritingRecognizer();
//   await recognizer.init();
//   const [{ digit, confidence }] = await recognizer.predict(canvasElement);
// ─────────────────────────────────────────────────────────────────────────────

// @tensorflow/tfjs is loaded lazily so the app still boots even if the
// package hasn't been installed yet (Tesseract.js will handle OCR instead).
let tf = null;

async function getTf() {
  if (tf) return tf;
  try {
    tf = await import('@tensorflow/tfjs');
    return tf;
  } catch {
    throw new Error(
      '[HandwritingRecognizer] TensorFlow.js is not installed.\n' +
      'Run:  npm install @tensorflow/tfjs'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export default class HandwritingRecognizer {
  // ── constants ───────────────────────────────────────────────────────────────
  static INPUT_SIZE    = 28;
  static NUM_CLASSES   = 10;
  static IDB_MODEL_KEY = 'indexeddb://alined-digit-recognition-model';
  // Replace with a self-hosted path under /public/ for a fully air-gapped build:
  static REMOTE_MODEL_URL =
    'https://storage.googleapis.com/tfjs-models/tfjs/mnist_transfer_cnn_v1/model.json';

  constructor() {
    this.model       = null;
    this.isReady     = false;
    this._initPromise = null;
  }

  // ── public API ──────────────────────────────────────────────────────────────

  /**
   * Load the model.  Safe to call multiple times; subsequent calls reuse the
   * same promise.
   */
  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      const tf = await getTf();
      console.info('[HandwritingRecognizer] Initialising…');

      // 1 – IndexedDB (instant offline)
      try {
        this.model = await tf.loadLayersModel(HandwritingRecognizer.IDB_MODEL_KEY);
        console.info('[HandwritingRecognizer] Loaded from IndexedDB ✓');
        this.isReady = true;
        return;
      } catch {
        console.info('[HandwritingRecognizer] No cached model – fetching remote…');
      }

      // 2 – Remote, then cache
      try {
        this.model = await tf.loadLayersModel(HandwritingRecognizer.REMOTE_MODEL_URL);
        await this.model.save(HandwritingRecognizer.IDB_MODEL_KEY);
        console.info('[HandwritingRecognizer] Fetched + cached ✓');
        this.isReady = true;
        return;
      } catch {
        console.warn('[HandwritingRecognizer] Remote unavailable – using blank CNN.');
      }

      // 3 – Untrained fallback (accuracy is random until weights are loaded)
      this.model = this._buildModel(tf);
      console.warn(
        '[HandwritingRecognizer] Using untrained model. ' +
        'Provide weights or call trainOnMnist() to improve accuracy.'
      );
      this.isReady = true;
    })();

    return this._initPromise;
  }

  /**
   * Predict digits from a canvas or ImageData.
   * @param  {HTMLCanvasElement|ImageData} source
   * @param  {number} topK  how many ranked candidates to return (default 3)
   * @returns {Promise<Array<{ digit: number, confidence: number }>>}
   */
  async predict(source, topK = 3) {
    if (!this.isReady) await this.init();
    const tf = await getTf();

    return tf.tidy(() => {
      const tensor = this._preprocess(tf, source);
      // model.predict() output is already probabilities for both the remote
      // mnist_transfer_cnn_v1 model (softmax baked in) and the local fallback
      // CNN (softmax activation on final layer). Never apply tf.softmax() again
      // here – doing so on an already-normalised output compresses confidence
      // scores toward uniform and degrades top-k ranking.
      const probs  = this.model.predict(tensor);
      const { values, indices } = tf.topk(probs, topK);

      const conf   = Array.from(values.dataSync());
      const digits = Array.from(indices.dataSync());

      return digits.map((digit, i) => ({ digit, confidence: conf[i] }));
    });
  }

  /** Persist the current model weights to IndexedDB. */
  async saveToCache() {
    if (!this.model) throw new Error('[HandwritingRecognizer] No model loaded.');
    await this.model.save(HandwritingRecognizer.IDB_MODEL_KEY);
    console.info('[HandwritingRecognizer] Cached to IndexedDB ✓');
  }

  /**
   * Fine-tune on browser-side MNIST data to improve accuracy.
   * @param {tf.Tensor} xTrain  [N, 28, 28, 1]  float32  [0-1]
   * @param {tf.Tensor} yTrain  [N, 10]          one-hot int32
   * @param {object}    opts    passed to model.fit()
   */
  async trainOnMnist(xTrain, yTrain, opts = {}) {
    const tf = await getTf();
    if (!this.model) await this.init();
    await this.model.fit(xTrain, yTrain, {
      epochs: 5, batchSize: 128, validationSplit: 0.1,
      ...opts,
    });
    await this.saveToCache();
    console.info('[HandwritingRecognizer] Training complete ✓');
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Preprocess canvas → [1, 28, 28, 1] float32 tensor.
   * Dark-on-white drawing is inverted to match MNIST white-on-black convention.
   */
  _preprocess(tf, source) {
    return tf.tidy(() => {
      let t = tf.browser.fromPixels(source, 1);           // [H, W, 1]
      t = tf.image.resizeBilinear(t, [
        HandwritingRecognizer.INPUT_SIZE,
        HandwritingRecognizer.INPUT_SIZE,
      ]);
      t = t.toFloat().div(255.0);
      t = tf.scalar(1.0).sub(t);                          // invert
      return t.expandDims(0);                             // [1, 28, 28, 1]
    });
  }

  /**
   * Minimal MNIST-compatible CNN.
   * Conv2D(32,3) → MaxPool → Conv2D(64,3) → MaxPool → Dense(128) → Dense(10)
   */
  _buildModel(tf) {
    const model = tf.sequential({ name: 'digit-recognizer' });

    model.add(tf.layers.conv2d({
      inputShape: [28, 28, 1], filters: 32,
      kernelSize: 3, activation: 'relu', padding: 'same',
    }));
    model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
    model.add(tf.layers.conv2d({
      filters: 64, kernelSize: 3, activation: 'relu', padding: 'same',
    }));
    model.add(tf.layers.maxPooling2d({ poolSize: 2 }));
    model.add(tf.layers.flatten());
    model.add(tf.layers.dense({ units: 128, activation: 'relu' }));
    model.add(tf.layers.dropout({ rate: 0.25 }));
    // Use softmax here so the fallback model's output matches the remote
    // mnist_transfer_cnn_v1 model (which also outputs probabilities, not logits).
    // This keeps predict() consistent regardless of which model is loaded.
    model.add(tf.layers.dense({ units: HandwritingRecognizer.NUM_CLASSES, activation: 'softmax' }));
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy'],
    });
    return model;
  }
}
