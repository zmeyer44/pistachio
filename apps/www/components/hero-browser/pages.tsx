"use client";

/**
 * The pages the hero's panes paint (./catalog.ts says which address gets
 * which). Each is a still sketch of the real site — its layout, its colours,
 * enough structure that a visitor reads "X is open here" — with mostly invented
 * accounts and content. The featured 3Blue1Brown video uses its real title
 * and official thumbnail; comments and engagement UI remain demo content.
 * Links go through the pane's `navigate`, so an in-page click pushes history
 * the back button can walk, as in the app.
 */

import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { ARTICLE, describeUrl, GITHUB_REPO_PATH, searchCatalog, searchQuery, VIDEOS, youtubeVideo, type SiteInfo } from "./catalog";

/**
 * How a page reaches its tab. A page can go somewhere; a link can be
 * Glanced (a modifier-click, as in the app: ⇧, ⌘ or ⌥); and the reader page
 * can ask for its article to be read aloud.
 */
export interface PaneActions {
  navigate: (url: string) => void;
  glance?: (url: string, source: DOMRect) => void;
  readAloud?: () => void;
}

export const PaneContext = createContext<PaneActions>({ navigate: () => {} });

function A({ href, className, children }: { href: string; className?: string; children: ReactNode }): ReactNode {
  const { navigate, glance } = useContext(PaneContext);
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        if (glance !== undefined && (event.shiftKey || event.metaKey || event.altKey)) {
          glance(href, event.currentTarget.getBoundingClientRect());
          return;
        }
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** A path on the page's own site. */
function siteLink(site: SiteInfo, path: string): string {
  return new URL(path, site.url).toString();
}

/* -------------------------------- shared --------------------------------- */

function Avatar({ name, tone, size = 28 }: { name: string; tone: string; size?: number }): ReactNode {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ background: tone, width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {name
        .split(" ")
        .map((part) => part.charAt(0))
        .join("")
        .slice(0, 2)}
    </span>
  );
}

/** Generated photography for the mock pages, shipped as compact local assets. */
function DemoImage({ src, alt = "", className, width = 960, height = 540 }: { src: string; alt?: string; className?: string; width?: number; height?: number }): ReactNode {
  return <img src={src} alt={alt} width={width} height={height} loading="lazy" decoding="async" className={`object-cover ${className ?? ""}`} />;
}

