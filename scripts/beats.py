"""事先算好每首歌的節拍位置(給節奏遊戲用)。實驗性功能,目前只處理曲庫裡的歌。

  python scripts/beats.py                  只處理還沒有節拍檔的歌
  python scripts/beats.py --force          全部重算
  python scripts/beats.py music-a5c1db6d   只處理指定曲目

分析的是「轉檔後、實際上傳到 R2 的那份音訊」(hls-output/<id>/index.m3u8),不是原始檔,
這樣節拍時間才會跟播放器播出來的時間軸一致。結果存到 public/beats/<id>.json,跟網站一起部署。

輸出欄位:
  bpm       估計速度
  beats     每一拍的時間(秒,從這首歌的開頭算起)
  strength  每一拍的力度 0~1(重拍、鼓點明顯的拍比較大)
  quality   這份節拍圖可不可靠:拍點上的音量起伏,比「兩拍中間」高多少倍(大於 1.3 才算有抓到節拍)
"""
import json
import subprocess
import sys
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
import numpy as np
import librosa

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "beats"
SR = 22050
HOP = 256  # 約 11.6 毫秒一格,節拍時間的精度


def decode(track_id: str, wav: Path) -> None:
    playlist = ROOT / "hls-output" / track_id / "index.m3u8"
    if not playlist.exists():
        sys.exit(f"找不到 {playlist}(請先 npm run convert)")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-allowed_extensions", "ALL", "-i", str(playlist), "-ac", "1", "-ar", str(SR), str(wav)],
        check=True,
    )


def analyse(track_id: str) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "a.wav"
        decode(track_id, wav)
        y, _ = librosa.load(wav, sr=SR, mono=True)
    duration = len(y) / SR

    # 鼓點偏向低頻與瞬間起伏:用打擊成分算「起伏強度」,比整段混音準
    y_perc = librosa.effects.percussive(y, margin=3.0)
    env = librosa.onset.onset_strength(y=y_perc, sr=SR, hop_length=HOP, aggregate=np.median)

    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, tightness=120)
    tempo = float(np.atleast_1d(tempo)[0])
    # 速度折成 60~120 BPM(這類放鬆音樂的鼓常常是兩倍速,折回來每秒才不會太多拍,遊戲才點得到)
    raw = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    raw_bpm = 60.0 / np.median(np.diff(raw)) if len(raw) > 4 else tempo
    while raw_bpm > 120 and len(raw) > 4:
        raw = raw[::2]
        raw_bpm /= 2
    while raw_bpm < 60 and len(raw) > 1:
        raw = np.sort(np.concatenate([raw, (raw[:-1] + raw[1:]) / 2]))
        raw_bpm *= 2

    # 把每一拍貼到附近最明顯的起伏上(±40 毫秒),讓拍點對準真正的鼓點
    times = librosa.frames_to_time(np.arange(len(env)), sr=SR, hop_length=HOP)
    snapped = []
    for b in raw:
        near = np.where(np.abs(times - b) <= 0.04)[0]
        snapped.append(float(times[near[np.argmax(env[near])]]) if len(near) else float(b))
    beats = np.array(snapped)
    beats = beats[(beats > 0.2) & (beats < duration - 0.5)]

    def at(ts):
        idx = np.clip(np.round(ts / (HOP / SR)).astype(int), 0, len(env) - 1)
        return env[idx]

    on = at(beats)
    mid = at((beats[:-1] + beats[1:]) / 2)
    quality = float(np.mean(on) / max(np.mean(mid), 1e-6))
    strength = on / max(float(np.percentile(on, 95)), 1e-6)
    strength = np.clip(strength, 0, 1)
    bpm = 60.0 / float(np.median(np.diff(beats))) if len(beats) > 4 else raw_bpm
    return {
        "id": track_id,
        "duration": round(duration, 3),
        "bpm": round(bpm, 1),
        "quality": round(quality, 2),
        "beats": [round(float(b), 3) for b in beats],
        "strength": [round(float(s), 2) for s in strength],
    }


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    tracks = json.loads((ROOT / "playlist.json").read_text(encoding="utf-8"))["tracks"]
    ids = args or [t["id"] for t in tracks]
    OUT.mkdir(parents=True, exist_ok=True)
    for tid in ids:
        dest = OUT / f"{tid}.json"
        if dest.exists() and not force and not args:
            print(f"{tid}: 已有節拍檔,略過(--force 可重算)")
            continue
        info = analyse(tid)
        dest.write_text(json.dumps(info, separators=(",", ":")), encoding="utf-8")
        gaps = np.diff(info["beats"])
        print(f"{tid}: {len(info['beats'])} 拍  {info['bpm']} BPM  可靠度 {info['quality']}  拍距誤差 ±{np.std(gaps) * 1000:.0f} 毫秒")


if __name__ == "__main__":
    main()
