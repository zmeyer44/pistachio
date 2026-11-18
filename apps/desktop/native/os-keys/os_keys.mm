/**
 * The modifier keys as the OS has them now (main/os-keys.ts; docs/desk.md, "Engine notes").
 *
 * The desk follows its grab key (Shift, unless set otherwise) and its snap key from the key events the window's views
 * are sent, since a mouse event reaching main carries no modifiers. A key that goes up where the window never hears it —
 * ⌘⇧4 takes the keyboard for its crosshair, and the keys are let go there — was held for good as far as the desk knew:
 * every press on a page grabbed its window until some key was pressed again. AppKit knows better: the keys down now,
 * whatever events this app was or was not sent. Electron has no word for that, so this asks AppKit.
 *
 * Node-API only (compiled by scripts/build-native.mjs, as native/desk-glass is), macOS only.
 */

#import <AppKit/AppKit.h>
#include <node_api.h>

/** modifiers(): { shift, control, alt, meta } — the modifier keys held down now. */
static napi_value Modifiers(napi_env env, napi_callback_info) {
  const NSEventModifierFlags flags = [NSEvent modifierFlags];
  napi_value out = nullptr;
  if (napi_create_object(env, &out) != napi_ok) return nullptr;
  const struct {
    const char* name;
    NSEventModifierFlags flag;
  } keys[] = {
      {"shift", NSEventModifierFlagShift},
      {"control", NSEventModifierFlagControl},
      {"alt", NSEventModifierFlagOption},
      {"meta", NSEventModifierFlagCommand},
  };
  for (const auto& key : keys) {
    napi_value held = nullptr;
    if (napi_get_boolean(env, (flags & key.flag) != 0, &held) != napi_ok) return nullptr;
    if (napi_set_named_property(env, out, key.name, held) != napi_ok) return nullptr;
  }
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
      {"modifiers", nullptr, Modifiers, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof methods / sizeof methods[0], methods);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
