"""Synthesize the promo soundtrack (out/soundtrack.wav), cue-synced to video.html.

Pure synthesis (numpy + scipy), no samples, so the audio is royalty-free.
120 BPM, A minor. Cue times mirror the timeline in video.html.
"""
import os
import wave

import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
V7 = 26.0  # 0.7.0 chapter (统一接口 / 外部智能体 / 智能管家 / 应用工厂) inserted right after the logo (cue 9.5)
V7_AT = 9.5
SHIFT = False  # while True, place() moves cues at or after V7_AT later by V7 (the old timeline after the insert)
DUR = 78.5 + V7
OFF = 0.0  # set to INTRO after the intro block: every later cue is placed INTRO seconds later
INTRO = 2.0  # intro grew from 5s to 7s
SH = 22.5  # 资产纳管 / 资源投射 / 游乐场 / 共享市场 (36-64.5s) replace the old 36-42s scene; montage + finale shift by SH
D2 = 6.5   # 资产纳管 (36-42.5s) pushes 投射 / 游乐场 / 共享市场 back by D2
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(3)

L = np.zeros(N)
R = np.zeros(N)
send = np.zeros(N)  # reverb send (mono)


def hz(note):
    """MIDI note -> Hz."""
    return 440.0 * 2 ** ((note - 69) / 12)


def place(sig, t, gain=1.0, pan=0.0, rev=0.0):
    if SHIFT and t >= V7_AT:
        t += V7
    i = int((t + OFF) * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * gain * l * 1.414
    R[i:i + len(sig)] += sig * gain * r * 1.414
    send[i:i + len(sig)] += sig * gain * rev


def tt(d):
    return np.arange(int(d * SR)) / SR


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR * 0.45), 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)


def saw(f, t, detune=0.0):
    out = np.zeros_like(t)
    for d in (-detune, 0.0, detune) if detune else (0.0,):
        ph = (t * f * (1 + d) + rng.random()) % 1.0
        out += 2 * ph - 1
    return out / (3 if detune else 1)


# ------------------------------------------------------------------ instruments
def kick(level=1.0):
    t = tt(0.45)
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = hp(rng.standard_normal(len(t)), 2000) * np.exp(-t * 300) * 0.25
    return np.tanh((body + click) * 1.6) * level


def clap():
    t = tt(0.35)
    n = bp(rng.standard_normal(len(t)), 900, 4500)
    env = np.exp(-t * 18)
    for k in (0.0, 0.011, 0.022):
        env += np.where(t >= k, np.exp(-(t - k) * 120), 0) * 0.6
    return n * env * 0.45


def hat(open_=False):
    t = tt(0.25 if open_ else 0.06)
    n = hp(rng.standard_normal(len(t)), 7000)
    return n * np.exp(-t * (14 if open_ else 70)) * 0.22


def impact(d=3.0):
    t = tt(d)
    f = 30 + 90 * np.exp(-t * 6)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6)
    boom = lp(rng.standard_normal(len(t)), 400) * np.exp(-t * 3.5) * 0.8
    crack = hp(rng.standard_normal(len(t)), 1500) * np.exp(-t * 9) * 0.35
    return np.tanh((sub * 1.3 + boom + crack) * 1.4)


def riser(d, lo=300, hi=9000):
    t = tt(d)
    n = rng.standard_normal(len(t))
    out = np.zeros_like(t)
    seg = 2048
    for s in range(0, len(t), seg):  # sweep a band-pass upward
        k = s / len(t)
        c = lo * (hi / lo) ** k
        out[s:s + seg] = bp(n[s:s + seg + 0], c * 0.7, min(c * 1.4, SR * 0.45))[: len(out[s:s + seg])]
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (t / d * 2)) / SR) * 0.15
    return (out + tone) * (t / d) ** 2


def whoosh(d=0.9):
    t = tt(d)
    n = rng.standard_normal(len(t))
    env = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 2
    return bp(n, 400, 5000) * env * 0.5


def bell(note, d=2.5, bright=1.0):
    t = tt(d)
    f = hz(note)
    s = (np.sin(2 * np.pi * f * t) + 0.5 * bright * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 3)
         + 0.25 * bright * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 6))
    return s * np.exp(-t * 2.2) * np.minimum(1, t * 400) * 0.35


