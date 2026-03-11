#!/usr/bin/env python3
"""
train_measurement_model.py
══════════════════════════════════════════════════════════════════════════════
Trains a 13-class CNN for offline architectural measurement recognition.

Classes (index 0-12):
  0  1  2  3  4  5  6  7  8  9  '  "  -

Architecture:
  Conv2D(32) → BN → MaxPool → Dropout
  Conv2D(64) → BN → MaxPool → Dropout
  Flatten → Dense(128) → Dropout → Dense(13, softmax)

Data sources:
  • Digits 0-9   →  MNIST  (70 000 real handwritten samples, auto-downloaded)
  • '  "  -       →  Synthetic stroke simulation (5 000 samples each)

Output:
  public/models/measurement-recognizer/
    model.json      ← TF.js model topology
    group1-shard*   ← weight shards
    classes.json    ← ["0","1",...,"9","'",'"',"-"]

Install:
  pip install tensorflow tensorflowjs pillow numpy

Run:
  python train_measurement_model.py          # train and export
  python train_measurement_model.py --quick  # 2 000 sym samples, 20 epochs
  python train_measurement_model.py --check  # generate preview images and exit
══════════════════════════════════════════════════════════════════════════════
"""

import os, sys, json, math, random, argparse
import numpy as np

# ── Argument parsing ──────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description='Train measurement CNN')
parser.add_argument('--quick',   action='store_true', help='Faster training for dev')
parser.add_argument('--check',   action='store_true', help='Preview synthetic data only')
parser.add_argument('--epochs',  type=int,   default=0,    help='Override epoch count')
parser.add_argument('--samples', type=int,   default=0,    help='Override symbol samples')
parser.add_argument('--out',     type=str,   default='public/models/measurement-recognizer',
                    help='Output directory')
args = parser.parse_args()

# ── Config ────────────────────────────────────────────────────────────────────
IMG          = 28                      # model input: 28×28 px (MNIST compatible)
CLASSES      = list('0123456789') + ["'", '"', '-']
NC           = len(CLASSES)            # 13
SYM_SAMPLES  = args.samples or (2_000 if args.quick else 5_000)
EPOCHS       = args.epochs  or (20    if args.quick else 50)
BATCH        = 128
OUTPUT       = args.out

# ── PIL is always needed (used by preview_check too) ──────────────────────────
from PIL import Image, ImageDraw, ImageFilter

# TensorFlow / tensorflowjs are imported lazily in main() so that
# --check mode works without them installed.

# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — SYNTHETIC DATA GENERATOR
# ══════════════════════════════════════════════════════════════════════════════

def _draw_polyline(draw, pts, width, color=255):
    """Draw a sequence of (x,y) tuples as a connected line."""
    for i in range(len(pts) - 1):
        draw.line([pts[i], pts[i+1]], fill=color, width=width)


def _bezier(p0, p1, p2, n=12):
    """Quadratic bezier interpolation — creates natural stroke curvature."""
    if n <= 1:
        return [p0]   # guard against division-by-zero when n=1
    pts = []
    for k in range(n):
        t   = k / (n - 1)
        mt  = 1 - t
        x   = mt*mt*p0[0] + 2*mt*t*p2[0] + t*t*p1[0]
        y   = mt*mt*p0[1] + 2*mt*t*p2[1] + t*t*p1[1]
        x  += random.gauss(0, IMG * 0.015)
        y  += random.gauss(0, IMG * 0.015)
        pts.append((x, y))
    return pts


def _new_canvas(bg=0):
    """28×28 black canvas — ink is WHITE (MNIST convention: ink=1, bg=0)."""
    return Image.new('L', (IMG, IMG), bg)


# ── Apostrophe  '  ────────────────────────────────────────────────────────────
def make_apostrophe():
    img  = _new_canvas()
    draw = ImageDraw.Draw(img)
    s    = IMG

    # Position: upper half, slightly off-centre to the right
    cx   = s * random.uniform(0.38, 0.62)
    ytop = s * random.uniform(0.06, 0.20)
    ybot = s * random.uniform(0.36, 0.52)
    dx   = random.uniform(-0.08, 0.14) * s          # slight tilt

    # Style: tiny curve or straight
    ctrl = (cx + random.uniform(-0.1, 0.1)*s,
            (ytop + ybot) / 2 + random.uniform(-0.08, 0.08)*s)
    pts  = _bezier((cx + dx*0.5, ytop), (cx - dx*0.5, ybot), ctrl, n=10)
    w    = random.choice([2, 2, 3])
    _draw_polyline(draw, pts, width=w)
    return np.array(img, 'f') / 255.0


