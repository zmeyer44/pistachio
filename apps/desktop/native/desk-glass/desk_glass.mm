// The window's own glass under the desk's nub over a live page (docs/desk-agent.md §1, "The Bar"; main/desk-glass.ts).
//
// Over a live page the nub is main's "notch" view (NotchApp), not a hole down to the shell's ground: a tab's view
// paints over everything the shell draws. With the desktop glass on, that ground is AppKit's behind-window material,
// which no renderer can read — it follows whatever lies behind the window — so the view could only paint a stand-in
// grey. This puts the material itself there: an NSVisualEffectView set up as the window's own (Electron's vibrancy
// view, at the foot of the window's content view), inside the notch view's own NSView, so it moves, stacks, shows and
// hides with the view without being told. Behind-window blending samples what is behind the WINDOW, not the page
// between, so it is the same glass the gutter shows (measured 2026-10-15: within 1 level of the gutter over a black, a
// white and a blue window behind; the stand-in was 21 off over black). It is cut to the nub's outline as the view's
// page is (outline()).
//
// Chromium draws no page into its own NSView: every view's page — the shell, the tabs, the notch view — is composited
// into one layer under all of their NSViews (the views compositor's), so the glass, above that layer, hides the notch
// view's own page too. That page is drawn again above the glass (frame(): each frame it paints, main's frame
// subscription), in a layer that takes no pointer — the notch view's NSView still has it. So the nub is the window's
// glass with what the shell lays over the glass on it (the tint, the theme's gradient, the grain) and its mark: the
// gutter's own layers.
//
// Electron gives no handle to a WebContentsView's NSView: the notch view's is found as the one whose frame is the
// view's box (attach), once — it stays the same NSView for the life of the view.
//
// Node-API only, so it loads in Electron as built against Node's headers (as node-pty's prebuilt binary does).

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>

#include <cmath>
#include <vector>

/** The notch view's page drawn over the glass: a layer of its own, which takes no pointer. */
@interface PistachioDeskGlassPage : NSView
@end

@implementation PistachioDeskGlassPage
- (NSView*)hitTest:(NSPoint)point {
  return nil;
}
@end

/** Our glass and the page over it, and the notch view's NSView they lie in (each held by the view hierarchy, not by us). */
static __weak NSVisualEffectView* gGlass = nil;
static __weak PistachioDeskGlassPage* gPage = nil;
static __weak NSView* gHost = nil;
/** The outline last given, in the host's coordinates from its top-left corner (x, y pairs). */
static std::vector<CGFloat> gOutline;

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

/** Cut the glass to the outline: nothing of it shows outside (an empty outline hides it all). */
static void applyOutline() {
  NSVisualEffectView* glass = gGlass;
  if (glass == nil) return;
  NSSize size = glass.bounds.size;
  if (size.width < 1 || size.height < 1) return;
  std::vector<CGFloat> points = gOutline;
  glass.maskImage = [NSImage imageWithSize:size
                                   flipped:YES
                            drawingHandler:^BOOL(NSRect) {
                              if (points.size() < 6) return YES;
                              NSBezierPath* path = [NSBezierPath bezierPath];
                              [path moveToPoint:NSMakePoint(points[0], points[1])];
                              for (size_t i = 2; i + 1 < points.size(); i += 2) [path lineToPoint:NSMakePoint(points[i], points[i + 1])];
                              [path closePath];
                              [[NSColor blackColor] setFill];
                              [path fill];
                              return YES;
                            }];
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
    // Under the view's own (which draws nothing of its own: the compositor's layer does, under all of them).
    [host addSubview:glass positioned:NSWindowBelow relativeTo:nil];
    // The page over it: a layer we own (layer-hosting), its contents each frame.
    PistachioDeskGlassPage* page = [[PistachioDeskGlassPage alloc] initWithFrame:host.bounds];
    page.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    CALayer* layer = [CALayer layer];
    layer.contentsGravity = kCAGravityResize;
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
  applyOutline();
  return boolean(env, true);
}

/** outline(points): the nub's outline in the view's coordinates from its top-left corner, x and y in turn. */
static napi_value Outline(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) return nullptr;
  bool isArray = false;
  uint32_t length = 0;
  if (napi_is_array(env, argv[0], &isArray) != napi_ok || !isArray || napi_get_array_length(env, argv[0], &length) != napi_ok) return nullptr;
  std::vector<CGFloat> points;
  points.reserve(length);
  for (uint32_t i = 0; i < length; i += 1) {
    napi_value item;
    double value;
    if (napi_get_element(env, argv[0], i, &item) != napi_ok || napi_get_value_double(env, item, &value) != napi_ok || !std::isfinite(value))
      return nullptr;
    points.push_back(value);
  }
  if (points.size() % 2 != 0) return nullptr;
  gOutline = std::move(points);
  applyOutline();
  return nullptr;
}

/**
 * frame(bitmap, width, height): the notch view's page as it painted it — premultiplied BGRA, top row first, `width` by
 * `height` device pixels (a NativeImage's toBitmap) — drawn over the glass.
 */
static napi_value Frame(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 3) return nullptr;
  PistachioDeskGlassPage* page = gPage;
  if (page == nil) return nullptr;
  void* data = nullptr;
  size_t length = 0;
  uint32_t width = 0, height = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || napi_get_value_uint32(env, argv[1], &width) != napi_ok ||
      napi_get_value_uint32(env, argv[2], &height) != napi_ok)
    return nullptr;
  if (width == 0 || height == 0 || width > 4096 || height > 4096 || length < size_t(width) * height * 4) return nullptr;
  CFDataRef bytes = CFDataCreate(nullptr, static_cast<const UInt8*>(data), CFIndex(size_t(width) * height * 4));
  CGDataProviderRef provider = CGDataProviderCreateWithCFData(bytes);
  // (In the colour space the window's own pages are in: Chromium paints them for the display, and so the frame.)
  CGColorSpaceRef space = page.window.colorSpace.CGColorSpace;
  space = space != nullptr ? CGColorSpaceRetain(space) : CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGImageRef image = CGImageCreate(width, height, 8, 32, size_t(width) * 4, space,
                                   CGBitmapInfo(kCGBitmapByteOrder32Little) | CGBitmapInfo(kCGImageAlphaPremultipliedFirst), provider, nullptr, false,
                                   kCGRenderingIntentDefault);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  page.layer.contents = (__bridge id)image;
  page.layer.contentsScale = page.bounds.size.width > 0 ? width / page.bounds.size.width : 1;
  [CATransaction commit];
  CGImageRelease(image);
  CGColorSpaceRelease(space);
  CGDataProviderRelease(provider);
  CFRelease(bytes);
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
      {"outline", nullptr, Outline, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"frame", nullptr, Frame, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"detach", nullptr, Detach, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof methods / sizeof methods[0], methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