def blip(note, d=0.18):
    t = tt(d)
    return np.sin(2 * np.pi * hz(note) * t) * np.exp(-t * 28) * np.minimum(1, t * 800) * 0.3


def pad(notes, d, cutoff=1800):
    t = tt(d)
    s = sum(saw(hz(n), t, 0.004) for n in notes) / len(notes)
    s = lp(s, cutoff, 2)
    a = np.minimum(1, t / 0.4) * np.minimum(1, (d - t) / 0.6)
    return s * a


def bass(note, d):
    t = tt(d)
    s = saw(hz(note), t) * 0.6 + np.sin(2 * np.pi * hz(note) * t)
    pluck = np.exp(-t * 12)  # filter envelope: bright attack, dark tail
    s = lp(s, 1900) * pluck + lp(s, 500) * (1 - pluck)
    return s * np.minimum(1, t * 300) * np.exp(-t * 3) * np.minimum(1, (d - t) * 60)


# cinematic trailer variant (CINE=1): taiko instead of kick/clap, braams on every section
# hit, legato strings instead of the synth pad, 16th cello ostinato, longer reverb.
CINE = bool(os.environ.get('CINE'))


def taiko(level=1.0):
    t = tt(1.2)
    f = 55 + 60 * np.exp(-t * 18)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 4.5)
    skin = lp(rng.standard_normal(len(t)), 900) * np.exp(-t * 22) * 0.6
    return np.tanh((body * 1.4 + skin) * 1.5) * level


def braam(root=33, d=3.5):
    t = tt(d)
    s = sum(saw(hz(n), t, 0.006) for n in (root, root + 12, root + 19, root + 24)) / 4
    swell = np.minimum(1, t / 0.35)  # filter opens as it swells
    s = lp(s, 250) * (1 - swell * 0.7) + lp(s, 1600) * swell * 0.7
    env = np.minimum(1, t / 0.08) * np.exp(-t * 0.9)
    return np.tanh(s * env * 3.0) * 0.9


def strings(notes, d):
    t = tt(d)
    s = lp(sum(saw(hz(n), t, 0.005) for n in notes) / len(notes), 2200)
    return s * np.minimum(1, t / 0.7) * np.minimum(1, (d - t) / 0.8)


if CINE:
    kick = taiko
    clap = lambda: np.zeros(1)  # noqa: E731

# chords (A minor): Am, F, C, G
CHORDS = [[57, 60, 64, 71], [53, 57, 60, 67], [55, 60, 64, 67], [55, 59, 62, 69]]
ROOTS = [33, 29, 36, 31]

# ------------------------------------------------------------------ S1 intro (0 - 7): six pain points, then the answer
t = tt(7.0)
raw = saw(hz(33), t, 0.003) + saw(hz(45), t, 0.004) * 0.5
open_ = (t / 7) ** 2  # filter opens as tension builds
drone = (lp(raw, 180) * (1 - open_) + lp(raw, 900) * open_) * np.minimum(1, t / 0.8)
place(drone, 0, 0.35, rev=0.2)
for i in range(int(6.2 / 0.125)):  # clock ticks
    tk = 0.3 + i * 0.125
    place(hat(), tk, 0.5 + 0.5 * (i % 4 == 0), pan=0.3 * (-1) ** i)
for tp in (0.3, 1.0, 1.7, 2.4, 3.1, 3.8):  # one slam per pain point
    place(kick(0.9), tp, 0.8)
    place(impact(1.2) * 0.5, tp, 0.42, rev=0.35)
place(impact(2.0), 4.5, 0.75, rev=0.5)  # "你的 AI，该有个管家了"
place(pad([57, 64, 69, 72], 2.0, 1600), 4.5, 0.22, rev=0.6)
place(riser(1.9), 5.1, 0.55, rev=0.3)
place(whoosh(0.5)[::-1], 6.5, 0.8)
OFF = INTRO

# ------------------------------------------------------------------ S2 logo (5 - 9.5)
place(impact(3.5), 5.0, 1.0, rev=0.6)
place(pad([57, 64, 69, 71, 76], 4.7, 2400), 5.0, 0.28, rev=0.7)
for k, n in enumerate([81, 76, 84, 83, 88]):
    place(bell(n), 5.5 + k * 0.25, 0.55, pan=(-0.4 + 0.2 * k), rev=0.6)