/** The watch page and sidebar media card share the video's generated artwork. */
export function VideoArt({ video, className, controls = false }: { video: (typeof VIDEOS)[number]; className?: string; controls?: boolean }): ReactNode {
  return (
    <div className={`demo-video relative overflow-hidden bg-black ${className ?? ""}`}>
      <DemoImage src={video.thumbnail} alt={video.title} className="demo-video-drift absolute inset-0 h-full w-full" />
      {controls ? (
        <div className="absolute inset-x-0 bottom-0 px-3 pb-2">
          <div className="h-[3px] overflow-hidden rounded-full bg-white/30">
            <div className="demo-video-playhead h-full bg-[#ff0000]" />
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-[12px] text-white">
            <span>❚❚</span>
            <span>▶▶</span>
            <span className="opacity-80">4:12 / {video.length}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const Icon = {
  search: (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M12 19V5m0 0-6 6m6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/* ----------------------------------- X ----------------------------------- */

const POSTS: Array<{ name: string; handle: string; tone: string; time: string; text: string; replies: number; reposts: number; likes: number; thumb?: { src: string; alt: string } }> = [
  {
    name: "Maya Lindqvist",
    handle: "@mayabuilds",
    tone: "#7c3aed",
    time: "2h",
    text: "Asked my browser to rebook the 7am flight to the 4pm and move the car rental to match. It did both, showed me the two confirmation pages, and then went quiet. First agent thing that feels like a tool and not a demo.",
    replies: 41,
    reposts: 188,
    likes: 1_240,
  },
  {
    name: "Theo Park",
    handle: "@theopark",
    tone: "#0ea5e9",
    time: "4h",
    text: "hot take: the browser has been the operating system for years, we just kept pretending the apps were the point",
    replies: 96,
    reposts: 412,
    likes: 3_508,
  },
  {
    name: "Pistachio",
    handle: "@pistachiobrowser",
    tone: "#52a862",
    time: "6h",
    text: "0.0.17 is out. Split panes remember their widths, the home page shows your day, and Tidy puts idle tabs away for you. Notes in the thread ↓",
    replies: 22,
    reposts: 130,
    likes: 890,
    thumb: { src: "/img/demo/browser-desk.webp", alt: "A laptop with split browser panes and a daily calendar on a sunlit desk" },
  },
  {
    name: "Dana Okafor",
    handle: "@danaok",
    tone: "#f59e0b",
    time: "9h",
    text: "Every year a new nut is declared the healthy one. This year it's the pistachio's turn again. Respect the rotation.",
    replies: 12,
    reposts: 30,
    likes: 402,
  },
];

function X({ site }: { site: SiteInfo }): ReactNode {
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/u, "")}K` : String(n));
  const NAV: Array<[string, string]> = [["Home", "/home"], ["Explore", "/explore"], ["Notifications", "/notifications"], ["Messages", "/messages"], ["Bookmarks", "/i/bookmarks"], ["Profile", "/you"]];
  return (
    <div className="flex h-full bg-black text-[#e7e9ea]">
      <nav className="hidden w-56 shrink-0 flex-col gap-1 border-r border-[#2f3336] px-3 py-3 text-[17px] md:flex">
        <span className="mb-2 px-3 text-[22px] font-bold">𝕏</span>
        {NAV.map(([label, path], i) => (
          <A key={label} href={siteLink(site, path)} className={`rounded-full px-3 py-2 hover:bg-[#181818] ${i === 0 ? "font-bold" : ""}`}>
            {label}
          </A>
        ))}
        <span className="mt-3 rounded-full bg-[#eff3f4] py-2.5 text-center text-[15px] font-bold text-black">Post</span>
      </nav>
      <main className="min-w-0 max-w-[600px] flex-1 overflow-y-auto border-r border-[#2f3336]">
        <div className="sticky top-0 grid grid-cols-2 border-b border-[#2f3336] bg-black/80 text-[15px] backdrop-blur">
          <span className="py-3.5 text-center font-bold">
            <span className="border-b-4 border-[#1d9bf0] pb-3">For you</span>
          </span>
          <span className="py-3.5 text-center text-[#71767b]">Following</span>
        </div>
        <div className="flex gap-3 border-b border-[#2f3336] px-4 py-3">
          <Avatar name="You" tone="#1d9bf0" size={40} />
          <span className="pt-2 text-[20px] text-[#71767b]">What is happening?!</span>
        </div>
        {POSTS.map((post, index) => (
          <A key={post.handle} href={siteLink(site, `/${post.handle.slice(1)}/status/${String(1_800_000_000 + index)}`)} className="flex gap-3 border-b border-[#2f3336] px-4 py-3 hover:bg-[#080808]">
            <Avatar name={post.name} tone={post.tone} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-[15px]">
                <span className="font-bold">{post.name}</span>
                <span className="text-[#71767b]">
                  {post.handle} · {post.time}
                </span>
              </div>
              <p className="mt-0.5 text-[15px] leading-5">{post.text}</p>
              {post.thumb === undefined ? null : <DemoImage src={post.thumb.src} alt={post.thumb.alt} className="mt-3 h-44 w-full rounded-2xl border border-[#2f3336]" />}
              <div className="mt-3 flex max-w-[380px] justify-between text-[13px] text-[#71767b]">
                <span>💬 {fmt(post.replies)}</span>
                <span>🔁 {fmt(post.reposts)}</span>
                <span>♡ {fmt(post.likes)}</span>
                <span>⇪</span>
              </div>
            </div>
          </A>
        ))}
      </main>
      <aside className="hidden w-72 shrink-0 flex-col gap-4 p-4 lg:flex">
        <div className="flex items-center gap-3 rounded-full bg-[#202327] px-4 py-2.5 text-[15px] text-[#71767b]">{Icon.search} Search</div>
        <div className="rounded-2xl border border-[#2f3336] p-4">
          <div className="text-[20px] font-bold">What’s happening</div>
          {[
            ["Technology · Trending", "agentic browsers", "24.1K posts"],
            ["Trending in Food", "#PistachioSeason", "8,203 posts"],
            ["Travel", "SFO delays", "3,410 posts"],
          ].map(([kicker, topic, count]) => (
            <div key={topic} className="mt-3 text-[13px] text-[#71767b]">
              {kicker}
              <div className="text-[15px] font-bold text-[#e7e9ea]">{topic}</div>
              {count}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------- YouTube -------------------------------- */


const YT_ICON = {
  home: "M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z",
  shorts: "M10 8.5v7l5.5-3.5zM17.8 9.3l-1.1-.6 1.3-.7a3.6 3.6 0 0 0-3.5-6.3L6.8 5.8a3.6 3.6 0 0 0-.6 6.3l1.1.6-1.3.7a3.6 3.6 0 0 0 3.5 6.3l7.7-4.1a3.6 3.6 0 0 0 .6-6.3z",
  subs: "M4 5h16M6 2h12M3 8h18v13H3zM10 11.5v6l5-3z",
  you: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  history: "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5M3.5 4v4.5H8",
  playlists: "M4 6h12M4 11h12M4 16h7M17 13v7l5-3.5z",
  later: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  liked: "M7 10v11H3V10zM7 10l4-8a2.5 2.5 0 0 1 2.5 2.5V9h6a2 2 0 0 1 2 2.3l-1.4 7.8A2.5 2.5 0 0 1 17.6 21H7",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  bell: "M18 16V11a6 6 0 0 0-12 0v5l-2 2h16zM10 20a2 2 0 0 0 4 0",
  plus: "M12 5v14M5 12h14",
  dislike: "M17 14V3h4v11zM17 14l-4 8a2.5 2.5 0 0 1-2.5-2.5V15h-6a2 2 0 0 1-2-2.3l1.4-7.8A2.5 2.5 0 0 1 6.4 3H17",
  share: "M14 5l7 7-7 7v-4c-6 0-9 2-11 5 1-6 4-10 11-11z",
  download: "M12 3v12m0 0-5-5m5 5 5-5M4 20h16",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  sort: "M3 6h18M6 12h12M10 18h4",
};

function YtIcon({ d, className = "size-6" }: { d: string; className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** Creator artwork is shared across the feed, recommendations, and search. */
function VideoThumb({ video, className }: { video: (typeof VIDEOS)[number]; className?: string }): ReactNode {
  return (
    <div className={`relative overflow-hidden ${className ?? ""}`} style={{ backgroundColor: video.tone }}>
      <DemoImage src={video.thumbnail} className="absolute inset-0 h-full w-full" />
      <span className="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1 text-[12px] font-medium text-white">{video.length}</span>
    </div>
  );
}

const YT_COMMENTS: Array<{ name: string; tone: string; age: string; text: string; likes: string; replies?: number }> = [
  { name: "mira.codes", tone: "#0e7490", age: "2 days ago", text: "The part where it rebooked the dentist around the calendar conflict without being asked is honestly the moment I was sold.", likes: "1.8K", replies: 42 },
  { name: "Theo Park", tone: "#a16207", age: "2 days ago", text: "12:40 — watching it compare three grocery carts across tabs at once was wild. More of this please.", likes: "964", replies: 11 },
  { name: "quietbuilder", tone: "#4c1d95", age: "1 day ago", text: "Would love a follow-up on what it got wrong. The returns label bit looked like it needed a nudge.", likes: "512", replies: 7 },
  { name: "Lena Ortiz", tone: "#be123c", age: "3 days ago", text: "Timestamps:\n0:00 Setup\n2:15 Day 1 — groceries\n5:48 Day 3 — travel\n12:40 Day 5 — shopping\n16:02 Verdict", likes: "2.3K" },
  { name: "Sam Whitlock", tone: "#3f6b3a", age: "20 hours ago", text: "I tried the same thing after watching and it cancelled a subscription I forgot I had. Paid for itself in a day.", likes: "288", replies: 3 },
];

const MATH_COMMENTS = [
  "Seeing the vectors stay on the same line finally made the definition click.",
  "The geometric explanation is exactly what I was missing in class.",
  "I paused the animation and tried drawing the transformation myself. That helped a lot.",
  "The connection between the determinant and eigenvalues makes so much more sense visually.",
  "Coming back to this series before my linear algebra exam.",
];

function YouTube({ site }: { site: SiteInfo }): ReactNode {
  const watching = youtubeVideo(site.url);
  const guide: Array<[string, string]> = [
    ["Home", YT_ICON.home],
    ["Shorts", YT_ICON.shorts],
    ["Subscriptions", YT_ICON.subs],
  ];
  const you: Array<[string, string]> = [
    ["History", YT_ICON.history],
    ["Playlists", YT_ICON.playlists],
    ["Watch later", YT_ICON.later],
    ["Liked videos", YT_ICON.liked],
  ];
  const channels = ["3Blue1Brown", "Ada Builds", "Farm & Field", "Tabless", "Quiet Room", "Pixel Pushers", "Slow Cities"];
  const pill = "flex items-center gap-2 rounded-full bg-[#f2f2f2] px-4 py-2 text-[14px] font-medium";
  return (
    <div className="flex h-full flex-col bg-white text-[#0f0f0f]">
      <div className="flex h-14 shrink-0 items-center gap-4 px-4">
        <YtIcon d="M3 6h18M3 12h18M3 18h18" />
        <A href={siteLink(site, "/")} className="flex items-center gap-1">
          <span className="flex h-5 w-7 items-center justify-center rounded-md bg-[#ff0000] text-[10px] text-white">▶</span>
          <span className="text-[19px] font-bold tracking-[-0.06em]">YouTube</span>
        </A>
        <div className="mx-auto flex w-full max-w-[640px] items-center gap-3">
          <div className="flex h-10 flex-1 items-center overflow-hidden rounded-full border border-[#ccc]">
            <span className="flex-1 px-4 text-[15px] text-[#888]">Search</span>
            <span className="flex h-full w-16 items-center justify-center border-l border-[#ccc] bg-[#f8f8f8]">{Icon.search}</span>
          </div>
          <span className="flex size-10 items-center justify-center rounded-full bg-[#f2f2f2]">
            <YtIcon d={YT_ICON.mic} className="size-5" />
          </span>
        </div>
        <span className="hidden items-center gap-1 rounded-full bg-[#f2f2f2] py-1.5 pr-3 pl-2 text-[14px] font-medium lg:flex">
          <YtIcon d={YT_ICON.plus} className="size-5" /> Create
        </span>
        <span className="relative">
          <YtIcon d={YT_ICON.bell} />
          <span className="absolute -top-1 -right-1.5 rounded-full bg-[#cc0000] px-1 text-[10px] font-medium text-white">9+</span>
        </span>
        <Avatar name="You" tone="#606060" size={32} />
      </div>
      <div className="flex min-h-0 flex-1">
        {watching === null ? (
          <nav className="hidden w-[220px] shrink-0 flex-col overflow-y-auto px-3 pb-4 text-[14px] xl:flex">
            {guide.map(([label, d], i) => (
              <span key={label} className={`flex items-center gap-5 rounded-lg px-3 py-2 ${i === 0 ? "bg-[#f2f2f2] font-medium" : ""}`}>
                <YtIcon d={d} /> {label}
              </span>
            ))}
            <div className="my-3 border-t border-black/10" />
            <span className="px-3 pb-1 text-[16px] font-semibold">You ›</span>
            {you.map(([label, d]) => (
              <span key={label} className="flex items-center gap-5 rounded-lg px-3 py-2">
                <YtIcon d={d} /> {label}
              </span>
            ))}
            <div className="my-3 border-t border-black/10" />
            <span className="px-3 pb-1 text-[16px] font-semibold">Subscriptions</span>
            {channels.map((name, i) => (
              <span key={name} className="flex items-center gap-4 rounded-lg px-3 py-1.5">
                <Avatar name={name} tone={VIDEOS.find((v) => v.channel === name)?.tone ?? "#606060"} size={24} />
                <span className="flex-1 truncate">{name}</span>
                {i < 3 ? <span className="size-1.5 rounded-full bg-[#3ea6ff]" /> : null}
              </span>
            ))}
          </nav>
        ) : null}
        {watching === null ? (
          <nav className="flex w-[72px] shrink-0 flex-col items-center gap-1 pt-1 text-[10px] xl:hidden">
            {[...guide, ["You", YT_ICON.you] as [string, string]].map(([label, d], i) => (
              <span key={label} className={`flex w-16 flex-col items-center gap-1.5 rounded-lg py-3 ${i === 0 ? "font-semibold" : ""}`}>
                <YtIcon d={d} />
                {label === "Subscriptions" ? "Subs" : label}
              </span>
            ))}
          </nav>
        ) : null}
        {watching === null ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
            <div className="sticky top-0 z-10 flex gap-3 overflow-hidden bg-white py-3 text-[14px] font-medium">
              {["All", "Music", "Browsers", "Live", "Cooking", "Travel", "Podcasts", "Gardening", "Recently uploaded", "Watched", "New to you"].map((chip, i) => (
                <span key={chip} className={`shrink-0 rounded-lg px-3 py-1.5 ${i === 0 ? "bg-[#0f0f0f] text-white" : "bg-[#f2f2f2]"}`}>
                  {chip}
                </span>
              ))}
            </div>
            <div className="grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {VIDEOS.slice(0, 6).map((video) => (
                <YtCard key={video.id} site={site} video={video} />
              ))}
            </div>
            <div className="mt-8 border-t border-black/10 pt-5">
              <div className="flex items-center gap-2 text-[20px] font-bold">
                <YtIcon d={YT_ICON.shorts} className="size-6 text-[#ff0000]" /> Shorts
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 lg:grid-cols-5">
                {[
                  ["Cracking 1,000 pistachios in 60 seconds", "18M views", "/img/demo/pistachio-nuts.webp"],
                  ["POV: you finally closed all 214 tabs", "4.1M views", "/img/demo/browser-desk.webp"],
                  ["The shaker harvest is so satisfying", "9.7M views", "/img/demo/harvest-shaker.webp"],
                  ["One shortcut that saves me an hour", "2.2M views", "/img/demo/shortcut-short.webp"],
                  ["Rainy Tokyo at night in 20 seconds", "6.3M views", "/img/demo/tokyo-rain.webp"],
                ].map(([title, views, src], i) => (
                  <div key={title} className={i > 2 ? "hidden lg:block" : ""}>
                    <DemoImage src={src!} width={540} height={960} className="aspect-[9/16] w-full rounded-xl" />
                    <div className="mt-2 line-clamp-2 text-[15px] font-medium leading-5">{title}</div>
                    <div className="text-[13px] text-[#606060]">{views}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-8 grid gap-x-4 gap-y-8 border-t border-black/10 pt-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {VIDEOS.slice(6).map((video) => (
                <YtCard key={video.id} site={site} video={video} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-6 overflow-y-auto px-6 pt-1 pb-8">
            <div className="min-w-0 flex-1">
              <VideoArt video={watching} className="aspect-video w-full rounded-xl" controls />
              <h1 className="mt-3 text-[20px] font-bold leading-7">{watching.title}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Avatar name={watching.channel} tone={watching.tone} size={40} />
                <div className="text-[14px]">
                  <div className="font-semibold">{watching.channel}</div>
                  <div className="text-[12px] text-[#606060]">{watching.channel === "3Blue1Brown" ? "Animated mathematics" : "128K subscribers"}</div>
                </div>
                <span className="ml-2 rounded-full bg-[#0f0f0f] px-4 py-2 text-[14px] font-medium text-white">Subscribe</span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="flex items-center rounded-full bg-[#f2f2f2] text-[14px] font-medium">
                    <span className="flex items-center gap-2 border-r border-black/10 py-2 pr-3 pl-4">
                      <YtIcon d={YT_ICON.liked} className="size-5" /> 4.2K
                    </span>
                    <span className="py-2 pr-4 pl-3">
                      <YtIcon d={YT_ICON.dislike} className="size-5" />
                    </span>
                  </span>
                  <span className={pill}>
                    <YtIcon d={YT_ICON.share} className="size-5" /> Share
                  </span>
                  <span className={`${pill} hidden lg:flex`}>
                    <YtIcon d={YT_ICON.download} className="size-5" /> Download
                  </span>
                  <span className="flex size-9 items-center justify-center rounded-full bg-[#f2f2f2]">
                    <YtIcon d={YT_ICON.more} className="size-5" />
                  </span>
                </span>
              </div>
              <div className="mt-3 rounded-xl bg-[#f2f2f2] p-3 text-[14px] leading-5">
                <b>
                  {watching.views} · {watching.age}
                </b>{" "}
                <span className="text-[#065fd4]">{watching.tags ?? "#browsers #productivity #ai"}</span>
                <p className="mt-1">
                  {watching.description ?? "Seven days, one browser, every errand I could think of: groceries, a dentist reschedule, two returns and a very confused airline. Here's what worked, what didn't, and whether I'd keep doing it."}
                </p>
                <div className="mt-1 font-medium">...more</div>
              </div>
              <div className="mt-6 flex items-center gap-8 text-[20px] font-bold">
                1,284 Comments
                <span className="flex items-center gap-2 text-[14px] font-medium">
                  <YtIcon d={YT_ICON.sort} className="size-5" /> Sort by
                </span>
              </div>
              <div className="mt-5 flex items-center gap-4">
                <Avatar name="You" tone="#606060" size={40} />
                <span className="flex-1 border-b border-black/20 pb-1 text-[14px] text-[#606060]">Add a comment…</span>
              </div>
              <div className="mt-6 flex flex-col gap-6">
                {YT_COMMENTS.map((comment, index) => (
                  <div key={comment.name} className="flex gap-4">
                    <Avatar name={comment.name} tone={comment.tone} size={40} />
                    <div className="min-w-0 text-[14px]">
                      <div className="text-[13px]">
                        <b>@{comment.name.toLowerCase().replace(/\s+/g, "")}</b> <span className="text-[#606060]">{comment.age}</span>
                      </div>
                      <p className="mt-0.5 leading-5 whitespace-pre-line">{watching.channel === "3Blue1Brown" ? MATH_COMMENTS[index] : comment.text}</p>
                      <div className="mt-2 flex items-center gap-4 text-[12px] text-[#606060]">
                        <span className="flex items-center gap-1.5">
                          <YtIcon d={YT_ICON.liked} className="size-4" /> {comment.likes}
                        </span>
                        <YtIcon d={YT_ICON.dislike} className="size-4" />
                        <span className="font-medium text-[#0f0f0f]">Reply</span>
                      </div>
                      {comment.replies !== undefined ? <div className="mt-2 text-[14px] font-medium text-[#065fd4]">⌄ {comment.replies} replies</div> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="hidden w-[360px] shrink-0 flex-col gap-2 lg:flex">
              <div className="mb-1 flex gap-2 text-[14px] font-medium">
                {["All", `From ${watching.channel}`, "Related", "Recently uploaded"].map((chip, i) => (
                  <span key={chip} className={`shrink-0 rounded-lg px-3 py-1.5 ${i === 0 ? "bg-[#0f0f0f] text-white" : "bg-[#f2f2f2]"}`}>
                    {chip}
                  </span>
                ))}
              </div>
              {VIDEOS.filter((v) => v.id !== watching.id).map((video) => (
                <A key={video.id} href={siteLink(site, `/watch?v=${video.id}`)} className="flex gap-2">
                  <VideoThumb video={video} className="h-[94px] w-[168px] shrink-0 rounded-lg [container-type:inline-size]" />
                  <div className="min-w-0 text-[12px] text-[#606060]">
                    <div className="line-clamp-2 text-[14px] font-medium leading-5 text-[#0f0f0f]">{video.title}</div>
                    <div className="mt-1">{video.channel}</div>
                    <div>
                      {video.views} · {video.age}
                    </div>
                  </div>
                </A>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function YtCard({ site, video }: { site: SiteInfo; video: (typeof VIDEOS)[number] }): ReactNode {
  return (
    <A href={siteLink(site, `/watch?v=${video.id}`)} className="block">
      <VideoThumb video={video} className="aspect-video w-full rounded-xl [container-type:inline-size]" />
      <div className="mt-3 flex gap-3">
        <Avatar name={video.channel} tone={video.tone} size={36} />
        <div className="min-w-0">
          <div className="line-clamp-2 text-[15px] font-medium leading-5">{video.title}</div>
          <div className="mt-1 text-[13px] text-[#606060]">{video.channel}</div>
          <div className="text-[13px] text-[#606060]">
            {video.views} · {video.age}
          </div>
        </div>
      </div>
    </A>
  );
}

/* --------------------------------- Google -------------------------------- */

function GoogleWord({ className }: { className?: string }): ReactNode {
  const letters: Array<[string, string]> = [["G", "#4285f4"], ["o", "#ea4335"], ["o", "#fbbc05"], ["g", "#4285f4"], ["l", "#34a853"], ["e", "#ea4335"]];
  return (
    <span className={`font-sans font-medium tracking-[-0.04em] ${className ?? ""}`}>
      {letters.map(([letter, tone], i) => (
        <span key={i} style={{ color: tone }}>
          {letter}
        </span>
      ))}
    </span>
  );
}

const BLURBS: Partial<Record<SiteInfo["page"], string>> = {
  wikipedia: "The pistachio (Pistacia vera) is a small tree in the cashew family, originally from Central Asia and the Middle East. The tree produces seeds that are widely consumed as food.",
  github: "A browser built for tomorrow. A Mac browser with an agent built in. Contribute to zmeyer44/pistachio development by creating an account on GitHub.",
  x: "The latest posts on X. See what people are saying about agents, browsers and everything else.",
  youtube: "Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.",
  "google-calendar": "Access Google Calendar with a Google account (for personal use) or Google Workspace account (for business use).",
  chatgpt: "ChatGPT helps you get answers, find inspiration and be more productive. It is free to use and easy to try.",
  claude: "Claude is an AI assistant by Anthropic. Talk with Claude, or build with the Claude API.",
  article: `${ARTICLE.published} — ${ARTICLE.lead}`,
};

/**
 * The rest of a results page, beyond the catalog's own sites: web results,
 * "People also ask", related searches. Every site here is invented, like the
 * accounts on the other sketches. A search about pistachios (the tour's)
 * gets a page written for it; anything else gets neutral results worded
 * around the query.
 */
interface WebResult {
  site: string;
  url: string;
  title: string;
  blurb: string;
  tone: string;
}

interface SearchExtras {
  web: WebResult[];
  ask: Array<[question: string, answer: string]>;
  related: string[];
}

function searchExtras(query: string): SearchExtras {
  if (/pistachio/iu.test(query)) {
    return {
      web: [
        {
          site: "Central Valley Growers Extension",
          url: "https://cvgrowers.org/crops/pistachio/alternate-bearing",
          title: "Alternate bearing in pistachio: causes and management",
          blurb: "Heavy 'on' years deplete the tree's stored carbohydrates, so next season's flower buds drop. Thinning, pruning and nitrogen timing can soften the cycle.",
          tone: "#2f6b3a",
        },
        {
          site: "Threadline",
          url: "https://threadline.net/r/orchards/why-do-my-pistachios-skip-a-year",
          title: "Why do my pistachio trees only produce every other year?",
          blurb: "38 answers · Top answer: “Totally normal for pistachios. Mine went 40 lb, 6 lb, 44 lb. Don't over-fertilize in the off year — it won't fix it.”",
          tone: "#ff6a3d",
        },
        {
          site: "Farm Ledger",
          url: "https://farmledger.news/2026/09/pistachio-harvest-off-year",
          title: "California pistachio harvest 2026: an ‘off’ year, and prices show it",
          blurb: "Sep 12, 2026 — Growers expect a crop roughly a third smaller than last season's record, the latest swing in the industry's alternating cycle.",
          tone: "#8a6d3b",
        },
        {
          site: "Explainer Weekly",
          url: "https://explainerweekly.com/science/alternate-bearing-explained",
          title: "The biology of alternate bearing, explained in five minutes",
          blurb: "Apples, olives, avocados and pistachios all do it. Here is what is going on inside a tree that crops heavily one year and barely the next.",
          tone: "#3b5bdb",
        },
      ],
      ask: [
        ["Why do pistachio trees produce every other year?", "A heavy crop uses up the sugars the tree would spend on next year's flower buds, so many buds drop and the following crop is light — which leaves plenty for the buds again."],
        ["Can alternate bearing be prevented?", "Not entirely. Pruning, thinning clusters in heavy years and careful irrigation and nitrogen can reduce how far the yields swing."],
        ["How long does a pistachio tree take to bear nuts?", "Usually five to seven years for a first crop, with full production at around fifteen to twenty years."],
        ["Are pistachios more expensive in off years?", "Often, yes. A light harvest tightens supply, so wholesale prices tend to rise in the year after a smaller crop."],
      ],
      related: ["pistachio off year", "alternate bearing apples", "pistachio tree lifespan", "how to thin pistachio clusters", "pistachio prices 2026", "male and female pistachio trees"],
    };
  }
  const q = query.trim();
  const slug = encodeURIComponent(q.toLowerCase().replace(/\s+/gu, "-"));
  return {
    web: [
      { site: "Explainer Weekly", url: `https://explainerweekly.com/topics/${slug}`, title: `${q} — explained`, blurb: `A plain-language look at ${q}: what it is, why it matters, and what people most often get wrong.`, tone: "#3b5bdb" },
      { site: "Threadline", url: `https://threadline.net/search?q=${slug}`, title: `“${q}” — what does everyone recommend?`, blurb: "54 answers · Top answer: “Depends what you're after, but here's what finally worked for me after trying most of the usual suggestions…”", tone: "#ff6a3d" },
      { site: "Field Notes", url: `https://fieldnotes.blog/guides/${slug}`, title: `A beginner's guide to ${q}`, blurb: `Start here: the basics of ${q}, a short checklist, and the three mistakes we see most.`, tone: "#2f6b3a" },
      { site: "Papers Digest", url: `https://papersdigest.org/q/${slug}`, title: `${q}: what the research says`, blurb: "A summary of recent studies, with links to the sources and a note on how confident to be in each.", tone: "#6b5b95" },
    ],
    ask: [
      [`What is the best way to start with ${q}?`, "Most guides suggest starting small, keeping notes, and changing one thing at a time."],
      [`Is ${q} worth it?`, "It depends on what you need it for — the answers above compare the common options."],
      [`What do people get wrong about ${q}?`, "The most common mistake is skipping the basics and going straight to the advanced advice."],
    ],
    related: [`${q} for beginners`, `${q} tips`, `${q} near me`, `best ${q} 2026`],
  };
}

function PeopleAlsoAsk({ items }: { items: SearchExtras["ask"] }): ReactNode {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section>
      <h2 className="text-[20px]">People also ask</h2>
      <div className="mt-2 border-t border-[#dadce0]">
        {items.map(([question, answer], i) => (
          <div key={question} className="border-b border-[#dadce0]">
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center justify-between py-3 text-left text-[15px]">
              {question}
              <span className={`text-[#5f6368] transition-transform ${open === i ? "rotate-180" : ""}`}>⌄</span>
            </button>
            {open === i ? <p className="pb-3 text-[14px] leading-[22px] text-[#4d5156]">{answer}</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** One result: the site's name and address over a blue title and its snippet. */
function Result({ site, url, title, blurb, icon }: { site: string; url: string; title: string; blurb: ReactNode; icon: ReactNode }): ReactNode {
  return (
    <li>
      <div className="flex items-center gap-3 text-[14px]">
        {icon}
        <span className="min-w-0">
          <span className="block truncate text-[#1f1f1f]">{site}</span>
          <span className="block truncate text-[12px] text-[#4d5156]">{url}</span>
        </span>
      </div>
      <A href={url} className="mt-1 block text-[20px] leading-[26px] text-[#1a0dab] hover:underline">
        {title}
      </A>
      <p className="mt-1 text-[14px] leading-[22px] text-[#4d5156]">{blurb}</p>
    </li>
  );
}

function siteMark(site: string, tone: string): ReactNode {
  return (
    <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full border border-[#ecedef] text-[12px] font-bold text-white" style={{ background: tone }}>
      {site.charAt(0)}
    </span>
  );
}

function Google({ site }: { site: SiteInfo }): ReactNode {
  const query = searchQuery(site.url);
  if (query === null) {
    return (
      <div className="flex h-full flex-col bg-white text-[#1f1f1f]">
        <div className="flex h-14 shrink-0 items-center justify-end gap-5 px-5 text-[13px]">
          <span>Gmail</span>
          <span>Images</span>
          <span className="grid size-6 grid-cols-3 gap-0.5 opacity-60">
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="size-1.5 rounded-full bg-[#5f6368]" />
            ))}
          </span>
          <Avatar name="You" tone="#1a73e8" size={32} />
        </div>
        <div className="flex flex-1 flex-col items-center pt-[10vh]">
          <GoogleWord className="text-[80px] leading-none" />
          <div className="mt-8 flex h-12 w-full max-w-[580px] items-center gap-3 rounded-full border border-[#dfe1e5] px-4 text-[16px] text-[#9aa0a6] shadow-[0_1px_6px_rgba(32,33,36,0.28)]">
            {Icon.search}
            <span className="flex-1" />
            <span className="text-[#4285f4]">🎤</span>
            <span className="text-[#4285f4]">📷</span>
          </div>
          <div className="mt-7 flex gap-3 text-[14px]">
            <span className="rounded bg-[#f8f9fa] px-4 py-2">Google Search</span>
            <span className="rounded bg-[#f8f9fa] px-4 py-2">I’m Feeling Lucky</span>
          </div>
        </div>
        <div className="flex h-12 shrink-0 items-center justify-between bg-[#f2f2f2] px-6 text-[14px] text-[#70757a]">
          <span>About · Advertising · Business</span>
          <span>Privacy · Terms · Settings</span>
        </div>
      </div>
    );
  }
  const results = searchCatalog(query);
  const extras = searchExtras(query);
  return (
    <div className="flex h-full flex-col bg-white text-[#1f1f1f]">
      <div className="flex h-16 shrink-0 items-center gap-6 px-6">
        <A href="https://www.google.com/">
          <GoogleWord className="text-[26px]" />
        </A>
        <div className="flex h-11 w-full max-w-[640px] items-center gap-3 rounded-full border border-[#dfe1e5] px-5 text-[16px] shadow-[0_1px_6px_rgba(32,33,36,0.2)]">
          <span className="flex-1">{query}</span>
          <span className="text-[#4285f4]">{Icon.search}</span>
        </div>
      </div>
      <div className="flex gap-6 border-b border-[#ebebeb] px-6 text-[14px] text-[#5f6368]">
        {["All", "Images", "Videos", "News", "Shopping", "More"].map((tab, i) => (
          <span key={tab} className={`pb-2.5 ${i === 0 ? "border-b-[3px] border-[#1a73e8] text-[#1a73e8]" : ""}`}>
            {tab}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-[652px] px-6 py-4">
          <p className="text-[13px] text-[#70757a]">About {(9_420_000 + query.length * 131_000).toLocaleString()} results (0.31 seconds)</p>
          <ul className="mt-5 flex flex-col gap-7">
            {results.slice(0, 2).map((result) => (
              <Result
                key={result.url}
                site={result.title.split(" - ").pop() ?? result.title}
                url={result.url}
                title={result.title}
                blurb={BLURBS[result.page]}
                icon={<img src={result.faviconUrl} alt="" className="size-[26px] shrink-0 rounded-full border border-[#ecedef] bg-white p-1" />}
              />
            ))}
            <li>
              <PeopleAlsoAsk items={extras.ask} />
            </li>
            {extras.web.slice(0, 2).map((result) => (
              <Result key={result.url} {...result} icon={siteMark(result.site, result.tone)} />
            ))}
            <li>
              <h2 className="text-[20px]">Videos</h2>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {VIDEOS.slice(0, 3).map((video) => (
                  <A key={video.id} href={`https://www.youtube.com/watch?v=${video.id}`} className="block">
                    <VideoThumb video={video} className="aspect-video w-full rounded-lg" />
                    <div className="mt-1.5 line-clamp-2 text-[13px] leading-[18px] text-[#1a0dab]">{video.title}</div>
                    <div className="mt-0.5 text-[12px] text-[#70757a]">
                      YouTube · {video.channel} · {video.age}
                    </div>
                  </A>
                ))}
              </div>
            </li>
            {results.slice(2).map((result) => (
              <Result
                key={result.url}
                site={result.title.split(" - ").pop() ?? result.title}
                url={result.url}
                title={result.title}
                blurb={BLURBS[result.page]}
                icon={<img src={result.faviconUrl} alt="" className="size-[26px] shrink-0 rounded-full border border-[#ecedef] bg-white p-1" />}
              />
            ))}
            {extras.web.slice(2).map((result) => (
              <Result key={result.url} {...result} icon={siteMark(result.site, result.tone)} />
            ))}
            <li>
              <h2 className="text-[20px]">Related searches</h2>
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                {extras.related.map((related) => (
                  <A key={related} href={`https://www.google.com/search?q=${encodeURIComponent(related)}`} className="flex items-center gap-3 rounded-full bg-[#f1f3f4] px-4 py-2.5 text-[14px] hover:bg-[#e8eaed]">
                    <span className="text-[#5f6368]">{Icon.search}</span>
                    <span className="truncate">{related}</span>
                  </A>
                ))}
              </div>
            </li>
          </ul>
          <div className="mt-10 mb-4 flex items-center justify-center gap-4 text-[14px] text-[#4d5156]">
            <span className="text-[#1f1f1f]">1</span>
            {[2, 3, 4, 5].map((page) => (
              <span key={page} className="text-[#1a0dab]">
                {page}
              </span>
            ))}
            <span className="text-[#1a0dab]">Next ›</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Google Calendar --------------------------- */

/** 8 AM to 6 PM: the rows the week view draws, one per hour, stretched to the pane's height. */
const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const DAY_START = HOURS[0]!;
const DAY_HOURS = HOURS.length;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
/** Tuesday the 22nd: the same day the mini month marks, with "now" drawn across it. */
const TODAY = 1;
const NOW = 10.7;
const EVENTS: Array<{ day: number; start: number; end: number; title: string; tone: string; where?: string }> = [
  { day: 0, start: 9.5, end: 9.75, title: "Standup", tone: "#7986cb" },
  { day: 0, start: 11, end: 12, title: "Q3 planning review", tone: "#f4511e", where: "Room 4" },
  { day: 0, start: 15.5, end: 16.25, title: "Dentist", tone: "#33b679", where: "Mission St" },
  { day: 1, start: 9.5, end: 9.75, title: "Standup", tone: "#7986cb" },
  { day: 1, start: 13, end: 14, title: "Design crit", tone: "#8e24aa", where: "Studio" },
  { day: 2, start: 9.5, end: 9.75, title: "Standup", tone: "#7986cb" },
  { day: 2, start: 10, end: 11.5, title: "Roadmap", tone: "#f4511e", where: "Room 2" },
  { day: 3, start: 9.5, end: 9.75, title: "Standup", tone: "#7986cb" },
  { day: 3, start: 16, end: 17, title: "1:1 with Marcus", tone: "#039be5" },
  { day: 4, start: 9.5, end: 9.75, title: "Standup", tone: "#7986cb" },
  { day: 4, start: 12, end: 13, title: "Team lunch", tone: "#33b679", where: "Tartine" },
];

/** Thursday's lunch the agent books in the demo: `?lunch=draft` while it types, `?lunch=booked` once saved. */
const LUNCH = { day: 3, start: 12.5, end: 13.5, title: "Lunch with Maya", tone: "#039be5" };

function clock(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12)}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

/** An event's box in its day column, as percentages of the stretched day. */
function span(start: number, end: number): CSSProperties {
  return { top: `${String(((start - DAY_START) / DAY_HOURS) * 100)}%`, height: `${String(((end - start) / DAY_HOURS) * 100)}%` };
}

function CalendarEvent({ event }: { event: (typeof EVENTS)[number] }): ReactNode {
  const short = event.end - event.start < 0.5;
  return (
    <div
      className={`absolute inset-x-1 overflow-hidden rounded-md border-l-[3px] text-[11px] leading-[14px] ${short ? "flex items-center gap-1 px-1.5" : "px-1.5 py-1"}`}
      style={{ ...span(event.start, event.end), borderColor: event.tone, background: `color-mix(in srgb, ${event.tone} 16%, #fff)`, color: `color-mix(in srgb, ${event.tone} 70%, #000)` }}
    >
      <span className="truncate font-semibold">{event.title}</span>
      {short ? (
        <span className="hidden shrink-0 opacity-75 @min-[124px]:inline">{clock(event.start)}</span>
      ) : (
        <div className="truncate opacity-75">
          {clock(event.start)} – {clock(event.end)}
          {event.where === undefined ? null : ` · ${event.where}`}
        </div>
      )}
    </div>
  );
}

function GoogleCalendar({ site }: { site: SiteInfo }): ReactNode {
  const lunch = new URL(site.url).searchParams.get("lunch");
  return (
    // A container, so the page lays itself out for the pane it has: the
    // sidebar steps aside when the agent console narrows the pane.
    <div className="@container flex h-full flex-col bg-white text-[#3c4043]">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[#e8eaed] px-3 @min-[640px]:gap-3">
        <span className="flex size-8 items-center justify-center rounded-full text-[18px] text-[#5f6368]">☰</span>
        <img src={site.faviconUrl} alt="" className="size-7" />
        <span className="hidden text-[18px] text-[#5f6368] @min-[560px]:inline">Calendar</span>
        <span className="ml-1 rounded-md border border-[#dadce0] px-3 py-1 text-[13px] font-medium @min-[560px]:ml-4">Today</span>
        <span className="flex text-[15px] text-[#5f6368]">
          <span className="px-1">‹</span>
          <span className="px-1">›</span>
        </span>
        <span className="truncate text-[17px] whitespace-nowrap">September 2026</span>
        <span className="ml-auto hidden items-center gap-1 rounded-md border border-[#dadce0] px-2.5 py-1 text-[13px] font-medium @min-[480px]:flex">Week ▾</span>
        <Avatar name="You" tone="#1a73e8" size={28} />
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[184px] shrink-0 flex-col gap-4 px-3 pt-3 @min-[760px]:flex">
          <span className="flex w-fit items-center gap-1.5 rounded-xl bg-white px-3.5 py-2 text-[13px] font-medium shadow-[0_1px_2px_rgba(60,64,67,0.3),0_1px_3px_1px_rgba(60,64,67,0.15)]">
            <span className="text-[18px] leading-none text-[#1a73e8]">＋</span> Create
          </span>
          <div>
            <div className="mb-1 flex items-center justify-between px-1 text-[12px] font-medium">
              September 2026 <span className="text-[#5f6368]">‹ ›</span>
            </div>
            <div className="grid grid-cols-7 text-center text-[9.5px] leading-[20px]">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <span key={i} className="font-medium text-[#70757a]">
                  {d}
                </span>
              ))}
              {Array.from({ length: 35 }, (_, i) => {
                const day = i - 1;
                const inMonth = day >= 1 && day <= 30;
                const week = day >= 20 && day <= 26;
                return (
                  <span key={i} className={week ? "bg-[#e8f0fe] first:rounded-l-full" : ""}>
                    <span
                      className={`mx-auto flex size-5 items-center justify-center rounded-full ${day === 22 ? "bg-[#1a73e8] font-semibold text-white" : inMonth ? "" : "text-[#bdc1c6]"}`}
                    >
                      {inMonth ? day : day < 1 ? 31 + day : day - 30}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
          <div className="text-[12px]">
            <div className="mb-1 px-1 font-medium">My calendars</div>
            {[
              ["You", "#039be5"],
              ["Team", "#7986cb"],
              ["Family", "#33b679"],
              ["Birthdays", "#0b8043"],
            ].map(([name, tone]) => (
              <div key={name} className="flex items-center gap-2 px-1 py-[3px]">
                <span className="flex size-3 items-center justify-center rounded-[3px] text-[8px] leading-none text-white" style={{ background: tone }}>
                  ✓
                </span>
                {name}
              </div>
            ))}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col border-l border-[#e8eaed] @max-[759px]:border-l-0">
          <div className="grid shrink-0 grid-cols-[48px_repeat(5,1fr)] border-b border-[#e8eaed]">
            <div />
            {DAYS.map((day, index) => (
              <div key={day} className="flex flex-col items-center py-1.5">
                <span className={`text-[10px] font-medium tracking-wide uppercase ${index === TODAY ? "text-[#1a73e8]" : "text-[#70757a]"}`}>{day}</span>
                <span
                  className={`mt-0.5 flex size-9 items-center justify-center rounded-full text-[20px] ${index === TODAY ? "bg-[#1a73e8] text-white" : "text-[#3c4043]"}`}
                >
                  {21 + index}
                </span>
              </div>
            ))}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[48px_repeat(5,1fr)]">
            <div className="relative">
              {HOURS.slice(1).map((hour, index) => (
                <span key={hour} className="absolute right-2 -translate-y-1/2 text-[10px] text-[#70757a]" style={{ top: `${String(((index + 1) / DAY_HOURS) * 100)}%` }}>
                  {clock(hour).toUpperCase().replace(/(AM|PM)$/u, " $1")}
                </span>
              ))}
            </div>
            {DAYS.map((day, dayIndex) => (
              <div key={day} className="@container relative border-l border-[#e8eaed]">
                {HOURS.slice(1).map((hour, index) => (
                  <div key={hour} className="absolute inset-x-0 border-t border-[#e8eaed]" style={{ top: `${String(((index + 1) / DAY_HOURS) * 100)}%` }} />
                ))}
                {EVENTS.filter((event) => event.day === dayIndex).map((event) => (
                  <CalendarEvent key={event.title + String(event.start)} event={event} />
                ))}
                {dayIndex === LUNCH.day && (lunch === "draft" || lunch === "booked") ? (
                  <div
                    data-testid="calendar-lunch"
                    className={`absolute inset-x-1 overflow-hidden rounded-md px-1.5 py-1 text-[11px] leading-[14px] ${
                      lunch === "draft" ? "border-2 border-dashed border-[#1a73e8] bg-[#e8f0fe] text-[#1967d2]" : "text-white shadow-[0_0_0_2px_#fff,0_0_0_4px_#1a73e8]"
                    }`}
                    style={{ ...span(LUNCH.start, LUNCH.end), background: lunch === "booked" ? LUNCH.tone : undefined }}
                  >
                    <div className="truncate font-semibold">{lunch === "draft" ? "(No title)" : LUNCH.title}</div>
                    <div className="truncate opacity-90">
                      {clock(LUNCH.start)} – {clock(LUNCH.end)}
                    </div>
                  </div>
                ) : null}
                {dayIndex === TODAY ? (
                  <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-[#ea4335]" style={{ top: span(NOW, NOW).top }}>
                    <span className="absolute -top-[6px] -left-[5px] size-2.5 rounded-full bg-[#ea4335]" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ ChatGPT, Claude -------------------------- */

const CHAT: Array<{ role: "user" | "assistant"; text: string }> = [
  { role: "user", text: "What's the difference between a browser agent and a regular chatbot?" },
  {
    role: "assistant",
    text: "A chatbot answers in a text box. A browser agent works inside your browser: it can open tabs, read pages you're signed in to, fill forms and click through flows on your behalf, then show you what it did. The trade-off is trust — a good one pauses before anything irreversible (a purchase, a send) and lets you take over at any point.",
  },
  { role: "user", text: "Give me three errands worth handing off." },
  {
    role: "assistant",
    text: "1. Rebooking a flight and moving the hotel to match.\n2. Comparing the same cart across two grocery sites and ordering the cheaper one.\n3. Cancelling a subscription that buries the cancel button four pages deep.",
  },
];

function ChatGPT({ site }: { site: SiteInfo }): ReactNode {
  return (
    <div className="flex h-full bg-white text-[#0d0d0d]">
      <nav className="hidden w-64 shrink-0 flex-col bg-[#f9f9f9] p-3 text-[14px] md:flex">
        <div className="flex items-center justify-between px-2 py-1">
          <img src={site.faviconUrl} alt="" className="size-6" />
          <span className="text-[#5d5d5d]">✎</span>
        </div>
        <div className="mt-4 flex flex-col gap-0.5">
          {["New chat", "Search chats", "Library"].map((item) => (
            <span key={item} className="rounded-lg px-2 py-1.5 hover:bg-[#ececec]">
              {item}
            </span>
          ))}
        </div>
        <div className="mt-5 px-2 text-[12px] text-[#8f8f8f]">Chats</div>
        {["Browser agents vs chatbots", "Pistachio recipe ideas", "Q3 planning summary", "Flight change wording", "Regex for favicon URLs"].map((chat, i) => (
          <span key={chat} className={`truncate rounded-lg px-2 py-1.5 ${i === 0 ? "bg-[#ececec]" : ""}`}>
            {chat}
          </span>
        ))}
        <div className="mt-auto flex items-center gap-2 px-2 py-2">
          <Avatar name="You" tone="#10a37f" size={28} />
          <span>
            You <span className="text-[#8f8f8f]">Plus</span>
          </span>
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center px-4 text-[18px] font-medium">
          ChatGPT <span className="ml-1 text-[#8f8f8f]">5 ▾</span>
          <span className="ml-auto rounded-full border border-[#e3e3e3] px-3 py-1 text-[13px]">Share</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-4 text-[16px] leading-7">
            {CHAT.map((message, i) =>
              message.role === "user" ? (
                <div key={i} className="ml-auto max-w-[70%] rounded-3xl bg-[#f4f4f4] px-5 py-2.5">
                  {message.text}
                </div>
              ) : (
                <div key={i} className="whitespace-pre-line">
                  {message.text}
                </div>
              ),
            )}
          </div>
        </div>
        <div className="shrink-0 px-6 pb-4">
          <div className="mx-auto flex max-w-[720px] items-center gap-3 rounded-[28px] border border-[#e3e3e3] px-4 py-3 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
            <span className="text-[20px] text-[#5d5d5d]">＋</span>
            <span className="flex-1 text-[16px] text-[#8f8f8f]">Ask anything</span>
            <span className="flex size-9 items-center justify-center rounded-full bg-black text-white">{Icon.send}</span>
          </div>
          <p className="mt-2 text-center text-[12px] text-[#8f8f8f]">ChatGPT can make mistakes. Check important info.</p>
        </div>
      </main>
    </div>
  );
}

function Claude({ site }: { site: SiteInfo }): ReactNode {
  return (
    <div className="flex h-full bg-[#faf9f5] font-serif text-[#29261b]">
      <nav className="hidden w-64 shrink-0 flex-col border-r border-[#e8e6dc] bg-[#f5f4ed] p-3 font-sans text-[14px] md:flex">
        <div className="flex items-center gap-2 px-2 py-1">
          <img src={site.faviconUrl} alt="" className="size-6 rounded-md" />
          <span className="font-serif text-[18px]">Claude</span>
        </div>
        <span className="mt-4 rounded-lg bg-[#d97757] px-3 py-2 text-center text-white">＋ New chat</span>
        <div className="mt-4 flex flex-col gap-0.5">
          {["Chats", "Projects", "Artifacts"].map((item) => (
            <span key={item} className="rounded-lg px-2 py-1.5 text-[#5e5a4d] hover:bg-[#ebe9df]">
              {item}
            </span>
          ))}
        </div>
        <div className="mt-5 px-2 text-[12px] text-[#8b8778]">Recents</div>
        {["Browser agents vs chatbots", "Draft: rebooking email", "Pistachio orchard math", "Weekend plan in Tahoe"].map((chat, i) => (
          <span key={chat} className={`truncate rounded-lg px-2 py-1.5 ${i === 0 ? "bg-[#ebe9df]" : "text-[#5e5a4d]"}`}>
            {chat}
          </span>
        ))}
        <div className="mt-auto flex items-center gap-2 px-2 py-2">
          <Avatar name="You" tone="#d97757" size={28} />
          <span className="text-[#5e5a4d]">You · Pro</span>
        </div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-8 text-[16.5px] leading-7">
            {CHAT.map((message, i) =>
              message.role === "user" ? (
                <div key={i} className="ml-auto max-w-[75%] rounded-2xl bg-[#efede4] px-4 py-2.5 font-sans text-[15px]">
                  {message.text}
                </div>
              ) : (
                <div key={i} className="flex gap-3">
                  <img src={site.faviconUrl} alt="" className="mt-1 size-6 shrink-0 rounded-md" />
                  <div className="whitespace-pre-line">{message.text}</div>
                </div>
              ),
            )}
          </div>
        </div>
        <div className="shrink-0 px-6 pb-5 font-sans">
          <div className="mx-auto max-w-[720px] rounded-2xl border border-[#e0ddd0] bg-white px-4 py-3 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
            <div className="text-[15px] text-[#8b8778]">Reply to Claude…</div>
            <div className="mt-3 flex items-center gap-3 text-[13px] text-[#5e5a4d]">
              <span>＋</span>
              <span className="rounded-md border border-[#e0ddd0] px-2 py-0.5">Claude ▾</span>
              <span className="ml-auto flex size-8 items-center justify-center rounded-lg bg-[#d97757] text-white">{Icon.send}</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* -------------------------------- Wikipedia ------------------------------ */

function WikiH2({ children }: { children: ReactNode }): ReactNode {
  return <h2 className="mt-6 mb-2 overflow-hidden border-b border-[#a2a9b1] font-serif text-[22px] leading-snug">{children}</h2>;
}

function Wikipedia({ site }: { site: SiteInfo }): ReactNode {
  const link = "text-[#36c]";
  const cite = (n: number): ReactNode => <sup className={`${link} text-[10px]`}>[{n}]</sup>;
  const taxo: Array<[string, ReactNode]> = [
    ["Kingdom:", "Plantae"],
    ["Clade:", "Tracheophytes"],
    ["Clade:", "Angiosperms"],
    ["Clade:", "Eudicots"],
    ["Clade:", "Rosids"],
    ["Order:", "Sapindales"],
    ["Family:", "Anacardiaceae"],
    ["Genus:", <i key="g">Pistacia</i>],
    ["Species:", <i key="s">P. vera</i>],
  ];
  const nutrition: Array<[string, string, boolean?]> = [
    ["Energy", "2,351 kJ (562 kcal)"],
    ["Carbohydrates", "27.2 g"],
    ["Sugars", "7.7 g", true],
    ["Dietary fiber", "10.6 g", true],
    ["Fat", "45.3 g"],
    ["Protein", "20.2 g"],
    ["Vitamin B6", "1.7 mg"],
    ["Potassium", "1,025 mg"],
  ];
  const toc = ["(Top)", "Etymology", "Description", "Distribution and habitat", "Cultivation", "Production", "Nutrition", "Uses", "See also", "References"];
  return (
    <div className="flex h-full flex-col bg-white text-[#202122]">
      <div className="flex h-14 shrink-0 items-center gap-4 px-5">
        <span className="text-[20px] text-[#54595d]">☰</span>
        <A href={siteLink(site, "/wiki/Main_Page")} className="flex items-center gap-2">
          <img src={site.faviconUrl} alt="" className="size-9" />
          <span className="flex flex-col leading-none">
            <span className="font-serif text-[17px] tracking-[0.08em]">WIKIPEDIA</span>
            <span className="mt-0.5 font-serif text-[10px] text-[#54595d] italic">The Free Encyclopedia</span>
          </span>
        </A>
        <div className="ml-6 flex h-8 w-full max-w-[420px] items-center rounded-sm border border-[#a2a9b1] text-[13px] text-[#72777d]">
          <span className="flex flex-1 items-center gap-2 px-2">{Icon.search} Search Wikipedia</span>
          <span className="flex h-full items-center border-l border-[#a2a9b1] bg-[#f8f9fa] px-3 font-bold text-[#202122]">Search</span>
        </div>
        <span className="ml-auto flex items-center gap-4 text-[13px] text-[#36c]">
          <span className="hidden lg:inline">Donate</span>
          <span className="hidden lg:inline">Create account</span>
          <span>Log in</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <nav className="sticky top-0 hidden w-48 shrink-0 self-start p-4 text-[13px] leading-[1.5] md:block">
          <div className="flex items-center justify-between border-b border-[#c8ccd1] pb-1.5 font-bold">
            Contents <span className="rounded-sm border border-[#a2a9b1] px-1.5 text-[11px] font-normal text-[#202122]">hide</span>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {toc.map((item, i) => (
              <A key={item} href={siteLink(site, `/wiki/Pistachio#${item.replace(/ /g, "_")}`)} className={i === 0 ? "font-bold text-[#202122]" : link}>
                {item}
              </A>
            ))}
          </div>
        </nav>
        <article className="min-w-0 flex-1 px-8 pt-5 pb-12">
          <div className="flex items-end justify-between border-b border-[#a2a9b1] pb-1">
            <h1 className="font-serif text-[28px] leading-tight">Pistachio</h1>
            <span className="mb-1 rounded-sm border border-[#a2a9b1] px-2 py-0.5 text-[13px] font-bold text-[#36c]">文A 79 languages ⌄</span>
          </div>
          <div className="mt-1 flex gap-4 border-b border-[#eaecf0] text-[13px]">
            <span className="border-b-2 border-[#202122] pb-1.5">Article</span>
            <span className={link}>Talk</span>
            <span className="ml-auto border-b-2 border-[#202122] pb-1.5">Read</span>
            <span className={link}>Edit</span>
            <span className={link}>View history</span>
            <span className={link}>Tools ⌄</span>
          </div>
          <p className="mt-3 text-[12px] text-[#54595d]">From Wikipedia, the free encyclopedia</p>
          <p className="mt-2 border-l-0 pl-6 text-[13px] text-[#202122] italic">
            For other uses, see <span className={link}>Pistachio (disambiguation)</span>.
          </p>
          <div className="mt-3 text-[14px] leading-[1.6]">
            <aside className="mb-4 w-full border border-[#a2a9b1] bg-[#f8f9fa] p-1.5 text-[12.5px] leading-[1.45] lg:float-right lg:ml-5 lg:w-[270px]">
              <div className="bg-[#d3eca3] py-1 text-center text-[14px] font-bold">Pistachio</div>
              <DemoImage src="/img/demo/pistachio-nuts.webp" alt="Split pistachio shells with green kernels and shelled nuts" width={690} height={600} className="mx-auto mt-2 block h-auto w-[230px]" />
              <div className="mt-1 text-center text-[11.5px]">Pistachio nuts, shelled and in the shell</div>
              <div className="mt-2 bg-[#d3eca3] py-0.5 text-center font-bold">Scientific classification</div>
              <table className="mt-1 w-full">
                <tbody>
                  {taxo.map(([rank, name], i) => (
                    <tr key={i}>
                      <td className="w-[45%] py-px pr-2 align-top">{rank}</td>
                      <td className={`py-px ${link}`}>{name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 bg-[#d3eca3] py-0.5 text-center font-bold">Binomial name</div>
              <div className="py-1 text-center">
                <b>
                  <i>Pistacia vera</i>
                </b>
                <div className="text-[11.5px]">L.</div>
              </div>
            </aside>
            <p>
              The <b>pistachio</b> (<i>Pistacia vera</i>) is a small to medium-sized tree of the <span className={link}>cashew family</span>, native to{" "}
              <span className={link}>Central Asia</span> and the <span className={link}>Middle East</span>. The tree produces <span className={link}>seeds</span> that
              are widely consumed as food.{cite(1)} <i>Pistacia vera</i> is often confused with other species in the genus <i>Pistacia</i> that are also known as
              pistachio. These other species can be distinguished by their geographic distributions and their seeds, which are much smaller and have a soft shell.
              {cite(2)}
            </p>
            <p className="mt-3">
              In 2022, world production of pistachios was roughly one million tonnes, with the <span className={link}>United States</span>,{" "}
              <span className={link}>Iran</span> and <span className={link}>Turkey</span> together accounting for the large majority of the total.{cite(3)}
            </p>

            <WikiH2>Etymology</WikiH2>
            <p>
              <i>Pistachio</i> is from late Middle English <i>pistace</i>, from Old French, superseded in the 16th century by forms from Italian <i>pistaccio</i>, via
              Latin from Greek <i>pistákion</i>, from Middle Persian <i>pistakē</i>.{cite(4)}
            </p>

            <WikiH2>Description</WikiH2>
            <p>
              The tree grows up to 10 m (33 ft) tall. It has <span className={link}>deciduous</span>, <span className={link}>pinnate</span> leaves 10–20 cm long. The
              plants are <span className={link}>dioecious</span>, with separate male and female trees. The flowers are apetalous and unisexual and borne in{" "}
              <span className={link}>panicles</span>.{cite(5)}
            </p>
            <p className="mt-3">
              The fruit is a <span className={link}>drupe</span>, containing an elongated seed, which is the edible portion. The seed, commonly thought of as a nut, is a
              culinary nut, not a botanical nut. The fruit has a hard, cream-colored exterior shell. The seed has a mauvish skin and light green flesh, with a
              distinctive flavor. When the fruit ripens, the shell changes from green to an autumnal yellow/red, and abruptly splits partly open.{cite(6)}
            </p>

            <WikiH2>Distribution and habitat</WikiH2>
            <p>
              Pistachio is a desert plant and is highly tolerant of <span className={link}>saline soil</span>. It has been reported to grow well when irrigated with
              water having 3,000–4,000 ppm of soluble salts.{cite(7)} Pistachio trees are fairly hardy in the right conditions and can survive temperatures ranging
              between −10 °C (14 °F) in winter and 48 °C (118 °F) in summer. They need a sunny position and well-drained soil.
            </p>

            <WikiH2>Cultivation</WikiH2>
            <figure className="mb-3 border border-[#c8ccd1] bg-[#f8f9fa] p-1 text-[12px] leading-snug sm:float-right sm:ml-4 sm:w-[230px]">
              <DemoImage src="/img/demo/pistachio-orchard.webp" alt="Rows of pistachio trees with ripe clusters in a California orchard" width={1200} height={675} className="block h-auto w-full" />
              <figcaption className="px-1 pt-1">A pistachio orchard in the San Joaquin Valley, California</figcaption>
            </figure>
            <p>
              The trees are planted in orchards, and take approximately seven to ten years to reach significant production. Production is alternate-bearing, or{" "}
              <span className={link}>biennial-bearing</span>, meaning the harvest is heavier in alternate years. Peak production is reached around 20 years. Trees
              are usually pruned to size to make the harvest easier.{cite(8)}
            </p>
            <p className="mt-3">
              One male tree produces enough pollen for eight to twelve nut-bearing females. Harvesting in the United States and in Greece is often accomplished by
              using equipment to shake the drupes off the tree. After hulling and drying, pistachios are sorted according to open-mouth and closed-mouth shells, then
              roasted or processed by special machines to produce pistachio kernels.
            </p>

            <WikiH2>Production</WikiH2>
            <p>
              The United States, Iran and Turkey are the world&apos;s leading producers, followed by Syria and China. Nearly all of the American crop is grown in{" "}
              <span className={link}>California</span>, mostly in the <span className={link}>San Joaquin Valley</span>, with smaller plantings in Arizona and New
              Mexico. In Iran, production centres on <span className={link}>Kerman Province</span>, where the tree has been cultivated for centuries.{cite(3)}
            </p>
            <p className="mt-3">
              Because orchards bear alternately, national harvests swing sharply from one year to the next, and a frost or heat wave in a single major region can move
              world prices.
            </p>

            <WikiH2>Nutrition</WikiH2>
            <aside className="mb-3 border border-[#a2a9b1] bg-[#f8f9fa] p-1.5 text-[12.5px] sm:float-right sm:ml-4 sm:w-[230px]">
              <div className="bg-[#d3eca3] py-0.5 text-center font-bold">Pistachio nuts, raw</div>
              <div className="py-1 text-center text-[11.5px]">Nutritional value per 100 g (3.5 oz)</div>
              <table className="w-full">
                <tbody>
                  {nutrition.map(([name, amount, sub]) => (
                    <tr key={name} className="border-t border-[#c8ccd1]">
                      <td className={`py-0.5 ${sub === true ? "pl-3" : "font-bold"}`}>{name}</td>
                      <td className="py-0.5 text-right">{amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </aside>
            <p>
              Raw pistachios are 4% water, 45% fat, 27% carbohydrates, and 20% protein. In a 100-gram reference amount, pistachios provide 2,350 kilojoules (562
              kilocalories) of <span className={link}>food energy</span> and are a rich source of protein, <span className={link}>dietary fiber</span>, several{" "}
              <span className={link}>dietary minerals</span> and the <span className={link}>B vitamins</span> thiamin and vitamin B6.{cite(9)}
            </p>

            <WikiH2>Uses</WikiH2>
            <p>
              The kernels are often eaten whole, either fresh or roasted and salted, and are also used in <span className={link}>pistachio ice cream</span>,{" "}
              <span className={link}>baklava</span>, <span className={link}>halva</span>, pistachio butter and pistachio paste, and in savory dishes such as{" "}
              <span className={link}>mortadella</span>.
            </p>

            <WikiH2>See also</WikiH2>
            <ul className="list-disc pl-6">
              {["List of culinary nuts", "Pistacia atlantica", "Pistachio ice cream", "Alternate bearing"].map((item) => (
                <li key={item} className={link}>
                  {item}
                </li>
              ))}
            </ul>

            <WikiH2>References</WikiH2>
            <ol className="list-decimal pl-6 text-[12.5px] leading-[1.5]">
              {[
                "“Pistacia vera”. Germplasm Resources Information Network. Agricultural Research Service, USDA.",
                "Hormaza, J. I.; Wünsch, A. (2007). “Pistachio”. Fruits and Nuts. Genome Mapping and Molecular Breeding in Plants.",
                "“Pistachio production in 2022, Crops/Regions/World list/Production Quantity”. FAOSTAT, UN Food and Agriculture Organization.",
                "“Pistachio”. Oxford Dictionaries. Oxford University Press.",
                "“Pistacia vera”. Flora of China. Missouri Botanical Garden.",
                "Rieger, Mark. “Pistachio – Pistacia vera”. University of Georgia.",
                "Ferguson, Louise (2005). Pistachio Production Manual. University of California.",
                "“Pistachio growing in California”. UC Davis Fruit & Nut Research.",
                "“Nuts, pistachio nuts, raw per 100 g”. FoodData Central, USDA.",
              ].map((ref) => (
                <li key={ref} className="mt-0.5">
                  <span className={link}>^</span> {ref}
                </li>
              ))}
            </ol>
            <div className="clear-both mt-8 border-t border-[#a2a9b1] pt-3 text-[12px] text-[#54595d]">
              This page was last edited on 14 September 2026, at 09:12 (UTC). Text is available under the Creative Commons Attribution-ShareAlike 4.0 License.
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}

/* --------------------------------- GitHub -------------------------------- */

const FEED: Array<{ who: string; tone: string; did: string; repo: string; blurb: string; stars: string; when: string }> = [
  { who: "priyanat", tone: "#e0532f", did: "starred", repo: "zmeyer44/pistachio", blurb: "A browser built for tomorrow. A Mac browser with an agent built in.", stars: "2.4k", when: "2 hours ago" },
  { who: "marcusbell", tone: "#5e6ad2", did: "released", repo: "zmeyer44/pistachio", blurb: "v0.0.17 — split panes remember their widths, home page shows your day, Tidy puts idle tabs away.", stars: "2.4k", when: "yesterday" },
  { who: "danaok", tone: "#0b7a75", did: "forked", repo: "smart-find/smart-find", blurb: "Find by meaning, not by string. Ctrl+F for people who forget the exact word.", stars: "812", when: "2 days ago" },
  { who: "adabuilds", tone: "#1e3a8a", did: "starred", repo: "dom-mirror/dom-mirror", blurb: "Mirror a live document into another window, patches only, assets on demand.", stars: "1.1k", when: "3 days ago" },
];

function GitHubBar({ site, crumbs }: { site: SiteInfo; crumbs: ReactNode }): ReactNode {
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-[#d1d9e0] bg-[#f6f8fa] px-4 text-[14px]">
      <span className="text-[20px]">☰</span>
      <A href={siteLink(site, "/")}>
        <img src={site.faviconUrl} alt="" className="size-8" />
      </A>
      <span className="flex items-center gap-2">{crumbs}</span>
      <div className="ml-auto flex h-8 w-64 items-center gap-2 rounded-md border border-[#d1d9e0] bg-white px-2 text-[#59636e]">
        {Icon.search} Type <kbd className="rounded border px-1 text-[11px]">/</kbd> to search
      </div>
      <Avatar name="You" tone="#8250df" size={28} />
    </div>
  );
}

/** github.com signed in: the dashboard — repositories on the left, the feed in the middle. */
function GitHubHome({ site }: { site: SiteInfo }): ReactNode {
  return (
    <div className="flex h-full flex-col bg-white text-[#1f2328]">
      <GitHubBar site={site} crumbs={<b>Dashboard</b>} />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 flex-col border-r border-[#d1d9e0] bg-[#f6f8fa] p-4 text-[14px] md:flex">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Top repositories</span>
            <span className="rounded-md bg-[#1f883d] px-2 py-1 text-[12px] font-medium text-white">New</span>
          </div>
          <div className="mt-2 flex h-7 items-center rounded-md border border-[#d1d9e0] bg-white px-2 text-[12px] text-[#59636e]">Find a repository…</div>
          <ul className="mt-3 flex flex-col gap-2">
            {[["zmeyer44", "pistachio"], ["zmeyer44", "sidetrack"], ["smart-find", "smart-find"], ["dom-mirror", "dom-mirror"], ["zmeyer44", "dotfiles"]].map(([owner, name]) => (
              <li key={name}>
                <A href={siteLink(site, `/${owner}/${name}`)} className="flex items-center gap-2 hover:underline">
                  <Avatar name={owner!} tone={owner === "zmeyer44" ? "#0969da" : "#8250df"} size={16} />
                  <span className="truncate">
                    {owner}/<b>{name}</b>
                  </span>
                </A>
              </li>
            ))}
          </ul>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-6 py-5">
            <h1 className="text-[20px] font-semibold">Home</h1>
            <div className="mt-3 flex h-10 items-center rounded-md border border-[#d1d9e0] px-3 text-[14px] text-[#59636e]">Ask Copilot</div>
            <div className="mt-6 flex flex-col gap-3">
              {FEED.map((item) => (
                <div key={item.who + item.repo} className="rounded-md border border-[#d1d9e0] p-4 text-[14px]">
                  <div className="flex items-center gap-2 text-[#59636e]">
                    <Avatar name={item.who} tone={item.tone} size={20} />
                    <b className="text-[#1f2328]">{item.who}</b> {item.did} <span>· {item.when}</span>
                  </div>
                  <A href={siteLink(site, `/${item.repo}`)} className="mt-2 block text-[16px] font-semibold text-[#0969da] hover:underline">
                    {item.repo}
                  </A>
                  <p className="mt-1 text-[#59636e]">{item.blurb}</p>
                  <div className="mt-3 flex gap-4 text-[12px] text-[#59636e]">
                    <span>● TypeScript</span>
                    <span>☆ {item.stars}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
        <aside className="hidden w-80 shrink-0 flex-col gap-3 p-4 text-[14px] lg:flex">
          <div className="rounded-md border border-[#d1d9e0] p-4">
            <div className="font-semibold">Latest changes</div>
            {["Split panes remember their widths", "Home page: schedule and weather", "Tidy: archived groups restore whole"].map((line) => (
              <div key={line} className="mt-2 border-l-2 border-[#d1d9e0] pl-3 text-[13px] text-[#59636e]">{line}</div>
            ))}
          </div>
          <div className="rounded-md border border-[#d1d9e0] p-4">
            <div className="font-semibold">Trending repositories</div>
            {["smart-find/smart-find", "dom-mirror/dom-mirror", "zmeyer44/pistachio"].map((repo) => (
              <A key={repo} href={siteLink(site, `/${repo}`)} className="mt-2 block text-[13px] text-[#0969da] hover:underline">
                {repo}
              </A>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function GitHubRepo({ site }: { site: SiteInfo }): ReactNode {
  const files: Array<[string, string, string]> = [
    ["apps", "web: split panes remember their widths", "2 hours ago"],
    ["packages", "shell-ui: home page schedule", "yesterday"],
    ["services", "cloud-browser: DOM mirror fallback", "2 days ago"],
    ["docs", "web-browser-design.md §16", "3 days ago"],
    ["README.md", "Update install instructions", "last week"],
    ["package.json", "Release 0.0.17", "last week"],
  ];
  return (
    <div className="flex h-full flex-col bg-white text-[#1f2328]">
      <GitHubBar
        site={site}
        crumbs={
          <>
            <A href={siteLink(site, "/zmeyer44")}>zmeyer44</A> / <b>pistachio</b>
          </>
        }
      />
      <div className="flex gap-4 border-b border-[#d1d9e0] px-4 text-[14px]">
        {["Code", "Issues 12", "Pull requests 3", "Actions", "Wiki", "Security", "Insights"].map((tab, i) => (
          <span key={tab} className={`py-2.5 ${i === 0 ? "border-b-2 border-[#fd8c73] font-semibold" : "text-[#59636e]"}`}>
            {tab}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1000px] gap-6 px-5 py-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[14px]">
              <span className="rounded-md border border-[#d1d9e0] bg-[#f6f8fa] px-3 py-1 font-medium">⑂ main ▾</span>
              <span className="text-[#59636e]">6 branches · 17 tags</span>
              <span className="ml-auto rounded-md bg-[#1f883d] px-3 py-1 font-medium text-white">Code ▾</span>
            </div>
            <div className="mt-4 overflow-hidden rounded-md border border-[#d1d9e0] text-[13px]">
              <div className="flex items-center gap-2 bg-[#f6f8fa] px-3 py-2 text-[#59636e]">
                <Avatar name="Z M" tone="#0969da" size={20} />
                <b className="text-[#1f2328]">zmeyer44</b>
                <span className="truncate">Release 0.0.17</span>
                <span className="ml-auto shrink-0">last week · 1,284 commits</span>
              </div>
              {files.map(([name, message, when]) => (
                <A key={name} href={siteLink(site, `/zmeyer44/pistachio/tree/main/${name}`)} className="flex items-center gap-3 border-t border-[#d1d9e0] px-3 py-1.5 hover:bg-[#f6f8fa]">
                  <span className="w-28 shrink-0 text-[#0969da]">
                    {name.includes(".") ? "📄" : "📁"} {name}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[#59636e]">{message}</span>
                  <span className="shrink-0 text-[#59636e]">{when}</span>
                </A>
              ))}
            </div>
            <div className="mt-4 rounded-md border border-[#d1d9e0] p-5">
              <h2 className="text-[24px] font-semibold">Pistachio</h2>
              <p className="mt-2 text-[15px] text-[#59636e]">A browser built for tomorrow. A Mac browser with an agent built in — open source, local by default.</p>
            </div>
          </div>
          <aside className="hidden w-72 shrink-0 text-[14px] lg:block">
            <h3 className="font-semibold">About</h3>
            <p className="mt-2 text-[#59636e]">A Mac browser with an agent that works inside the tabs you are already signed in to.</p>
            <div className="mt-3 flex flex-col gap-1.5 text-[#59636e]">
              <span>☆ 2.4k stars</span>
              <span>👁 41 watching</span>
              <span>⑂ 188 forks</span>
            </div>
            <h3 className="mt-5 font-semibold">Languages</h3>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full">
              <span className="w-[92%] bg-[#3178c6]" />
              <span className="w-[5%] bg-[#563d7c]" />
              <span className="flex-1 bg-[#f1e05a]" />
            </div>
            <div className="mt-2 text-[12px] text-[#59636e]">TypeScript 92% · CSS 5% · JavaScript 3%</div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function GitHub({ site }: { site: SiteInfo }): ReactNode {
  return new URL(site.url).pathname.startsWith(GITHUB_REPO_PATH) ? <GitHubRepo site={site} /> : <GitHubHome site={site} />;
}

/* ------------------------- article, reader, read aloud ------------------------ */

const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

function SubscribeBox(): ReactNode {
  return (
    <div className="my-8 rounded-md bg-[#f7f7f7] px-6 py-6 text-center font-sans">
      <p className="text-[15px] text-[#363737]" style={{ fontFamily: SERIF }}>
        {ARTICLE.site} is a reader-supported publication. To receive new posts and support my work, consider becoming a free or paid subscriber.
      </p>
      <div className="mx-auto mt-4 flex max-w-[380px] overflow-hidden rounded-md border border-black/15 bg-white text-[14px]">
        <span className="flex-1 px-3 py-2 text-left text-[#9a9a9a]">Type your email…</span>
        <span className="bg-[#e05a2b] px-4 py-2 font-semibold text-white">Subscribe</span>
      </div>
    </div>
  );
}

const ARTICLE_STATS = { likes: 214, comments: 38, restacks: 17 };

function PostActions(): ReactNode {
  const pill = "flex items-center gap-1.5 rounded-full border border-black/10 px-3 py-1 text-[13px] text-[#555]";
  return (
    <div className="flex items-center gap-2 border-y border-black/10 py-2.5 font-sans">
      <span className={pill}>
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
        </svg>
        {ARTICLE_STATS.likes}
      </span>
      <span className={pill}>
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
        </svg>
        {ARTICLE_STATS.comments}
      </span>
      <span className={pill}>
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />
        </svg>
        {ARTICLE_STATS.restacks}
      </span>
      <span className={`${pill} ml-auto`}>
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13" />
        </svg>
        Share
      </span>
    </div>
  );
}

/** ARTICLE as a Substack post: the publication's own look, not Pistachio's. */
function Article({ site }: { site: SiteInfo }): ReactNode {
  const [first, ...rest] = ARTICLE.sections;
  const body = "text-[17px] leading-[1.7] text-[#363737]";
  return (
    <div className="flex h-full flex-col bg-white font-sans text-[#363737]">
      <header className="relative flex h-14 shrink-0 items-center border-b border-black/10 px-5">
        <img src={site.faviconUrl} alt="" className="size-8 rounded-md" />
        <b className="absolute left-1/2 -translate-x-1/2 text-[19px] font-bold tracking-tight text-[#1a1a1a]" style={{ fontFamily: SERIF }}>
          {ARTICLE.site}
        </b>
        <span className="ml-auto flex items-center gap-2 text-[13px] font-semibold">
          <span className="rounded-md bg-[#e05a2b] px-3 py-1.5 text-white">Subscribe</span>
          <span className="rounded-md px-3 py-1.5 text-[#555]">Sign in</span>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[680px] px-6 pb-16 pt-10">
          <h1 className="text-[34px] font-bold leading-[1.15] tracking-[-0.01em] text-[#1a1a1a]" style={{ fontFamily: SERIF }}>
            {ARTICLE.title}
          </h1>
          <p className="mt-2 text-[19px] leading-snug text-[#757575]" style={{ fontFamily: SERIF }}>
            On-years, off-years, and the sugar budget behind them
          </p>
          <div className="mt-6 flex items-center gap-3">
            <Avatar name={ARTICLE.byline} tone="#8a6d3b" size={36} />
            <div className="text-[13px] leading-tight">
              <div className="font-semibold text-[#1a1a1a]">{ARTICLE.byline}</div>
              <div className="mt-0.5 uppercase tracking-wide text-[#757575]">
                {ARTICLE.published} · {ARTICLE.minutes} min read
              </div>
            </div>
          </div>
          <div className="mt-5">
            <PostActions />
          </div>
          <figure className="mt-7">
            <div className="overflow-hidden rounded-sm">
              <DemoImage src="/img/demo/pistachio-orchard.webp" alt="Pistachio branches laden with fruit above sunlit orchard rows" width={1200} height={675} className="block aspect-[640/220] w-full" />
            </div>
            <figcaption className="mt-2 text-center text-[13px] text-[#757575]">Late light over a block of Kerman trees, Kern County.</figcaption>
          </figure>
          <div style={{ fontFamily: SERIF }}>
            <p className={`mt-7 ${body}`}>{ARTICLE.lead}</p>
            {first !== undefined && (
              <section>
                <h2 className="mt-8 text-[24px] font-bold text-[#1a1a1a]">{first.heading}</h2>
                <p className={`mt-3 ${body}`}>{first.body}</p>
              </section>
            )}
            <SubscribeBox />
            {rest.map((section) => (
              <section key={section.heading}>
                <h2 className="mt-8 text-[24px] font-bold text-[#1a1a1a]">{section.heading}</h2>
                <p className={`mt-3 ${body}`}>{section.body}</p>
              </section>
            ))}
            <p className={`mt-8 italic ${body}`}>Thanks for reading — see you in the grove in two weeks.</p>
          </div>
          <div className="mt-8">
            <PostActions />
          </div>
          <div className="mt-8 flex items-center justify-between text-[13px] text-[#757575]">
            <span className="font-semibold text-[#1a1a1a]">{ARTICLE_STATS.comments} Comments</span>
            <span>Top · Latest · Discussions</span>
          </div>
        </article>
      </div>
    </div>
  );
}

/** Reader view of ARTICLE: the words on the app's own ground and type, with "Listen" up top. */
function Reader(): ReactNode {
  const { readAloud } = useContext(PaneContext);
  return (
    <div data-testid="demo-reader" className="h-full overflow-y-auto bg-[#fcfcfa] text-[#1d1d1b]">
      <div className="mx-auto max-w-[620px] px-8 py-10">
        <div className="text-[12px] text-[#77776f]">
          {ARTICLE.site} · <span className="font-mono">thegroveletter.com</span>
        </div>
        <h1 className="mt-3 text-[32px] font-semibold leading-[1.15] tracking-[-0.02em]">{ARTICLE.title}</h1>
        <div className="mt-2 font-mono text-[12px] text-[#77776f]">
          {ARTICLE.byline} · {ARTICLE.published} · {ARTICLE.minutes} min read
        </div>
        <button
          type="button"
          data-testid="demo-listen"
          onClick={() => readAloud?.()}
          className="mt-4 flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1.5 text-[12px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] hover:bg-[#f3f3ef]"
        >
          <span className="text-[9px]">▶</span> Listen to article
        </button>
        <p className="mt-7 text-[16px] leading-[1.75]">{ARTICLE.lead}</p>
        {ARTICLE.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="mt-7 text-[19px] font-semibold">{section.heading}</h2>
            <p className="mt-2 text-[16px] leading-[1.75]">{section.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The tab a "Read aloud" clip plays in: the article's title over a waveform. */
function ReadAloud(): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-[#f6f6f3] text-[#1d1d1b]">
      <div className="text-[12px] uppercase tracking-[0.2em] text-[#77776f]">Read aloud</div>
      <div className="max-w-[420px] text-center text-[22px] font-semibold leading-snug">{ARTICLE.title}</div>
      <div className="flex h-10 items-center gap-[3px]">
        {Array.from({ length: 36 }, (_, i) => (
          <span key={i} className="demo-wave w-[3px] rounded-full bg-[#52a862]" style={{ height: `${20 + ((i * 37) % 60)}%`, animationDelay: `${(i % 9) * 90}ms` }} />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- generic ------------------------------- */

function Generic({ site }: { site: SiteInfo }): ReactNode {
  const host = (() => {
    try {
      return new URL(site.url).hostname;
    } catch {
      return site.url;
    }
  })();
  return (
    <div className="flex h-full flex-col bg-white text-[#1f2933]">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-black/8 px-5">
        <img src={site.faviconUrl} alt="" className="size-6 rounded-md" />
        <span className="text-[14px] font-semibold">{site.title}</span>
        <span className="ml-auto flex gap-3 text-[12px] text-[#7b8794]">
          <span>Product</span>
          <span>Pricing</span>
          <span>Docs</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[640px] px-6 py-10">
          <h1 className="text-[28px] font-bold tracking-tight">{host}</h1>
          <p className="mt-2 text-[14px] text-[#52606d]">
            This preview paints its own pages, so {host} shows as a sketch. In the Mac app this tab would be the real site, signed in as you.
          </p>
          <div className="mt-6 grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 rounded-lg bg-[#f1f4f7]" />
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2">
            {[100, 92, 76, 88, 60].map((width, i) => (
              <div key={i} className="h-3 rounded bg-[#eef1f4]" style={{ width: `${width}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The page for an address. */
export function MockPage({ url }: { url: string }): ReactNode {
  const site = describeUrl(url);
  switch (site.page) {
    case "x":
      return <X site={site} />;
    case "youtube":
      return <YouTube site={site} />;
    case "google":
      return <Google site={site} />;
    case "google-calendar":
      return <GoogleCalendar site={site} />;
    case "chatgpt":
      return <ChatGPT site={site} />;
    case "claude":
      return <Claude site={site} />;
    case "wikipedia":
      return <Wikipedia site={site} />;
    case "github":
      return <GitHub site={site} />;
    case "article":
      return <Article site={site} />;
    case "reader":
      return <Reader />;
    case "read-aloud":
      return <ReadAloud />;
    default:
      return <Generic site={site} />;
  }
}
