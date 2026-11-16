"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";

/*
 * The map inside the location picker: OpenStreetMap tiles (free, no key; credited in the corner as
 * their terms ask) and one draggable pin. Clicking the map moves the pin there. Loaded only in the
 * browser (Leaflet needs `window`).
 */

export type Pin = { latitude: number; longitude: number };

// A drawn pin, so no marker images need to be served.
const pinIcon = L.divIcon({
  className: "",
  iconSize: [28, 36],
  iconAnchor: [14, 34],
  html: `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 35s12-11.6 12-21A12 12 0 0 0 2 14c0 9.4 12 21 12 21z" fill="#e5484d" stroke="#ffffff" stroke-width="2"/><circle cx="14" cy="14" r="4.5" fill="#ffffff"/></svg>`,
});

function ClickToMove({ onPick }: { onPick: (p: Pin) => void }) {
  useMapEvents({ click: (e) => onPick({ latitude: e.latlng.lat, longitude: e.latlng.lng }) });
  return null;
}

/** Keeps the map on the pin when it's set from outside (a search result or a pasted link). */
function Follow({ pin, zoom }: { pin: Pin | null; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    if (pin) map.setView([pin.latitude, pin.longitude], Math.max(map.getZoom(), zoom), { animate: true });
  }, [map, pin, zoom]);
  // The modal opens with an animation: measure again once it has its final size.
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 250);
    return () => clearTimeout(t);
  }, [map]);
  return null;
}

export default function LocationMap({
  pin,
  onPick,
  className,
}: {
  pin: Pin | null;
  onPick: (p: Pin) => void;
  className?: string;
}) {
  // Somewhere sensible to start when nothing is chosen yet: the whole region, zoomed out.
  const start = useMemo<[number, number]>(() => (pin ? [pin.latitude, pin.longitude] : [22, 60]), [pin]);
  return (
    <MapContainer center={start} zoom={pin ? 16 : 3} className={className} scrollWheelZoom attributionControl>
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
      />
      <ClickToMove onPick={onPick} />
      <Follow pin={pin} zoom={16} />
      {pin ? (
        <Marker
          position={[pin.latitude, pin.longitude]}
          icon={pinIcon}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const p = (e.target as L.Marker).getLatLng();
              onPick({ latitude: p.lat, longitude: p.lng });
            },
          }}
        />
      ) : null}
    </MapContainer>
  );
}
