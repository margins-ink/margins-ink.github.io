#!/bin/bash
# usage: encode.sh in.wav outbase  -> outbase.opus (40k) outbase.m4a (64k AAC), two-pass loudnorm -16 LUFS / -1.5 dBTP
set -e
in=$1; out=$2
j=$(ffmpeg -nostats -i "$in" -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
g(){ echo "$j" | grep "\"$1\"" | sed 's/.*: "\(.*\)".*/\1/'; }
F="loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$(g input_i):measured_TP=$(g input_tp):measured_LRA=$(g input_lra):measured_thresh=$(g input_thresh):offset=$(g target_offset):linear=true"
ffmpeg -loglevel error -y -i "$in" -af "$F,aresample=48000" -ac 1 -c:a libopus -b:a 40k -application audio "$out.opus"
ffmpeg -loglevel error -y -i "$in" -af "$F,aresample=48000" -ac 1 -c:a aac -b:a 64k -movflags +faststart "$out.m4a"
