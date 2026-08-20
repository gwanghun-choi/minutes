"""FFmpeg normalization: any input -> 16 kHz mono wav, which is what both
faster-whisper and pyannote want."""
import shutil
import subprocess
from pathlib import Path


def ffmpeg_bin() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg  # bundled static build, used when the OS has no ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def to_wav16k(src: Path) -> Path:
    dst = src.with_suffix(".16k.wav")
    if dst.exists():
        return dst
    subprocess.run(
        [ffmpeg_bin(), "-nostdin", "-y", "-i", str(src),
         "-ac", "1", "-ar", "16000", "-vn", "-f", "wav", str(dst)],
        check=True, capture_output=True,
    )
    return dst


def duration_seconds(path: Path) -> float:
    out = subprocess.run(
        [ffmpeg_bin(), "-nostdin", "-i", str(path), "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    # ffmpeg prints "time=HH:MM:SS.xx" on the final progress line
    last = [ln for ln in out.splitlines() if "time=" in ln]
    if not last:
        return 0.0
    stamp = last[-1].split("time=")[1].split(" ")[0]
    try:
        h, m, s = stamp.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except ValueError:
        return 0.0
