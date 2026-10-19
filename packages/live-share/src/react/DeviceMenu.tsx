/**
 * A choice of camera, microphone or speaker: one section of a media menu.
 * Browsers name devices only once a permission is granted, so an unnamed
 * one reads by its kind and place ("Camera 2").
 */

import { Check } from "lucide-react";

export interface DeviceMenuProps {
  title: string;
  devices: readonly MediaDeviceInfo[];
  /** The device in use, or null for the browser's default (the first). */
  selected: string | null;
  onSelect(deviceId: string): void;
}

const UNNAMED: Readonly<Record<MediaDeviceKind, string>> = {
  audioinput: "Microphone",
  audiooutput: "Speaker",
  videoinput: "Camera",
};

export function deviceLabel(device: MediaDeviceInfo, index: number): string {
  // Chrome prefixes the system default's own entry; the plain name reads better in a menu.
  const label = device.label.replace(/^Default - /u, "");
  return label === "" ? `${UNNAMED[device.kind]} ${String(index + 1)}` : label;
}

export function DeviceMenu({ title, devices, selected, onSelect }: DeviceMenuProps) {
  if (devices.length === 0) return null;
  const current = selected !== null && devices.some((d) => d.deviceId === selected) ? selected : devices[0]?.deviceId;
  return (
    <div className="lv-menu-section" role="group" aria-label={title}>
      <div className="lv-menu-title">{title}</div>
      {devices.map((device, index) => (
        <button
          key={device.deviceId}
          type="button"
          role="menuitemradio"
          aria-checked={device.deviceId === current}
          className="lv-menu-item"
          onClick={() => onSelect(device.deviceId)}
        >
          <span className="lv-menu-check">{device.deviceId === current ? <Check aria-hidden="true" /> : null}</span>
          <span className="lv-menu-label">{deviceLabel(device, index)}</span>
        </button>
      ))}
    </div>
  );
}
