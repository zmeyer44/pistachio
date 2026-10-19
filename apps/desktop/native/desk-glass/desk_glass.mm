// The window's own glass under the desk's nub over a live page (docs/desk-agent.md §1, "The Bar"; main/desk-glass.ts).
//
// Over a live page the nub is main's "notch" view (NotchApp), not a hole down to the shell's ground: a tab's view
// paints over everything the shell draws. With the desktop glass on, that ground is AppKit's behind-window material,
// which no renderer can read — it follows whatever lies behind the window — so the view can only paint a stand-in
// grey. This puts the material itself there: an NSVisualEffectView set up as the window's own (Electron's vibrancy
// view, at the foot of the window's content view), inside the notch view's own NSView, so it moves, stacks, shows and
// hides with the view without being told. Behind-window blending samples what is behind the WINDOW, not the page
// between, so it is the same glass the gutter shows (measured 2026-10-15: within 1 level of the gutter over a black, a
// white and a blue window behind; the stand-in was 21 off over black).
//
// Chromium draws no page into its own NSView: every view's page — the shell, the tabs, the notch view — is composited
// into one layer under all of their NSViews (the views compositor's), so the glass, above that layer, hides the notch
// view's own page too. The nub is drawn again above the glass, in a layer that takes no pointer (the notch view's
// NSView still has it), from frames main hands in (frame()): the notch view's page painted offscreen, which paints the
// nub as it lies on the glass — the shell's tint, the theme's gradient, the grain, the mark: the gutter's own layers —
// and below it the nub's outline alone, opaque, which the glass is cut to. One frame holds both, laid in one pass, so
// the glass's edge and the nub on it never part: they move as one, at the rate the frames come (the display's). Until
// the first, the glass shows nowhere, and the view's own stand-in is what shows.
//
// Electron gives no handle to a WebContentsView's NSView: the notch view's is found as the one whose frame is the
// view's box (attach), once — it stays the same NSView for the life of the view.
//
// Node-API only, so it loads in Electron as built against Node's headers (as node-pty's prebuilt binary does).

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

#include <cmath>

/** The nub laid over the glass, in a layer of its own, which takes no pointer. */
@interface PistachioDeskGlassPage : NSView
@end

@implementation PistachioDeskGlassPage
- (NSView*)hitTest:(NSPoint)point {
  return nil;
}
@end

/** Our glass, the nub over it, and the notch view's NSView they lie in (each held by the view hierarchy, not by us). */
static __weak NSVisualEffectView* gGlass = nil;
static __weak PistachioDeskGlassPage* gPage = nil;
static __weak NSView* gHost = nil;

/** A glass cut to nothing: none of it shows until a frame says where the nub is. */
static NSImage* noMask(NSSize size) {
  return [NSImage imageWithSize:size flipped:NO drawingHandler:^BOOL(NSRect) {
    return YES;
  }];
}

static NSView* contentViewOf(napi_env env, napi_value handle) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length < sizeof(void*)) return nil;
  NSView* view = (__bridge NSView*)(*static_cast<void**>(data));
  return view.window.contentView;
}

/** The window's own glass: Electron's vibrancy view, the first NSVisualEffectView in its content view that is not ours. */
static NSVisualEffectView* windowGlass(NSView* content) {
  for (NSView* view in content.subviews)
    if ([view isKindOfClass:[NSVisualEffectView class]] && view != gGlass) return (NSVisualEffectView*)view;
  return nil;
}

/** A view's frame in the window, from the content view's top-left corner (Electron's coordinates). */
static NSRect topLeftFrame(NSView* view, NSView* content) {
  NSRect frame = [view convertRect:view.bounds toView:content];
  if (!content.isFlipped) frame.origin.y = content.bounds.size.height - frame.origin.y - frame.size.height;
  return frame;
}

static void findHost(NSView* view, NSView* content, NSRect box, NSView* __strong* found) {
  for (NSView* sub in view.subviews) {
    if (sub.hidden) continue;
    if ([NSStringFromClass([sub class]) isEqualToString:@"WebContentsViewCocoa"]) {
      NSRect frame = topLeftFrame(sub, content);
      // The topmost that fits wins (subviews run bottom to top).
      if (std::fabs(frame.origin.x - box.origin.x) <= 1 && std::fabs(frame.origin.y - box.origin.y) <= 1 &&
          std::fabs(frame.size.width - box.size.width) <= 1 && std::fabs(frame.size.height - box.size.height) <= 1)
        *found = sub;
      continue;
    }
    findHost(sub, content, box, found);
  }
}

static void detachGlass() {
  NSVisualEffectView* glass = gGlass;
  if (glass != nil) [glass removeFromSuperview];
  PistachioDeskGlassPage* page = gPage;
  if (page != nil) [page removeFromSuperview];
  gGlass = nil;
  gPage = nil;
  gHost = nil;
}

static bool numberAt(napi_env env, napi_value object, const char* key, double* out) {
  napi_value value;
  return napi_get_named_property(env, object, key, &value) == napi_ok && napi_get_value_double(env, value, out) == napi_ok &&
         std::isfinite(*out);
}

static napi_value boolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

