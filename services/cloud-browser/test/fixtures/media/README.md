# Generated media fixtures

These ten-second fixtures contain FFmpeg's generated test pattern and a 440 Hz
tone; no third-party recordings are included. H.264 baseline and AAC cover
native decoding and separate MediaSource audio/video tracks.

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 10 -c:v libx264 -preset ultrafast -profile:v baseline -level 3.0 -g 24 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart av.mp4
ffmpeg -i av.mp4 -an -c:v copy -movflags frag_keyframe+empty_moov+default_base_moof video-fragmented.mp4
ffmpeg -i av.mp4 -vn -c:a copy -movflags frag_keyframe+empty_moov+default_base_moof audio-fragmented.mp4
```

The real-stack `web-media.spec.ts` verifies nonzero decoded PCM audio,
authenticated range delivery, fenced controls, resizing, reattachment and
media capability invalidation. The fixture server is accessible to the worker;
the mirrored page only receives worker capabilities or local MediaSource URLs.
