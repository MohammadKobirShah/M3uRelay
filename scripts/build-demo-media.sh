#!/usr/bin/env bash
# Regenerate the tiny test-pattern HLS assets used by `npm run demo`.
#
#   ./scripts/build-demo-media.sh [ffmpeg-binary]
#
# Produces 16s / 8-segment loops at 360p, 720p and 1080p plus silent AAC
# segments shared by the Bangla/Hindi audio renditions (~1-2 MB in total).
# The production relay never touches these files or ffmpeg.
set -euo pipefail

FFMPEG="${1:-${FFMPEG:-ffmpeg}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/demo/media"
FONT="${DEMO_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! "$FFMPEG" -hide_banner -version >/dev/null 2>&1; then
  echo "ffmpeg not found: pass the binary path as the first argument" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/360p" "$OUT/720p" "$OUT/1080p" "$OUT/audio"

echo "==> source frame (1080p, 16s)"
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x0b1512:s=1920x1080:r=12:d=16" \
  -vf "drawbox=x=0:y=0:w=iw:h=10:color=0x16c98d@1:t=fill,\
drawbox=x=0:y=ih-10:w=iw:h=10:color=0x0a8f6a@0.8:t=fill,\
drawbox=x=120:y=300:w=12:h=420:color=0x16c98d@1:t=fill,\
drawbox=x='mod(t*220\,iw-520)':y=880:w=520:h=8:color=0x16c98d@0.85:t=fill,\
drawtext=fontfile='${FONT}':text='MY IPTV PRO':x=180:y=286:fontsize=132:fontcolor=0xe9f2ef,\
drawtext=fontfile='${FONT}':text='BANGLA AUDIO FIRST':x=184:y=452:fontsize=54:fontcolor=0x8da79f,\
drawtext=fontfile='${FONT}':text='720p start \\: 1080p max':x=184:y=524:fontsize=54:fontcolor=0x8da79f,\
drawtext=fontfile='${FONT}':text='DEMO LOOP %{pts\\:hms}':x=184:y=640:fontsize=64:fontcolor=0x16c98d,\
drawtext=fontfile='${FONT}':text='1080p':x=w-tw-120:y=h-200:fontsize=72:fontcolor=0x16c98d,\
drawtext=fontfile='${FONT}':text='DEMO':x=w-tw-120:y=140:fontsize=72:fontcolor=0x16c98d" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -g 24 -keyint_min 24 -sc_threshold 0 \
  "$TMP/source.mp4"

encode () {
  local height="$1" crf="$2"
  local dir="$OUT/${height}p"
  echo "==> HLS ${height}p"
  # Silent audio is muxed into every variant as well: the alternate audio
  # renditions stay the primary path, but a player that ignores EXT-X-MEDIA
  # still gets a complete stream.
  "$FFMPEG" -hide_banner -loglevel error -y -i "$TMP/source.mp4" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo" -shortest \
    -vf "scale=-2:${height}:flags=bicubic,drawtext=fontfile='${FONT}':text='${height}p':x=w-tw-40:y=h-80:fontsize=40:fontcolor=0x16c98d" \
    -c:v libx264 -preset veryfast -tune stillimage -crf "$crf" -pix_fmt yuv420p \
    -c:a aac -b:a 32k -ac 2 \
    -g 24 -keyint_min 24 -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*2)" \
    -f hls -hls_time 2 -hls_list_size 0 -hls_playlist_type vod \
    -hls_segment_filename "$dir/seg%d.ts" "$dir/index.m3u8"
}

encode 1080 30
encode 720 31
encode 360 33

# Audio renditions ship as audio-only MPEG-TS so every HLS.js build can mux them.
# Two-stage: encode once, then cut exact 2s segments with the segment muxer.
echo "==> silent audio segments (audio-only TS)"
"$FFMPEG" -hide_banner -loglevel error -y \
  -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 16 -c:a aac -b:a 48k -f mpegts "$TMP/audio.ts"
"$FFMPEG" -hide_banner -loglevel error -y -i "$TMP/audio.ts" -c copy \
  -f segment -segment_time 2 -segment_format mpegts -reset_timestamps 1 \
  "$OUT/audio/seg%d.ts"

# The mock origin generates rolling live playlists, so the static ones can go.
rm -f "$OUT"/*/index.m3u8

# Drop a sub-100ms tail segment so the demo loop stays perfectly periodic.
find "$OUT/audio" -name 'seg*.ts' -size -1024c -delete

SEGMENTS=$(find "$OUT/720p" -name 'seg*.ts' | wc -l | tr -d ' ')
AUDIO_SEGMENTS=$(find "$OUT/audio" -name 'seg*.ts' | wc -l | tr -d ' ')
cat > "$OUT/manifest.json" <<JSON
{
  "generatedBy": "scripts/build-demo-media.sh",
  "segmentDuration": 2,
  "segments": ${SEGMENTS},
  "audioSegments": ${AUDIO_SEGMENTS},
  "qualities": ["360p", "720p", "1080p"],
  "note": "Synthetic test pattern for the offline demo only."
}
JSON

echo "==> done"
du -sh "$OUT"
find "$OUT" -type f | sort | sed "s|$ROOT/||"