/**
 * attach(windowHandle, box): the glass under the notch view whose box this is (the window's coordinates). True when it
 * lies there — already, or now; false, nothing changed, with no view at that box or no glass on the window to match.
 */
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) return boolean(env, false);
  NSView* content = contentViewOf(env, argv[0]);
  double x, y, w, h;
  if (content == nil || !numberAt(env, argv[1], "x", &x) || !numberAt(env, argv[1], "y", &y) || !numberAt(env, argv[1], "width", &w) ||
      !numberAt(env, argv[1], "height", &h))
    return boolean(env, false);
  NSVisualEffectView* source = windowGlass(content);
  if (source == nil) {
    detachGlass();
    return boolean(env, false);
  }
  NSView* host = gHost;
  NSVisualEffectView* glass = gGlass;
  if (host == nil || glass == nil || glass.superview != host || host.window != content.window) {
    NSView* found = nil;
    findHost(content, content, NSMakeRect(x, y, w, h), &found);
    if (found == nil) return boolean(env, false);
    detachGlass();
    host = found;
    glass = [[NSVisualEffectView alloc] initWithFrame:host.bounds];
    glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    glass.maskImage = noMask(host.bounds.size);
    // Under the view's own (which draws nothing of its own: the compositor's layer does, under all of them).
    [host addSubview:glass positioned:NSWindowBelow relativeTo:nil];
    // The nub over it: a layer we own (layer-hosting), its contents as they come.
    PistachioDeskGlassPage* page = [[PistachioDeskGlassPage alloc] initWithFrame:host.bounds];
    page.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    CALayer* layer = [CALayer layer];
    // Where the nub lies, at the box's bottom-right corner, at its own scale: a frame painted for the box as it was
    // before it changed lies where its nub does until the next comes.
    layer.contentsGravity = kCAGravityBottomRight;
    // (Each frame at once, as the glass's cut is: no fade from the last.)
    layer.actions = @{@"contents" : [NSNull null], @"contentsScale" : [NSNull null], @"bounds" : [NSNull null], @"position" : [NSNull null]};
    page.layer = layer;
    page.wantsLayer = YES;
    [host addSubview:page positioned:NSWindowAbove relativeTo:glass];
    gGlass = glass;
    gPage = page;
    gHost = host;
  }
  // As the window's own is now (it may have been made afresh since: the glass turned off and on).
  glass.material = source.material;
  glass.blendingMode = source.blendingMode;
  glass.state = source.state;
  glass.emphasized = source.emphasized;
  glass.appearance = source.appearance;
  return boolean(env, true);
}

/** `height` rows of `width` premultiplied BGRA pixels in sRGB (what an offscreen page paints), copied. */
static CGImageRef imageOf(const UInt8* bytes, size_t width, size_t height, CGColorSpaceRef space) {
  CFDataRef data = CFDataCreate(nullptr, bytes, CFIndex(width * height * 4));
  CGDataProviderRef provider = CGDataProviderCreateWithCFData(data);
  CGImageRef image = CGImageCreate(width, height, 8, 32, width * 4, space,
                                   CGBitmapInfo(kCGBitmapByteOrder32Little) | CGBitmapInfo(kCGImageAlphaPremultipliedFirst), provider, nullptr, false,
                                   kCGRenderingIntentDefault);
  CGDataProviderRelease(provider);
  CFRelease(data);
  return image;
}

/**
 * frame(bitmap, width, height, scale): the nub as it lies on the glass over its outline — premultiplied BGRA in sRGB,
 * top row first, `width` by `height` device pixels at `scale` (an offscreen page's paint), its top half the nub and its
 * bottom half the outline. The nub is laid over the glass and the glass cut to the outline, together.
 */
static napi_value Frame(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 4) return nullptr;
  PistachioDeskGlassPage* page = gPage;
  NSVisualEffectView* glass = gGlass;
  if (page == nil || glass == nil) return nullptr;
  void* data = nullptr;
  size_t length = 0;
  uint32_t width = 0, height = 0;
  double scale = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || napi_get_value_uint32(env, argv[1], &width) != napi_ok ||
      napi_get_value_uint32(env, argv[2], &height) != napi_ok || napi_get_value_double(env, argv[3], &scale) != napi_ok)
    return nullptr;
  if (width == 0 || height < 2 || height % 2 != 0 || width > 4096 || height > 8192 || length < size_t(width) * height * 4 ||
      !std::isfinite(scale) || scale < 0.5 || scale > 8)
    return nullptr;
  size_t half = height / 2;
  const UInt8* bytes = static_cast<const UInt8*>(data);
  CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGImageRef nub = imageOf(bytes, width, half, srgb);
  // (Held by the cut's drawing, which runs whenever AppKit draws it.)
  id outline = (__bridge_transfer id)imageOf(bytes + size_t(width) * half * 4, width, half, srgb);
  CGColorSpaceRelease(srgb);
  CGFloat w = width / scale;
  CGFloat h = half / scale;
  page.layer.contents = (__bridge id)nub;
  page.layer.contentsScale = scale;
  CGImageRelease(nub);
  glass.maskImage = [NSImage imageWithSize:glass.bounds.size
                                   flipped:NO
                            drawingHandler:^BOOL(NSRect rect) {
                              // At the box's bottom-right corner, as the nub is.
                              CGContextDrawImage(NSGraphicsContext.currentContext.CGContext, CGRectMake(NSMaxX(rect) - w, NSMinY(rect), w, h),
                                                 (__bridge CGImageRef)outline);
                              return YES;
                            }];
  return nullptr;
}

/** detach(): the glass taken out (the desktop glass turned off, or the window going). */
static napi_value Detach(napi_env env, napi_callback_info) {
  detachGlass();
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
      {"attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"frame", nullptr, Frame, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof methods / sizeof methods[0], methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