place(bell(93, 3, 1.4), 6.9, 0.4, rev=0.8)  # coin shine
place(riser(1.3, 500, 7000), 8.2, 0.35)

# ------------------------------------------------------------------ groove (9.5 - 42)
g0, g1 = 9.5, 42.0 + SH + V7
nbeats = int((g1 - g0) / BEAT)
duck = np.ones(N)  # sidechain envelope for pad/bass
for b in range(nbeats):
    tb = g0 + b * BEAT
    if not CINE or b % 4 == 0:
        place(kick(), tb, 0.95)
    elif b % 4 == 2:
        place(kick(0.6), tb, 0.8)
    if CINE and b % 16 == 15:  # taiko fill into the next phrase
        for q in range(4):
            place(taiko(0.45), tb + q * 0.125, 0.6, pan=0.3 * (-1) ** q)
    i = int((tb + OFF) * SR)
    dt = np.arange(int(0.3 * SR)) / SR
    seg = 1 - (0.35 if CINE else 0.75) * np.exp(-dt * 14)
    duck[i:i + len(seg)] = np.minimum(duck[i:i + len(seg)], seg[: max(0, N - i)])
    if b % 2 == 1:
        place(clap(), tb, 0.9, rev=0.25)
    place(hat(), tb + 0.25, 0.35 if CINE else 0.8, pan=0.25)
    if b % 4 == 3:
        place(hat(True), tb + 0.25, 0.6, pan=-0.2)
music = np.zeros(N)
bar = 2.0
for k in range(int((g1 - g0) / bar)):
    tb = g0 + k * bar
    ci = k % 4
    seg = strings([n - 12 for n in CHORDS[ci]] + CHORDS[ci], bar + 0.6) if CINE else pad(CHORDS[ci], bar + 0.1, 1400 + 600 * (k % 2))
    i = int((tb + OFF) * SR)
    music[i:i + len(seg)] += seg[: N - i] * 0.30
    steps, step = (16, 0.125) if CINE else (8, 0.25)  # cello ostinato vs 8th-note synth bass
    for e in range(steps):
        bs = bass(ROOTS[ci] + (12 if e % 4 == 3 else 0), step * 0.96)
        j = int((tb + OFF + e * step) * SR)
        music[j:j + len(bs)] += bs * (0.24 if CINE else 0.33)
    # arpeggio on the upper chord tones
    for e in range(8):
        n = CHORDS[ci][[0, 1, 2, 3, 2, 1, 3, 2][e]] + 12
        place(bell(n, 0.6, 0.6), tb + e * 0.25, 0.10, pan=0.5 * np.sin(e), rev=0.5)
music *= duck
L += music
R += music
send += music * 0.25

# transitions
SHIFT = True
for tc in (16.0, 22.5, 30.0, 36.0, 42.5, 42.5 + D2, 49.0 + D2):
    place(whoosh(0.8), tc - 0.55, 0.7, rev=0.3)
    place(impact(1.5) * 0.4, tc, 0.4, rev=0.3)
if CINE:  # braams on every section hit
    for tb in (4.5 - OFF, 5.0, 9.5, 16.0, 22.5, 30.0, 36.0, 42.5, 42.5 + D2, 49.0 + D2):
        place(braam(33), tb, 0.5, rev=0.5)
# S3 toggles: ascending pentatonic blips
for k, n in enumerate([81, 84, 86, 88, 91, 93]):
    place(blip(n, 0.25), 11.0 + k * 0.5, 0.9, pan=(-0.5 if k < 3 else 0.5), rev=0.4)
# S4 trace rows: soft ticks
for k in range(22):
    place(blip(96 + (k % 3) * 2, 0.06), 17.0 + k * 0.32, 0.35, pan=0.6)
# S5 routing zaps
for t0 in (23.2, 25.0, 26.8):
    place(whoosh(0.5), t0, 0.35, pan=-0.4)
    place(blip(88, 0.3), t0 + 0.55, 0.7, rev=0.4)
    place(whoosh(0.5), t0 + 0.75, 0.35, pan=0.4)
    place(bell(93, 1.2), t0 + 1.3, 0.35, pan=0.5, rev=0.5)
