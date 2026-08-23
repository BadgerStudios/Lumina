#!/bin/bash
# Builds a seamless purple-graded nebula loop from real public-domain NASA/ESA/STScI imagery
# (see nebula-sources.txt). Slow Ken Burns over each nebula, cross-dissolved.
#
# SEAMLESS LOOP: Orion's camera move is SPLIT in half. The video opens on the second half of that
# move and closes on the first half. The final frame therefore matches the opening frame exactly
# — same image, same zoom — so the wrap is an invisible cut with no crossfade needed at the seam.
#
# ---------------------------------------------------------------------------------------------
# WHY THE MOVE IS THIS FAST, AND WHY THE LOOP IS THIS SHORT
#
# The first version of this loop ran 7 segments of 46s (~5 minutes) with a very slow push. It
# juddered on every machine, and the reason was not bitrate — it was geometry:
#
#   46s segment, zoom 1.00->1.12, pan 150px  =>  0.154 px/frame of real camera motion
#
# H.264's finest motion vector is a QUARTER of a pixel; VP9's is an eighth. At 0.154 px/frame the
# true motion is below the grid the codec can express, so every block is rounded to either 0 (hold
# still) or 0.25 (jump). The encoder therefore holds a block for several frames and then snaps it.
# Measured on the shipped file: 85% of frames were near-static and the frame-to-frame difference
# had a coefficient of variation of 0.99 — on a move that is, by construction, constant velocity.
# Raising CRF cannot fix this. Nothing below quarter-pel is representable at any bitrate.
#
# So the move has to be fast enough to land ABOVE quarter-pel. Shorter segments plus a much longer
# pan put it at ~0.96 px/frame — roughly 4x the codec's floor, where motion vectors describe real
# motion again. The shorter total loop is a second win: the same byte budget spread over 66s
# instead of 298s is ~4.5x the bitrate per second of video.
#
# If you lengthen D or shorten the pans, RE-CHECK the arithmetic above. Anything under ~0.5
# px/frame will start to judder again no matter how many bits you throw at it.
# ---------------------------------------------------------------------------------------------
set -e
FPS=25; D=11; X=1.8; FR=$((D*FPS))

# zoompan renders at 3840x2160 and is then downscaled to 1080p: zoompan truncates its crop origin
# to whole pixels, and halving that step on the way down is what keeps the push from stair-stepping.
# zoompan's pan expression always BEGINS at offset zero, which is why this takes explicit start
# offsets: the loop's closing Orion segment has to END exactly where the opening one BEGINS, and
# without a start offset it cannot. Getting that wrong puts a jump at the wrap — measured at 9.5x
# a normal frame step on a build that lacked it, i.e. a visible lurch once per loop. Note the pan
# divides by FR-1, not FR, so the last frame lands ON the end value rather than one step short.
ken() { # src  zfrom  zto  panx  pany  out  [startx starty]   (pan is in 3840-wide render space)
  local sx=${7:-0} sy=${8:-0}
  ffmpeg -v error -y -loop 1 -i "$1.jpg" -filter_complex \
    "[0:v]crop=iw:iw*9/16:0:(ih-iw*9/16)/2,scale=3840:2160:flags=lanczos,\
zoompan=z='$2+($3-$2)*on/($FR-1)':x='iw/2-(iw/zoom/2)+($sx)+($4)*(on/($FR-1))':y='ih/2-(ih/zoom/2)+($sy)+($5)*(on/($FR-1))':d=$FR:s=3840x2160:fps=$FPS,\
scale=1920:1080:flags=lanczos,format=yuv420p[v]" \
    -map "[v]" -t $D -c:v libx264 -crf 16 -preset veryfast "$6"
  echo "  seg $6"
}
echo "== Ken Burns segments =="
ken orion     1.12 1.22  -420  -180  s0.mp4  -420 -180   # Orion, 2nd half — opens the loop
                                                     # (starts exactly where s6 ends: zoom 1.12,
                                                     #  pan -420/-180. That is the seamless wrap.)
ken fireworks 1.00 1.10   440   200  s1.mp4
ken lagoon    1.05 1.15  -400   230  s2.mp4
ken tarantula 1.00 1.10   430  -210  s3.mp4
ken helix     1.08 1.18   410  -190  s4.mp4
ken cygnus    1.00 1.10  -450   200  s5.mp4
ken orion     1.02 1.12  -420  -180  s6.mp4        # Orion, 1st half — ends where s0 begins

echo "== crossfade chain + purple grade =="
# Duotone: luma mapped from --void #0a0714 to a saturated ion violet #b794ff, with G held below R
# and B so the result can never drift to grey. hue=s=0.12 keeps a trace of the original chroma so
# the gas structure still reads as gas.
GRADE="hue=s=0.12,eq=contrast=1.16:brightness=-0.03,lutrgb=r='clip((10+val*0.678)*0.62,0,255)':g='clip((7+val*0.553)*0.62,0,255)':b='clip((20+val*0.922)*0.62,0,255)'"
O1=$(python3 -c "print($D-$X)"); O2=$(python3 -c "print(2*($D-$X))"); O3=$(python3 -c "print(3*($D-$X))")
O4=$(python3 -c "print(4*($D-$X))"); O5=$(python3 -c "print(5*($D-$X))"); O6=$(python3 -c "print(6*($D-$X))")
ffmpeg -v error -y -i s0.mp4 -i s1.mp4 -i s2.mp4 -i s3.mp4 -i s4.mp4 -i s5.mp4 -i s6.mp4 -filter_complex \
"[0][1]xfade=transition=fade:duration=$X:offset=$O1[a];\
[a][2]xfade=transition=fade:duration=$X:offset=$O2[b];\
[b][3]xfade=transition=fade:duration=$X:offset=$O3[c];\
[c][4]xfade=transition=fade:duration=$X:offset=$O4[d];\
[d][5]xfade=transition=fade:duration=$X:offset=$O5[e];\
[e][6]xfade=transition=fade:duration=$X:offset=$O6[f];\
[f]$GRADE,format=yuv420p[v]" -map "[v]" -c:v libx264 -crf 14 -preset medium master.mp4
echo "  master: $(ffprobe -v error -show_entries format=duration -of csv=p=0 master.mp4)s  $(du -h master.mp4|cut -f1)"

echo "== delivery encodes =="
# A 66s loop gets ~4.5x the bits per second of video that the old 298s one did at the same file
# size, which is what buys back the detail the aggressive CRF used to eat.
ffmpeg -v error -y -i master.mp4 -an -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -cpu-used 3 -g 250 -pix_fmt yuv420p nebula-1080.webm &
ffmpeg -v error -y -i master.mp4 -an -c:v libx264 -crf 25 -preset slow -g 250 -pix_fmt yuv420p -movflags +faststart nebula-1080.mp4 &
ffmpeg -v error -y -i master.mp4 -an -vf scale=1280:720 -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -cpu-used 3 -g 250 -pix_fmt yuv420p nebula-720.webm &
ffmpeg -v error -y -i master.mp4 -an -vf scale=1280:720 -c:v libx264 -crf 26 -preset slow -g 250 -pix_fmt yuv420p -movflags +faststart nebula-720.mp4 &
wait
ffmpeg -v error -y -i master.mp4 -frames:v 1 -q:v 6 -vf scale=1920:1080 nebula-poster.jpg
echo "== done =="
ls -la nebula-*.webm nebula-*.mp4 nebula-poster.jpg