# ── Double-quote  "  ──────────────────────────────────────────────────────────
def make_double_quote():
    img  = _new_canvas()
    draw = ImageDraw.Draw(img)
    s    = IMG

    gap  = s * random.uniform(0.16, 0.26)
    cx   = s * 0.5
    x1   = cx - gap / 2
    x2   = cx + gap / 2

    for x in (x1, x2):
        ytop = s * random.uniform(0.06, 0.20)
        ybot = s * random.uniform(0.36, 0.52)
        dx   = random.uniform(-0.07, 0.10) * s
        ctrl = (x + random.uniform(-0.07, 0.07)*s,
                (ytop + ybot)/2 + random.uniform(-0.07, 0.07)*s)
        pts  = _bezier((x + dx*0.5, ytop), (x - dx*0.5, ybot), ctrl, n=10)
        w    = random.choice([2, 2, 3])
        _draw_polyline(draw, pts, width=w)

    return np.array(img, 'f') / 255.0


# ── Dash  -  ─────────────────────────────────────────────────────────────────
def make_dash():
    img  = _new_canvas()
    draw = ImageDraw.Draw(img)
    s    = IMG

    y     = s * random.uniform(0.38, 0.62)
    xleft = s * random.uniform(0.06, 0.18)
    xrigh = s * random.uniform(0.82, 0.94)
    ctrl  = (s * 0.5,
             y + random.gauss(0, s * 0.04))   # slight bow
    pts   = _bezier((xleft, y), (xrigh, y), ctrl, n=12)
    w     = random.choice([2, 2, 3])
    _draw_polyline(draw, pts, width=w)

    return np.array(img, 'f') / 255.0


# ── Augmentation ──────────────────────────────────────────────────────────────
def augment(arr):
    """
    Random augmentation pipeline that mimics real stylus handwriting:
      rotation ±20°  |  scale ±12%  |  translation ±2px  |  noise
    Input/output: float32 array [28,28], values 0.0-1.0, ink=1.
    """
    img = Image.fromarray((arr * 255).astype('uint8'))

    # Rotation
    angle = random.uniform(-20, 20)
    img   = img.rotate(angle, fillcolor=0, expand=False)

    # Scale
    sc    = random.uniform(0.88, 1.12)
    new_s = max(4, int(IMG * sc))
    img   = img.resize((new_s, new_s), Image.BILINEAR)

    # Crop / pad back to IMG×IMG
    if new_s > IMG:
        off = (new_s - IMG) // 2
        img = img.crop((off, off, off + IMG, off + IMG))
    else:
        pad = Image.new('L', (IMG, IMG), 0)
        off = (IMG - new_s) // 2
        pad.paste(img, (off, off))
        img = pad

    # Translation
    tx, ty = random.randint(-2, 2), random.randint(-2, 2)
    if tx or ty:
        img = img.transform(
            (IMG, IMG), Image.AFFINE, (1, 0, -tx, 0, 1, -ty), fillcolor=0
        )

    out = np.array(img, 'f') / 255.0

    # Gaussian noise  (cast back to float32 — np.random.normal returns float64)
    out = np.clip(out + np.random.normal(0, random.uniform(0.02, 0.07), out.shape),
                  0, 1).astype('float32')

    # Occasional light blur (simulates soft stylus tip)
    if random.random() < 0.25:
        blurred = Image.fromarray((out * 255).astype('uint8')).filter(
            ImageFilter.GaussianBlur(random.uniform(0.3, 0.7))
        )
        out = np.array(blurred, 'f') / 255.0

    return out


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — DATASET ASSEMBLY
# ══════════════════════════════════════════════════════════════════════════════

def load_mnist():
    """Load MNIST, return float32 [N,28,28,1] with ink=1/bg=0."""
    print('[1/4] Downloading / loading MNIST digits …')
    (x_tr, y_tr), (x_te, y_te) = keras.datasets.mnist.load_data()
    x = np.concatenate([x_tr, x_te]).astype('f') / 255.0   # ink=1 (MNIST is already correct)
    y = np.concatenate([y_tr, y_te])
    x = x.reshape(-1, IMG, IMG, 1)
    print(f'      {len(x):,} samples  (labels 0-9)')
    return x, y.astype('int32')


