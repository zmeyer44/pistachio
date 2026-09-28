"""Pistachio launch — original music bed, synthesized deterministically.

120 BPM (beat 0.5s, bar 2s), D major. Sections follow STORYBOARD.md frame starts:
  0-6   hook      pad + pluck motif, swell into the drop
  6-12  intro     drop: kick, sub, full pad, bright arps
  12-28 demo      calmer groove: kick, offbeat hats, soft arps
  28-32 control   three chord stabs (28, 29, 30), air
  32-42 moves     full energy: kick, clap, 16th hats, sub, arps
  42-46 trust     filtered pad, hits on 42/43/44, riser + roll into 46
  46-54 outro     impact, ringing Dmaj9, slow motif, fade
Run: python3 make_bgm.py out.wav
"""
import sys, wave
import numpy as np

SR = 44100
DUR = 54.0
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(7)  # deterministic

def t_of(n):
    return np.arange(n) / SR

def midi(m):
    return 440.0 * 2 ** ((m - 69) / 12)

def at(buf, start, sig, gain=1.0):
    i = int(round(start * SR))
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain

def fft_filter(x, lo=None, hi=None, order=2):
    """Smooth zero-phase band filter in the frequency domain."""
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    H = np.ones_like(f)
    if hi:
        H *= 1 / np.sqrt(1 + (f / hi) ** (2 * order))
    if lo:
        with np.errstate(divide="ignore"):
            H *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-3)) ** (2 * order))
    return np.fft.irfft(X * H, n)

def env_adsr(n, a, d, s, r, sus_len=None):
    total = n
    e = np.zeros(total)
    A, D, R = int(a * SR), int(d * SR), int(r * SR)
    S = total - A - D - R if sus_len is None else int(sus_len * SR)
    S = max(S, 0)
    idx = 0
    if A: e[idx:idx + A] = np.linspace(0, 1, A); idx += A
    if D: e[idx:idx + D] = np.linspace(1, s, D); idx += D
    e[idx:idx + S] = s; idx += S
    rem = total - idx
    if rem > 0: e[idx:] = np.linspace(s, 0, rem)
    return e

# ---------------------------------------------------------------- harmony
CHORDS = {
    "D":  [50, 57, 61, 64, 66],   # Dmaj9
    "Bm": [47, 54, 57, 62, 64],   # Bm11-ish
    "G":  [43, 50, 54, 57, 59],   # Gmaj9-ish
    "A":  [45, 52, 57, 59, 64],   # Asus2
}
PROG = ["D", "Bm", "G", "A"]
def chord_at(bar):
    return PROG[bar % 4]

# ---------------------------------------------------------------- voices
def pad_note(freq, dur, bright=8):
    n = int(dur * SR)
    t = t_of(n)
    sig = np.zeros(n)
    for det in (-0.0045, 0.0045):
        f = freq * (1 + det)
        for h in range(1, bright + 1):
            sig += np.sin(2 * np.pi * f * h * t + h * 0.37) / h
    return sig * 0.08

def pluck(freq, dur=0.6, bright=1.0):
    n = int(dur * SR)
    t = t_of(n)
    e = np.exp(-t * 7.5)
    sig = (np.sin(2 * np.pi * freq * t)
           + 0.45 * bright * np.sin(2 * np.pi * 2 * freq * t) * np.exp(-t * 10)
           + 0.18 * bright * np.sin(2 * np.pi * 3 * freq * t) * np.exp(-t * 16))
    att = np.minimum(1, t / 0.003)
    return sig * e * att * 0.22

def kick(gain=1.0):
    n = int(0.45 * SR)
    t = t_of(n)
    f = 45 + 95 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    sig = np.sin(ph) * np.exp(-t * 7.0)
    click = fft_filter(rng.standard_normal(n), hi=3500) * np.exp(-t * 300) * 0.3
    return (sig + click) * 0.9 * gain

KICK_ENV_LEN = int(0.4 * SR)
def duck_curve(kick_times, depth=0.55):
    d = np.ones(N)
    t = t_of(KICK_ENV_LEN)
    shape = 1 - depth * np.exp(-t * 9)
    for kt in kick_times:
        i = int(kt * SR)
        j = min(N, i + KICK_ENV_LEN)
        d[i:j] = np.minimum(d[i:j], shape[: j - i])
    return d

HAT_NOISE = fft_filter(rng.standard_normal(int(0.12 * SR)), lo=7000)
def hat(open_=False):
    n = len(HAT_NOISE)
    t = t_of(n)
    return HAT_NOISE * np.exp(-t * (18 if open_ else 55)) * 0.16

CLAP_NOISE = fft_filter(rng.standard_normal(int(0.3 * SR)), lo=900, hi=5000)
def clap():
    n = len(CLAP_NOISE)
    t = t_of(n)
    e = np.exp(-t * 18)
    # three quick flams
    for off in (0.0, 0.011, 0.022):
        k = int(off * SR)
        e[k:k + 40] += 0.6
    return CLAP_NOISE * e * 0.28

