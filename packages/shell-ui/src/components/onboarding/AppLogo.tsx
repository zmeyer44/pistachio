import { useState } from "react";
import { favoriteApp } from "@pistachio/shell-contracts/onboarding";
import { cn } from "../../lib/cn";

/**
 * The brand marks the favorites step draws. The ones with simple geometry
 * are inline SVG, so they are crisp at any size and need no network; the
 * rest load the site's own icon, with the app's initial as the fallback
 * when that cannot be fetched (offline, blocked). Colours here are the
 * logos' own, not the theme's.
 */
export function AppLogo({ id, className }: { id: string; className?: string }) {
  const drawn = DRAWN[id];
  if (drawn !== undefined) {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={cn("block size-8", className)}
      >
        {drawn}
      </svg>
    );
  }
  return <FetchedLogo id={id} className={className} />;
}

function FetchedLogo({ id, className }: { id: string; className?: string }) {
  const app = favoriteApp(id);
  const [failed, setFailed] = useState(false);
  const host = app === null ? "" : new URL(app.url).host;
  if (app === null || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 place-items-center rounded-[9px] bg-alpha-200 text-[15px] font-semibold text-gray-900",
          className,
        )}
      >
        {(app?.name ?? "?").charAt(0)}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("block size-8 rounded-[9px]", className)}
    />
  );
}

/* Brand geometry, each in a 24×24 box. */

const GOOGLE = {
  blue: "#4285F4",
  red: "#EA4335",
  yellow: "#FBBC04",
  green: "#34A853",
};

