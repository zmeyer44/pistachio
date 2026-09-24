"use client";

import { useRef, useState } from "react";

/**
 * Poster image with a play affordance that swaps to an inline video on click,
 * mirroring how the source defers its Mux players until interaction.
 */
export function VideoCard({
  poster,
  src,
  label,
  className = "",
}: {
  poster: string;
  src: string;
  label: string;
  className?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        preload="none"
        playsInline
        controls={playing}
        className="size-full object-cover"
      />
      {!playing && (
        <button
          type="button"
          aria-label={`Play ${label}`}
          onClick={() => {
            setPlaying(true);
            void ref.current?.play();
          }}
          className="absolute inset-0 flex items-end justify-start p-4"
        >
          <span className="flex size-14 items-center justify-center rounded-full bg-black/35 backdrop-blur-[2px] transition-colors hover:bg-black/50">
            <svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">
              <path d="M0 0v22l18-11L0 0Z" fill="#fff" />
            </svg>
          </span>
        </button>
      )}
    </div>
  );
}