def sub(freq, dur):
    n = int(dur * SR)
    t = t_of(n)
    e = env_adsr(n, 0.01, 0.05, 0.8, 0.08)
    return np.sin(2 * np.pi * freq * t) * e * 0.34

# ---------------------------------------------------------------- buses
pad = np.zeros(N)
plk = np.zeros(N)
drm = np.zeros(N)
bas = np.zeros(N)
fx = np.zeros(N)

# ---- pad: one chord per bar, crossfaded, level per section
def pad_level(t):
    if t < 6: return 0.55
    if t < 12: return 1.0
    if t < 28: return 0.7
    if t < 32: return 0.8
    if t < 42: return 0.9
    if t < 46: return 0.75
    return 1.1
for bar in range(0, 23):
    start = bar * 2.0
    ch = CHORDS[chord_at(bar)]
    lvl = pad_level(start)
    for m in ch:
        note = pad_note(midi(m), 2.6, bright=6 if start < 42 or start >= 46 else 3)
        note *= env_adsr(len(note), 0.35, 0.3, 0.85, 0.6)
        at(pad, start, note, lvl)
# outro ring: Dmaj9 long
for m in CHORDS["D"] + [69, 73]:
    note = pad_note(midi(m), 8.0, bright=7)
    note *= env_adsr(len(note), 0.02, 1.2, 0.6, 5.5)
    at(pad, 46.0, note, 1.0)