# S6 "added" dings
for k in range(3):
    place(bell(88 + k * 3, 1.0), 33.6 + k * 0.3, 0.4, pan=0.5, rev=0.5)
# SA 资产纳管: scattered files glitch, then snap into the library
for k in range(14):
    place(blip(60 + (k * 7) % 13, 0.08) * 0.8, 36.2 + k * 0.06, 0.5, pan=np.sin(k * 1.7) * 0.7)
for k in range(10):
    place(hp(rng.standard_normal(int(0.05 * SR)), 3000) * 0.3, 36.9 + k * 0.13, 0.4, pan=np.cos(k) * 0.6)  # glitch
place(riser(0.9, 400, 6000), 37.4, 0.4)
place(whoosh(0.7), 38.2, 0.7, rev=0.3)
place(impact(1.2) * 0.5, 38.9, 0.5, rev=0.4)
for k in range(8):
    place(blip([81, 84, 86, 88, 91, 93, 96, 98][k], 0.15), 39.2 + k * 0.07, 0.45, pan=-0.5 + k * 0.14, rev=0.3)
place(bell(88, 1.2), 41.0, 0.35, rev=0.5)
# SP 资源投射: beams converge, gate pulse, targets receive, one is skipped
place(whoosh(0.7), 37.7 + D2, 0.45, pan=-0.4, rev=0.3)
place(bell(81, 1.5, 1.2), 38.45 + D2, 0.5, rev=0.6)
for k in range(4):
    place(blip([84, 88, 91, 96][k], 0.3), 38.6 + D2 + k * 0.18 + 0.6, 0.8, pan=0.5, rev=0.4)
place(blip(52, 0.35) * 1.5, 38.6 + D2 + 4 * 0.18 + 0.6, 0.7, pan=0.5)  # skipped target
# SG 游乐场: typing, dispatches, completions
for k in range(20):
    place(hat() * 0.8, 43.4 + D2 + k * 0.05, 0.5, pan=-0.3)
for k, td in enumerate((45.0 + D2, 45.5 + D2, 46.0 + D2)):
    place(whoosh(0.4), td, 0.4, pan=0.4)
    place(blip(79 + k * 5, 0.25), td, 0.6, pan=0.3, rev=0.3)
    place(bell(88 + k * 2, 1.0), td + 1.6, 0.4, pan=0.4, rev=0.5)
for k, n in enumerate([81, 85, 88]):
    place(bell(n, 1.6), 48.0 + D2 + k * 0.06, 0.35, rev=0.6)
# SM 共享市场: task goes out, runs in the lender's vault, result comes back, credits land
for t0 in (50.4 + D2, 52.7 + D2):
    place(blip(84, 0.2), t0, 0.5, pan=0.5, rev=0.3)
    place(whoosh(0.6), t0 + 0.3, 0.45, pan=0.3)            # task -> lender
    place(pad([69, 76, 81], 0.9, 2600), t0 + 0.9, 0.12, pan=-0.5, rev=0.6)  # vault shimmer
    place(whoosh(0.6), t0 + 1.5, 0.45, pan=-0.3)           # result -> renter
    place(bell(91, 1.2), t0 + 2.1, 0.4, pan=0.5, rev=0.5)
    for k in range(5):                                     # coins
        place(bell(100 + (k % 3), 0.35, 1.5), t0 + 2.1 + k * 0.08, 0.15, pan=-0.5, rev=0.4)
place(riser(1.6), 56.4 + D2, 0.6, rev=0.3)

# V7 0.7.0 chapter (cue 9.5 - 35.5), not shifted
SHIFT = False
v0 = V7_AT
for k in range(4):
    tc = v0 + k * 6.5
    place(whoosh(0.8), tc - 0.55, 0.7, rev=0.3)
    place(impact(1.5) * 0.45, tc, 0.45, rev=0.3)
    if CINE:
        place(braam(33), tc, 0.5, rev=0.5)
for k in range(18):  # 09 typing the request
    place(hat() * 0.8, v0 + 1.0 + k * 0.07, 0.45, pan=-0.4)
