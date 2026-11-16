"""効果音のwavを、ゲームが読めるJS(assets/sfx.data.js、window.SFX_DATA)に変える (2026-11-16)。
index.htmlはfile://でダブルクリックでも動く決まり(fetchでローカルのファイルを読めない)なので、音はbase64でJSに埋め込む。
小さくするため、モノラル・24000Hz・16bitにする。

  python tools/sfx_to_js.py            … assets/sounds-raw/*.wav を全部 assets/sfx.data.js に
名前はファイル名(拡張子なし、例: dice-roll)。
"""
import base64, glob, io, os, wave
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'assets', 'sounds-raw')
OUT = os.path.join(ROOT, 'assets', 'sfx.data.js')
TARGET_RATE = 24000


def convert(path):
    with wave.open(path, 'rb') as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width == 2:
        data = np.frombuffer(raw, dtype='<i2').astype(np.float32)
    elif width == 3:  # 24bit: 3バイトずつを符号付き整数にして16bitの大きさにそろえる
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        data = (v / 256.0).astype(np.float32)
    else:
        raise ValueError(f'unsupported sample width {width}')
    data = data.reshape(-1, ch).mean(axis=1)
    if rate != TARGET_RATE:
        t_old = np.arange(len(data)) / rate
        t_new = np.arange(int(len(data) * TARGET_RATE / rate)) / TARGET_RATE
        data = np.interp(t_new, t_old, data)
    # 短いフェードで端のプチッという音を防ぐ
    fade = int(TARGET_RATE * 0.005)
    if len(data) > 2 * fade:
        data[:fade] *= np.linspace(0, 1, fade)
        data[-fade:] *= np.linspace(1, 0, fade)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(np.clip(data, -32768, 32767).astype('<i2').tobytes())
    return base64.b64encode(buf.getvalue()).decode('ascii')


def main():
    entries = {}
    for path in sorted(glob.glob(os.path.join(SRC, '*.wav'))):
        name = os.path.splitext(os.path.basename(path))[0]
        entries[name] = convert(path)
        print(f'{name}: {len(entries[name]) // 1024}KB')
    lines = ['/* 効果音 (tools/sfx_to_js.py が assets/sounds-raw/*.wav から作る。手で書きかえない) */', 'window.SFX_DATA = {']
    for name, b64 in entries.items():
        lines.append(f"  '{name}': 'data:audio/wav;base64,{b64}',")
    lines.append('};')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print('Wrote', OUT)


if __name__ == '__main__':
    main()