def generate_symbols():
    """Generate synthetic ' " - samples with augmentation."""
    GENERATORS = [make_apostrophe, make_double_quote, make_dash]
    X, y = [], []

    for offset, gen_fn in enumerate(GENERATORS):
        label  = 10 + offset
        char   = CLASSES[label]
        print(f'[2/4] Generating "{char}" class (label {label}): ', end='', flush=True)
        for k in range(SYM_SAMPLES):
            base = gen_fn()
            aug  = augment(base)
            X.append(aug.reshape(IMG, IMG, 1))
            y.append(label)
            if (k+1) % 1000 == 0:
                print(f'{k+1}…', end='', flush=True)
        print(f' {SYM_SAMPLES} done')

    return np.array(X, 'f'), np.array(y, 'int32')


def build_dataset():
    X_dig, y_dig = load_mnist()
    X_sym, y_sym = generate_symbols()

    X = np.concatenate([X_dig, X_sym])
    y = np.concatenate([y_dig, y_sym])

    # Shuffle
    idx  = np.random.permutation(len(X))
    X, y = X[idx], y[idx]

    # Train / val split (90 / 10)
    split  = int(0.90 * len(X))
    X_tr, X_va = X[:split], X[split:]
    y_tr, y_va = y[:split], y[split:]

    print(f'\n[3/4] Dataset ready:  train={len(X_tr):,}  val={len(X_va):,}')
    return X_tr, y_tr, X_va, y_va


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — MODEL
# ══════════════════════════════════════════════════════════════════════════════

def build_model():
    """
    13-class CNN — same architecture reproduced in measurementCNN.js
    so the untrained JS fallback has identical structure as the trained model.

    Target: < 500 KB on disk, < 10 ms inference on mobile Safari / Chrome.
    """
    inp = keras.Input(shape=(IMG, IMG, 1), name='input')

    x = keras.layers.Conv2D(32, 3, padding='same', activation='relu', name='conv1')(inp)
    x = keras.layers.BatchNormalization(name='bn1')(x)
    x = keras.layers.MaxPooling2D(2, name='pool1')(x)
    x = keras.layers.Dropout(0.20, name='drop1')(x)

    x = keras.layers.Conv2D(64, 3, padding='same', activation='relu', name='conv2')(x)
    x = keras.layers.BatchNormalization(name='bn2')(x)
    x = keras.layers.MaxPooling2D(2, name='pool2')(x)
    x = keras.layers.Dropout(0.25, name='drop2')(x)

    x = keras.layers.Flatten(name='flat')(x)
    x = keras.layers.Dense(128, activation='relu', name='fc1')(x)
    x = keras.layers.Dropout(0.35, name='drop3')(x)
    x = keras.layers.Dense(NC, activation='softmax', name='output')(x)

    model = keras.Model(inp, x, name='measurement_cnn')
    model.compile(
        optimizer = keras.optimizers.Adam(1e-3),
        loss      = 'sparse_categorical_crossentropy',
        metrics   = ['accuracy'],
    )
    return model


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — MAIN
# ══════════════════════════════════════════════════════════════════════════════

def preview_check():
    """Save preview PNG of synthetic samples and exit (for visual QA)."""
    try:
        from PIL import ImageFont
    except ImportError:
        pass

    cols = 10
    rows = 6  # 2 rows per symbol class
    W    = cols * IMG + (cols + 1) * 2
    H    = rows * IMG + (rows + 1) * 2 + 20
    out_img = Image.new('L', (W, H), 64)

    generators = [
        ('apos', make_apostrophe, 0, 0),
        ('quot', make_double_quote, 2, 10),
        ('dash', make_dash, 4, 20),
    ]
    for _, gen_fn, row_start, _ in generators:
        for k in range(cols * 2):
            arr = augment(gen_fn())
            tile = Image.fromarray((arr * 255).astype('uint8'))
            r = row_start + k // cols
            c = k  % cols
            x = c * (IMG + 2) + 2
            y = r * (IMG + 2) + 2
            out_img.paste(tile, (x, y))

    out_img.save('synthetic_preview.png')
    print('Saved synthetic_preview.png  — inspect it before training!')
    sys.exit(0)


