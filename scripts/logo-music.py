# Synthesises the music beds for the logo animation on /logos, from nothing but numpy.
# Needs numpy and ffmpeg. Run from the repository root; it rewrites apps/web/public/audio/logo-music:
#   python3 scripts/logo-music.py            all four beds
#   python3 scripts/logo-music.py glow haze  only these (the others then differ slightly from a full run)
# Every bed has two parts, so it stays in step with the picture whatever the length of the voice:
#   <id>-a  starts when Play is pressed: blue sky at 0 s, warm fog 0.9-2.8 s, logo at 2.8 s,
#           letters 3.25-3.6 s, voice from 4.3 s (the bed drops under it).
#   <id>-b  starts when the face begins erasing the word: erase 0-1 s, address at 1.2 s, wink at 2.05 s.
import os, re, subprocess, sys, tempfile
import numpy as np

SR = 44100
TAU = 2 * np.pi
rng = np.random.default_rng(7)
A_LEN, B_LEN = 9.0, 6.0

def n_of(seconds): return int(round(seconds * SR))
def hz(midi): return 440.0 * 2 ** ((midi - 69) / 12)

def curve(seconds, points, smooth=0.08):
    """Automation through (time, value) points, with the corners rounded off."""
    t = np.arange(n_of(seconds)) / SR
    xs, ys = zip(*points)
    y = np.interp(t, xs, ys)
    k = max(1, n_of(smooth))
    if k > 1:
        kernel = np.hanning(k + 2)[1:-1]
        kernel /= kernel.sum()
        y = np.convolve(np.pad(y, (k // 2, k - k // 2 - 1), mode="edge"), kernel, mode="valid")
    return y

class Bus:
    def __init__(self, seconds): self.x = np.zeros((n_of(seconds), 2))
    def add(self, sig, at=0.0, pan=0.0, gain=1.0):
        i = n_of(at)
        n = min(len(sig), len(self.x) - i)
        if n <= 0: return
        if sig.ndim == 1:
            angle = (pan + 1) * np.pi / 4
            self.x[i:i + n, 0] += sig[:n] * np.cos(angle) * gain
            self.x[i:i + n, 1] += sig[:n] * np.sin(angle) * gain
        else:
            self.x[i:i + n] += sig[:n] * gain

def over(seconds, value):
    return np.broadcast_to(np.asarray(value, float), (n_of(seconds),))

def pad(midi, seconds, cutoff, amp, detune=(-9, 0, 8), slope=2.0):
    """Warm pad: detuned saw-like voices through a low-pass whose cutoff (Hz) can move over time."""
    n = n_of(seconds); t = np.arange(n) / SR
    cutoff, amp = over(seconds, cutoff), over(seconds, amp)
    out = np.zeros((n, 2))
    top = min(float(cutoff.max()) * 4, SR * 0.45)
    for cents, pan in zip(detune, np.linspace(-0.75, 0.75, len(detune))):
        f = hz(midi) * 2 ** (cents / 1200)
        drift = 1 + 0.0012 * np.sin(TAU * rng.uniform(0.08, 0.3) * t + rng.uniform(0, TAU))
        phase = TAU * np.cumsum(f * drift) / SR
        ratio = (f / cutoff) ** (2 * slope)
        voice = np.zeros(n)
        h = 1
        while h * f < top and h <= 64:
            voice += np.sin(h * phase + rng.uniform(0, TAU)) / (h * np.sqrt(1 + ratio * h ** (2 * slope)))
            h += 1
        angle = (pan + 1) * np.pi / 4
        out[:, 0] += voice * np.cos(angle); out[:, 1] += voice * np.sin(angle)
    return out * amp[:, None] / len(detune)

VOWELS = {"oo": ((350, 180, 1.0), (750, 200, 0.3), (2400, 300, 0.04)), "ah": ((750, 220, 1.0), (1150, 220, 0.55), (2800, 350, 0.15))}
def vox(midi, seconds, openness, amp, detune=(-11, -3, 4, 10)):
    """Choir-like pad: harmonics weighted by vowel formants, moving from 'oo' (0) to 'ah' (1)."""
    n = n_of(seconds); t = np.arange(n) / SR
    openness, amp = over(seconds, openness), over(seconds, amp)
    out = np.zeros((n, 2))
    for cents, pan in zip(detune, np.linspace(-0.8, 0.8, len(detune))):
        f = hz(midi) * 2 ** (cents / 1200)
        vibrato = 1 + 0.004 * np.minimum(1, t / 1.5) * np.sin(TAU * rng.uniform(4.6, 5.4) * t + rng.uniform(0, TAU))
        phase = TAU * np.cumsum(f * vibrato) / SR
        dark = np.zeros(n); bright = np.zeros(n)
        h = 1
        while h * f < 5200:
            partial = np.sin(h * phase + rng.uniform(0, TAU))
            weight = lambda vowel: sum(g * np.exp(-0.5 * ((h * f - fc) / bw) ** 2) for fc, bw, g in VOWELS[vowel]) + 0.5 / h ** 2
            dark += weight("oo") * partial; bright += weight("ah") * partial
            h += 1
        voice = dark * (1 - openness) + bright * openness
        angle = (pan + 1) * np.pi / 4
        out[:, 0] += voice * np.cos(angle); out[:, 1] += voice * np.sin(angle)
    return out * amp[:, None] / len(detune)

def tone(midi, seconds, amp):
    """A plain sine, for the low end."""
    t = np.arange(n_of(seconds)) / SR
    return np.sin(TAU * hz(midi) * t) * over(seconds, amp)

SOFT = ((1, 1.0, 1.0), (2, 0.18, 0.6), (3, 0.05, 0.4))
GLASS = ((1, 1.0, 1.0), (2.76, 0.45, 0.65), (5.4, 0.22, 0.4), (8.93, 0.1, 0.25))
def bell(midi, seconds=3.2, partials=SOFT, decay=1.4, attack=0.004):
    t = np.arange(n_of(seconds)) / SR
    f = hz(midi)
    out = sum(a * np.sin(TAU * f * r * t + rng.uniform(0, TAU)) * np.exp(-t / (decay * d)) for r, a, d in partials if f * r < 17000)
    return out * (1 - np.exp(-t / attack))

def kalimba(midi, vel=1.0, seconds=2.4):
    t = np.arange(n_of(seconds)) / SR
    f = hz(midi)
    out = np.sin(TAU * f * t) * np.exp(-t / 0.55) + 0.28 * np.sin(TAU * 2 * f * t) * np.exp(-t / 0.22)
    if 5.43 * f < 16000: out += 0.2 * vel * np.sin(TAU * 5.43 * f * t + 1.0) * np.exp(-t / 0.06)
    thumb = np.convolve(rng.standard_normal(len(t)), np.ones(8) / 8, mode="same") * np.exp(-t / 0.008)
    return vel * (out + 0.35 * vel * thumb) * (1 - np.exp(-t / 0.0015))

def epiano(midi, vel, at, wobble, seconds=5.0):
    """Electric piano: one sine bending another, with a short bright tine at the start. `wobble` is the tape's pitch drift."""
    t = np.arange(n_of(seconds)) / SR
    f = hz(midi)
    phase = TAU * np.cumsum(f * wobble(at + t)) / SR
    index = 1.5 * vel * np.exp(-t / 0.45) + 0.22
    out = np.sin(phase + index * np.sin(phase)) * np.exp(-t / 1.9)
    tine = 14 if 14 * f < 15000 else 7
    out += 0.1 * vel * np.sin(tine * phase) * np.exp(-t / 0.07)
    out *= vel * (1 - np.exp(-t / 0.003))
    sway = 0.18 * np.sin(TAU * 4.3 * (at + t))
    return np.stack([out * (1 - sway), out * (1 + sway)], axis=1) * 0.7

def air(seconds, centre, amp, width=0.9):
    """Wind-like noise whose brightness follows `centre` (Hz over time)."""
    n = n_of(seconds)
    centre, amp = over(seconds, centre), over(seconds, amp)
    freqs = np.maximum(np.fft.rfftfreq(n, 1 / SR), 1)
    out = np.zeros((n, 2))
    for ch in (0, 1):
        spectrum = np.fft.rfft(rng.standard_normal(n))
        for fc in np.geomspace(200, 9000, 12):
            band = np.fft.irfft(spectrum * np.exp(-0.5 * (np.log2(freqs / fc) / 0.22) ** 2), n)
            out[:, ch] += band * np.exp(-0.5 * (np.log2(fc / centre) / width) ** 2)
    return out * amp[:, None] / np.sqrt(np.mean(out ** 2))

def fftconv(a, b):
    n = len(a) + len(b) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(a, size) * np.fft.rfft(b, size), size)[:n]

def reverb(x, rt60, wet, damp=4500, predelay=0.02):
    """A wide hall made of decaying noise: both sides hear the middle of the mix through their own room."""
    m = n_of(rt60 * 1.3)
    t = np.arange(m) / SR
    f = np.fft.rfftfreq(m, 1 / SR)
    mid = x.mean(axis=1)
    d = n_of(predelay)
    out = x.copy()
    for ch in (0, 1):
        ir = np.fft.irfft(np.fft.rfft(rng.standard_normal(m) * np.exp(-6.91 * t / rt60)) / np.sqrt(1 + (f / damp) ** 2) * (f / (f + 180)), m)
        ir /= np.sqrt(np.sum(ir ** 2))
        out[d:, ch] += wet * fftconv(mid, ir)[:len(x) - d]
    return out

def tilt(x, lowcut=30, highcut=None):
    f = np.fft.rfftfreq(len(x), 1 / SR)
    shape = f ** 2 / (f ** 2 + lowcut ** 2)
    if highcut: shape = shape / (1 + (f / highcut) ** 4)
    return np.stack([np.fft.irfft(np.fft.rfft(x[:, ch]) * shape, len(x)) for ch in (0, 1)], axis=1)

def a_level(duck):
    """Full while the art arrives, down under the voice, out before the second part takes over."""
    return curve(A_LEN, [(0, 0), (0.03, 1), (3.9, 1), (4.6, duck), (7.3, duck), (A_LEN - 0.05, 0)], 0.3)
B_LEVEL = curve(B_LEN, [(0, 1), (3.0, 1), (B_LEN - 0.05, 0)], 0.3)

# ---------------------------------------------------------------- Glow: a warm pad that opens like light. D major.
def glow_a():
    L = A_LEN; bus = Bus(L)
    swell = curve(L, [(0, 0), (0.5, 0.05), (0.9, 0.16), (3.0, 1.0)], 0.3)
    cut = curve(L, [(0, 240), (0.9, 360), (3.2, 2700), (4.0, 2300), (4.7, 800), (L, 650)], 0.25)
    colour = curve(L, [(0, 1), (3.8, 1), (4.7, 0)], 0.25)          # the upper notes leave before the voice
    for m in (50, 57): bus.add(pad(m, L, cut, swell * 0.9))          # D3 A3 stay as the bed
    for m, g in ((64, 0.7), (66, 0.6), (69, 0.5)): bus.add(pad(m, L, cut, swell * colour * g))  # E4 F#4 A4
    bus.add(tone(38, L, swell * 0.5))
    for at, m, g, pan in ((2.80, 81, 0.22, -0.3), (2.89, 86, 0.2, 0.3), (3.02, 90, 0.11, 0.0)): bus.add(bell(m) * g, at, pan)  # eyes, smile
    return reverb(bus.x, 3.0, 0.35) * a_level(0.38)[:, None]

def glow_b():
    L = B_LEN; bus = Bus(L)
    four = curve(L, [(0, 0), (0.3, 0.45), (0.9, 1.0), (1.15, 0.9), (1.7, 0)], 0.2)
    one = curve(L, [(0, 0), (1.0, 0), (1.5, 1.0), (2.6, 1.0), (L, 0.55)], 0.25)
    cut = curve(L, [(0, 650), (0.9, 2300), (1.3, 2000), (2.1, 3300), (L, 900)], 0.2)
    for m, g in ((55, 0.9), (59, 0.8), (62, 0.7), (66, 0.6), (69, 0.5)): bus.add(pad(m, L, cut, four * g))             # G maj9
    for m, g in ((50, 0.9), (57, 0.85), (62, 0.7), (66, 0.6), (69, 0.55), (76, 0.3)): bus.add(pad(m, L, cut, one * g))  # D add9
    bus.add(tone(38, L, curve(L, [(0, 0), (0.5, 0.5), (L, 0.4)], 0.3)))
    for at, m, g, pan in ((1.20, 74, 0.16, 0.0), (2.05, 81, 0.26, -0.3), (2.20, 86, 0.24, 0.3), (2.36, 90, 0.1, 0.0)): bus.add(bell(m) * g, at, pan)
    return reverb(bus.x, 3.0, 0.35) * B_LEVEL[:, None]

# ---------------------------------------------------------------- Kalimba: soft plucks that follow the picture. F major pentatonic.
def plucks(bus, notes):
    for i, (at, m, vel) in enumerate(notes):
        bus.add(kalimba(m, vel), at + rng.uniform(-0.006, 0.006), pan=0.35 * (-1) ** i)

def kalimba_a():
    L = A_LEN; bus = Bus(L)
    bed = curve(L, [(0, 0), (0.9, 0.25), (3.0, 1.0)], 0.3)
    cut = curve(L, [(0, 300), (3.0, 1400), (4.6, 700), (L, 600)], 0.25)
    for m, g in ((53, 0.5), (60, 0.5)): bus.add(pad(m, L, cut, bed * g))
    bus.add(pad(69, L, cut, bed * curve(L, [(0, 0.3), (3.8, 0.3), (4.7, 0)], 0.25)))
    bus.add(tone(41, L, bed * 0.35))
    notes = [(0.95, 65, 0.55), (1.30, 69, 0.6), (1.62, 72, 0.65), (1.92, 74, 0.7), (2.20, 77, 0.75), (2.46, 79, 0.8),   # up with the fog
             (2.80, 81, 0.9), (2.89, 84, 0.85), (3.02, 77, 0.5), (3.02, 81, 0.5)]                                      # two eyes, the smile
    notes += [(3.25 + 0.055 * i, m, 0.45 + 0.05 * i) for i, m in enumerate((72, 74, 77, 79, 81, 84, 86))]             # one note per letter
    notes += [(3.82, 89, 0.45)]
    plucks(bus, notes)
    return reverb(bus.x, 2.2, 0.28) * a_level(0.5)[:, None]

def kalimba_b():
    L = B_LEN; bus = Bus(L)
    four = curve(L, [(0, 0), (0.3, 0.5), (0.9, 1.0), (1.2, 0.8), (1.7, 0)], 0.2)
    one = curve(L, [(0, 0), (1.0, 0), (1.5, 1.0), (2.6, 1.0), (L, 0.5)], 0.25)
    cut = curve(L, [(0, 600), (1.0, 1500), (2.2, 1800), (L, 700)], 0.2)
    for m in (58, 62, 65): bus.add(pad(m, L, cut, four * 0.5))                       # Bb
    for m, g in ((53, 0.55), (60, 0.5), (69, 0.35)): bus.add(pad(m, L, cut, one * g))  # F
    bus.add(tone(46, L, four * 0.35)); bus.add(tone(41, L, one * 0.4))
    notes = [(0.10 + 0.115 * i, m, 0.8 - 0.05 * i) for i, m in enumerate((86, 84, 81, 79, 77, 74, 72))]  # the letters go, one by one
    notes += [(1.20, 65, 0.5), (1.20, 72, 0.5), (2.05, 81, 0.8), (2.19, 89, 0.9)]                          # address, then the wink
    plucks(bus, notes)
    return reverb(bus.x, 2.2, 0.28) * B_LEVEL[:, None]

# ---------------------------------------------------------------- Haze: lo-fi electric piano on wobbly tape. A major.
def tape(t): return 1 + 0.0032 * np.sin(TAU * 0.6 * t) + 0.0011 * np.sin(TAU * 6.1 * t + 1)
def haze(L, notes, lows, level):
    bus = Bus(L)
    for at, m, vel in notes: bus.add(epiano(m, vel, at, tape), at)
    for m, env in lows: bus.add(tone(m, L, env))
    hiss = air(L, 5000, 1.0, width=1.4) * 0.006
    x = tilt(reverb(bus.x, 1.8, 0.22) + hiss, 35, 4200)
    return np.tanh(1.4 * x) / 1.4 * level[:, None]

def haze_a():
    L = A_LEN
    notes = [(0.90, 50, 0.62), (0.99, 57, 0.62), (1.08, 61, 0.66), (1.17, 64, 0.7), (1.26, 66, 0.74),    # D maj9, rolled, as the fog starts
             (1.95, 73, 0.45), (2.32, 69, 0.4),
             (2.78, 45, 0.7), (2.86, 52, 0.62), (2.94, 56, 0.62), (3.02, 59, 0.66), (3.10, 61, 0.7), (3.18, 64, 0.72),  # A maj9 with the logo
             (3.62, 76, 0.5)]
    lows = [(38, curve(L, [(0.9, 0), (1.3, 0.4), (2.6, 0.4), (2.9, 0)], 0.15)), (33, curve(L, [(2.7, 0), (3.1, 0.38), (4.4, 0.3), (L, 0.12)], 0.2))]
    return haze(L, notes, lows, a_level(0.42))

def haze_b():
    L = B_LEN
    notes = [(0.00, 50, 0.6), (0.07, 54, 0.6), (0.14, 57, 0.62), (0.21, 61, 0.66), (0.28, 64, 0.7), (0.62, 66, 0.5), (0.86, 69, 0.5),  # D maj9, rising with the erase
             (1.20, 45, 0.7), (1.26, 52, 0.62), (1.32, 56, 0.62), (1.38, 61, 0.68), (1.44, 71, 0.6),                                   # home to A maj9
             (2.05, 85, 0.55), (2.20, 88, 0.6)]                                                                                         # the wink
    lows = [(38, curve(L, [(0, 0), (0.3, 0.4), (1.0, 0.4), (1.3, 0)], 0.15)), (33, curve(L, [(1.1, 0), (1.5, 0.38), (L, 0.2)], 0.2))]
    return haze(L, notes, lows, B_LEVEL)

# ---------------------------------------------------------------- Rise: air and voices, with a glass chime. C major.
def rise_a():
    L = A_LEN; bus = Bus(L)
    swell = curve(L, [(0, 0), (0.9, 0.15), (3.0, 1.0)], 0.3)
    opening = curve(L, [(0, 0), (0.9, 0.1), (3.2, 0.9), (4.0, 0.7), (4.7, 0.15)], 0.25)
    colour = curve(L, [(0, 1), (3.8, 1), (4.7, 0)], 0.25)
    for m in (48, 55): bus.add(vox(m, L, opening, swell * 0.9))                                         # C3 G3 stay as the bed
    for m, g in ((62, 0.6), (64, 0.6), (67, 0.5)): bus.add(vox(m, L, opening, swell * colour * g))      # D4 E4 G4
    bus.add(tone(36, L, swell * 0.45))
    bus.add(air(L, curve(L, [(0, 280), (0.9, 420), (3.0, 2600), (4.2, 1500), (L, 900)], 0.2),
                curve(L, [(0, 0), (0.9, 0.25), (2.6, 1.0), (3.4, 0.6), (4.4, 0.12), (L, 0.06)], 0.25)) * 0.16)
    for at, m, g, pan in ((2.80, 72, 0.2, -0.25), (2.89, 79, 0.18, 0.25)): bus.add(bell(m, attack=0.12, decay=1.8) * g, at, pan)
    return reverb(bus.x, 3.2, 0.4) * a_level(0.4)[:, None]

def rise_b():
    L = B_LEN; bus = Bus(L)
    four = curve(L, [(0, 0), (0.3, 0.45), (0.9, 1.0), (1.2, 0.8), (1.7, 0)], 0.2)
    one = curve(L, [(0, 0), (1.0, 0), (1.5, 1.0), (2.6, 1.0), (L, 0.5)], 0.25)
    opening = curve(L, [(0, 0.2), (0.9, 0.6), (2.1, 0.85), (L, 0.2)], 0.25)
    for m, g in ((53, 0.9), (60, 0.7), (67, 0.55), (69, 0.5)): bus.add(vox(m, L, opening, four * g))               # F add9
    for m, g in ((48, 0.9), (55, 0.85), (64, 0.6), (67, 0.55), (72, 0.4)): bus.add(vox(m, L, opening, one * g))    # C
    bus.add(tone(36, L, curve(L, [(0, 0), (0.5, 0.45), (L, 0.35)], 0.3)))
    bus.add(air(L, curve(L, [(0, 500), (0.95, 3800), (1.4, 2500), (L, 1200)], 0.15),
                curve(L, [(0, 0), (0.85, 1.0), (1.15, 0.35), (2.0, 0.1), (L, 0)], 0.15)) * 0.2)                       # a breath as the word goes
    for at, m, g, pan in ((2.05, 91, 0.3, -0.3), (2.20, 96, 0.24, 0.3)): bus.add(bell(m, partials=GLASS, decay=1.6) * g, at, pan)
    return reverb(bus.x, 3.2, 0.4) * B_LEVEL[:, None]

BEDS = {"glow": (glow_a, glow_b), "kalimba": (kalimba_a, kalimba_b), "haze": (haze_a, haze_b), "rise": (rise_a, rise_b)}
TARGET = {"a": -19.0, "b": -19.5}   # loudest moment, in LUFS. The voice sits at -16.

def loudness(path, raw=True):
    source = ["-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", path] if raw else ["-i", path]
    log = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", *source, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
    return [(float(t), float(m)) for t, m in re.findall(r"t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+)\s+S:", log)]

if __name__ == "__main__":
    out = "apps/web/public/audio/logo-music"
    os.makedirs(out, exist_ok=True)
    scratch = tempfile.mkdtemp()
    for name in sys.argv[1:] or BEDS:
        for part, build in zip("ab", BEDS[name]):
            x = tilt(build())
            x[:n_of(0.004)] *= np.linspace(0, 1, n_of(0.004))[:, None]
            raw = os.path.join(scratch, f"{name}-{part}.f32")
            x.astype("<f4").tofile(raw)
            gain = TARGET[part] - max(m for _, m in loudness(raw))
            peak = 20 * np.log10(np.abs(x).max()) + gain
            dest = os.path.join(out, f"{name}-{part}.mp3")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", raw, "-af", f"volume={gain:.2f}dB", "-c:a", "libmp3lame", "-b:a", "128k", dest], check=True)
            marks = dict((round(t, 1), m) for t, m in loudness(dest, raw=False))
            times = (0.5, 1.0, 2.0, 3.0, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5) if part == "a" else (0.5, 1.0, 1.5, 2.2, 2.6, 3.5, 4.5, 5.5)
            print(f"{name}-{part}: peak {peak:5.1f} dBFS, {os.path.getsize(dest) // 1024} KB | LUFS at " + "  ".join(f"{t}s {marks.get(t, float('nan')):.0f}" for t in times), flush=True)