place(whoosh(0.5), v0 + 3.2, 0.45, pan=0.3)
place(blip(88, 0.3), v0 + 3.6, 0.7, pan=0.4, rev=0.4)
place(bell(93, 1.2), v0 + 4.6, 0.4, pan=0.5, rev=0.5)
b0 = v0 + 6.5  # 10 pairing, allow, pick-up, push
place(blip(81, 0.2), b0 + 1.2, 0.5, pan=-0.4, rev=0.3)
place(bell(88, 1.0), b0 + 2.4, 0.45, pan=-0.4, rev=0.5)
place(whoosh(0.6), b0 + 3.4, 0.45, pan=0.4)
place(blip(91, 0.25), b0 + 4.2, 0.6, pan=0.4, rev=0.3)
place(bell(96, 1.2), b0 + 5.3, 0.4, pan=0.5, rev=0.5)
c0 = v0 + 13.0  # 11 butler steps
place(blip(52, 0.35) * 1.4, c0 + 1.0, 0.6, pan=-0.4)
for k in range(3):
    place(blip([84, 88, 91][k], 0.25), c0 + 2.4 + k * 0.8, 0.65, pan=0.4, rev=0.4)
for k, n in enumerate([81, 85, 88]):
    place(bell(n, 1.6), c0 + 5.0 + k * 0.06, 0.35, rev=0.6)
d0 = v0 + 19.5  # 12 six layers stack up
for k in range(6):
    place(blip([69, 72, 76, 81, 84, 88][k], 0.2), d0 + 0.8 + k * 0.35, 0.6, pan=-0.5 + k * 0.2, rev=0.4)
place(impact(2.0) * 0.6, d0 + 3.2, 0.55, rev=0.5)
place(riser(1.6), v0 + 24.4, 0.6, rev=0.3)
SHIFT = True

# ------------------------------------------------------------------ S8 montage (42 - 47)
for k in range(5):
    tb = 42.0 + SH + k
    if CINE:
        place(braam([33, 29, 36, 31, 33][k], 1.4), tb, 0.55, rev=0.5)
    place(impact(1.4), tb, 0.75, rev=0.5)
    place(pad(CHORDS[[0, 1, 2, 3, 0][k]], 0.95, 3200), tb, 0.35, rev=0.5)
    place(kick(), tb + 0.5, 0.8)
    place(clap(), tb + 0.5, 0.6, rev=0.3)
place(riser(0.9, 600, 10000), 46.1 + SH, 0.6)

# ------------------------------------------------------------------ S9 finale (47 - 54)
place(impact(4.0), 47.0 + SH, 1.0, rev=0.7)
if CINE:
    place(braam(33, 6.0), 47.0 + SH, 0.7, rev=0.7)
place(pad([45, 57, 64, 69, 71, 76], 6.8, 2200), 47.0 + SH, 0.34, rev=0.8)
for k, n in enumerate([81, 88, 84, 93]):
    place(bell(n, 3.0), 47.2 + SH + k * 0.3, 0.5, pan=(-0.3 + 0.2 * k), rev=0.7)
place(bell(96, 3.5, 1.4), 48.6 + SH, 0.35, rev=0.8)

# ------------------------------------------------------------------ reverb + master
ir_t = tt(3.8 if CINE else 2.6)
ir = rng.standard_normal((2, len(ir_t))) * np.exp(-ir_t * (1.6 if CINE else 2.4))
ir = np.array([lp(ch, 5000) for ch in ir])
ir /= np.abs(ir).sum(axis=1, keepdims=True) ** 0.5 * 30
wetL = fftconvolve(send, ir[0])[:N]
wetR = fftconvolve(send, ir[1])[:N]
mixL = hp(L + wetL, 25)
mixR = hp(R + wetR, 25)
fade = np.ones(N)
fs, fe = int((52.2 + SH + V7 + OFF) * SR), N
fade[fs:fe] = np.linspace(1, 0, fe - fs) ** 2
mix = np.stack([mixL, mixR]) * fade
mix /= np.abs(mix).max()
mix = np.tanh(mix * 1.5) / np.tanh(1.5) * 0.66  # ~ -14 LUFS for web platforms

os.makedirs(os.path.join(os.path.dirname(__file__), 'out'), exist_ok=True)
path = os.path.join(os.path.dirname(__file__), 'out', 'soundtrack-cine.wav' if CINE else 'soundtrack.wav')
with wave.open(path, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print('wrote', path)