def main():
    if args.check:
        preview_check()   # PIL-only path — exits before TF is needed

    # ── Lazy TF import (skipped entirely when --check is used) ────────────────
    # Declare globals so load_mnist(), build_model() etc. can access them.
    global tf, keras, tfjs
    try:
        import tensorflow as tf
        from tensorflow import keras
    except ImportError:
        sys.exit('ERROR: pip install tensorflow')

    try:
        import tensorflowjs as tfjs
    except ImportError:
        sys.exit('ERROR: pip install tensorflowjs')

    print(f'TensorFlow {tf.__version__}  |  TF.js converter {tfjs.__version__}')
    print(f'Classes ({NC}): {CLASSES}')
    print(f'Symbol samples per class: {SYM_SAMPLES}  |  Epochs: {EPOCHS}')
    print()

    # ── Data ─────────────────────────────────────────────────────────────────
    X_tr, y_tr, X_va, y_va = build_dataset()

    # ── Model ─────────────────────────────────────────────────────────────────
    model = build_model()
    model.summary()
    total_params = model.count_params()
    print(f'\nTotal parameters: {total_params:,}')

    # ── Training ──────────────────────────────────────────────────────────────
    print(f'\n[3/4] Training for up to {EPOCHS} epochs …')

    callbacks = [
        keras.callbacks.EarlyStopping(
            monitor='val_accuracy', patience=8,
            restore_best_weights=True, verbose=1
        ),
        keras.callbacks.ReduceLROnPlateau(
            monitor='val_loss', factor=0.4, patience=3,
            min_lr=1e-5, verbose=1
        ),
    ]

    history = model.fit(
        X_tr, y_tr,
        validation_data = (X_va, y_va),
        epochs          = EPOCHS,
        batch_size      = BATCH,
        callbacks       = callbacks,
        verbose         = 1,
    )

    best_val_acc = max(history.history['val_accuracy'])
    print(f'\n✅ Best val accuracy: {best_val_acc:.2%}')

    # ── Per-class accuracy ────────────────────────────────────────────────────
    print('\nPer-class accuracy on validation set:')
    y_pred = np.argmax(model.predict(X_va, verbose=0), axis=1)
    for c in range(NC):
        mask = (y_va == c)
        if mask.sum() == 0:
            continue
        acc = (y_pred[mask] == c).mean()
        bar = '█' * int(acc * 20)
        print(f'  [{c:2d}] "{CLASSES[c]}" : {acc:.0%}  {bar}')

    # ── Export to TF.js ───────────────────────────────────────────────────────
    print(f'\n[4/4] Exporting TF.js model to {OUTPUT}/ …')
    os.makedirs(OUTPUT, exist_ok=True)

    tfjs.converters.save_keras_model(model, OUTPUT)

    # classes.json (read by measurementCNN.js)
    with open(os.path.join(OUTPUT, 'classes.json'), 'w') as f:
        json.dump({ 'classes': CLASSES, 'imageSize': IMG }, f, indent=2)

    # ── Report size ───────────────────────────────────────────────────────────
    total_kb = sum(
        os.path.getsize(os.path.join(OUTPUT, fn))
        for fn in os.listdir(OUTPUT)
    ) // 1024
    print(f'   Model size: {total_kb} KB  (target < 500 KB)')

    if total_kb > 500:
        print('   ⚠ Model exceeds 500 KB target.  Consider reducing dense layer.')

    print(f"""
╔══════════════════════════════════════════════════════════╗
║  Training complete                                       ║
║  Best val accuracy : {best_val_acc:.1%}                          ║
║  Output directory  : {OUTPUT:<36s}║
║  Model size        : {total_kb} KB                                ║
╠══════════════════════════════════════════════════════════╣
║  Next steps:                                             ║
║  1. The model is already in your project's public/       ║
║     folder — just run  npm run dev                       ║
║  2. measurementCNN.js auto-loads it from                 ║
║     /models/measurement-recognizer/model.json            ║
║  3. No internet required after loading                   ║
╚══════════════════════════════════════════════════════════╝
""")


if __name__ == '__main__':
    main()