# ---- plucks: 8th-note arpeggio over chord tones (+ octave)
ARP = [0, 2, 1, 3, 2, 4, 3, 1]
def arp_section(t0, t1, octave=12, gain=1.0, step=0.25, bright=1.0):
    t = t0
    k = 0
    while t < t1 - 1e-6:
        bar = int(t // 2.0)
        ch = CHORDS[chord_at(bar)]
        tones = sorted(ch)[1:] + [sorted(ch)[1] + 12]
        m = tones[ARP[k % len(ARP)] % len(tones)] + octave
        g = gain * (1.0 if k % 2 == 0 else 0.72)
        at(plk, t, pluck(midi(m), 0.7, bright), g)
        t += step
        k += 1

# hook motif: sparse, rising — lands on key-press beats 0,1,2 then questions at 3.5/4.5
motif = [(0.0, 74), (0.5, 73), (1.0, 71), (1.5, 69), (2.0, 74), (2.5, 76), (3.0, 78), (3.5, 69), (4.0, 71), (4.5, 73), (5.0, 76), (5.5, 78)]
for tt, m in motif:
    at(plk, tt, pluck(midi(m), 0.9, 0.8), 0.9)
arp_section(6.0, 12.0, octave=12, gain=0.9, bright=1.2)
arp_section(12.0, 28.0, octave=12, gain=0.5, step=0.5, bright=0.7)
arp_section(32.0, 42.0, octave=12, gain=0.85, bright=1.3)
# outro motif, slower, resolving
for tt, m in [(47.0, 78), (47.5, 76), (48.0, 73), (49.0, 74), (50.5, 81), (51.0, 78)]:
    at(plk, tt, pluck(midi(m), 1.4, 0.8), 0.8)

# ---- control stabs at 28, 29, 30 (chord plucks, stacked)
for st, name in [(28.0, "D"), (29.0, "Bm"), (30.0, "G")]:
    for m in CHORDS[name]:
        at(plk, st, pluck(midi(m + 12), 1.0, 1.1), 0.55)

# ---- drums
kicks = []
def kicks_every(t0, t1, step=0.5):
    t = t0
    while t < t1 - 1e-6:
        kicks.append(round(t, 3)); t += step
kicks_every(6.0, 12.0)
kicks_every(12.0, 28.0)
kicks += [28.0, 29.0, 30.0]
kicks_every(32.0, 42.0)
kicks += [42.0, 43.0, 44.0]
for kt in kicks:
    g = 0.75 if 12 <= kt < 28 else 1.0
    at(drm, kt, kick(g))
# big impacts
at(drm, 6.0, kick(1.25)); at(drm, 46.0, kick(1.4))

# hats
def hats(t0, t1, step, off=0.0, gain=1.0):
    t = t0 + off
    while t < t1 - 1e-6:
        at(drm, t, hat(open_=(step == 0.5)), gain); t += step
hats(6.0, 12.0, 0.5, off=0.25, gain=0.8)
hats(12.0, 28.0, 0.5, off=0.25, gain=0.55)
hats(32.0, 42.0, 0.125, gain=0.5)
hats(32.0, 42.0, 0.5, off=0.25, gain=0.6)
# claps on 2 & 4
t = 32.5
while t < 42.0:
    at(drm, t, clap()); t += 1.0
t = 8.5
while t < 12.0:
    at(drm, t, clap(), 0.7); t += 1.0
# snare roll into 46
roll_t = 45.0
k = 0
while roll_t < 46.0 - 1e-6:
    at(drm, roll_t, clap(), 0.25 + 0.5 * k / 8); roll_t += 0.125; k += 1

# ---- sub bass on offbeat 8ths (pumping) in high-energy sections
def bass_section(t0, t1, gain=1.0):
    t = t0
    while t < t1 - 1e-6:
        bar = int(t // 2.0)
        root = sorted(CHORDS[chord_at(bar)])[0]
        while root > 45: root -= 12
        at(bas, t + 0.25, sub(midi(root), 0.22), gain)
        t += 0.5
bass_section(6.0, 12.0)
bass_section(12.0, 28.0, 0.6)
bass_section(32.0, 42.0)
sb = sub(midi(38), 5.0) * np.exp(-t_of(int(5.0 * SR)) * 0.9)
at(bas, 46.0, sb, 1.2)

# ---- fx: swells/risers (filtered noise with rising brightness)
def riser(dur, lo_start=300, hi_end=9000):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    segs = 16
    for s in range(segs):
        a, b = s * n // segs, (s + 1) * n // segs
        hi = lo_start * (hi_end / lo_start) ** (s / (segs - 1))
        seg = fft_filter(noise[a:b], lo=150, hi=hi)
        out[a:b] = seg
    e = np.linspace(0, 1, n) ** 2.2
    return out * e * 0.22
at(fx, 4.5, riser(1.5, 400, 7000), 0.8)
at(fx, 44.0, riser(2.0, 300, 10000), 1.0)
at(fx, 30.5, riser(1.5, 500, 6000), 0.4)

# ---------------------------------------------------------------- mix
duck = duck_curve(kicks + [6.0, 46.0])
pad_f = fft_filter(pad, hi=4200, order=1)
# trust section: darker pad (crossfade to heavily filtered copy)
dark = fft_filter(pad, hi=700, order=2)
w = np.zeros(N)
a, b = int(41.6 * SR), int(42.2 * SR)
w[a:b] = np.linspace(0, 1, b - a); w[b:int(45.8 * SR)] = 1
c = int(45.8 * SR); d = int(46.0 * SR)
w[c:d] = np.linspace(1, 0, d - c)
pad_mix = pad_f * (1 - w) + dark * w
# hook: pad starts filtered and opens toward the drop
open_w = np.clip((t_of(N) - 0.0) / 6.0, 0, 1)
hook_mask = t_of(N) < 6.0
hook_dark = fft_filter(pad, hi=900, order=2)
pad_mix = np.where(hook_mask, hook_dark * (1 - open_w) + pad_f * open_w, pad_mix)

plk_f = fft_filter(plk, lo=180, hi=9000, order=1)

def reverb_ir(sec=2.4, seed=11):
    r = np.random.default_rng(seed)
    n = int(sec * SR)
    t = t_of(n)
    ir = r.standard_normal(n) * np.exp(-t * 3.0)
    ir = fft_filter(ir, lo=250, hi=6000)
    ir[: int(0.012 * SR)] = 0
    return ir / np.sqrt(np.sum(ir ** 2))

def convolve(x, ir):
    n = len(x) + len(ir) - 1
    nfft = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(ir, nfft), nfft)[: len(x)]
    return y

irL, irR = reverb_ir(seed=11), reverb_ir(seed=12)
send = pad_mix * 0.35 + plk_f * 0.6 + fx * 0.4
revL, revR = convolve(send, irL) * 0.35, convolve(send, irR) * 0.35

dry = pad_mix * duck * 0.9 + plk_f * 0.95 + drm * 1.0 + bas * duck ** 0.5 + fx
# slight stereo: plucks alternate pan by position in time (deterministic)
pan = 0.5 + 0.18 * np.sin(2 * np.pi * t_of(N) / 4.0)
L = dry - plk_f * 0.95 * (pan - 0.5) + revL
R = dry + plk_f * 0.95 * (pan - 0.5) + revR

# global fade in/out
fade = np.ones(N)
fi = int(0.05 * SR); fade[:fi] = np.linspace(0, 1, fi)
fo0, fo1 = int(51.5 * SR), int(54.0 * SR)
fade[fo0:fo1] = np.linspace(1, 0, fo1 - fo0) ** 1.5
L *= fade; R *= fade

stereo = np.stack([L, R], axis=1)
stereo = np.tanh(stereo * 1.4) / np.tanh(1.4)
stereo /= np.max(np.abs(stereo)) / 0.89

out = sys.argv[1] if len(sys.argv) > 1 else "bgm.wav"
pcm = (stereo * 32767).astype(np.int16)
with wave.open(out, "wb") as wf:
    wf.setnchannels(2); wf.setsampwidth(2); wf.setframerate(SR)
    wf.writeframes(pcm.tobytes())
print("wrote", out, f"{DUR}s")