const DRAWN: Record<string, React.ReactNode> = {
  x: (
    <path
      fill="currentColor"
      className="text-gray-1000"
      d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
    />
  ),
  youtube: (
    <>
      <rect x="1.5" y="5" width="21" height="14.5" rx="4.2" fill="#FF0000" />
      <path d="M10 8.9v6.7l5.6-3.35z" fill="#fff" />
    </>
  ),
  spotify: (
    <>
      <circle cx="12" cy="12" r="11" fill="#1DB954" />
      <path
        d="M6.6 9.6c3.7-1.1 7.8-.8 11 1.2"
        fill="none"
        stroke="#000"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7.4 12.6c3.1-.9 6.4-.6 9.1 1"
        fill="none"
        stroke="#000"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M8.1 15.3c2.5-.7 5.1-.5 7.3.8"
        fill="none"
        stroke="#000"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </>
  ),
  slack: (
    // Slack's own mark, cropped to the four lollipops.
    <svg viewBox="66 66 138 138" x="1" y="1" width="22" height="22">
      <path
        fill="#E01E5A"
        d="M99.4,151.2c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9h12.9V151.2z"
      />
      <path
        fill="#E01E5A"
        d="M105.9,151.2c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v32.3c0,7.1-5.8,12.9-12.9,12.9s-12.9-5.8-12.9-12.9V151.2z"
      />
      <path
        fill="#36C5F0"
        d="M118.8,99.4c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v12.9H118.8z"
      />
      <path
        fill="#36C5F0"
        d="M118.8,105.9c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9H86.5c-7.1,0-12.9-5.8-12.9-12.9s5.8-12.9,12.9-12.9H118.8z"
      />
      <path
        fill="#2EB67D"
        d="M170.6,118.8c0-7.1,5.8-12.9,12.9-12.9c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9h-12.9V118.8z"
      />
      <path
        fill="#2EB67D"
        d="M164.1,118.8c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9V86.5c0-7.1,5.8-12.9,12.9-12.9c7.1,0,12.9,5.8,12.9,12.9V118.8z"
      />
      <path
        fill="#ECB22E"
        d="M151.2,170.6c7.1,0,12.9,5.8,12.9,12.9c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9v-12.9H151.2z"
      />
      <path
        fill="#ECB22E"
        d="M151.2,164.1c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9h32.3c7.1,0,12.9,5.8,12.9,12.9c0,7.1-5.8,12.9-12.9,12.9H151.2z"
      />
    </svg>
  ),
  figma: (
    <>
      <path d="M12 1.5H8.5a3.5 3.5 0 0 0 0 7H12z" fill="#F24E1E" />
      <path d="M12 1.5h3.5a3.5 3.5 0 0 1 0 7H12z" fill="#FF7262" />
      <path d="M12 8.5H8.5a3.5 3.5 0 0 0 0 7H12z" fill="#A259FF" />
      <circle cx="15.5" cy="12" r="3.5" fill="#1ABCFE" />
      <path
        d="M12 15.5H8.5a3.5 3.5 0 0 0 0 7 3.5 3.5 0 0 0 3.5-3.5z"
        fill="#0ACF83"
      />
    </>
  ),
  gmail: (
    // Google's 2026 Gmail mark: the M with its gradient wings.
    <svg viewBox="0 0 800 636.36322" x="1" y="3.25" width="22" height="17.5">
      <defs>
        <linearGradient
          id="gmail-right"
          x1="165"
          x2="165"
          y1="44"
          y2="166"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(4.5454426,0,0,4.5454426,-36.362684,-118.18025)"
        >
          <stop stopColor="#60d673" />
          <stop offset=".17" stopColor="#42c868" />
          <stop offset=".39" stopColor="#0ebc5f" />
          <stop offset=".62" stopColor="#00a9bb" />
          <stop offset=".86" stopColor="#3c90ff" />
          <stop offset="1" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient
          id="gmail-top"
          x1="8"
          x2="184"
          y1="46.130001"
          y2="46.130001"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(4.5454426,0,0,4.5454426,-36.362684,-118.18025)"
        >
          <stop offset=".08" stopColor="#ff63a0" />
          <stop offset=".3" stopColor="#fc413d" />
          <stop offset=".5" stopColor="#fc413d" />
          <stop offset=".65" stopColor="#fc413d" />
          <stop offset=".72" stopColor="#fc5c30" />
          <stop offset=".86" stopColor="#feb10c" />
          <stop offset=".91" stopColor="#fec700" />
          <stop offset=".96" stopColor="#ffdb0f" />
        </linearGradient>
      </defs>
      <path
        fill="url(#gmail-right)"
        d="M 627.27193,81.819216 H 799.99875 V 581.8179 c 0,30.12265 -24.42266,54.54532 -54.54531,54.54532 h -90.90885 a 27.272655,27.272655 0 0 1 -27.27266,-27.27266 z"
      />
      <path
        fill="#fc413d"
        d="M 172.72768,81.819216 H 8.5692711e-4 V 581.8179 c 0,30.12265 24.42266207289,54.54532 54.54531007289,54.54532 h 90.908853 a 27.272655,27.272655 0 0 0 27.27266,-27.27266 z"
      />
      <path
        fill="url(#gmail-top)"
        d="M 141.93685,20.255746 C 105.42331,-10.435083 50.946177,-5.7169131 20.255349,30.796627 -10.435479,67.305622 -5.7173098,121.78275 30.79623,152.47813 l 345.80818,290.6765 a 36.36354,36.36354 0 0 0 46.79533,0 L 769.20792,152.47358 C 805.71691,121.78275 810.43508,67.305622 779.74426,30.792081 749.05343,-5.7169131 694.5763,-10.435083 658.0673,20.255746 L 399.9998,237.18245 Z"
      />
    </svg>
  ),
  "google-calendar": (
    // Google's 2020 Calendar icon.
    <svg viewBox="0 0 200 200" x="1" y="1" width="22" height="22">
      <g transform="translate(3.75 3.75)">
        <path
          fill="#FFFFFF"
          d="M148.882,43.618l-47.368-5.263l-57.895,5.263L38.355,96.25l5.263,52.632l52.632,6.579l52.632-6.579l5.263-53.947L148.882,43.618z"
        />
        <path
          fill="#1A73E8"
          d="M65.211,125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c0.829,3.158,2.276,5.605,4.342,7.342c2.053,1.737,4.553,2.592,7.474,2.592c2.987,0,5.553-0.908,7.697-2.724s3.224-4.132,3.224-6.934c0-2.868-1.132-5.211-3.395-7.026s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921,0,5.382-0.789,7.382-2.368c2-1.579,3-3.737,3-6.487c0-2.447-0.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684,0-4.816,0.711-6.395,2.145s-2.724,3.197-3.447,5.276l-9.039-3.763c1.197-3.395,3.395-6.395,6.618-8.987c3.224-2.592,7.342-3.895,12.342-3.895c3.697,0,7.026,0.711,9.974,2.145c2.947,1.434,5.263,3.421,6.934,5.947c1.671,2.539,2.5,5.382,2.5,8.539c0,3.224-0.776,5.947-2.329,8.184c-1.553,2.237-3.461,3.947-5.724,5.145v0.539c2.987,1.25,5.421,3.158,7.342,5.724c1.908,2.566,2.868,5.632,2.868,9.211s-0.908,6.776-2.724,9.579c-1.816,2.803-4.329,5.013-7.513,6.618c-3.197,1.605-6.789,2.421-10.776,2.421C73.408,129.263,69.145,127.934,65.211,125.276z"
        />
        <path
          fill="#1A73E8"
          d="M121.25,79.961l-9.974,7.25l-5.013-7.605l17.987-12.974h6.895v61.197h-9.895L121.25,79.961z"
        />
        <path
          fill="#EA4335"
          d="M148.882,196.25l47.368-47.368l-23.684-10.526l-23.684,10.526l-10.526,23.684L148.882,196.25z"
        />
        <path
          fill="#34A853"
          d="M33.092,172.566l10.526,23.684h105.263v-47.368H43.618L33.092,172.566z"
        />
        <path
          fill="#4285F4"
          d="M12.039-3.75C3.316-3.75-3.75,3.316-3.75,12.039v136.842l23.684,10.526l23.684-10.526V43.618h105.263l10.526-23.684L148.882-3.75H12.039z"
        />
        <path
          fill="#188038"
          d="M-3.75,148.882v31.579c0,8.724,7.066,15.789,15.789,15.789h31.579v-47.368H-3.75z"
        />
        <path
          fill="#FBBC04"
          d="M148.882,43.618v105.263h47.368V43.618l-23.684-10.526L148.882,43.618z"
        />
        <path
          fill="#1967D2"
          d="M196.25,43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368H196.25z"
        />
      </g>
    </svg>
  ),
  "google-docs": (
    <>
      <path
        d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill={GOOGLE.blue}
      />
      <path d="M14 2v5h5z" fill="#A1C2FA" />
      <path
        d="M8 12h8M8 15h8M8 18h5"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </>
  ),
  github: (
    <path
      fill="currentColor"
      className="text-gray-1000"
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
    />
  ),
  notion: (
    // Notion's mark; paper and ink follow the theme so it reads in dark mode too.
    <svg viewBox="0 0 59.9 62.6" x="0.52" y="0" width="22.96" height="24">
      <path
        fill="var(--color-background-100)"
        d="M3.8,2.7l34.6-2.6c4.2-0.4,5.3-0.1,8,1.8l11.1,7.8c1.8,1.3,2.4,1.7,2.4,3.2v42.7c0,2.7-1,4.3-4.4,4.5l-40.2,2.4c-2.6,0.1-3.8-0.2-5.1-1.9L2.1,50.1c-1.5-2-2.1-3.4-2.1-5.1V7C0,4.8,1,2.9,3.8,2.7L3.8,2.7z"
      />
      <path
        fill="currentColor"
        className="text-gray-1000"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M38.4,0.1L3.8,2.7C1,2.9,0,4.8,0,7v38c0,1.7,0.6,3.2,2.1,5.1l8.1,10.6c1.3,1.7,2.6,2.1,5.1,1.9l40.2-2.4c3.4-0.2,4.4-1.8,4.4-4.5V12.9c0-1.4-0.5-1.8-2.2-3c-0.1-0.1-0.2-0.1-0.3-0.2L46.4,2C43.8,0,42.7-0.2,38.4,0.1L38.4,0.1z M16.2,12.2c-3.3,0.2-4,0.3-5.9-1.3L5.6,7.2C5.1,6.7,5.3,6.1,6.6,6l33.3-2.4c2.8-0.2,4.2,0.7,5.3,1.6l5.7,4.1c0.3,0.1,0.9,0.8,0.1,0.8l-34.4,2.1L16.2,12.2z M12.4,55.3V19c0-1.6,0.5-2.3,1.9-2.4l39.5-2.3c1.3-0.1,1.9,0.7,1.9,2.3v36c0,1.6-0.3,2.9-2.4,3l-37.8,2.2C13.4,58,12.4,57.2,12.4,55.3L12.4,55.3z M49.7,21c0.2,1.1,0,2.2-1.1,2.3l-1.8,0.4v26.8c-1.6,0.9-3,1.3-4.2,1.3c-1.9,0-2.4-0.6-3.9-2.4L26.7,30.6v18.1l3.8,0.9c0,0,0,2.2-3,2.2l-8.4,0.5c-0.2-0.5,0-1.7,0.8-1.9l2.2-0.6v-24l-3-0.3c-0.2-1.1,0.4-2.7,2.1-2.8l9-0.6l12.4,19V24.3l-3.2-0.4c-0.2-1.3,0.7-2.3,1.9-2.4L49.7,21z"
      />
    </svg>
  ),
  linkedin: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="3.5" fill="#0A66C2" />
      <path
        d="M7 10h2.3v7H7zM8.15 6.6a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7zM10.8 10h2.2v1c.4-.7 1.2-1.2 2.3-1.2 2.3 0 2.7 1.5 2.7 3.4V17h-2.3v-3.4c0-.9-.1-1.9-1.2-1.9-1.2 0-1.4.9-1.4 1.8V17h-2.3z"
        fill="#fff"
      />
    </>
  ),
  instagram: (
    <>
      <defs>
        <linearGradient
          id="ig"
          x1="4"
          y1="20"
          x2="20"
          y2="4"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#F58529" />
          <stop offset="0.5" stopColor="#DD2A7B" />
          <stop offset="1" stopColor="#8134AF" />
        </linearGradient>
      </defs>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="5.5"
        fill="none"
        stroke="url(#ig)"
        strokeWidth="2"
      />
      <circle
        cx="12"
        cy="12"
        r="4"
        fill="none"
        stroke="url(#ig)"
        strokeWidth="2"
      />
      <circle cx="17.2" cy="6.8" r="1.2" fill="url(#ig)" />
    </>
  ),
};
